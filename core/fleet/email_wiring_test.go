package fleet_test

import (
	"context"
	"testing"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/secrets"
	emailtool "github.com/agix-ai/agix/core/tool/email"
)

// A spec that declares the `email`/`notify` capability resolves it to the LIVE
// governed email tool (not reported unresolved), and it is the real one: with no
// deployment Mailer wired it is the $0 dry-run recorder. This proves the runner
// wired a declared email/notify into a real, fail-closed capability the worker can
// invoke under the actor≠verifier swarm — mirroring the exec wiring test.
func TestEmailCapabilityResolvesAndIsGoverned(t *testing.T) {
	r := fleet.New()
	r.Ledger = newLedger(t)
	r.RepoRoot = t.TempDir()

	spec := secretaryLikeSpec()
	res, err := r.Run(context.Background(), spec, "email the operator a digest")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !contains(res.Tools, "email") {
		t.Fatalf("Tools = %v, want email resolved", res.Tools)
	}
	if contains(res.UnresolvedTools, "email") || contains(res.UnresolvedTools, "notify") {
		t.Errorf("UnresolvedTools = %v, want email/notify resolved as governed built-ins", res.UnresolvedTools)
	}
	if !res.Result.Verified {
		t.Error("email-enabled run should still be governed/verified")
	}
}

// The credentialed email path is gated at the boundary exactly like exec: a spec
// declaring an SMTP credential ref is DENIED that secret when the deployment policy
// does not grant it (deny-by-default), and the denial is audited value-free. The
// live transport is a credentialed SenderFunc; a denied grant means the vault is
// never touched and the transport is never invoked with a raw key.
func TestEmailGrantGatedByPolicy(t *testing.T) {
	r := fleet.New()
	r.RepoRoot = t.TempDir()
	r.Vault = &fleetFakeVault{vals: map[secrets.Ref]string{"smtp-app-password": "ghp_FAKEyTOKEN0123456789abcd"}} // # public-clean: ok synthetic vault value (grant-gating test; not a real secret)
	r.Policy = secrets.Policy{}                                                                                  // grants nothing → deny-by-default

	var invoked bool
	r.Mailer = emailtool.SenderFunc{
		Transport:    "smtp",
		Credentialed: true,
		Fn: func(_ context.Context, _ emailtool.Message, _ map[string]string) (emailtool.Result, error) {
			invoked = true
			return emailtool.Result{Sent: true}, nil
		},
	}

	spec := secretaryLikeSpec()
	res, err := r.Run(context.Background(), spec, "email a digest")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// smtp-app-password is declared but the deployment policy denies it.
	var d *fleet.GrantDecision
	for i := range res.Boundary {
		if res.Boundary[i].Ref == "smtp-app-password" {
			d = &res.Boundary[i]
		}
	}
	if d == nil {
		t.Fatal("no boundary decision recorded for smtp-app-password")
	}
	if d.Allowed {
		t.Errorf("smtp-app-password should be DENIED under an empty deployment policy, got %+v", *d)
	}
	// A denied grant never resolves the vault, and (because the credentialed transport
	// is only invoked with a grant) the live sender is never called with a raw key.
	if r.Vault.(*fleetFakeVault).calls != 0 {
		t.Errorf("the vault was resolved %d times for a denied grant; must be 0", r.Vault.(*fleetFakeVault).calls)
	}
	if invoked {
		t.Error("the credentialed transport was invoked despite a denied grant (must fail closed)")
	}
}

// secretaryLikeSpec mirrors the ported secretary: it declares the email capability
// and an SMTP credential ref in its boundary, plus an email output surface so the
// tool derives the operator as its default recipient.
func secretaryLikeSpec() *agentspec.Spec {
	return &agentspec.Spec{
		Name:         "secretary",
		Role:         "secretary",
		Trust:        agentspec.TrustBoundary,
		Public:       true,
		Instructions: "triage the inbox and email a digest; never send without the human.",
		Tools:        []string{"read", "write", "email"},
		Models:       agentspec.ModelTiers{Workers: 1},
		Boundary: agentspec.Boundary{
			Secrets: []string{"anthropic-api-key", "smtp-app-password", "workspace-gmail"},
			Read:    []string{"wiki/secretary/"},
			Write:   []string{"wiki/secretary/"},
		},
		Outputs: []agentspec.Output{{Kind: "email", Path: "operator"}},
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
