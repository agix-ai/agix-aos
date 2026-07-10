package fleet_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/ledger"
)

// A governed run whose spec declares the ported filesystem + metric tools resolves
// them all to LIVE, boundary-scoped impls, drives the tool-use loop on every worker
// (the mock provider calls the first offered tool — glob — which tolerates {} args),
// and audits each execution to the ledger. This is criterion (a) end-to-end: the
// declared tools became real capabilities a worker actually invoked under the
// actor≠verifier swarm, scoped to the sidecar RepoRoot.
func TestGovernedFilesystemToolsResolveAndRun(t *testing.T) {
	root := t.TempDir()
	must := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("main.go", "package main\n\nfunc main() {}\n")
	must("sub/lib.go", "package sub\n\nfunc Help() {}\n")

	led := newLedger(t)
	r := fleet.New()
	r.Ledger = led
	r.RepoRoot = root // the sidecar seam scopes the fs/metric tools here

	spec := proposerSpec()
	spec.Tools = []string{"glob", "read", "write", "metric"} // glob first → mock invokes it
	spec.Models.Workers = 2

	res, err := r.Run(context.Background(), spec, "survey the repository")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Every declared filesystem/metric tool resolves to a live impl; none unported.
	want := []string{"glob", "read", "write", "metric"}
	if len(res.Tools) != len(want) {
		t.Fatalf("Tools = %v, want %v", res.Tools, want)
	}
	for i := range want {
		if res.Tools[i] != want[i] {
			t.Errorf("Tools[%d] = %q, want %q", i, res.Tools[i], want[i])
		}
	}
	if len(res.UnresolvedTools) != 0 {
		t.Errorf("UnresolvedTools = %v, want none", res.UnresolvedTools)
	}

	// Still governed: distinct verifier, verified, $0.
	if !res.Result.Verified {
		t.Error("tool-enabled governed run should still be verified")
	}
	if res.QueenActor == res.VerifierActor {
		t.Fatalf("actor≠verifier violated: %q", res.QueenActor)
	}
	if res.Result.Cost.USD != 0 {
		t.Errorf("mock run must be $0, got %v", res.Result.Cost.USD)
	}

	// Each of the 2 workers invoked glob once, and each execution SUCCEEDED (a real
	// listing was produced and threaded) — audited to the ledger.
	tc, err := led.Read(ledger.KindToolCall, time.Time{})
	if err != nil {
		t.Fatalf("Read(tool_call): %v", err)
	}
	if len(tc) != 2 {
		t.Fatalf("tool_call entries = %d, want 2 (one per worker)", len(tc))
	}
	for _, e := range tc {
		if e.Data["tool"] != "glob" {
			t.Errorf("tool_call tool = %v, want glob", e.Data["tool"])
		}
		if ok, _ := e.Data["ok"].(bool); !ok {
			t.Errorf("glob execution should have succeeded, entry = %+v", e.Data)
		}
	}
}

// The built-in tools honor the agent's boundary through the governed runner: a spec
// with no write allowlist runs fine (write is deny-by-default and simply refuses if
// called), and read is scoped to RepoRoot regardless of what the model asks for.
// Here we assert the resolver threads the spec's boundary into the tools by checking
// a read-boundaried spec still resolves + runs governed.
func TestGovernedRunHonorsRepoRootScoping(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "only.go"), []byte("package only\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := fleet.New()
	r.Ledger = newLedger(t)
	r.RepoRoot = root

	spec := proposerSpec()
	spec.Tools = []string{"walk"}
	spec.Boundary = agentspec.Boundary{Read: []string{"."}, Secrets: []string{"anthropic-api-key"}}

	res, err := r.Run(context.Background(), spec, "list the tree")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Tools) != 1 || res.Tools[0] != "walk" {
		t.Errorf("Tools = %v, want [walk]", res.Tools)
	}
	if !res.Result.Verified {
		t.Error("run should be governed/verified")
	}
}
