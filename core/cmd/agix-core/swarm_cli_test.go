package main

import (
	"encoding/json"
	"io"
	"os"
	"testing"
)

// captureStdout redirects os.Stdout for the duration of fn and returns whatever
// fn wrote plus its exit code.
func captureStdout(t *testing.T, fn func() int) (string, int) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	code := fn()
	_ = w.Close()
	os.Stdout = orig

	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	return string(out), code
}

// TestRunSwarmCLIFirstLightJSON drives RunSwarmCLI directly (main.go stays
// untouched) and asserts the emitted stdout is exactly the frozen agix.swarm.v1
// contract, at $0, verified, with all five bees.
func TestRunSwarmCLIFirstLightJSON(t *testing.T) {
	// Outermost run: no inherited AGIX_RUN_ID, so this process owns the bracket.
	// t.Setenv also cleans up the os.Setenv runBracketOwner performs, so the id does
	// not leak into sibling tests in this process.
	t.Setenv("AGIX_RUN_ID", "")
	// Run from a temp dir so the .agix/ledger.jsonl lands there, not in the repo.
	dir := t.TempDir()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}
	defer func() { _ = os.Chdir(orig) }()

	out, code := captureStdout(t, func() int {
		return RunSwarmCLI([]string{"--task", "add a login page", "--provider", "mock", "--workers", "2", "--json"})
	})
	if code != 0 {
		t.Fatalf("RunSwarmCLI exit code = %d, want 0; output:\n%s", code, out)
	}

	var got swarmJSON
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("stdout is not valid agix.swarm.v1 JSON: %v\noutput:\n%s", err, out)
	}

	if got.Schema != "agix.swarm.v1" {
		t.Errorf("schema = %q, want agix.swarm.v1", got.Schema)
	}
	if got.Cost.USD != 0 {
		t.Errorf("cost.usd = %v, want 0 (mock provider)", got.Cost.USD)
	}
	if !got.Verified {
		t.Errorf("verified = %v, want true", got.Verified)
	}
	if got.Verdict.By != "agix/worker/verifier-1" {
		t.Errorf("verdict.by = %q, want agix/worker/verifier-1", got.Verdict.By)
	}
	if len(got.Bees) != 5 {
		t.Fatalf("len(bees) = %d, want 5 (queen-decompose + 2 workers + queen-synth + verifier)", len(got.Bees))
	}
	// The first bee is the Queen's decompose; the last is the verifier.
	if got.Bees[0].Role != "queen" || got.Bees[0].Phase != "decompose" {
		t.Errorf("bees[0] = %s/%s, want queen/decompose", got.Bees[0].Role, got.Bees[0].Phase)
	}
	if last := got.Bees[len(got.Bees)-1]; last.Actor != "agix/worker/verifier-1" || last.Role != "verifier" {
		t.Errorf("last bee = %s (%s), want agix/worker/verifier-1 (verifier)", last.Actor, last.Role)
	}
	if got.Config.Provider != "mock" || got.Config.Workers != 2 || got.Config.KM || got.Config.Subtasks != 2 {
		t.Errorf("config = %+v, want {provider:mock workers:2 km:false subtasks:2}", got.Config)
	}
}

func TestRunSwarmCLINeedsTask(t *testing.T) {
	if code := RunSwarmCLI([]string{"--provider", "mock"}); code != 2 {
		t.Errorf("RunSwarmCLI with no task exit = %d, want 2", code)
	}
}
