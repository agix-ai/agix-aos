package hivekit_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/hivekit"
	"github.com/agix-ai/agix/core/ledger"
)

func newLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	return led
}

// TestHiveBuilderGovernedRun is the headline ADK proof: the fluent builder,
// exercised exactly as a caller would, produces a governed Result end-to-end on
// the $0 mock provider — verified, per-role model tiering landing on the right
// bees, and the actor≠verifier guarantee holding (the verifier is a distinct
// actor from every other bee, and Verdict.By is that verifier).
func TestHiveBuilderGovernedRun(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	hive := hivekit.New().
		Named("testhive").
		Provider("mock").
		Queen("claude-opus-4-8").
		Workers(3, "claude-sonnet-5", "claude-haiku-4-5").
		Verifier("claude-sonnet-5").
		Ledger(led)

	res, err := hive.Run(ctx, "add a login page")
	if err != nil {
		t.Fatalf("hive.Run: %v", err)
	}

	// ── Governed outcome ────────────────────────────────────────────────────
	if res.Answer == "" {
		t.Error("expected a non-empty synthesized answer")
	}
	if !res.Verified {
		t.Errorf("governed run should be verified (approve-with-note), got %v", res.Verified)
	}
	if res.Cost.USD != 0 {
		t.Errorf("mock run must be $0, got %v", res.Cost.USD)
	}

	// ── actor≠verifier is first-class ───────────────────────────────────────
	wantVerifier := "testhive/worker/verifier-1"
	if hive.VerifierActor() != wantVerifier {
		t.Errorf("VerifierActor() = %q, want %q", hive.VerifierActor(), wantVerifier)
	}
	if hive.QueenActor() != "testhive/queen/root" {
		t.Errorf("QueenActor() = %q, want testhive/queen/root", hive.QueenActor())
	}
	if hive.QueenActor() == hive.VerifierActor() {
		t.Fatal("actor≠verifier violated: queen and verifier share an actor ref")
	}
	if res.Verdict.By != hive.VerifierActor() {
		t.Errorf("Verdict.By = %q, want the distinct verifier %q", res.Verdict.By, hive.VerifierActor())
	}

	// ── The verifier bee is distinct from every actor that produced work ─────
	// workers=3 → 1 decompose + 3 forage + 1 synth + 1 verify = 6 bees.
	if len(res.Cost.Bees) != 6 {
		t.Fatalf("len(Bees) = %d, want 6 (decompose + 3 workers + synth + verify)", len(res.Cost.Bees))
	}
	var verifierBee, foragers, queens int
	for _, b := range res.Cost.Bees {
		if b.Role == "verifier" {
			verifierBee++
			if b.Actor != hive.VerifierActor() {
				t.Errorf("verifier bee actor = %q, want %q", b.Actor, hive.VerifierActor())
			}
			continue
		}
		// No non-verifier bee (queen or forager) may share the verifier's actor.
		if b.Actor == hive.VerifierActor() {
			t.Errorf("non-verifier bee %s/%s reused the verifier actor %q", b.Role, b.Phase, b.Actor)
		}
		switch b.Role {
		case "forager":
			foragers++
		case "queen":
			queens++
		}
	}
	if verifierBee != 1 {
		t.Errorf("verifier bees = %d, want exactly 1 (the single distinct grader)", verifierBee)
	}
	if foragers != 3 || queens != 2 {
		t.Errorf("bee mix foragers=%d queens=%d, want 3 and 2", foragers, queens)
	}

	// ── Per-role model tiering lands on the right bees ──────────────────────
	var gotForagerModels []string
	for _, b := range res.Cost.Bees {
		switch b.Role {
		case "forager":
			gotForagerModels = append(gotForagerModels, b.Model)
		case "queen":
			if b.Model != "claude-opus-4-8" {
				t.Errorf("queen bee (%s) model = %q, want claude-opus-4-8", b.Phase, b.Model)
			}
		case "verifier":
			if b.Model != "claude-sonnet-5" {
				t.Errorf("verifier bee model = %q, want claude-sonnet-5", b.Model)
			}
		}
	}
	// Round-robin: 2 models across 3 workers → sonnet, haiku, sonnet.
	wantForagerModels := []string{"claude-sonnet-5", "claude-haiku-4-5", "claude-sonnet-5"}
	if len(gotForagerModels) != len(wantForagerModels) {
		t.Fatalf("forager models = %v, want %v", gotForagerModels, wantForagerModels)
	}
	for i := range wantForagerModels {
		if gotForagerModels[i] != wantForagerModels[i] {
			t.Errorf("forager[%d] model = %q, want %q (round-robin)", i, gotForagerModels[i], wantForagerModels[i])
		}
	}

	// ── The audit ledger records the distinct verifier's ratify verdict ─────
	rat, err := led.Read(ledger.KindRatify, time.Time{})
	if err != nil {
		t.Fatalf("Read(ratify): %v", err)
	}
	if len(rat) != 1 {
		t.Fatalf("ratify entries = %d, want exactly 1", len(rat))
	}
	if by, _ := rat[0].Data["by"].(string); by != hive.VerifierActor() {
		t.Errorf("ratify by = %q, want %q (actor≠verifier trail of record)", by, hive.VerifierActor())
	}
}

