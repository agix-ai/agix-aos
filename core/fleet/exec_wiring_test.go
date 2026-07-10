package fleet_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/secrets"
)

// fleetFakeVault is an in-memory SourcedResolver for the guard-bee wiring tests —
// no keychain, no network — that records how many times it was resolved so a test
// can assert a denied grant NEVER touches the store.
type fleetFakeVault struct {
	vals  map[secrets.Ref]string
	calls int
}

func (f *fleetFakeVault) Resolve(_ context.Context, ref secrets.Ref) (string, error) {
	f.calls++
	if v, ok := f.vals[ref]; ok {
		return v, nil
	}
	return "", errors.New("no such secret")
}
func (f *fleetFakeVault) Source() string { return "fake" }

// A spec that declares the `exec` capability resolves it to the LIVE governed exec
// tool (not reported unresolved), and the tool is the real one: the mock provider
// invokes it with empty args, the governed tool REFUSES an empty command, and the
// refusal is audited to the ledger (tool="exec", ok=false). This proves the runner
// wired a declared exec into a real, fail-closed capability the worker actually
// invoked under the actor≠verifier swarm.
func TestExecCapabilityResolvesAndIsGoverned(t *testing.T) {
	led := newLedger(t)
	r := fleet.New()
	r.Ledger = led
	r.RepoRoot = t.TempDir()

	spec := proposerSpec()
	spec.Tools = []string{"exec"}
	spec.Boundary = agentspec.Boundary{
		Secrets: []string{"anthropic-api-key"},
		Exec:    []string{"go version"},
		Deny:    []string{"git push"},
	}
	spec.Models.Workers = 1

	res, err := r.Run(context.Background(), spec, "run the tests")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Tools) != 1 || res.Tools[0] != "exec" {
		t.Fatalf("Tools = %v, want [exec] resolved", res.Tools)
	}
	if len(res.UnresolvedTools) != 0 {
		t.Errorf("UnresolvedTools = %v, want none (exec is a governed built-in)", res.UnresolvedTools)
	}
	if !res.Result.Verified {
		t.Error("exec-enabled run should still be governed/verified")
	}

	// The worker invoked exec (with the mock's empty {} args); the governed tool
	// refused the empty command and the refusal was audited.
	tc, err := led.Read(ledger.KindToolCall, time.Time{})
	if err != nil {
		t.Fatalf("Read(tool_call): %v", err)
	}
	if len(tc) != 1 {
		t.Fatalf("tool_call entries = %d, want 1", len(tc))
	}
	if tc[0].Data["tool"] != "exec" {
		t.Errorf("tool_call tool = %v, want exec", tc[0].Data["tool"])
	}
	if ok, _ := tc[0].Data["ok"].(bool); ok {
		t.Errorf("empty-command exec should be refused (ok=false), entry = %+v", tc[0].Data)
	}
}

// The credentialed exec path is gated at the boundary: a spec declaring an exec_env
// grant for gh-token is DENIED that secret when the deployment policy does not grant
// it (deny-by-default), and the denial is audited value-free.
func TestExecEnvGrantGatedByPolicy(t *testing.T) {
	r := fleet.New()
	r.RepoRoot = t.TempDir()
	r.Vault = &fleetFakeVault{vals: map[secrets.Ref]string{"gh-token": "ghp_FAKEyTOKEN0123456789abcd"}} // # public-clean: ok synthetic vault value (grant-gating test; not a real secret)
	r.Policy = secrets.Policy{}                                                                         // grants nothing → deny-by-default

	spec := ciWardenLikeSpec()
	res, err := r.Run(context.Background(), spec, "audit CI cost")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	// gh-token is declared but the deployment policy denies it.
	var ghDecision *fleet.GrantDecision
	for i := range res.Boundary {
		if res.Boundary[i].Ref == "gh-token" {
			ghDecision = &res.Boundary[i]
		}
	}
	if ghDecision == nil {
		t.Fatal("no boundary decision recorded for gh-token")
	}
	if ghDecision.Allowed {
		t.Errorf("gh-token should be DENIED under an empty deployment policy, got %+v", *ghDecision)
	}
	if r.Vault.(*fleetFakeVault).calls != 0 {
		t.Errorf("the vault was resolved %d times for a denied grant; must be 0", r.Vault.(*fleetFakeVault).calls)
	}
}

// ciWardenLikeSpec mirrors the ci-warden port: an exec allowlist for read-only gh
// plus an exec_env grant mapping GH_TOKEN to the gh-token secret ref.
func ciWardenLikeSpec() *agentspec.Spec {
	return &agentspec.Spec{
		Name:         "ci-warden",
		Role:         "ci-warden",
		Trust:        agentspec.TrustProposer,
		Public:       true,
		Instructions: "audit CI cost; never edit workflows.",
		Tools:        []string{"read", "exec"},
		Models:       agentspec.ModelTiers{Workers: 1},
		Boundary: agentspec.Boundary{
			Secrets: []string{"anthropic-api-key", "gh-token"},
			Exec:    []string{"gh run list", "gh api"},
			Deny:    []string{"gh workflow run", "gh pr merge", "git push"},
			ExecEnv: map[string]string{"GH_TOKEN": "gh-token"},
		},
	}
}
