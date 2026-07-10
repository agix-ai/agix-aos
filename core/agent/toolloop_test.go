package agent_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/tool"
)

// addTool is a minimal real tool: it parses {"a":int,"b":int} and returns the
// sum as a string. It records that it ran so the test can assert invocation.
type addTool struct{ calls int }

func (a *addTool) Name() string        { return "add" }
func (a *addTool) Description() string { return "Add two integers a and b; returns their sum." }
func (a *addTool) InputSchema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"]}`)
}
func (a *addTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	a.calls++
	var in struct {
		A int `json:"a"`
		B int `json:"b"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return "", err
	}
	return strconv.Itoa(in.A + in.B), nil
}

// lastToolResultContent finds the most recent tool result content in a transcript
// — the scripted provider uses it to prove the executed result was threaded back
// into the model call.
func lastToolResultContent(msgs []router.Message) (string, bool) {
	for i := len(msgs) - 1; i >= 0; i-- {
		if n := len(msgs[i].ToolResults); n > 0 {
			return msgs[i].ToolResults[n-1].Content, true
		}
	}
	return "", false
}

func toolAgent(t *testing.T, p router.Provider) (*agent.Agent, *ledger.Ledger, *coord.MemLedger) {
	t.Helper()
	r := router.NewRouter()
	r.Register(p)
	r.ForceProvider(p.Name())
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	leases := coord.NewMemLedger()
	return &agent.Agent{Name: "forager-tool", Router: r, Ledger: led, Leases: leases}, led, leases
}

// TestToolLoopExecutesAndThreadsResult is the headline $0/offline proof: a bee is
// given a real `add` tool; a scripted provider makes the model call it, the loop
// executes it via the registry, and the executed result is threaded back into the
// model's final answer. Asserts the tool WAS invoked, the result reached both the
// answer and the Result provenance, the ledger recorded the tool call, and the
// lease was released.
func TestToolLoopExecutesAndThreadsResult(t *testing.T) {
	ctx := context.Background()
	add := &addTool{}
	// Scripted model: with no tool result yet → call add(2,3); once the loop has
	// executed it and fed the result back → answer "the sum is <result>".
	scripted := &mock.Scripted{
		Named: "mock",
		Caps:  router.Capabilities{ToolUse: true},
		Reply: func(req router.ChatRequest, _ int) (router.ChatResponse, error) {
			if got, ok := lastToolResultContent(req.Messages); ok {
				return router.ChatResponse{Text: "the sum is " + got}, nil
			}
			return router.ChatResponse{ToolCalls: []router.ToolCall{{
				ID:   "call-1",
				Name: "add",
				Args: json.RawMessage(`{"a":2,"b":3}`),
			}}}, nil
		},
	}
	ag, led, leases := toolAgent(t, scripted)

	reg, err := tool.New(add)
	if err != nil {
		t.Fatalf("tool.New: %v", err)
	}
	res, err := ag.Run(ctx, agent.Task{
		Name:   "sum",
		Prompt: "what is 2 + 3?",
		Scope:  []string{"src/sum.go"},
		Tools:  reg,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The tool WAS invoked, exactly once.
	if add.calls != 1 {
		t.Errorf("add tool executed %d times, want 1", add.calls)
	}
	// The executed result was threaded into the model's final answer.
	if !strings.Contains(res.Text, "5") {
		t.Errorf("final answer %q should carry the tool result 5", res.Text)
	}
	// The Result carries tool provenance beyond the ledger.
	if len(res.ToolCalls) != 1 {
		t.Fatalf("res.ToolCalls = %d, want 1", len(res.ToolCalls))
	}
	inv := res.ToolCalls[0]
	if inv.Name != "add" || inv.Result != "5" || inv.IsError {
		t.Errorf("tool invocation = %+v, want {add 5 false}", inv)
	}
	// The scripted provider was called twice (tool-call turn + final answer).
	if scripted.Calls() != 2 {
		t.Errorf("model calls = %d, want 2 (request + answer)", scripted.Calls())
	}
	// The ledger recorded the tool call and both model calls.
	assertKindCount(t, led, ledger.KindToolCall, 1)
	assertKindCount(t, led, ledger.KindModelCall, 2)

	// Lease released (another agent sees no conflict on the scope).
	conf, _ := leases.CheckOverlap(ctx, []string{"src/sum.go"}, "other")
	if len(conf) != 0 {
		t.Fatalf("lease should be released, overlap remains: %+v", conf)
	}
}

// TestToolLoopMaxIterationsCapTrips is the runaway guard: a scripted model that
// ALWAYS asks for another tool call can never finish, so the loop must stop at
// MaxToolIters with an error and a degraded marker — and still release the lease
// (heals posture). Proves the loop cannot spin forever.
func TestToolLoopMaxIterationsCapTrips(t *testing.T) {
	ctx := context.Background()
	loopTool := &addTool{}
	scripted := &mock.Scripted{
		Named: "mock",
		Caps:  router.Capabilities{ToolUse: true},
		Reply: func(router.ChatRequest, int) (router.ChatResponse, error) {
			// Never returns a final answer — always another tool call.
			return router.ChatResponse{ToolCalls: []router.ToolCall{{
				ID:   "call-loop",
				Name: "add",
				Args: json.RawMessage(`{"a":1,"b":1}`),
			}}}, nil
		},
	}
	ag, led, leases := toolAgent(t, scripted)
	reg, _ := tool.New(loopTool)

	const cap = 3
	res, err := ag.Run(ctx, agent.Task{
		Name:         "runaway",
		Prompt:       "loop forever",
		Scope:        []string{"src/runaway.go"},
		Tools:        reg,
		MaxToolIters: cap,
	})
	if err == nil {
		t.Fatal("expected an error when the tool loop hits the max-iterations cap")
	}
	if !strings.Contains(res.Err, "max iterations") {
		t.Errorf("res.Err = %q, want it to mention the max-iterations cap", res.Err)
	}
	if !containsStr(res.Degraded, "tool-loop-max-iterations") {
		t.Errorf("res.Degraded = %v, want a tool-loop-max-iterations marker", res.Degraded)
	}
	// The cap bounded the model calls and the tool executions to exactly `cap`.
	if scripted.Calls() != cap {
		t.Errorf("model calls = %d, want %d (the cap)", scripted.Calls(), cap)
	}
	if loopTool.calls != cap {
		t.Errorf("tool executed %d times, want %d (once per capped iteration)", loopTool.calls, cap)
	}
	// Heals posture: the lease is released even on the runaway path.
	conf, _ := leases.CheckOverlap(ctx, []string{"src/runaway.go"}, "other")
	if len(conf) != 0 {
		t.Fatalf("lease should be released even on runaway, overlap remains: %+v", conf)
	}
	// The runaway's tool calls were still audited.
	assertKindCount(t, led, ledger.KindToolCall, cap)
}

// TestToolLoopUnknownToolFedBackNotFatal proves a model call to a tool that isn't
// registered does not crash the loop: it is fed back as an error result so the
// model can recover, and the loop still completes on the next turn.
func TestToolLoopUnknownToolFedBackNotFatal(t *testing.T) {
	ctx := context.Background()
	scripted := &mock.Scripted{
		Named: "mock",
		Caps:  router.Capabilities{ToolUse: true},
		Reply: func(req router.ChatRequest, call int) (router.ChatResponse, error) {
			if call == 0 {
				return router.ChatResponse{ToolCalls: []router.ToolCall{{
					ID: "call-x", Name: "does-not-exist", Args: json.RawMessage(`{}`),
				}}}, nil
			}
			// After seeing the error result, the model recovers with an answer.
			got, _ := lastToolResultContent(req.Messages)
			return router.ChatResponse{Text: "recovered after: " + got}, nil
		},
	}
	ag, _, _ := toolAgent(t, scripted)
	reg, _ := tool.New(&addTool{}) // registry has "add", not "does-not-exist"

	res, err := ag.Run(ctx, agent.Task{Name: "recover", Prompt: "go", Scope: []string{"a/b.go"}, Tools: reg})
	if err != nil {
		t.Fatalf("Run should not fail on an unknown tool (fed back): %v", err)
	}
	if len(res.ToolCalls) != 1 || !res.ToolCalls[0].IsError {
		t.Fatalf("expected one errored tool invocation, got %+v", res.ToolCalls)
	}
	if !strings.Contains(res.Text, "unknown tool") {
		t.Errorf("answer %q should reflect the error result fed back", res.Text)
	}
}

func containsStr(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

func assertKindCount(t *testing.T, led *ledger.Ledger, kind string, want int) {
	t.Helper()
	got, err := led.Read(kind, time.Time{})
	if err != nil {
		t.Fatalf("Read(%q): %v", kind, err)
	}
	if len(got) != want {
		t.Errorf("ledger %q entries = %d, want %d", kind, len(got), want)
	}
}
