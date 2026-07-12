// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/ledger"
)

// ── fixtures ─────────────────────────────────────────────────────────────────

// clk hands out monotonically increasing timestamps so a fixture's entries have
// a deterministic order/duration without colliding.
type clk struct{ t time.Time }

func newClk() *clk { return &clk{t: time.Date(2026, 7, 12, 1, 0, 0, 0, time.UTC)} }
func (c *clk) next() time.Time {
	c.t = c.t.Add(time.Millisecond)
	return c.t
}

// ent builds one ledger entry with the next timestamp.
func (c *clk) ent(kind, agent string, data map[string]any) ledger.Entry {
	return ledger.Entry{TS: c.next(), Kind: kind, Agent: agent, Data: data}
}

// swarmRun is the happy-path swarm trace: queen decompose → 2 workers forage →
// queen synthesize → gate → DISTINCT verifier ratifies (approved). Mirrors the
// real hive ledger shape (see core/swarm + core/orchestrator/mem).
func swarmRun(c *clk, runID string, approved bool) []ledger.Entry {
	scope := "agix/swarm/" + runID + "/subtask/"
	return []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock", "input_tokens": 76.0, "output_tokens": 48.0, "cost_usd": 0.0}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": "st-1", "capability": "cheap-classification"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-0001", "scope": []any{scope + "st-1"}}),
		c.ent("model_call", "agix/worker/forager-1", map[string]any{"model": "mock", "provider": "mock", "input_tokens": 58.0, "output_tokens": 41.0, "cost_usd": 0.0}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true, "chars": 242.0, "cost_usd": 0.0}),
		c.ent("lease_release", "agix/worker/forager-1", map[string]any{"lease": "lease-0001"}),
		c.ent("agent_start", "agix/worker/forager-2", map[string]any{"task": "st-2", "capability": "cheap-classification"}),
		c.ent("lease_claim", "agix/worker/forager-2", map[string]any{"lease": "lease-0002", "scope": []any{scope + "st-2"}}),
		c.ent("model_call", "agix/worker/forager-2", map[string]any{"model": "mock", "provider": "mock", "input_tokens": 58.0, "output_tokens": 41.0, "cost_usd": 0.0}),
		c.ent("agent_done", "agix/worker/forager-2", map[string]any{"ok": true, "chars": 242.0, "cost_usd": 0.0}),
		c.ent("lease_release", "agix/worker/forager-2", map[string]any{"lease": "lease-0002"}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock", "input_tokens": 147.0, "output_tokens": 123.0, "cost_usd": 0.0}),
		c.ent("node_start", "ratify", map[string]any{"node": "ratify"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify", "kind": "ratify", "checkpoint": "ckpt-0001",
			"payload": map[string]any{"gate": "ratify", "subject": "mock reply: Original task: review the auth module\n\nmore text"}}),
		c.ent("model_call", "agix/worker/verifier-1", map[string]any{"role": "verifier", "phase": "verify", "model": "mock", "input_tokens": 178.0, "output_tokens": 158.0, "cost_usd": 0.0}),
		c.ent("ratify", "agix/worker/verifier-1", map[string]any{"approved": approved, "by": "agix/worker/verifier-1", "gate": "ratify", "grounding": "judgment", "notes": "auto-approved (graceful path)"}),
	}
}

