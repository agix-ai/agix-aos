package fleet_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/secrets"
)

func newLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	l, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	return l
}

// countTool is a $0 tool that tolerates {} args (so the mock provider's tool loop
// drives it) and counts its executions across parallel worker bees.
type countTool struct{ calls int32 }

func (c *countTool) Name() string                 { return "ping" }
func (c *countTool) Description() string          { return "ping the service; returns pong" }
func (c *countTool) InputSchema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (c *countTool) Execute(context.Context, json.RawMessage) (string, error) {
	atomic.AddInt32(&c.calls, 1)
	return "pong", nil
}

// A proposer spec (worker caste) with one declared, un-catalogued tool.
func proposerSpec() *agentspec.Spec {
	return &agentspec.Spec{
		Name:         "investigator",
		DisplayName:  "Agix Investigator",
		Role:         "investigator",
		Trust:        agentspec.TrustProposer,
		Public:       true,
		Instructions: "find the root cause; never patch source.",
		Tools:        []string{"read"},
		Models:       agentspec.ModelTiers{Workers: 1},
		Boundary:     agentspec.Boundary{Secrets: []string{"anthropic-api-key"}},
	}
}

// A governed run of a reference spec certifies through a DISTINCT verifier
// (actor≠verifier), stays $0 on the mock provider, resolves its ported filesystem
// tools to live impls, and reports an un-ported capability without failing.
func TestRunGovernedActorNeVerifier(t *testing.T) {
	r := fleet.New()
	r.Ledger = newLedger(t)

	spec := proposerSpec()
	// read/glob are now ported built-ins; `fire` (the campaign-loop tool) has no
	// reborn impl yet — it must be reported unresolved, not fail the run.
	spec.Tools = []string{"read", "glob", "fire"}

	res, err := r.Run(context.Background(), spec, "the build is red at 0 steps")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Caste != caste.Worker {
		t.Errorf("caste = %q, want worker (proposer)", res.Caste)
	}
	if !res.Result.Verified {
		t.Error("governed run should be verified")
	}
	if res.QueenActor == res.VerifierActor {
		t.Fatalf("actor≠verifier violated: both resolved to %q", res.QueenActor)
	}
	if res.Result.Verdict.By != res.VerifierActor {
		t.Errorf("Verdict.By = %q, want the distinct verifier %q", res.Result.Verdict.By, res.VerifierActor)
	}
	if res.VerifierActor != "investigator/worker/verifier-1" {
		t.Errorf("VerifierActor = %q, want investigator/worker/verifier-1", res.VerifierActor)
	}
	if res.Result.Cost.USD != 0 {
		t.Errorf("mock run must be $0, got %v", res.Result.Cost.USD)
	}
	// The ported filesystem tools resolve to live impls (the whole slice's point).
	if len(res.Tools) != 2 || res.Tools[0] != "read" || res.Tools[1] != "glob" {
		t.Errorf("Tools = %v, want [read glob] resolved", res.Tools)
	}
	// The un-ported capability is reported, not fatal.
	if len(res.UnresolvedTools) != 1 || res.UnresolvedTools[0] != "fire" {
		t.Errorf("UnresolvedTools = %v, want [fire]", res.UnresolvedTools)
	}
}

// When a declared tool resolves against the catalog, the governed run drives the
// tool-use loop on every worker and audits each execution.
func TestRunToolUseGoverned(t *testing.T) {
	led := newLedger(t)
	tool := &countTool{}

	r := fleet.New()
	r.Ledger = led
	r.Register("ping", tool)

	spec := proposerSpec()
	spec.Tools = []string{"ping"}
	spec.Models.Workers = 3

	res, err := r.Run(context.Background(), spec, "check the service")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := atomic.LoadInt32(&tool.calls); got != 3 {
		t.Errorf("ping executed %d times, want 3 (once per worker)", got)
	}
	if len(res.UnresolvedTools) != 0 {
		t.Errorf("UnresolvedTools = %v, want empty (ping is catalogued)", res.UnresolvedTools)
	}
	if len(res.Tools) != 1 || res.Tools[0] != "ping" {
		t.Errorf("Tools = %v, want [ping]", res.Tools)
	}
	if !res.Result.Verified {
		t.Error("tool-enabled run should still be governed/verified")
	}
	tc, err := led.Read(ledger.KindToolCall, time.Time{})
	if err != nil {
		t.Fatalf("Read(tool_call): %v", err)
	}
	if len(tc) != 3 {
		t.Errorf("ledger tool_call entries = %d, want 3", len(tc))
	}
}