// TestHiveDefaultsOfflineAndGoverned proves New() alone — no configuration — is a
// legitimate governed, $0/offline system-under-test with the distinct verifier.
func TestHiveDefaultsOfflineAndGoverned(t *testing.T) {
	res, err := hivekit.New().Run(context.Background(), "summarize the release notes")
	if err != nil {
		t.Fatalf("hive.Run: %v", err)
	}
	if res.Cost.USD != 0 {
		t.Errorf("default hive must be $0 on mock, got %v", res.Cost.USD)
	}
	if !res.Verified {
		t.Error("default hive run should be verified")
	}
	// Default Workers=2 → 1 decompose + 2 forage + 1 synth + 1 verify = 5 bees.
	if len(res.Cost.Bees) != 5 {
		t.Errorf("len(Bees) = %d, want 5 at default workers=2", len(res.Cost.Bees))
	}
	if res.Verdict.By != "agix/worker/verifier-1" {
		t.Errorf("Verdict.By = %q, want agix/worker/verifier-1 (default hive)", res.Verdict.By)
	}
}

// fakeComb records how many times Augment ran — proof WithComb wires the KM seam
// through to every worker.
type fakeComb struct{ calls int32 }

func (f *fakeComb) Augment(_ context.Context, prompt string) (string, int, error) {
	atomic.AddInt32(&f.calls, 1)
	return "[comb context]\n" + prompt, 1, nil
}

// TestHiveWithCombAugments exercises the WithComb seam end-to-end: the retriever
// augments every worker's prompt before it forages, and the run stays $0.
func TestHiveWithCombAugments(t *testing.T) {
	fc := &fakeComb{}
	res, err := hivekit.New().
		Workers(4).
		WithComb(fc).
		Run(context.Background(), "add a login page")
	if err != nil {
		t.Fatalf("hive.Run: %v", err)
	}
	if got := atomic.LoadInt32(&fc.calls); got != 4 {
		t.Errorf("Comb.Augment called %d times, want 4 (once per worker)", got)
	}
	if res.Cost.USD != 0 {
		t.Errorf("Comb-on mock run should still be $0, got %v", res.Cost.USD)
	}
	if !res.Verified {
		t.Error("Comb-on run should be verified")
	}
}

// pingTool is a worker-facing tool that ignores its arguments and returns "pong",
// counting invocations so the test can prove every worker's loop actually ran it.
type pingTool struct{ calls int32 }