// flowRun is the single-agent governance graph: agent_start(task) → forage →
// gate → curator ratifies → feed → agent_done.
func flowRun(c *clk, task string, approved bool) []ledger.Entry {
	return []ledger.Entry{
		c.ent("agent_start", "forager-1", map[string]any{"graph": "forage-ratify-feed", "task": task}),
		c.ent("lease_claim", "forager-1", map[string]any{"lease": "lease-0001", "scope": "hive/flow/" + slugForTest(task)}),
		c.ent("node_start", "forage", map[string]any{"node": "forage"}),
		c.ent("model_call", "forager-1", map[string]any{"model": "mock", "provider": "mock", "node": "forage", "input_tokens": 19.0, "output_tokens": 7.0, "cost_usd": 0.0}),
		c.ent("node_done", "forage", map[string]any{"node": "forage", "ok": true}),
		c.ent("node_start", "ratify", map[string]any{"node": "ratify"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify", "kind": "ratify", "checkpoint": "ckpt-0001"}),
		c.ent("ratify", "curator-1", map[string]any{"approved": approved, "by": "curator-1", "gate": "ratify", "notes": "ratified"}),
		c.ent("node_start", "feed", map[string]any{"node": "feed"}),
		c.ent("model_call", "forager-1", map[string]any{"model": "mock", "node": "feed", "input_tokens": 30.0, "output_tokens": 10.0, "cost_usd": 0.0}),
		c.ent("node_done", "feed", map[string]any{"node": "feed", "ok": true}),
		c.ent("agent_done", "forager-1", map[string]any{"ok": true, "approved": approved, "outcome": "fed"}),
		c.ent("lease_release", "forager-1", map[string]any{"lease": "lease-0001"}),
	}
}

// runCmd is the plain `run` single-call agent path — no gate, no verifier.
func runCmd(c *clk) []ledger.Entry {
	return []ledger.Entry{
		c.ent("agent_start", "forager-1", map[string]any{"task": "cli-task", "capability": "default-quality"}),
		c.ent("lease_claim", "forager-1", map[string]any{"lease": "lease-0001", "scope": []any{"hive/cli/mock"}}),
		c.ent("model_call", "forager-1", map[string]any{"model": "mock", "provider": "mock", "input_tokens": 22.0, "output_tokens": 5.0, "cost_usd": 0.0}),
		c.ent("agent_done", "forager-1", map[string]any{"ok": true, "chars": 40.0, "cost_usd": 0.0}),
		c.ent("lease_release", "forager-1", map[string]any{"lease": "lease-0001"}),
	}
}

func slugForTest(s string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), " ", "-")
}

// writeLedger marshals entries to a temp .jsonl file (optionally appending extra
// raw lines, e.g. a corrupt one) and returns its path.
func writeLedger(t *testing.T, entries []ledger.Entry, rawExtra ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	var b strings.Builder
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal fixture entry: %v", err)
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	for _, raw := range rawExtra {
		b.WriteString(raw)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write fixture ledger: %v", err)
	}
	return path
}

// ── Stage-1.5 run-bracket fixtures ────────────────────────────────────────────

// bracketed wraps a run's entries between a run_start and run_done, exactly as the
// CLI run entry points now emit. runID/task/capability/kind become the EXACT run
// identity `agix artifacts` recovers — no decompose/gate heuristic. build runs
// AFTER the run_start so timestamps stay ordered (run_start first).
func bracketed(c *clk, runID, task, capability, kind string, build func(*clk) []ledger.Entry) []ledger.Entry {
	out := []ledger.Entry{
		c.ent(ledger.KindRunStart, "", map[string]any{"run_id": runID, "task": task, "capability": capability, "kind": kind}),
	}
	out = append(out, build(c)...)
	out = append(out, c.ent(ledger.KindRunDone, "", map[string]any{"run_id": runID, "ok": true}))
	return out
}

// agentRunInner mirrors the fleet → hive → swarm shape of a single governed
// `agix agent run`: the worker's agent_start carries the SYSTEM-PROMPT ENVELOPE as
// its task (the Stage-1 bug), and there is no "Original task:" gate marker — so the
// heuristic can only recover the envelope, never the raw user task.
func agentRunInner(c *clk, envelope string) []ledger.Entry {
	return []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock", "input_tokens": 40.0, "output_tokens": 20.0}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": envelope, "capability": "default-quality"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-ag01", "scope": []any{"agix/swarm/run-agent/subtask/st-1"}}),
		c.ent("model_call", "agix/worker/forager-1", map[string]any{"model": "mock", "input_tokens": 30.0, "output_tokens": 15.0}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
		c.ent("model_call", "agix/worker/verifier-1", map[string]any{"role": "verifier", "phase": "verify", "model": "mock"}),
		c.ent("ratify", "agix/worker/verifier-1", map[string]any{"approved": true, "by": "agix/worker/verifier-1"}),
	}
}

