package agent_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
)

func newMockAgent(t *testing.T) (*agent.Agent, *ledger.Ledger, *coord.MemLedger) {
	t.Helper()
	r := router.NewRouter()
	r.Register(mock.New())
	r.ForceProvider("mock")
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	leases := coord.NewMemLedger()
	return &agent.Agent{Name: "forager-1", Router: r, Ledger: led, Leases: leases}, led, leases
}

func TestAgentFullMockRun(t *testing.T) {
	ctx := context.Background()
	ag, led, leases := newMockAgent(t)

	res, err := ag.Run(ctx, agent.Task{
		Name:   "greet",
		Prompt: "hello hive",
		Scope:  []string{"src/greet.go"},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Text == "" {
		t.Error("expected a non-empty result text")
	}
	if res.Provider != "mock" || res.Model != "mock" {
		t.Errorf("provider/model = %s/%s, want mock/mock", res.Provider, res.Model)
	}
	if res.Usage.CostUSD < 0 {
		t.Errorf("cost must be >= 0, got %v", res.Usage.CostUSD)
	}
	if res.LeaseID == "" {
		t.Error("expected a lease id on the result")
	}

	// Lease must be released: another agent sees no conflict on the scope.
	conf, err := leases.CheckOverlap(ctx, []string{"src/greet.go"}, "other")
	if err != nil {
		t.Fatalf("CheckOverlap: %v", err)
	}
	if len(conf) != 0 {
		t.Fatalf("lease should be released, but overlap remains: %+v", conf)
	}

	// Ledger must record the full loop.
	assertHasKind(t, led, ledger.KindLeaseClaim)
	assertHasKind(t, led, ledger.KindModelCall)
	assertHasKind(t, led, ledger.KindAgentDone)
	assertHasKind(t, led, ledger.KindLeaseRelease)
}

func TestAgentGracefulDegradeOnProviderError(t *testing.T) {
	ctx := context.Background()
	r := router.NewRouter()
	// Mock configured to fail the model call.
	r.Register(&mock.MockProvider{Named: "mock", Fail: errBoom})
	r.ForceProvider("mock")
	led, _ := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	leases := coord.NewMemLedger()
	ag := &agent.Agent{Name: "forager-2", Router: r, Ledger: led, Leases: leases}

	res, err := ag.Run(ctx, agent.Task{Name: "boom", Prompt: "x", Scope: []string{"a/b.go"}})
	if err == nil {
		t.Fatal("expected an error from the failing provider")
	}
	if res.Err == "" {
		t.Error("Result.Err should carry the failure")
	}
	// Even on failure, the lease must be released (heals posture).
	conf, _ := leases.CheckOverlap(ctx, []string{"a/b.go"}, "other")
	if len(conf) != 0 {
		t.Fatalf("lease should be released even on error, got %+v", conf)
	}
}

var errBoom = &boomErr{}

type boomErr struct{}

func (*boomErr) Error() string { return "boom: synthetic provider failure" }

// leakErr mimics a provider/transport error whose string embeds an API key (the
// pre-fix Gemini URL-leak shape).
type leakErr struct{ msg string }

func (e *leakErr) Error() string { return e.msg }

// TestAgentRedactsKeyOnProviderError is the SECURITY regression for BUG 1: when
// the model call fails with an error carrying an API key, the key must not reach
// res.Err, the returned error, or the audit ledger.
func TestAgentRedactsKeyOnProviderError(t *testing.T) {
	ctx := context.Background()
	const key = "AIzaSyLEAK0123456789abcdefghijklmnopqrs"
	boom := &leakErr{msg: `gemini: http: Post "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=` + key + `": dial tcp: timeout`}

	r := router.NewRouter()
	r.Register(&mock.MockProvider{Named: "mock", Fail: boom})
	r.ForceProvider("mock")
	led, _ := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	leases := coord.NewMemLedger()
	ag := &agent.Agent{Name: "forager-9", Router: r, Ledger: led, Leases: leases}

	res, err := ag.Run(ctx, agent.Task{Name: "leak", Prompt: "x", Scope: []string{"a/b.go"}})
	if err == nil {
		t.Fatal("expected an error from the failing provider")
	}
	if strings.Contains(err.Error(), key) {
		t.Errorf("SECURITY: returned error leaked the key: %q", err.Error())
	}
	if strings.Contains(res.Err, key) {
		t.Errorf("SECURITY: res.Err leaked the key: %q", res.Err)
	}
	if !strings.Contains(res.Err, "[REDACTED:google-api-key]") {
		t.Errorf("res.Err should carry a redacted marker, got: %q", res.Err)
	}
	// The ledger must not persist the key either.
	entries, _ := led.Read(ledger.KindAgentDone, time.Time{})
	for _, e := range entries {
		if s, _ := e.Data["error"].(string); strings.Contains(s, key) {
			t.Errorf("SECURITY: ledger agent_done leaked the key: %q", s)
		}
	}
}

func assertHasKind(t *testing.T, led *ledger.Ledger, kind string) {
	t.Helper()
	got, err := led.Read(kind, time.Time{})
	if err != nil {
		t.Fatalf("Read(%q): %v", kind, err)
	}
	if len(got) == 0 {
		t.Errorf("ledger missing entry of kind %q", kind)
	}
}
