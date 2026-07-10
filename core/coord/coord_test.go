package coord_test

import (
	"context"
	"testing"

	"github.com/agix-ai/agix/core/coord"
)

func TestExclusiveOverlapRejected(t *testing.T) {
	m := coord.NewMemLedger()
	ctx := context.Background()
	if _, err := m.Claim(ctx, coord.ClaimRequest{
		Agent:  "A",
		Claims: []coord.Claim{{Path: "src/**", Mode: coord.ModeExclusive}},
	}); err != nil {
		t.Fatalf("A claim: %v", err)
	}
	// B claims a file inside A's exclusive subtree → must be rejected.
	if _, err := m.Claim(ctx, coord.ClaimRequest{
		Agent:  "B",
		Claims: []coord.Claim{{Path: "src/foo.go", Mode: coord.ModeExclusive}},
	}); err == nil {
		t.Fatal("expected conflict for B claiming inside A's exclusive subtree")
	}
}

func TestOwnLeaseNeverConflicts(t *testing.T) {
	m := coord.NewMemLedger()
	ctx := context.Background()
	if _, err := m.Claim(ctx, coord.ClaimRequest{Agent: "A", Claims: []coord.Claim{{Path: "src/**"}}}); err != nil {
		t.Fatalf("A claim 1: %v", err)
	}
	// Same agent claims an overlapping path in a NEW lease — never blocked.
	if _, err := m.Claim(ctx, coord.ClaimRequest{Agent: "A", Claims: []coord.Claim{{Path: "src/foo.go"}}}); err != nil {
		t.Fatalf("A's own overlapping claim should not conflict: %v", err)
	}
}

func TestCheckOverlapAndRelease(t *testing.T) {
	m := coord.NewMemLedger()
	ctx := context.Background()
	lease, err := m.Claim(ctx, coord.ClaimRequest{Agent: "A", Claims: []coord.Claim{{Path: "src/**"}}})
	if err != nil {
		t.Fatalf("A claim: %v", err)
	}

	// Another agent sees a conflict on a file under A's claim.
	conf, err := m.CheckOverlap(ctx, []string{"src/foo.go"}, "B")
	if err != nil {
		t.Fatalf("CheckOverlap B: %v", err)
	}
	if len(conf) != 1 || conf[0].Agent != "A" {
		t.Fatalf("expected 1 conflict owned by A, got %+v", conf)
	}

	// A itself sees no conflict on its own files.
	own, err := m.CheckOverlap(ctx, []string{"src/foo.go"}, "A")
	if err != nil {
		t.Fatalf("CheckOverlap A: %v", err)
	}
	if len(own) != 0 {
		t.Fatalf("own lease should not conflict, got %+v", own)
	}

	// Release A's lease → B is now clear.
	if err := m.Release(ctx, lease.ID, "A"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	after, err := m.CheckOverlap(ctx, []string{"src/foo.go"}, "B")
	if err != nil {
		t.Fatalf("CheckOverlap after release: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("released lease should not conflict, got %+v", after)
	}
}

func TestReleaseWrongOwnerRejected(t *testing.T) {
	m := coord.NewMemLedger()
	ctx := context.Background()
	lease, _ := m.Claim(ctx, coord.ClaimRequest{Agent: "A", Claims: []coord.Claim{{Path: "a/**"}}})
	if err := m.Release(ctx, lease.ID, "B"); err == nil {
		t.Fatal("only the owner may release a lease")
	}
}

func TestSharedAppendCoexists(t *testing.T) {
	m := coord.NewMemLedger()
	ctx := context.Background()
	if _, err := m.Claim(ctx, coord.ClaimRequest{Agent: "A", Claims: []coord.Claim{{Path: "docs/**", Mode: coord.ModeSharedAppend}}}); err != nil {
		t.Fatalf("A shared-append: %v", err)
	}
	if _, err := m.Claim(ctx, coord.ClaimRequest{Agent: "B", Claims: []coord.Claim{{Path: "docs/x.md", Mode: coord.ModeSharedAppend}}}); err != nil {
		t.Fatalf("B shared-append should coexist with A: %v", err)
	}
}

func TestMCPLeaseLedgerIsSeam(t *testing.T) {
	var l coord.LeaseLedger = &coord.MCPLeaseLedger{}
	if _, err := l.Claim(context.Background(), coord.ClaimRequest{Agent: "A"}); err != coord.ErrMCPNotImplemented {
		t.Fatalf("MCP seam should report not-implemented, got %v", err)
	}
}