// oneReceipt reconstructs and asserts exactly one run was found.
func oneReceipt(t *testing.T, entries []ledger.Entry) *Receipt {
	t.Helper()
	rs := reconstruct(entries)
	if len(rs) != 1 {
		t.Fatalf("expected exactly 1 receipt, got %d", len(rs))
	}
	return rs[0]
}

// ── reconstruction: the actor≠verifier core ──────────────────────────────────

func TestReceiptSwarmDistinct(t *testing.T) {
	c := newClk()
	r := oneReceipt(t, swarmRun(c, "run-777", true))

	if r.Kind != "swarm" {
		t.Errorf("kind = %q, want swarm", r.Kind)
	}
	if r.RunID != "run-777" {
		t.Errorf("run id = %q, want run-777 (from swarm scope)", r.RunID)
	}
	if r.Governance.Status != "distinct" || !r.Governance.ActorNeqVerifier {
		t.Errorf("governance = %+v, want distinct/true", r.Governance)
	}
	if len(r.Governance.Violations) != 0 {
		t.Errorf("unexpected violations: %v", r.Governance.Violations)
	}
	// The verifier must not appear among the actors that produced the work.
	for _, a := range r.Governance.Actors {
		if a == "agix/worker/verifier-1" {
			t.Errorf("verifier leaked into actor set: %v", r.Governance.Actors)
		}
	}
	if got := r.Governance.Verifiers; len(got) != 1 || got[0] != "agix/worker/verifier-1" {
		t.Errorf("verifiers = %v, want [agix/worker/verifier-1]", got)
	}
	if r.Verdict.State != "approved" {
		t.Errorf("verdict = %q, want approved", r.Verdict.State)
	}
	// tokens summed over the 4 model_calls: in 76+58+58+147+178, out 48+41+41+123+158
	if r.Cost.InputTokens != 517 || r.Cost.OutputTokens != 411 {
		t.Errorf("tokens = in %d out %d, want in 517 out 411", r.Cost.InputTokens, r.Cost.OutputTokens)
	}
	if r.Cost.ModelCalls != 5 {
		t.Errorf("model_calls = %d, want 5", r.Cost.ModelCalls)
	}
	if r.Cost.Bees != 4 { // queen, forager-1, forager-2, verifier-1
		t.Errorf("bees = %d, want 4", r.Cost.Bees)
	}
	if r.Capability != "cheap-classification" {
		t.Errorf("capability = %q, want cheap-classification (from a worker)", r.Capability)
	}
	if r.Task != "review the auth module" {
		t.Errorf("task = %q, want recovered from gate subject", r.Task)
	}
}

func TestReceiptSwarmRejected(t *testing.T) {
	c := newClk()
	r := oneReceipt(t, swarmRun(c, "run-9", false))
	if r.Verdict.State != "rejected" {
		t.Errorf("verdict = %q, want rejected", r.Verdict.State)
	}
	// A rejection is still a governed, distinct ratification.
	if r.Governance.Status != "distinct" {
		t.Errorf("governance = %q, want distinct", r.Governance.Status)
	}
}

func TestReceiptViolationActorEqualsVerifier(t *testing.T) {
	c := newClk()
	// A verifier that ALSO produced work (agent_done) — the governance violation.
	entries := []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock"}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": "st-1", "capability": "cheap"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-0001", "scope": []any{"agix/swarm/run-bad/subtask/st-1"}}),
		c.ent("model_call", "agix/worker/forager-1", map[string]any{"model": "mock", "input_tokens": 10.0, "output_tokens": 5.0}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
		// forager-1 ratifies ITS OWN work → actor == verifier.
		c.ent("ratify", "agix/worker/forager-1", map[string]any{"approved": true, "by": "agix/worker/forager-1", "gate": "ratify"}),
	}
	r := oneReceipt(t, entries)
	if r.Governance.Status != "violation" || r.Governance.ActorNeqVerifier {
		t.Fatalf("governance = %+v, want violation/false", r.Governance)
	}
	if len(r.Governance.Violations) != 1 || r.Governance.Violations[0] != "agix/worker/forager-1" {
		t.Errorf("violations = %v, want [agix/worker/forager-1]", r.Governance.Violations)
	}
	if len(r.Warnings) == 0 || !strings.Contains(strings.Join(r.Warnings, " "), "actor == verifier") {
		t.Errorf("expected a loud actor==verifier warning, got %v", r.Warnings)
	}
}