func (p *pingTool) Name() string        { return "ping" }
func (p *pingTool) Description() string { return "Ping a service; returns pong." }
func (p *pingTool) InputSchema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{}}`)
}
func (p *pingTool) Execute(context.Context, json.RawMessage) (string, error) {
	atomic.AddInt32(&p.calls, 1)
	return "pong", nil
}

// TestHiveWithToolsRunsToolLoop is the ADK tool exposure proof, end-to-end on the
// $0 mock: WithTools gives every worker a tool, the (tool-aware) mock drives each
// worker's forage to call it, the loop executes it, and the result propagates
// worker→synthesis→answer — all while the run stays governed, verified, and $0,
// and the actor≠verifier guarantee holds (the tool went only to workers).
func TestHiveWithToolsRunsToolLoop(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	ping := &pingTool{}

	hive := hivekit.New().
		Named("toolhive").
		Workers(3).
		WithTools(ping).
		Ledger(led)

	res, err := hive.Run(ctx, "check the service is up")
	if err != nil {
		t.Fatalf("hive.Run: %v", err)
	}
	if res.Cost.USD != 0 {
		t.Errorf("tool-enabled mock run must be $0, got %v", res.Cost.USD)
	}
	if !res.Verified {
		t.Error("tool-enabled run should still be governed/verified")
	}
	// Every one of the 3 workers ran the tool in its loop.
	if got := atomic.LoadInt32(&ping.calls); got != 3 {
		t.Errorf("ping tool executed %d times, want 3 (once per worker)", got)
	}
	// The tool result propagated all the way into the synthesized answer.
	if !strings.Contains(res.Answer, "pong") {
		t.Errorf("synthesized answer should carry the tool result 'pong', got %q", res.Answer)
	}
	// actor≠verifier and the bee shape are unchanged by tools: still 6 bees
	// (decompose + 3 forage + synth + verify), and the verifier is distinct.
	if len(res.Cost.Bees) != 6 {
		t.Errorf("len(Bees) = %d, want 6 (tools do not change the governance shape)", len(res.Cost.Bees))
	}
	if res.Verdict.By != hive.VerifierActor() {
		t.Errorf("Verdict.By = %q, want the distinct verifier %q", res.Verdict.By, hive.VerifierActor())
	}
	// The tool executions were audited.
	tc, err := led.Read(ledger.KindToolCall, time.Time{})
	if err != nil {
		t.Fatalf("Read(tool_call): %v", err)
	}
	if len(tc) != 3 {
		t.Errorf("ledger tool_call entries = %d, want 3 (one per worker)", len(tc))
	}
	for _, e := range tc {
		if e.Agent == hive.VerifierActor() {
			t.Errorf("a tool_call was attributed to the verifier %q; tools must go only to workers", e.Agent)
		}
	}
}

// TestHiveWithDuplicateToolsFailsAtRun proves the registry's namespace guard
// surfaces through the builder: two tools with the same name error at Run.
func TestHiveWithDuplicateToolsFailsAtRun(t *testing.T) {
	_, err := hivekit.New().
		WithTools(&pingTool{}, &pingTool{}).
		Run(context.Background(), "check the service")
	if err == nil {
		t.Fatal("expected a duplicate-tool-name error from WithTools at Run")
	}
}

// TestHiveRunNeedsTask proves the ADK guardrail: an empty task is rejected before
// any model call, with a friendly error and no partial run.
func TestHiveRunNeedsTask(t *testing.T) {
	_, err := hivekit.New().Run(context.Background(), "   ")
	if err == nil {
		t.Fatal("expected an error for an empty task, got nil")
	}
}

// TestHiveBuildReflectsConfig proves Build() returns an honest, inspectable view
// of the declared config (the pre-defaults swarm.Options).
func TestHiveBuildReflectsConfig(t *testing.T) {
	opts := hivekit.New().
		Provider("anthropic").
		Queen("claude-opus-4-8").
		Workers(5, "claude-haiku-4-5").
		Verifier("claude-sonnet-5").
		Concurrency(3).
		Build()

	if opts.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic", opts.Provider)
	}
	if opts.Workers != 5 {
		t.Errorf("Workers = %d, want 5", opts.Workers)
	}
	if opts.QueenModel != "claude-opus-4-8" {
		t.Errorf("QueenModel = %q, want claude-opus-4-8", opts.QueenModel)
	}
	if opts.VerifyModel != "claude-sonnet-5" {
		t.Errorf("VerifyModel = %q, want claude-sonnet-5", opts.VerifyModel)
	}
	if len(opts.WorkerModels) != 1 || opts.WorkerModels[0] != "claude-haiku-4-5" {
		t.Errorf("WorkerModels = %v, want [claude-haiku-4-5]", opts.WorkerModels)
	}
	if opts.Concurrency != 3 {
		t.Errorf("Concurrency = %d, want 3", opts.Concurrency)
	}
}
