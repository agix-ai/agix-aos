package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestParseAgentFlagsPassthrough — `agix agent run` must forward agent-specific flags it
// doesn't recognize (pr-reviewer --diff, onboarding --client, swe-solver --task) to the Bun
// behavior instead of rejecting them; known flags stay parsed, positionals stay in rest.
func TestParseAgentFlagsPassthrough(t *testing.T) {
	cases := []struct {
		name      string
		args      []string
		wantRest  []string
		wantExtra []string
	}{
		{"space-value unknown flag", []string{"pr-reviewer", "review this", "--diff", "x.diff"},
			[]string{"pr-reviewer", "review this"}, []string{"--diff", "x.diff"}},
		{"equals-form unknown flag", []string{"onboarding", "audit", "--client=acme"},
			[]string{"onboarding", "audit"}, []string{"--client=acme"}},
		{"boolean-style unknown flag at end", []string{"x", "task", "--verbose"},
			[]string{"x", "task"}, []string{"--verbose"}},
		{"known flags are not collected as extra", []string{"x", "task", "--provider", "mock", "--json"},
			[]string{"x", "task"}, nil},
		{"mix of known and unknown", []string{"x", "t", "--dir", "agents", "--diff", "d", "--json"},
			[]string{"x", "t"}, []string{"--diff", "d"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, err := parseAgentFlags(c.args)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(f.rest, c.wantRest) {
				t.Errorf("rest = %v, want %v", f.rest, c.wantRest)
			}
			if !reflect.DeepEqual(f.extra, c.wantExtra) {
				t.Errorf("extra = %v, want %v", f.extra, c.wantExtra)
			}
		})
	}
}

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
