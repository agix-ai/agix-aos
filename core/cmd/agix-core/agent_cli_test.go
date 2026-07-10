package main

import (
	"os"
	"path/filepath"
	"testing"
)

// R4 — the `agent run --repoRoot` live-run safety seam. An empty root legitimately
// defaults to CWD downstream, but a SUPPLIED root that does not resolve to a
// directory must fail loud rather than let the built-in fs/exec/metric tools scope a
// governed write/refactor to the wrong tree.
func TestValidateRepoRoot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "afile")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	t.Run("empty is allowed (defaults to CWD downstream)", func(t *testing.T) {
		if err := validateRepoRoot(""); err != nil {
			t.Fatalf("empty repoRoot should be allowed, got %v", err)
		}
		if err := validateRepoRoot("   "); err != nil {
			t.Fatalf("blank repoRoot should be allowed, got %v", err)
		}
	})

	t.Run("an existing directory is accepted", func(t *testing.T) {
		if err := validateRepoRoot(dir); err != nil {
			t.Fatalf("existing dir should be accepted, got %v", err)
		}
	})

	t.Run("a non-existent path fails loud", func(t *testing.T) {
		if err := validateRepoRoot(filepath.Join(dir, "does-not-exist")); err == nil {
			t.Fatal("non-existent repoRoot must return an error, got nil (would silently fall back to CWD)")
		}
	})

	t.Run("a file (not a directory) fails loud", func(t *testing.T) {
		if err := validateRepoRoot(file); err == nil {
			t.Fatal("a --repoRoot pointing at a file must return an error, got nil")
		}
	})
}

// The `agent run` verb rejects a supplied-but-missing --repoRoot with exit 2 before
// any run — the CLI-level fail-closed path (validateRepoRoot is wired into
// cmdAgentRun). A non-existent dir must never reach the runner.
func TestCmdAgentRunRejectsMissingRepoRoot(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-sidecar")
	code := cmdAgentRun([]string{"tester", "--repoRoot", missing, "some task"})
	if code != 2 {
		t.Fatalf("agent run with a missing --repoRoot: got exit %d, want 2", code)
	}
}
