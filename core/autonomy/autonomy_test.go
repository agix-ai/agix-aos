// Copyright 2026 Agix AI LLC. Apache-2.0.
package autonomy

import (
	"context"
	"testing"
	"time"
)

var t0 = time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)

func TestRungRoundTrip(t *testing.T) {
	for _, r := range []Rung{Shadow, Propose, Act} {
		got, err := ParseRung(r.String())
		if err != nil || got != r {
			t.Fatalf("round-trip %v: got %v err=%v", r, got, err)
		}
	}
	if _, err := ParseRung("god-mode"); err == nil {
		t.Fatal("expected error for unknown rung")
	}
}

func TestAllows(t *testing.T) {
	s := State{Rung: Propose}
	if !s.Allows(Shadow) || !s.Allows(Propose) {
		t.Fatal("Propose must allow Shadow and Propose")
	}
	if s.Allows(Act) {
		t.Fatal("Propose must NOT allow Act")
	}
}

// Five consecutive accepted outcomes climb exactly one rung, resetting the streak.
func TestLadderPromotes(t *testing.T) {
	l := Ladder{} // defaults: Promote=5, Hysteresis=3
	s := State{Domain: "issue-label"}
	for i := 0; i < 4; i++ {
		s = l.Observe(s, true, t0)
		if s.Rung != Shadow {
			t.Fatalf("after %d accepts rung=%v, want shadow", i+1, s.Rung)
		}
	}
	s = l.Observe(s, true, t0) // 5th
	if s.Rung != Propose || s.Streak != 0 {
		t.Fatalf("after 5 accepts: rung=%v streak=%d, want propose/0", s.Rung, s.Streak)
	}
}

// A single rejection demotes one rung and records the demotion.
func TestLadderDemotesOnReject(t *testing.T) {
	l := Ladder{}
	s := State{Domain: "d", Rung: Act, Streak: 2}
	s = l.Observe(s, false, t0)
	if s.Rung != Propose || s.Demotions != 1 || s.Streak != 0 {
		t.Fatalf("demote: rung=%v demotions=%d streak=%d, want propose/1/0", s.Rung, s.Demotions, s.Streak)
	}
}

// Shadow is the floor: a rejection there cannot go lower.
func TestLadderShadowFloor(t *testing.T) {
	l := Ladder{}
	s := State{Domain: "d", Rung: Shadow, Streak: 3}
	s = l.Observe(s, false, t0)
	if s.Rung != Shadow || s.Demotions != 0 || s.Streak != 0 {
		t.Fatalf("shadow reject: rung=%v demotions=%d streak=%d, want shadow/0/0", s.Rung, s.Demotions, s.Streak)
	}
}

// After a demotion, re-earning a rung requires MORE accepted outcomes (hysteresis).
func TestLadderHysteresis(t *testing.T) {
	l := Ladder{} // Promote=5, Hysteresis=3 → after 1 demotion, threshold=8
	s := State{Domain: "d", Rung: Shadow, Demotions: 1}
	for i := 0; i < 7; i++ {
		s = l.Observe(s, true, t0)
		if s.Rung != Shadow {
			t.Fatalf("after %d accepts (post-demotion) rung=%v, want still shadow (threshold 8)", i+1, s.Rung)
		}
	}
	s = l.Observe(s, true, t0) // 8th
	if s.Rung != Propose {
		t.Fatalf("after 8 accepts rung=%v, want propose", s.Rung)
	}
}

// The ceiling holds: Act never climbs past Act.
func TestLadderCeiling(t *testing.T) {
	l := Ladder{}
	s := State{Domain: "d", Rung: Act}
	for i := 0; i < 20; i++ {
		s = l.Observe(s, true, t0)
	}
	if s.Rung != Act {
		t.Fatalf("ceiling breached: rung=%v", s.Rung)
	}
}

// A fresh domain is deny-by-default above Shadow, and the ledger persists climbs.
func TestMemLedgerGateAndPersistence(t *testing.T) {
	ctx := context.Background()
	var sunk []State
	m := NewMemLedger(Ladder{}, func(s State, _ bool) { sunk = append(sunk, s) })

	// Unknown domain: Shadow allowed, higher denied.
	if ok, _ := m.Allowed(ctx, "pr-comment", Shadow); !ok {
		t.Fatal("shadow must be allowed for a fresh domain")
	}
	if ok, _ := m.Allowed(ctx, "pr-comment", Act); ok {
		t.Fatal("act must be denied for a fresh domain (deny-by-default)")
	}

	// Earn Propose with five accepted outcomes.
	for i := 0; i < 5; i++ {
		if _, err := m.Observe(ctx, "pr-comment", true); err != nil {
			t.Fatal(err)
		}
	}
	if ok, _ := m.Allowed(ctx, "pr-comment", Propose); !ok {
		t.Fatal("propose should be earned after 5 accepts")
	}
	if len(sunk) != 5 {
		t.Fatalf("sink got %d records, want 5", len(sunk))
	}

	// Empty domain is an error, never a permissive default.
	if _, err := m.Allowed(ctx, "", Shadow); err != ErrNoDomain {
		t.Fatalf("empty domain: err=%v, want ErrNoDomain", err)
	}
}

// Seed installs prior state without emitting outcomes; Snapshot is stably ordered.
func TestSeedAndSnapshot(t *testing.T) {
	ctx := context.Background()
	m := NewMemLedger(Ladder{}, nil)
	m.Seed(
		State{Domain: "release", Rung: Shadow},
		State{Domain: "issue-label", Rung: Act},
	)
	snap, _ := m.Snapshot(ctx)
	if len(snap) != 2 || snap[0].Domain != "issue-label" || snap[1].Domain != "release" {
		t.Fatalf("snapshot order/contents wrong: %+v", snap)
	}
	if got, _ := m.Rung(ctx, "issue-label"); got.Rung != Act {
		t.Fatalf("seeded issue-label rung=%v, want act", got.Rung)
	}
}
