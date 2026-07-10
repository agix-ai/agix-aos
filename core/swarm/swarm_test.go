package swarm_test

import (
	"context"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/swarm"
)

func newLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	return led
}

// agentsIn returns the set of distinct Agent strings recorded in the ledger.
func agentsIn(t *testing.T, led *ledger.Ledger) map[string]bool {
	t.Helper()
	entries, err := led.Read("", time.Time{})
	if err != nil {
		t.Fatalf("ledger.Read: %v", err)
	}
	set := map[string]bool{}
	for _, e := range entries {
		set[e.Agent] = true
	}
	return set
}

func countKind(t *testing.T, led *ledger.Ledger, kind string) int {
	t.Helper()
	got, err := led.Read(kind, time.Time{})
	if err != nil {
		t.Fatalf("ledger.Read(%q): %v", kind, err)
	}
	return len(got)
}

// TestSwarmMockFirstLight is the frozen-contract proof: a governed swarm runs
// end-to-end on the mock provider at $0, decomposing → foraging in parallel →
// synthesizing → certifying (actor≠verifier), leaving a complete audit trail.
func TestSwarmMockFirstLight(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	res, err := swarm.Run(ctx, swarm.Options{
		Task:     "add a login page",
		Provider: "mock",
		Workers:  2,
		Ledger:   led,
	})
	if err != nil {
		t.Fatalf("swarm.Run: %v", err)
	}

	// ── Outcome contract ───────────────────────────────────────────────────
	if res.Answer == "" {
		t.Error("expected a non-empty synthesized answer")
	}
	if !res.Verified {
		t.Errorf("first-light run should be verified (approve-with-note), got verified=%v", res.Verified)
	}
	if res.Verdict.By != "agix/worker/verifier-1" {
		t.Errorf("verdict.by = %q, want agix/worker/verifier-1 (actor≠verifier)", res.Verdict.By)
	}
	if len(res.Subtasks) != 2 {
		t.Errorf("len(Subtasks) = %d, want 2", len(res.Subtasks))
	}

	// ── Cost contract: $0 on mock, and Cost.USD == Σ Bees ──────────────────
	if res.Cost.USD != 0 {
		t.Errorf("Cost.USD = %v, want 0 on the mock provider", res.Cost.USD)
	}
	if len(res.Cost.Bees) != 5 {
		t.Fatalf("len(Bees) = %d, want 5 (queen-decompose + 2 workers + queen-synth + verifier)", len(res.Cost.Bees))
	}
	var beeSum float64
	var inTok, outTok int
	for _, b := range res.Cost.Bees {
		beeSum += b.Usage.CostUSD
		inTok += b.Usage.InputTokens
		outTok += b.Usage.OutputTokens
	}
	if beeSum != res.Cost.USD {
		t.Errorf("Σ Bees cost = %v, want Cost.USD = %v", beeSum, res.Cost.USD)
	}
	if inTok != res.Cost.InputTokens || outTok != res.Cost.OutputTokens {
		t.Errorf("Σ Bees tokens (in=%d out=%d) != Cost (in=%d out=%d)", inTok, outTok, res.Cost.InputTokens, res.Cost.OutputTokens)
	}

	// ── Ledger: distinct worker actors + queen + verifier + a ratify entry ──
	agents := agentsIn(t, led)
	for _, want := range []string{
		"agix/worker/forager-1",
		"agix/worker/forager-2",
		"agix/queen/root",
		"agix/worker/verifier-1",
	} {
		if !agents[want] {
			t.Errorf("ledger missing actor %q; saw %v", want, agents)
		}
	}

	// N worker leases claimed AND released (heals posture releases even so).
	if c := countKind(t, led, ledger.KindLeaseClaim); c != 2 {
		t.Errorf("lease claims = %d, want 2 (one per worker)", c)
	}
	if r := countKind(t, led, ledger.KindLeaseRelease); r != 2 {
		t.Errorf("lease releases = %d, want 2 (one per worker)", r)
	}

	// The actor≠verifier trail of record: exactly one ratify entry, by the verifier.
	rat, err := led.Read(ledger.KindRatify, time.Time{})
	if err != nil {
		t.Fatalf("Read(ratify): %v", err)
	}
	if len(rat) != 1 {
		t.Fatalf("ratify entries = %d, want exactly 1", len(rat))
	}
	if by, _ := rat[0].Data["by"].(string); by != "agix/worker/verifier-1" {
		t.Errorf("ratify by = %q, want agix/worker/verifier-1", by)
	}
	if approved, _ := rat[0].Data["approved"].(bool); !approved {
		t.Error("first-light ratify should be approved")
	}
}

