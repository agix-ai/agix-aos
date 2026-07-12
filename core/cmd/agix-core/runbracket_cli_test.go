package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/ledger"
)

// readRunStarts loads the .agix/ledger.jsonl written under the current working
// directory and returns every run_start entry — the CLI-level proof the bracket
// was emitted with the exact task.
func readRunStarts(t *testing.T) []ledger.Entry {
	t.Helper()
	led, err := ledger.Open(ledgerPath)
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	entries, err := led.Read(ledger.KindRunStart, time.Time{})
	if err != nil {
		t.Fatalf("read ledger: %v", err)
	}
	return entries
}

func taskOf(e ledger.Entry) string {
	if v, ok := e.Data["task"].(string); ok {
		return v
	}
	return ""
}

// The `hive` path writes a run_start carrying the ORIGINAL task and kind "swarm".
func TestHiveCLIEmitsRunStart(t *testing.T) {
	t.Setenv("AGIX_RUN_ID", "") // outermost: own the bracket + clean up the env mutation
	t.Chdir(t.TempDir())
	const task = "review the auth module"
	if code := RunHiveCLI([]string{task, "--provider", "mock", "--workers", "2"}); code != 0 {
		t.Fatalf("hive exit = %d, want 0", code)
	}
	starts := readRunStarts(t)
	if len(starts) != 1 {
		t.Fatalf("want exactly 1 run_start, got %d", len(starts))
	}
	if got := taskOf(starts[0]); got != task {
		t.Errorf("run_start task = %q, want %q", got, task)
	}
	if k, _ := starts[0].Data["kind"].(string); k != "swarm" {
		t.Errorf("run_start kind = %q, want swarm", k)
	}
	if id, _ := starts[0].Data["run_id"].(string); id == "" {
		t.Error("run_start carries no run_id")
	}
}

// The `agent run` path — the case Stage 1 got wrong — writes a run_start carrying
// the RAW user task, not the agent's system-prompt envelope.
func TestAgentRunCLIEmitsRunStartWithRealTask(t *testing.T) {
	t.Setenv("AGIX_RUN_ID", "") // outermost: own the bracket + clean up the env mutation
	dir := t.TempDir()
	t.Chdir(dir)
	writeProbeAgent(t, dir)

	const task = "login fails after refactor"
	// --engine forces the declarative governed path (no Bun delegation), which is
	// what the callback and the offline default both hit.
	code := cmdAgentRun([]string{"probe", task, "--dir", filepath.Join(dir, "agents"), "--provider", "mock", "--engine"})
	if code != 0 {
		t.Fatalf("agent run exit = %d, want 0", code)
	}
	starts := readRunStarts(t)
	if len(starts) != 1 {
		t.Fatalf("want exactly 1 run_start, got %d", len(starts))
	}
	if got := taskOf(starts[0]); got != task {
		t.Errorf("run_start task = %q, want the raw user task %q (not the system prompt)", got, task)
	}
	if k, _ := starts[0].Data["kind"].(string); k != "single" {
		t.Errorf("run_start kind = %q, want single", k)
	}
}

// A NESTED sub-invocation (AGIX_RUN_ID already set, as the Bun runner's agix-core
// grandchild inherits it) must NOT emit its own bracket — the outermost process
// already owns exactly one. This is the double-bracket guard the whole fix turns on.
func TestAgentRunNestedInvocationSkipsBracket(t *testing.T) {
	t.Setenv("AGIX_RUN_ID", "run-outer-preset") // pretend a parent already opened the bracket
	dir := t.TempDir()
	t.Chdir(dir)
	writeProbeAgent(t, dir)

	code := cmdAgentRun([]string{"probe", "some rendered task template", "--dir", filepath.Join(dir, "agents"), "--provider", "mock", "--engine"})
	if code != 0 {
		t.Fatalf("agent run (nested) exit = %d, want 0", code)
	}
	if starts := readRunStarts(t); len(starts) != 0 {
		t.Fatalf("nested invocation emitted %d run_start(s), want 0 (the parent owns the bracket)", len(starts))
	}
}

// runBracketOwner: the outermost process mints an id, owns the bracket, and
// publishes AGIX_RUN_ID so children see themselves as nested and skip it.
func TestRunBracketOwnerOutermostThenNested(t *testing.T) {
	t.Setenv("AGIX_RUN_ID", "")

	id, owner := runBracketOwner()
	if !owner {
		t.Fatal("first call (no AGIX_RUN_ID) must be the owner")
	}
	if id == "" {
		t.Fatal("owner must mint a non-empty run id")
	}
	if got := os.Getenv("AGIX_RUN_ID"); got != id {
		t.Fatalf("owner must publish AGIX_RUN_ID=%q for children to inherit, got %q", id, got)
	}

	// A "child" process now inheriting the env is nested and must not own.
	id2, owner2 := runBracketOwner()
	if owner2 {
		t.Fatal("second call (AGIX_RUN_ID set) must be nested, not the owner")
	}
	if id2 != id {
		t.Fatalf("nested call must return the inherited id %q, got %q", id, id2)
	}
}

// writeProbeAgent drops a minimal valid, public, agent.ts-free spec so `agent run`
// takes the declarative governed path on the mock provider (offline, $0).
func writeProbeAgent(t *testing.T, root string) {
	t.Helper()
	specDir := filepath.Join(root, "agents", "probe")
	if err := os.MkdirAll(specDir, 0o755); err != nil {
		t.Fatalf("mkdir spec: %v", err)
	}
	const spec = `{
  "name": "probe",
  "display_name": "Probe",
  "description": "A minimal test agent.",
  "tier": "basic",
  "public": true,
  "role": "investigator",
  "trust": "proposer",
  "instructions": "You investigate a signal and report the most-supported root cause, ranked, using only evidence in the signal."
}`
	if err := os.WriteFile(filepath.Join(specDir, "agent.json"), []byte(spec), 0o644); err != nil {
		t.Fatalf("write spec: %v", err)
	}
}
