package agent_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/provider/anthropic"
	"github.com/agix-ai/agix/core/tool"
)

// TestToolLoopDrivesRealAnthropicAdapter is the offline end-to-end proof for
// Slice 3b: the real core/agent toolLoop drives the REAL Anthropic adapter (its
// actual serialize + parse) through a full tool call → execute → final answer,
// with an httptest server standing in for the model (NO API key, NO network).
//
// The server keys off the request body: the first turn (no tool_result present)
// returns a tool_use block asking for add(2,3); once the loop has executed the
// tool and fed the result back — which the adapter serializes as a tool_result
// block — the server extracts that result and echoes it as the final answer.
// A pass therefore proves the whole round trip crossed the real adapter both
// directions: request tools + tool_use parse + tool_result serialize + text parse.
func TestToolLoopDrivesRealAnthropicAdapter(t *testing.T) {
	ctx := context.Background()
	add := &addTool{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		if result, ok := anthropicToolResult(raw); ok {
			io.WriteString(w, `{"model":"claude-sonnet-5","stop_reason":"end_turn","content":[{"type":"text","text":"the sum is `+result+`"}],"usage":{"input_tokens":60,"output_tokens":8}}`)
			return
		}
		io.WriteString(w, `{"model":"claude-sonnet-5","stop_reason":"tool_use","content":[{"type":"text","text":"I'll add them."},{"type":"tool_use","id":"toolu_01","name":"add","input":{"a":2,"b":3}}],"usage":{"input_tokens":40,"output_tokens":12}}`)
	}))
	defer srv.Close()

	prov := &anthropic.Provider{APIKey: "test-key", BaseURL: srv.URL, HTTP: srv.Client()}
	ag, led, leases := toolAgent(t, prov)

	reg, err := tool.New(add)
	if err != nil {
		t.Fatalf("tool.New: %v", err)
	}
	res, err := ag.Run(ctx, agent.Task{
		Name:   "sum-anthropic",
		Prompt: "what is 2 + 3?",
		Scope:  []string{"src/sum.go"},
		Tools:  reg,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The tool WAS invoked exactly once, and its executed result reached the answer.
	if add.calls != 1 {
		t.Errorf("add tool executed %d times, want 1", add.calls)
	}
	if !strings.Contains(res.Text, "5") {
		t.Errorf("final answer %q should carry the tool result 5 (threaded back through the real adapter)", res.Text)
	}
	if len(res.ToolCalls) != 1 || res.ToolCalls[0].Name != "add" || res.ToolCalls[0].Result != "5" || res.ToolCalls[0].IsError {
		t.Fatalf("res.ToolCalls = %+v, want one add=5 invocation", res.ToolCalls)
	}
	if res.Provider != "anthropic" {
		t.Errorf("provider = %q, want anthropic", res.Provider)
	}

	// The ledger recorded the tool call and both model calls (request + final answer).
	assertKindCount(t, led, ledger.KindToolCall, 1)
	assertKindCount(t, led, ledger.KindModelCall, 2)

	// Lease released.
	conf, _ := leases.CheckOverlap(ctx, []string{"src/sum.go"}, "other")
	if len(conf) != 0 {
		t.Fatalf("lease should be released, overlap remains: %+v", conf)
	}
}

// anthropicToolResult scans an Anthropic /v1/messages request body for the content
// of the first tool_result block, proving the loop fed the executed result back and
// the real adapter serialized it as a tool_result content block.
func anthropicToolResult(body []byte) (string, bool) {
	var req struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "", false
	}
	for _, m := range req.Messages {
		var blocks []struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(m.Content, &blocks); err != nil {
			continue // plain string content (not a tool turn)
		}
		for _, b := range blocks {
			if b.Type == "tool_result" {
				return b.Content, true
			}
		}
	}
	return "", false
}