func TestReceiptPendingRatification(t *testing.T) {
	c := newClk()
	// A swarm that paused at the gate but was never ratified.
	entries := []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock"}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": "st-1", "capability": "cheap"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-0001", "scope": []any{"agix/swarm/run-pend/subtask/st-1"}}),
		c.ent("model_call", "agix/worker/forager-1", map[string]any{"model": "mock"}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
	}
	r := oneReceipt(t, entries)
	if r.Governance.Status != "pending" {
		t.Errorf("governance = %q, want pending", r.Governance.Status)
	}
	if r.Governance.PendingGates != 1 {
		t.Errorf("pending gates = %d, want 1", r.Governance.PendingGates)
	}
	if r.Verdict.State != "pending" {
		t.Errorf("verdict = %q, want pending", r.Verdict.State)
	}
	if len(r.Governance.Verifiers) != 0 {
		t.Errorf("verifiers = %v, want none", r.Governance.Verifiers)
	}
}

func TestReceiptFlowDistinct(t *testing.T) {
	c := newClk()
	r := oneReceipt(t, flowRun(c, "add a login page", true))
	if r.Kind != "single" {
		t.Errorf("kind = %q, want single", r.Kind)
	}
	if r.Task != "add a login page" {
		t.Errorf("task = %q, want the recorded task", r.Task)
	}
	if r.Governance.Status != "distinct" {
		t.Errorf("governance = %q, want distinct (curator ≠ forager)", r.Governance.Status)
	}
	if r.Verdict.By != "curator-1" {
		t.Errorf("verdict by = %q, want curator-1", r.Verdict.By)
	}
}

func TestReceiptRunNoGate(t *testing.T) {
	c := newClk()
	r := oneReceipt(t, runCmd(c))
	if r.Governance.Status != "none" {
		t.Errorf("governance = %q, want none (no gate)", r.Governance.Status)
	}
	if r.Verdict.State != "none" {
		t.Errorf("verdict = %q, want none", r.Verdict.State)
	}
	if r.Cost.Bees != 1 {
		t.Errorf("bees = %d, want 1", r.Cost.Bees)
	}
}

// ── Stage-1.5: the run bracket makes task/id/kind EXACT ───────────────────────

func TestReceiptBracketSwarmExact(t *testing.T) {
	c := newClk()
	entries := bracketed(c, "run-brk-swarm", "review the auth module", "", "swarm",
		func(c *clk) []ledger.Entry { return swarmRun(c, "run-brk-swarm", true) })
	r := oneReceipt(t, entries)
	if r.Kind != "swarm" {
		t.Errorf("kind = %q, want swarm (from bracket)", r.Kind)
	}
	if r.RunID != "run-brk-swarm" {
		t.Errorf("run id = %q, want run-brk-swarm (from bracket)", r.RunID)
	}
	if r.Task != "review the auth module" {
		t.Errorf("task = %q, want exact bracket task", r.Task)
	}
	// The centerpiece must still compute from the (bracketed) frames.
	if r.Governance.Status != "distinct" || r.Verdict.State != "approved" {
		t.Errorf("governance/verdict = %q/%q, want distinct/approved", r.Governance.Status, r.Verdict.State)
	}
	if r.Cost.Bees != 4 {
		t.Errorf("bees = %d, want 4", r.Cost.Bees)
	}
}