// The guard-bee boundary authorizes each declared secret against the effective
// policy: deny-by-default under a deployment policy that does not grant it, allow
// when granted, and allow under the spec-derived self-consistent fallback.
func TestBoundaryGuardBee(t *testing.T) {
	ctx := context.Background()
	ref := "anthropic-api-key"

	t.Run("deny by default under deployment policy", func(t *testing.T) {
		var audited []fleet.GrantDecision
		r := fleet.New()
		r.Policy = secrets.Policy{} // grants nothing
		r.Audit = func(role string, rf secrets.Ref, allowed bool, source string) {
			audited = append(audited, fleet.GrantDecision{Role: role, Ref: string(rf), Allowed: allowed, Source: source})
		}
		res, err := r.Run(ctx, proposerSpec(), "x")
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if len(res.Boundary) != 1 || res.Boundary[0].Allowed {
			t.Fatalf("boundary = %+v, want anthropic-api-key DENIED", res.Boundary)
		}
		if len(audited) != 1 || audited[0].Allowed || audited[0].Ref != ref {
			t.Errorf("audit = %+v, want one denied record for %q", audited, ref)
		}
	})

	t.Run("allow when deployment policy grants it", func(t *testing.T) {
		r := fleet.New()
		r.Policy = secrets.Policy{"investigator": {secrets.Ref(ref)}}
		res, err := r.Run(ctx, proposerSpec(), "x")
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !res.Boundary[0].Allowed || res.Boundary[0].Source != "policy" {
			t.Errorf("boundary = %+v, want ALLOW via policy", res.Boundary[0])
		}
	})

	t.Run("spec-derived fallback grants its own declaration", func(t *testing.T) {
		r := fleet.New() // no deployment policy
		res, err := r.Run(ctx, proposerSpec(), "x")
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !res.Boundary[0].Allowed || res.Boundary[0].Source != "spec" {
			t.Errorf("boundary = %+v, want ALLOW via spec fallback", res.Boundary[0])
		}
	})
}

// A public-only runner refuses a proprietary spec — the OSS distribution gate.
func TestPublicOnlyGate(t *testing.T) {
	r := fleet.New()
	r.PublicOnly = true

	spec := proposerSpec()
	spec.Public = false
	if _, err := r.Run(context.Background(), spec, "x"); err == nil {
		t.Error("public-only runner should refuse a proprietary spec, got nil error")
	}

	spec.Public = true
	if _, err := r.Run(context.Background(), spec, "x"); err != nil {
		t.Errorf("public-only runner should run a public spec, got %v", err)
	}
}

// The two shipped reference ports parse, validate, and carry the identity the
// port claims. Skips cleanly if run outside the monorepo (core is an independent
// module), so `go test` on core alone stays self-contained.
func TestReferencePortsValidate(t *testing.T) {
	want := map[string]struct {
		caste  caste.Caste
		trust  string
		public bool
	}{
		"mentor":       {caste.Queen, agentspec.TrustConductor, true},
		"investigator": {caste.Worker, agentspec.TrustProposer, true},
	}
	for name, exp := range want {
		path := filepath.Join("..", "..", "agents", name, agentspec.SpecFileName)
		if _, err := os.Stat(path); err != nil {
			t.Skipf("reference spec %s not present (running outside the monorepo)", path)
		}
		s, err := agentspec.Load(path) // Load also validates
		if err != nil {
			t.Fatalf("load %s: %v", path, err)
		}
		if s.ResolveCaste() != exp.caste {
			t.Errorf("%s caste = %q, want %q", name, s.ResolveCaste(), exp.caste)
		}
		if s.Trust != exp.trust {
			t.Errorf("%s trust = %q, want %q", name, s.Trust, exp.trust)
		}
		if s.Public != exp.public {
			t.Errorf("%s public = %v, want %v", name, s.Public, exp.public)
		}
	}
}