// TestSwarmPerRoleModelOverrides is the mixed-model proof for the paid-run
// config "Opus queen + mixed Sonnet/Haiku workers": with QueenModel/VerifyModel
// set and WorkerModels assigned round-robin across 4 workers, every bee records
// the requested model on bees[].model — and the run stays $0 on the mock.
func TestSwarmPerRoleModelOverrides(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	res, err := swarm.Run(ctx, swarm.Options{
		Task:         "add a login page",
		Provider:     "mock",
		Workers:      4,
		Ledger:       led,
		QueenModel:   "claude-opus-4-8",
		WorkerModels: []string{"claude-sonnet-5", "claude-haiku-4-5"},
		VerifyModel:  "claude-sonnet-5",
	})
	if err != nil {
		t.Fatalf("swarm.Run: %v", err)
	}

	// Additive: overriding models must not break the $0-on-mock guarantee.
	if res.Cost.USD != 0 {
		t.Errorf("override run on mock must still be $0, got %v", res.Cost.USD)
	}

	var foragers, queens []string
	var verifier string
	for _, b := range res.Cost.Bees {
		switch b.Role {
		case "forager":
			foragers = append(foragers, b.Model)
		case "queen":
			queens = append(queens, b.Model)
		case "verifier":
			verifier = b.Model
		}
	}

	// Round-robin proof: 2 models across 4 workers → sonnet,haiku,sonnet,haiku.
	wantForagers := []string{"claude-sonnet-5", "claude-haiku-4-5", "claude-sonnet-5", "claude-haiku-4-5"}
	if !reflect.DeepEqual(foragers, wantForagers) {
		t.Errorf("forager models = %v, want %v (round-robin)", foragers, wantForagers)
	}

	// Queen override lands on BOTH queen bees (decompose + synthesize).
	if len(queens) != 2 {
		t.Fatalf("queen bees = %d, want 2 (decompose + synthesize)", len(queens))
	}
	for _, m := range queens {
		if m != "claude-opus-4-8" {
			t.Errorf("queen bee model = %q, want claude-opus-4-8", m)
		}
	}

	// Verify override lands on the verifier bee.
	if verifier != "claude-sonnet-5" {
		t.Errorf("verifier model = %q, want claude-sonnet-5", verifier)
	}
}

// TestSwarmNoOverridesUnchanged is the additive guard: with no model overrides,
// bees record the provider-reported model ("mock"), exactly as before.
func TestSwarmNoOverridesUnchanged(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	res, err := swarm.Run(ctx, swarm.Options{
		Task:     "add a login page",
		Provider: "mock",
		Workers:  2,
		Ledger:   led,
	})
	if err != nil {
		t.Fatalf("swarm.Run: %v", err)
	}
	if res.Cost.USD != 0 {
		t.Errorf("mock run should be $0, got %v", res.Cost.USD)
	}
	for _, b := range res.Cost.Bees {
		if b.Model != "mock" {
			t.Errorf("bee %s/%s model = %q, want mock (no override)", b.Role, b.Phase, b.Model)
		}
	}
}

// TestSwarmDuplicateSubtaskConflicts proves the stigmergy dedup the parallel
// fan-out relies on: two bees claiming the SAME subtask scope conflict, so no
// two workers can ever forage the same subtask.
func TestSwarmDuplicateSubtaskConflicts(t *testing.T) {
	ctx := context.Background()
	leases := coord.NewMemLedger()
	scope := "agix/swarm/run-x/subtask/st-1"

	if _, err := leases.Claim(ctx, coord.ClaimRequest{
		Agent:  "agix/worker/forager-1",
		Claims: []coord.Claim{{Path: scope, Mode: coord.ModeExclusive}},
	}); err != nil {
		t.Fatalf("first claim on %q should succeed: %v", scope, err)
	}

	_, err := leases.Claim(ctx, coord.ClaimRequest{
		Agent:  "agix/worker/forager-2",
		Claims: []coord.Claim{{Path: scope, Mode: coord.ModeExclusive}},
	})
	if err == nil {
		t.Fatal("expected a lease conflict on the duplicate subtask path (dedup), got nil")
	}
}

// fakeRetriever records how many times its Augment was called — proof the KM-on
// branch actually augments each worker's prompt.
type fakeRetriever struct{ calls int32 }

func (f *fakeRetriever) Augment(_ context.Context, prompt string) (string, int, error) {
	atomic.AddInt32(&f.calls, 1)
	return "[km context]\n" + prompt, 1, nil
}

// TestSwarmKMRetrieverInvoked exercises the KM-on branch: with a Retriever set,
// every worker's prompt is augmented before it forages.
func TestSwarmKMRetrieverInvoked(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	fr := &fakeRetriever{}

	res, err := swarm.Run(ctx, swarm.Options{
		Task:      "add a login page",
		Provider:  "mock",
		Workers:   3,
		Ledger:    led,
		Retriever: fr,
	})
	if err != nil {
		t.Fatalf("swarm.Run: %v", err)
	}
	if got := atomic.LoadInt32(&fr.calls); got != 3 {
		t.Errorf("Augment called %d times, want 3 (once per worker)", got)
	}
	if res.Answer == "" {
		t.Error("expected an answer with KM on")
	}
	if res.Cost.USD != 0 {
		t.Errorf("KM-on mock run should still be $0, got %v", res.Cost.USD)
	}
}
