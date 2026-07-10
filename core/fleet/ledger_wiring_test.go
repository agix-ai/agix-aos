package fleet_test

import (
	"context"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/ledger"
)

// A spec that declares the `ledger` capability resolves it to the LIVE read-only
// ledger-query tool (not reported unresolved) WHEN an audit sink is wired, and it is
// the real one: the mock provider invokes it with empty args, the governed tool reads
// the trail and returns well-formed JSON, and the invocation is audited (tool="ledger",
// ok=true). This mirrors the exec/email wiring tests — a declared capability became a
// real, governed built-in the worker actually ran under the actor≠verifier swarm.
func TestLedgerCapabilityResolvesWhenSinkWired(t *testing.T) {
	led := newLedger(t)
	r := fleet.New()
	r.Ledger = led
	r.RepoRoot = t.TempDir()

	spec := proposerSpec()
	spec.Tools = []string{"ledger"}
	spec.Models.Workers = 1

	res, err := r.Run(context.Background(), spec, "what has the hive been doing lately?")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Tools) != 1 || res.Tools[0] != "ledger" {
		t.Fatalf("Tools = %v, want [ledger] resolved", res.Tools)
	}
	if contains(res.UnresolvedTools, "ledger") {
		t.Errorf("UnresolvedTools = %v, want ledger resolved (an audit sink is wired)", res.UnresolvedTools)
	}
	if !res.Result.Verified {
		t.Error("ledger-enabled run should still be governed/verified")
	}

	// The worker invoked the ledger tool (with the mock's empty {} args); a read-only
	// query over the trail succeeds and the call was audited ok=true.
	tc, err := led.Read(ledger.KindToolCall, time.Time{})
	if err != nil {
		t.Fatalf("Read(tool_call): %v", err)
	}
	if len(tc) != 1 {
		t.Fatalf("tool_call entries = %d, want 1 (one worker)", len(tc))
	}
	if tc[0].Data["tool"] != "ledger" {
		t.Errorf("tool_call tool = %v, want ledger", tc[0].Data["tool"])
	}
	if ok, _ := tc[0].Data["ok"].(bool); !ok {
		t.Errorf("a read-only ledger query should succeed (ok=true), entry = %+v", tc[0].Data)
	}
}

// With NO audit sink wired (Runner.Ledger nil), a declared `ledger` capability degrades
// honestly to UNRESOLVED — reported, never fatal — and the run is still governed. This
// is the deny-by-default half of the wiring: the read-only tool needs a real ledger to
// read, so without one the capability has nothing behind it and says so.
func TestLedgerCapabilityUnresolvedWithoutSink(t *testing.T) {
	r := fleet.New() // New() leaves Ledger nil
	r.RepoRoot = t.TempDir()

	spec := proposerSpec()
	spec.Tools = []string{"ledger"}
	spec.Models.Workers = 1

	res, err := r.Run(context.Background(), spec, "query the trail")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !contains(res.UnresolvedTools, "ledger") {
		t.Errorf("UnresolvedTools = %v, want ledger unresolved (no audit sink)", res.UnresolvedTools)
	}
	if contains(res.Tools, "ledger") {
		t.Errorf("Tools = %v, ledger must NOT resolve without a sink", res.Tools)
	}
	if !res.Result.Verified {
		t.Error("an unresolved capability degrades the run, it does not break governance")
	}
}