// The case Stage 1 got wrong: `agix agent run` recorded the SYSTEM PROMPT as the
// task. The bracket recovers the raw user task EXACTLY; the heuristic (no bracket)
// still only sees the envelope — asserted side by side as the before/after.
func TestReceiptBracketAgentRunExactTask(t *testing.T) {
	const realTask = "login fails after refactor"
	const envelope = "You are a forensic debugger. You investigate a failure signal and identify its ROOT CAUSE. You do NOT write fixes. [system prompt continues...]"

	// BEFORE: no bracket → the heuristic can only surface the system-prompt envelope.
	cH := newClk()
	before := reconstructHeuristic(agentRunInner(cH, envelope))
	if len(before) != 1 {
		t.Fatalf("heuristic: expected 1 run, got %d", len(before))
	}
	if before[0].Task != envelope {
		t.Fatalf("precondition: heuristic should surface the envelope as the task, got %q", before[0].Task)
	}

	// AFTER: the bracket carries the raw task → exact recovery.
	c := newClk()
	entries := bracketed(c, "run-agent", realTask, "", "single",
		func(c *clk) []ledger.Entry { return agentRunInner(c, envelope) })
	r := oneReceipt(t, entries)
	if r.Task != realTask {
		t.Errorf("task = %q, want %q (the raw user task, NOT the system prompt)", r.Task, realTask)
	}
	if strings.Contains(r.Task, "forensic debugger") {
		t.Errorf("task still leaks the system prompt: %q", r.Task)
	}
	if r.Kind != "single" {
		t.Errorf("kind = %q, want single (from bracket)", r.Kind)
	}
	if r.RunID != "run-agent" {
		t.Errorf("run id = %q, want run-agent (from bracket)", r.RunID)
	}
	// Governance still computes: distinct verifier ratified.
	if r.Governance.Status != "distinct" {
		t.Errorf("governance = %q, want distinct", r.Governance.Status)
	}
}

func TestReceiptBracketFlowExact(t *testing.T) {
	c := newClk()
	entries := bracketed(c, "run-flow-7", "ship a login page", "", "flow",
		func(c *clk) []ledger.Entry { return flowRun(c, "ship a login page", true) })
	r := oneReceipt(t, entries)
	if r.Kind != "flow" {
		t.Errorf("kind = %q, want flow (from bracket — the heuristic would say single)", r.Kind)
	}
	if r.Task != "ship a login page" {
		t.Errorf("task = %q, want exact bracket task", r.Task)
	}
	if r.RunID != "run-flow-7" {
		t.Errorf("run id = %q, want run-flow-7", r.RunID)
	}
	if r.Verdict.By != "curator-1" {
		t.Errorf("verdict by = %q, want curator-1", r.Verdict.By)
	}
}

// A run path that records its task in agent_start (the plain `run` bracket carries
// the real prompt, which the agent's agent_start does NOT — it logs "cli-task").
func TestReceiptBracketSingleRunExactTask(t *testing.T) {
	c := newClk()
	entries := bracketed(c, "run-plain", "summarize the changelog", "default-quality", "single",
		func(c *clk) []ledger.Entry { return runCmd(c) })
	r := oneReceipt(t, entries)
	if r.Task != "summarize the changelog" {
		t.Errorf("task = %q, want the bracket task (not the agent_start 'cli-task')", r.Task)
	}
	if r.Capability != "default-quality" {
		t.Errorf("capability = %q, want default-quality (from bracket)", r.Capability)
	}
	if r.RunID != "run-plain" {
		t.Errorf("run id = %q, want run-plain", r.RunID)
	}
}

// Backward compat: a pre-bracket ledger (no run_start anywhere) still renders via
// the heuristic fallback, producing a sane receipt.
func TestReceiptBracketBackwardCompatNoBracket(t *testing.T) {
	c := newClk()
	r := oneReceipt(t, swarmRun(c, "legacy-run", true))
	if r.RunID != "legacy-run" {
		t.Errorf("legacy run id = %q, want legacy-run (heuristic from scope)", r.RunID)
	}
	if r.Task != "review the auth module" {
		t.Errorf("legacy task = %q, want the gate-scraped task (heuristic fallback)", r.Task)
	}
	if r.Governance.Status != "distinct" {
		t.Errorf("legacy governance = %q, want distinct", r.Governance.Status)
	}
}

