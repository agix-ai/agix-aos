package caste_test

import (
	"sync"
	"testing"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/caste"
)

// The actor-ref a caste mints must round-trip through the cross-hive envelope's
// parser — the two notions of "actor" must never drift.
func TestActorRoundTrips(t *testing.T) {
	cases := []struct {
		hive     string
		c        caste.Caste
		role     string
		instance int
		want     string
		wantDesg string
	}{
		{"agix", caste.Worker, "forager", 1, "agix/worker/forager-1", "forager-1"},
		{"agix", caste.Worker, "verifier", 1, "agix/worker/verifier-1", "verifier-1"},
		{"agix", caste.Queen, "root", 2, "agix/queen/root-2", "root-2"},
		{"agix", caste.Drone, "pr-bot", 7, "agix/drone/pr-bot-7", "pr-bot-7"},
	}
	for _, tc := range cases {
		got := caste.Actor(tc.hive, tc.c, tc.role, tc.instance)
		if got != tc.want {
			t.Errorf("Actor(%q,%q,%q,%d) = %q, want %q", tc.hive, tc.c, tc.role, tc.instance, got, tc.want)
		}
		hive, cst, desg, ok := apiary.ParseActorRef(got)
		if !ok {
			t.Fatalf("ParseActorRef(%q) failed to parse a caste-minted actor", got)
		}
		if hive != tc.hive || cst != string(tc.c) || desg != tc.wantDesg {
			t.Errorf("ParseActorRef(%q) = (%q,%q,%q), want (%q,%q,%q)",
				got, hive, cst, desg, tc.hive, tc.c, tc.wantDesg)
		}
	}
}

// The verifier is a Worker-caste bee — actor≠verifier is a role split within a
// caste, not a rank difference.
func TestDefaultCaste(t *testing.T) {
	cases := map[string]caste.Caste{
		"conductor":        caste.Queen,
		"director":         caste.Queen,
		"sensei":           caste.Queen,
		"verifier":         caste.Worker,
		"forager":          caste.Worker,
		"curator":          caste.Worker,
		"researcher":       caste.Worker,
		"pr-bot":           caste.Drone,
		"git-orchestrator": caste.Drone,
		"secretary":        caste.Drone,
		"unknown-role":     caste.Worker, // safe default
		"":                 caste.Worker,
	}
	for role, want := range cases {
		if got := caste.DefaultCaste(role); got != want {
			t.Errorf("DefaultCaste(%q) = %q, want %q", role, got, want)
		}
	}
}

func TestRosterMonotonic(t *testing.T) {
	var r caste.Roster
	for i := 1; i <= 5; i++ {
		if got := r.Next("forager"); got != i {
			t.Fatalf("Next(forager) call %d = %d, want %d", i, got, i)
		}
	}
	// Per-role counters are independent.
	if got := r.Next("verifier"); got != 1 {
		t.Errorf("Next(verifier) = %d, want 1 (independent counter)", got)
	}
	if got := r.Next("forager"); got != 6 {
		t.Errorf("Next(forager) = %d, want 6 (continues its own sequence)", got)
	}
}

// -race exercise: N goroutines hammering Next must produce a set of distinct,
// contiguous instance numbers with no torn reads.
func TestRosterConcurrent(t *testing.T) {
	const n = 200
	var r caste.Roster
	var wg sync.WaitGroup
	var mu sync.Mutex
	seen := make(map[int]bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := r.Next("forager")
			mu.Lock()
			seen[v] = true
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(seen) != n {
		t.Fatalf("expected %d distinct instance numbers, got %d (a collision means Next is not concurrency-safe)", n, len(seen))
	}
	for i := 1; i <= n; i++ {
		if !seen[i] {
			t.Errorf("missing instance number %d — the sequence is not contiguous", i)
		}
	}
}
