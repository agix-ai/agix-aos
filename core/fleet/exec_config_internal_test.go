package fleet

import (
	"context"
	"errors"
	"testing"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/secrets"
)

// wbVault is an in-memory SourcedResolver for the white-box execConfig tests.
type wbVault struct{ vals map[secrets.Ref]string }

func (v *wbVault) Resolve(_ context.Context, ref secrets.Ref) (string, error) {
	if s, ok := v.vals[ref]; ok {
		return s, nil
	}
	return "", errors.New("no such secret")
}
func (v *wbVault) Source() string { return "fake" }

// White-box coverage of the runner's guard-bee grant construction (execConfig):
// the exec tool's governance envelope is built straight from the spec's boundary,
// and the secret grant is deny-by-default + least-privilege — a ref becomes a grant
// ONLY when the effective policy allows it AND a vault exists to resolve it.
func TestExecConfigGrantGating(t *testing.T) {
	root := t.TempDir()
	spec := &agentspec.Spec{
		Name:         "ci-warden",
		Role:         "ci-warden",
		Trust:        agentspec.TrustProposer,
		Instructions: "audit",
		Boundary: agentspec.Boundary{
			Secrets: []string{"anthropic-api-key", "gh-token"},
			Exec:    []string{"gh run list"},
			Deny:    []string{"gh workflow run"},
			ExecEnv: map[string]string{"GH_TOKEN": "gh-token"},
		},
	}
	vault := &wbVault{vals: map[secrets.Ref]string{"gh-token": "ghp_FAKEyTOKEN0123456789abcd"}} // # public-clean: ok synthetic vault value (grant-gating test; not a real secret)

	t.Run("allowed ref becomes a grant with a broker wired", func(t *testing.T) {
		r := New()
		r.RepoRoot = root
		r.Vault = vault
		r.Policy = secrets.Policy{"ci-warden": {"gh-token"}} // grants gh-token

		cfg := r.execConfig(spec)
		if cfg.Root != root {
			t.Errorf("cfg.Root = %q, want %q", cfg.Root, root)
		}
		if len(cfg.Allow) != 1 || cfg.Allow[0] != "gh run list" {
			t.Errorf("cfg.Allow = %v, want [gh run list]", cfg.Allow)
		}
		if len(cfg.Deny) != 1 || cfg.Deny[0] != "gh workflow run" {
			t.Errorf("cfg.Deny = %v, want [gh workflow run]", cfg.Deny)
		}
		if got, ok := cfg.Grants["GH_TOKEN"]; !ok || got != "gh-token" {
			t.Errorf("cfg.Grants[GH_TOKEN] = %q (present=%v), want gh-token", got, ok)
		}
		if cfg.Broker == nil {
			t.Error("cfg.Broker should be wired when an authorized grant exists")
		}
	})

	t.Run("denied ref yields no grant and no broker", func(t *testing.T) {
		r := New()
		r.RepoRoot = root
		r.Vault = vault
		r.Policy = secrets.Policy{} // deny-by-default

		cfg := r.execConfig(spec)
		if len(cfg.Grants) != 0 {
			t.Errorf("cfg.Grants = %v, want empty (deny-by-default)", cfg.Grants)
		}
		if cfg.Broker != nil {
			t.Error("cfg.Broker should be nil when no grant is authorized")
		}
	})

	t.Run("no vault yields no broker even when allowed", func(t *testing.T) {
		r := New()
		r.RepoRoot = root
		r.Policy = secrets.Policy{"ci-warden": {"gh-token"}}
		// no Vault set

		cfg := r.execConfig(spec)
		if _, ok := cfg.Grants["GH_TOKEN"]; !ok {
			t.Error("an allowed ref should still be recorded as a grant intent")
		}
		if cfg.Broker != nil {
			t.Error("cfg.Broker must be nil with no vault (the exec tool degrades unauthenticated)")
		}
	})
}