// Two bracketed runs with distinct run_ids → two clean receipts, grouped on the
// bracket run_id, with no cross-run bee bleed.
func TestReceiptBracketGroupingTwoRuns(t *testing.T) {
	c := newClk()
	var all []ledger.Entry
	all = append(all, bracketed(c, "run-one", "first task", "", "swarm",
		func(c *clk) []ledger.Entry { return swarmRun(c, "run-one", true) })...)
	all = append(all, bracketed(c, "run-two", "second task", "", "single",
		func(c *clk) []ledger.Entry { return agentRunInner(c, "a system prompt") })...)

	rs := reconstruct(all)
	if len(rs) != 2 {
		t.Fatalf("expected 2 bracketed runs, got %d", len(rs))
	}
	byID := map[string]*Receipt{}
	for _, r := range rs {
		byID[r.RunID] = r
	}
	if byID["run-one"] == nil || byID["run-two"] == nil {
		t.Fatalf("runs not keyed on bracket run_id: %v", byID)
	}
	if byID["run-one"].Task != "first task" || byID["run-two"].Task != "second task" {
		t.Errorf("tasks crossed: %q / %q", byID["run-one"].Task, byID["run-two"].Task)
	}
	if byID["run-one"].Cost.Bees != 4 {
		t.Errorf("run-one bees = %d, want 4 (no bleed)", byID["run-one"].Cost.Bees)
	}
}

// Genuinely interleaved swarm runs: their entries carry distinct swarm scopes, so
// scope-based routing separates them even though their brackets overlap.
func TestReceiptBracketInterleavedByScope(t *testing.T) {
	c := newClk()
	scope := func(run, st string) []any { return []any{"agix/swarm/" + run + "/subtask/" + st} }
	entries := []ledger.Entry{
		c.ent(ledger.KindRunStart, "", map[string]any{"run_id": "run-P", "task": "task P", "kind": "swarm"}),
		c.ent(ledger.KindRunStart, "", map[string]any{"run_id": "run-Q", "task": "task Q", "kind": "swarm"}),
		// interleaved, each frame scoped to its own run
		c.ent("agent_start", "agix/worker/p1", map[string]any{"task": "st-1", "capability": "cheap"}),
		c.ent("lease_claim", "agix/worker/p1", map[string]any{"lease": "lp1", "scope": scope("run-P", "st-1")}),
		c.ent("agent_start", "agix/worker/q1", map[string]any{"task": "st-1", "capability": "cheap"}),
		c.ent("lease_claim", "agix/worker/q1", map[string]any{"lease": "lq1", "scope": scope("run-Q", "st-1")}),
		c.ent("model_call", "agix/worker/p1", map[string]any{"model": "mock", "scope": scope("run-P", "st-1"), "input_tokens": 10.0}),
		c.ent("model_call", "agix/worker/q1", map[string]any{"model": "mock", "scope": scope("run-Q", "st-1"), "input_tokens": 20.0}),
		c.ent(ledger.KindRunDone, "", map[string]any{"run_id": "run-P", "ok": true}),
		c.ent(ledger.KindRunDone, "", map[string]any{"run_id": "run-Q", "ok": true}),
	}
	rs := reconstruct(entries)
	if len(rs) != 2 {
		t.Fatalf("expected 2 interleaved runs, got %d", len(rs))
	}
	byID := map[string]*Receipt{}
	for _, r := range rs {
		byID[r.RunID] = r
	}
	if byID["run-P"] == nil || byID["run-Q"] == nil {
		t.Fatalf("interleaved runs not separated by scope: %v", byID)
	}
	// Each run kept exactly its own worker bee — no cross-attribution.
	if b := byID["run-P"].Cost.Bees; b != 1 {
		t.Errorf("run-P bees = %d, want 1 (only p1)", b)
	}
	if byID["run-P"].Task != "task P" || byID["run-Q"].Task != "task Q" {
		t.Errorf("interleaved tasks crossed: %q / %q", byID["run-P"].Task, byID["run-Q"].Task)
	}
}

