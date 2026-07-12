// Run-bracket emission — the CLI half of the Stage-1.5 ledger run bracket. Every
// run entry point (run/flow/swarm/hive/agent run) wraps its invocation between a
// run_start and a run_done ledger entry, so `agix artifacts` recovers the run's
// boundary, id, kind, and the ORIGINAL user task EXACTLY instead of inferring
// them from decompose boundaries and gate payloads. Born-clean: stdlib only.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/agix-ai/agix/core/ledger"
)

// runIDEnv is the process-inherited handle that names the OUTERMOST run's bracket.
// A command process that finds it already set knows a parent opened the bracket, so
// the process is a NESTED sub-invocation and must not emit its own — see
// runBracketOwner.
const runIDEnv = "AGIX_RUN_ID"

// runBracketOwner decides whether THIS process owns the run bracket, enforcing the
// invariant "the outermost command process owns exactly one bracket." The bug it
// fixes: `agix agent run` delegates to the Bun behavior runner, which shells back
// into `agix-core agent run --engine` (and swarm/run) for each governed unit —
// each of those children used to emit its OWN run_start carrying the RENDERED
// system-prompt/task-template instead of the user's raw task, double-bracketing the
// run and landing the wrong task.
//
// The signal is the AGIX_RUN_ID env var. If it is already set, a parent already
// opened the bracket and this process is nested: return that id with owner=false
// (do NOT emit). Otherwise this is the outermost process: mint a fresh id, publish
// it into the environment so every spawned child (the Bun runner and its agix-core
// grandchild, which inherit os.Environ) sees itself as nested, and return
// owner=true. Born-clean: stdlib only.
func runBracketOwner() (runID string, owner bool) {
	if id := os.Getenv(runIDEnv); id != "" {
		return id, false
	}
	id := newRunID()
	_ = os.Setenv(runIDEnv, id)
	return id, true
}

// newRunID mints a short, stable, process-local run id (e.g. "run-9f3a1c2b7d40").
// crypto/rand keeps it collision-free across concurrent invocations writing the
// same ledger; a rand failure degrades to a timestamp id so a run is never
// blocked on entropy. Reused verbatim in the swarm/hive path's lease scope so the
// bracket's run_id and the scope agree.
func newRunID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	return "run-" + hex.EncodeToString(b[:])
}

// emitRunStart writes the opening bracket of a run. task is the ORIGINAL user
// task string (not an agent's system-prompt envelope or a synthetic "cli-task"),
// kind is "swarm" | "single" | "flow", and hive is optional (swarm/hive paths).
// A nil ledger or a write error is swallowed — an audit-trail hiccup must never
// fail the run itself.
func emitRunStart(led *ledger.Ledger, runID, task, capability, kind, hive string) {
	if led == nil {
		return
	}
	data := map[string]any{"run_id": runID, "task": task, "kind": kind}
	if capability != "" {
		data["capability"] = capability
	}
	if hive != "" {
		data["hive"] = hive
	}
	_ = led.Append(ledger.Entry{Kind: ledger.KindRunStart, Data: data})
}

// emitRunDone writes the closing bracket. ok records whether the run succeeded;
// costUSD (when >= 0) records the run's total cost. Best-effort, like emitRunStart.
func emitRunDone(led *ledger.Ledger, runID string, ok bool, costUSD float64) {
	if led == nil {
		return
	}
	data := map[string]any{"run_id": runID, "ok": ok}
	if costUSD >= 0 {
		data["cost_usd"] = costUSD
	}
	_ = led.Append(ledger.Entry{Kind: ledger.KindRunDone, Data: data})
}
