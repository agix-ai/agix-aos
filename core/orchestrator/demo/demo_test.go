package demo_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/orchestrator/demo"
	"github.com/agix-ai/agix/core/router"
)

func newLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	return led
}

func TestDemoBuildGraphValidates(t *testing.T) {
	r := router.NewRouter()
	g := demo.BuildGraph(r, nil)
	if err := g.Validate(); err != nil {
		t.Fatalf("demo graph should validate: %v", err)
	}
}

func TestDemoApprovePath(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	res, err := demo.Run(ctx, demo.Options{Task: "ship a login page", Approve: true, Ledger: led})
	if err != nil {
		t.Fatalf("demo.Run(approve): %v", err)
	}
	if res.Interrupted != "ratify" {
		t.Errorf("expected the run to pause at ratify, got %q", res.Interrupted)
	}
	if res.Outcome != "fed" {
		t.Errorf("approve outcome = %q, want fed", res.Outcome)
	}
	if res.OutputText == "" {
		t.Error("approve should produce a fed output")
	}

	// The audit trail must show the full forage→gate→feed loop with the verdict.
	assertKind(t, led, ledger.KindAgentStart)
	assertKind(t, led, ledger.KindLeaseClaim)
	assertKind(t, led, ledger.KindGatePause)
	assertKind(t, led, ledger.KindLeaseRelease)
	assertKind(t, led, ledger.KindAgentDone)
	assertRatify(t, led, true)

	// feed ran (approve path), remediate did not.
	if res.State.GetString("feed.output") == "" {
		t.Error("feed node should have produced output on approve")
	}
	if res.State.GetString("remediate.output") != "" {
		t.Error("remediate must NOT run on approve")
	}
}

func TestDemoRejectPath(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)

	res, err := demo.Run(ctx, demo.Options{Task: "ship a login page", Approve: false, Ledger: led})
	if err != nil {
		t.Fatalf("demo.Run(reject): %v", err)
	}
	if res.Outcome != "remediated" {
		t.Errorf("reject outcome = %q, want remediated", res.Outcome)
	}
	assertRatify(t, led, false)

	// remediate ran (reject path), feed did not — unratified work never fed.
	if res.State.GetString("remediate.output") == "" {
		t.Error("remediate node should have produced output on reject")
	}
	if res.State.GetString("feed.output") != "" {
		t.Error("feed must NOT run on reject (governance, not decoration)")
	}
}

func TestDemoReleasesLease(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	res, err := demo.Run(ctx, demo.Options{Task: "x", Approve: true, Ledger: led})
	if err != nil {
		t.Fatalf("demo.Run: %v", err)
	}
	if res.LeaseID == "" {
		t.Error("expected a lease id on the result")
	}
	claims, _ := led.Read(ledger.KindLeaseClaim, time.Time{})
	releases, _ := led.Read(ledger.KindLeaseRelease, time.Time{})
	if len(claims) != 1 || len(releases) != 1 {
		t.Errorf("lease bracket = claim %d / release %d, want 1/1", len(claims), len(releases))
	}
}

func assertKind(t *testing.T, led *ledger.Ledger, kind string) {
	t.Helper()
	got, err := led.Read(kind, time.Time{})
	if err != nil {
		t.Fatalf("Read(%q): %v", kind, err)
	}
	if len(got) == 0 {
		t.Errorf("ledger missing entry of kind %q", kind)
	}
}

func assertRatify(t *testing.T, led *ledger.Ledger, wantApproved bool) {
	t.Helper()
	got, err := led.Read(ledger.KindRatify, time.Time{})
	if err != nil {
		t.Fatalf("Read(ratify): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly 1 ratify entry, got %d", len(got))
	}
	approved, _ := got[0].Data["approved"].(bool)
	if approved != wantApproved {
		t.Errorf("ratify verdict = %v, want %v", approved, wantApproved)
	}
	if by, _ := got[0].Data["by"].(string); by != "curator-1" {
		t.Errorf("ratify by = %q, want curator-1 (actor≠verifier)", by)
	}
}