// A mixed ledger — a legacy (pre-bracket) run followed by a bracketed run — still
// renders both: the bracketed via its bracket, the legacy via the heuristic.
func TestReceiptBracketMixedLegacyAndBracketed(t *testing.T) {
	c := newClk()
	var all []ledger.Entry
	all = append(all, runCmd(c)...) // legacy, no bracket
	all = append(all, bracketed(c, "run-new", "the new task", "", "swarm",
		func(c *clk) []ledger.Entry { return swarmRun(c, "run-new", true) })...)

	rs := reconstruct(all)
	if len(rs) != 2 {
		t.Fatalf("expected 2 runs (1 legacy + 1 bracketed), got %d", len(rs))
	}
	var sawBracketed, sawLegacy bool
	for _, r := range rs {
		switch r.RunID {
		case "run-new":
			sawBracketed = true
			if r.Task != "the new task" {
				t.Errorf("bracketed task = %q, want the new task", r.Task)
			}
		default:
			sawLegacy = true // the legacy run keeps its heuristic handle
		}
	}
	if !sawBracketed || !sawLegacy {
		t.Errorf("mixed ledger dropped a run: bracketed=%v legacy=%v", sawBracketed, sawLegacy)
	}
}

// ── run grouping / segmentation ──────────────────────────────────────────────

func TestReceiptMultiRunGrouping(t *testing.T) {
	c := newClk()
	var all []ledger.Entry
	all = append(all, swarmRun(c, "run-A", true)...)
	all = append(all, flowRun(c, "reject this", false)...)
	all = append(all, runCmd(c)...)
	all = append(all, swarmRun(c, "run-B", true)...)

	rs := reconstruct(all)
	if len(rs) != 4 {
		t.Fatalf("expected 4 distinct runs, got %d", len(rs))
	}
	// Verify the two swarm runs are grouped under their distinct run ids and the
	// flow/run paths did not bleed into them.
	ids := map[string]string{} // runID -> kind
	for _, r := range rs {
		ids[r.RunID] = r.Kind
	}
	if ids["run-A"] != "swarm" || ids["run-B"] != "swarm" {
		t.Errorf("swarm runs not grouped by run id: %v", ids)
	}
	// Each swarm run has exactly its own 4 bees (no cross-run bleed).
	for _, r := range rs {
		if r.Kind == "swarm" && r.Cost.Bees != 4 {
			t.Errorf("swarm %s bees = %d, want 4 (cross-run bleed?)", r.RunID, r.Cost.Bees)
		}
	}
}

func TestFindReceiptByLeaseAndRunID(t *testing.T) {
	c := newClk()
	rs := reconstruct(swarmRun(c, "run-XYZ", true))
	if got := findReceipt(rs, "run-XYZ"); got == nil {
		t.Error("lookup by swarm run id failed")
	}
	if got := findReceipt(rs, "lease-0002"); got == nil {
		t.Error("lookup by lease id failed")
	}
	if got := findReceipt(rs, "run-X"); got == nil {
		t.Error("prefix lookup failed")
	}
	if got := findReceipt(rs, "nope"); got != nil {
		t.Error("expected no match for a bogus id")
	}
}

// ── edge cases ───────────────────────────────────────────────────────────────

func TestReconstructEmpty(t *testing.T) {
	if rs := reconstruct(nil); len(rs) != 0 {
		t.Errorf("empty ledger reconstructed %d runs, want 0", len(rs))
	}
}

func TestReconstructCorruptLineSkipped(t *testing.T) {
	c := newClk()
	path := writeLedger(t, runCmd(c), "{ this is not valid json", "")
	led, err := ledger.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := led.Read("", time.Time{})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	rs := reconstruct(entries)
	if len(rs) != 1 {
		t.Fatalf("corrupt/blank lines should be skipped, got %d runs", len(rs))
	}
}

// ── CLI surface ──────────────────────────────────────────────────────────────

func TestCmdArtifactsMissingLedger(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.jsonl")
	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--ledger", missing})
	})
	if code != 0 {
		t.Errorf("exit = %d, want 0 (friendly)", code)
	}
	if !strings.Contains(out, "no ledger yet") {
		t.Errorf("want a friendly no-ledger message, got:\n%s", out)
	}
}

func TestCmdArtifactsDefaultReceipt(t *testing.T) {
	c := newClk()
	path := writeLedger(t, swarmRun(c, "run-CLI", true))
	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--ledger", path})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0; out:\n%s", code, out)
	}
	for _, want := range []string{"GOVERNANCE RECEIPT", "actor ≠ verifier", "DISTINCT", "APPROVED", "run-CLI", "review the auth module", "timeline"} {
		if !strings.Contains(out, want) {
			t.Errorf("receipt missing %q; out:\n%s", want, out)
		}
	}
}

func TestCmdArtifactsViolationRendersLoudly(t *testing.T) {
	c := newClk()
	entries := []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock"}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": "st-1"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-0001", "scope": []any{"agix/swarm/run-v/subtask/st-1"}}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
		c.ent("ratify", "agix/worker/forager-1", map[string]any{"approved": true, "by": "agix/worker/forager-1"}),
	}
	path := writeLedger(t, entries)
	out, _ := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--ledger", path})
	})
	if !strings.Contains(out, "VIOLATION") {
		t.Errorf("violation not surfaced; out:\n%s", out)
	}
}

func TestCmdArtifactsList(t *testing.T) {
	c := newClk()
	var all []ledger.Entry
	all = append(all, swarmRun(c, "run-list-A", true)...)
	all = append(all, flowRun(c, "second task", false)...)
	path := writeLedger(t, all)
	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--list", "--ledger", path})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if !strings.Contains(out, "GOVERNANCE RECEIPTS") || !strings.Contains(out, "(2 runs)") {
		t.Errorf("list header wrong; out:\n%s", out)
	}
	// newest first: the flow run (added later) precedes the swarm run.
	iFlow := strings.Index(out, "second task")
	iSwarm := strings.Index(out, "run-list-A")
	if iFlow < 0 || iSwarm < 0 || iFlow > iSwarm {
		t.Errorf("list not newest-first; out:\n%s", out)
	}
}

func TestCmdArtifactsJSONShape(t *testing.T) {
	c := newClk()
	path := writeLedger(t, swarmRun(c, "run-json", true))
	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--json", "--ledger", path})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	var r Receipt
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("--json output is not a valid Receipt: %v\n%s", err, out)
	}
	if r.RunID != "run-json" {
		t.Errorf("json run_id = %q, want run-json", r.RunID)
	}
	if !r.Governance.ActorNeqVerifier {
		t.Errorf("json governance.actor_neq_verifier = false, want true")
	}
	if r.Verdict.State != "approved" {
		t.Errorf("json verdict.state = %q, want approved", r.Verdict.State)
	}
	if len(r.Timeline) == 0 {
		t.Errorf("json timeline is empty")
	}
}

func TestCmdArtifactsJSONListIsArray(t *testing.T) {
	c := newClk()
	var all []ledger.Entry
	all = append(all, swarmRun(c, "run-1", true)...)
	all = append(all, runCmd(c)...)
	path := writeLedger(t, all)
	out, _ := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--list", "--json", "--ledger", path})
	})
	var rs []Receipt
	if err := json.Unmarshal([]byte(out), &rs); err != nil {
		t.Fatalf("--list --json is not a Receipt array: %v\n%s", err, out)
	}
	if len(rs) != 2 {
		t.Errorf("json list has %d receipts, want 2", len(rs))
	}
}

func TestCmdArtifactsUnknownRun(t *testing.T) {
	c := newClk()
	path := writeLedger(t, runCmd(c))
	_, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"does-not-exist", "--ledger", path})
	})
	if code != 1 {
		t.Errorf("exit = %d, want 1 for an unknown run id", code)
	}
}
