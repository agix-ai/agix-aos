package ledger

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T, opts ...Option) *Store {
	t.Helper()
	s, err := NewStore(context.Background(), &MemorySnapshotter{}, opts...)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func exclusive(paths ...string) []Claim {
	out := make([]Claim, len(paths))
	for i, p := range paths {
		out[i] = Claim{Path: p, Mode: ModeExclusive}
	}
	return out
}

func mustClaim(t *testing.T, s *Store, req ClaimRequest) *Lease {
	t.Helper()
	l, err := s.Claim(context.Background(), req)
	if err != nil {
		t.Fatalf("Claim(%+v): %v", req, err)
	}
	return l
}

// ── claim + overlap (table-driven) ───────────────────────────────────────

func TestClaimOverlap(t *testing.T) {
	base := ClaimRequest{
		Agent:    "agent-a",
		Branches: []string{"claude/lane-a"},
		Claims:   exclusive("apps/api/**"),
		Excludes: []string{"apps/api/src/routes/mcp.ts"},
	}
	tests := []struct {
		name    string
		second  ClaimRequest
		wantErr bool
	}{
		{
			name: "overlapping exclusive claim rejected",
			second: ClaimRequest{
				Agent: "agent-b", Branches: []string{"claude/lane-b"},
				Claims: exclusive("apps/api/src/index.ts"),
			},
			wantErr: true,
		},
		{
			name: "disjoint claim accepted",
			second: ClaimRequest{
				Agent: "agent-b", Branches: []string{"claude/lane-b"},
				Claims: exclusive("apps/web/**"),
			},
			wantErr: false,
		},
		{
			name: "first lease's exclusion admits the second claim",
			second: ClaimRequest{
				Agent: "agent-b", Branches: []string{"claude/lane-b"},
				Claims: exclusive("apps/api/src/routes/mcp.ts"),
			},
			wantErr: false,
		},
		{
			name: "second lease's exclusion subtracts the conflict",
			second: ClaimRequest{
				Agent: "agent-b", Branches: []string{"claude/lane-b"},
				Claims:   exclusive("apps/**"),
				Excludes: []string{"apps/api/**"},
			},
			wantErr: false,
		},
		{
			name: "same agent never blocks itself (identity-keyed, cross-branch)",
			second: ClaimRequest{
				Agent: "agent-a", Branches: []string{"claude/lane-a-stacked"},
				Claims: exclusive("apps/api/src/index.ts"),
			},
			wantErr: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			mustClaim(t, s, base)
			_, err := s.Claim(context.Background(), tt.second)
			if tt.wantErr {
				var oe *OverlapError
				if !errors.As(err, &oe) {
					t.Fatalf("want *OverlapError, got %v", err)
				}
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestSharedAppendCoexistsOnClaim(t *testing.T) {
	s := newTestStore(t)
	shared := []Claim{{Path: "docs/coordination/active-work.md", Mode: ModeSharedAppend}}
	mustClaim(t, s, ClaimRequest{Agent: "a", Branches: []string{"b1"}, Claims: shared})
	// shared-append vs shared-append on the same path is NOT a conflict.
	mustClaim(t, s, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: shared})
	// but an EXCLUSIVE claim on it is.
	_, err := s.Claim(context.Background(), ClaimRequest{
		Agent: "c", Branches: []string{"b3"},
		Claims: exclusive("docs/coordination/active-work.md"),
	})
	var oe *OverlapError
	if !errors.As(err, &oe) {
		t.Fatalf("exclusive over shared-append: want *OverlapError, got %v", err)
	}
}

func TestClaimValidation(t *testing.T) {
	tests := []struct {
		name string
		req  ClaimRequest
	}{
		{"missing agent", ClaimRequest{Branches: []string{"b"}, Claims: exclusive("a.ts")}},
		{"missing branches", ClaimRequest{Agent: "a", Claims: exclusive("a.ts")}},
		{"missing claims", ClaimRequest{Agent: "a", Branches: []string{"b"}}},
		{"empty claim path", ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: []Claim{{Path: "  "}}}},
		{"bang path rejected", ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: []Claim{{Path: "!x.ts"}}}},
		{"bad mode", ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: []Claim{{Path: "x.ts", Mode: "write"}}}},
		{"ttl too small", ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x.ts"), TTLSeconds: 5}},
		{"ttl too big", ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x.ts"), TTLSeconds: 999999}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			if _, err := s.Claim(context.Background(), tt.req); !errors.Is(err, ErrValidation) {
				t.Fatalf("want ErrValidation, got %v", err)
			}
		})
	}
}

// ── race-freedom: concurrent overlapping claims → exactly one winner ─────

func TestConcurrentClaimsExactlyOneWinner(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	const n = 32
	var wg sync.WaitGroup
	var mu sync.Mutex
	winners := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.Claim(context.Background(), ClaimRequest{
				Agent:    fmt.Sprintf("agent-%d", i),
				Branches: []string{fmt.Sprintf("branch-%d", i)},
				Claims:   exclusive("apps/api/src/index.ts"),
			})
			if err == nil {
				mu.Lock()
				winners++
				mu.Unlock()
				return
			}
			var oe *OverlapError
			if !errors.As(err, &oe) {
				t.Errorf("loser got non-overlap error: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if winners != 1 {
		t.Fatalf("want exactly 1 winning claim, got %d", winners)
	}
	leases, err := s.ListLeases(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 {
		t.Fatalf("want 1 active lease, got %d", len(leases))
	}
}

func TestConcurrentMixedOpsRaceClean(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	l := mustClaim(t, s, ClaimRequest{Agent: "owner", Branches: []string{"b"}, Claims: exclusive("pkg/**")})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx := context.Background()
			switch i % 4 {
			case 0:
				_, _ = s.Heartbeat(ctx, l.ID, "owner", 0)
			case 1:
				_, _ = s.CheckOverlap(ctx, []string{"pkg/a.go"}, fmt.Sprintf("reader-%d", i))
			case 2:
				_, _ = s.ListLeases(ctx, true)
			case 3:
				_, _ = s.Events(ctx, 10)
			}
		}(i)
	}
	wg.Wait()
}

// ── release: owner-only / coordinator / never-auto ───────────────────────

func TestReleaseOwnerOnly(t *testing.T) {
	s := newTestStore(t)
	l := mustClaim(t, s, ClaimRequest{Agent: "owner", Branches: []string{"b"}, Claims: exclusive("x/**")})

	if _, err := s.Release(context.Background(), l.ID, "intruder", false); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("non-owner release: want ErrNotOwner, got %v", err)
	}
	if _, err := s.Release(context.Background(), "L-999", "owner", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown lease: want ErrNotFound, got %v", err)
	}
	rel, err := s.Release(context.Background(), l.ID, "owner", false)
	if err != nil {
		t.Fatalf("owner release: %v", err)
	}
	if rel.Status != StatusReleased || rel.ReleasedBy != "owner" {
		t.Fatalf("release not attributed: %+v", rel)
	}
	if _, err := s.Release(context.Background(), l.ID, "owner", false); !errors.Is(err, ErrNotActive) {
		t.Fatalf("double release: want ErrNotActive, got %v", err)
	}
}

func TestReleaseByCoordinator(t *testing.T) {
	s := newTestStore(t)
	l := mustClaim(t, s, ClaimRequest{Agent: "owner", Branches: []string{"b"}, Claims: exclusive("x/**")})
	rel, err := s.Release(context.Background(), l.ID, "ops", true)
	if err != nil {
		t.Fatalf("coordinator release: %v", err)
	}
	if rel.ReleasedBy != "ops" {
		t.Fatalf("coordinator release not attributed: %+v", rel)
	}
	evs, _ := s.Events(context.Background(), 0)
	last := evs[len(evs)-1]
	if last.Type != EventReleased || last.Actor != "ops" || last.Detail != "released by coordinator" {
		t.Fatalf("audit event wrong: %+v", last)
	}
}

// ── TTL expiry: lazy sweep, expired ≠ deleted ────────────────────────────

func TestTTLExpiry(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	clock := &now
	s := newTestStore(t, WithClock(func() time.Time { return *clock }))
	ctx := context.Background()

	l := mustClaim(t, s, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**"), TTLSeconds: 120})

	// heartbeat keeps it alive past the original deadline
	now = now.Add(100 * time.Second)
	if _, err := s.Heartbeat(ctx, l.ID, "a", 0); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	now = now.Add(100 * time.Second) // 200s after claim, 100s after heartbeat — still alive
	active, _ := s.ListLeases(ctx, false)
	if len(active) != 1 {
		t.Fatalf("lease expired despite heartbeat")
	}

	// past TTL with no heartbeat → reads report it expired VIEW-SIDE (reads
	// never persist; the expired event lands on the next mutating call)
	now = now.Add(121 * time.Second)
	active, _ = s.ListLeases(ctx, false)
	if len(active) != 0 {
		t.Fatalf("want 0 active leases after TTL, got %d", len(active))
	}
	all, _ := s.ListLeases(ctx, true)
	if len(all) != 1 || all[0].Status != StatusExpired {
		t.Fatalf("expired lease must be preserved, got %+v", all)
	}

	// the freed path is claimable again — the mutating claim also persists
	// the lazy sweep's expired event
	mustClaim(t, s, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("x/y.go")})
	evs, _ := s.Events(ctx, 0)
	var sawExpired bool
	for _, ev := range evs {
		if ev.Type == EventExpired && ev.LeaseID == l.ID && ev.Actor == SweepActor {
			sawExpired = true
		}
	}
	if !sawExpired {
		t.Fatalf("want persisted expired audit event by %s, got %+v", SweepActor, evs)
	}

	// heartbeat on an expired lease is refused (claim again instead)
	if _, err := s.Heartbeat(ctx, l.ID, "a", 0); !errors.Is(err, ErrNotActive) {
		t.Fatalf("heartbeat on expired: want ErrNotActive, got %v", err)
	}
}

// ── narrowing ────────────────────────────────────────────────────────────

func TestNarrowLease(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	l := mustClaim(t, s, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("apps/web/**")})

	// another agent is blocked while the broad claim stands
	if _, err := s.Claim(ctx, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("apps/web/src/app.tsx")}); err == nil {
		t.Fatal("expected overlap before narrowing")
	}

	// non-owner cannot narrow
	if _, err := s.Claim(ctx, ClaimRequest{
		Agent: "b", Branches: []string{"b2"}, LeaseID: l.ID,
		Claims: exclusive("apps/web/src/other.tsx"),
	}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("non-owner narrow: want ErrNotOwner, got %v", err)
	}

	// owner narrows to one file
	narrowed, err := s.Claim(ctx, ClaimRequest{
		Agent: "a", Branches: []string{"b"}, LeaseID: l.ID,
		Claims: exclusive("apps/web/src/lib/api.ts"),
	})
	if err != nil {
		t.Fatalf("narrow: %v", err)
	}
	if narrowed.ID != l.ID {
		t.Fatalf("narrow must keep the lease ID (got %s)", narrowed.ID)
	}
	evs, _ := s.Events(ctx, 0)
	last := evs[len(evs)-1]
	if last.Type != EventNarrowed {
		t.Fatalf("want narrowed event, got %+v", last)
	}

	// the freed path is claimable now
	mustClaim(t, s, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("apps/web/src/app.tsx")})

	// coordinator may narrow someone else's over-broad lease
	if _, err := s.Claim(ctx, ClaimRequest{
		Agent: "ops", Coordinator: true, Branches: []string{"b"}, LeaseID: l.ID,
		Claims: exclusive("apps/web/src/lib/api.ts"),
	}); err != nil {
		t.Fatalf("coordinator narrow: %v", err)
	}
}

// ── check_overlap semantics ──────────────────────────────────────────────

func TestCheckOverlap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustClaim(t, s, ClaimRequest{
		Agent: "a", Branches: []string{"lane-a"},
		Claims:   exclusive("apps/api/**"),
		Excludes: []string{"apps/api/src/routes/mcp.ts"},
	})
	mustClaim(t, s, ClaimRequest{
		Agent: "b", Branches: []string{"lane-b"},
		Claims: []Claim{{Path: "docs/coordination/active-work.md", Mode: ModeSharedAppend}},
	})

	tests := []struct {
		name      string
		files     []string
		agent     string
		wantFiles int
	}{
		{"other agent's file blocked", []string{"apps/api/src/index.ts"}, "c", 1},
		{"own claim never blocks", []string{"apps/api/src/index.ts"}, "a", 0},
		{"excluded path is free", []string{"apps/api/src/routes/mcp.ts"}, "c", 0},
		{"unclaimed path is free", []string{"packages/db/x.ts"}, "c", 0},
		{"shared-append blocks the unconsented", []string{"docs/coordination/active-work.md"}, "c", 1},
		{"multiple files aggregate", []string{"apps/api/a.ts", "apps/api/b.ts"}, "c", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.CheckOverlap(ctx, tt.files, tt.agent)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != tt.wantFiles {
				t.Fatalf("want %d conflicts, got %+v", tt.wantFiles, got)
			}
		})
	}

	// consent model: an agent holding its own shared-append claim on the file
	// is NOT blocked by the other shared-append holder.
	mustClaim(t, s, ClaimRequest{
		Agent: "c", Branches: []string{"lane-c"},
		Claims: []Claim{{Path: "docs/coordination/active-work.md", Mode: ModeSharedAppend}},
	})
	got, err := s.CheckOverlap(ctx, []string{"docs/coordination/active-work.md"}, "c")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("shared-append holder should coexist, got %+v", got)
	}
}

// ── persistence: replay + write-through rollback ─────────────────────────

func TestSnapshotReplay(t *testing.T) {
	snap := &MemorySnapshotter{}
	ctx := context.Background()
	s1, err := NewStore(ctx, snap)
	if err != nil {
		t.Fatal(err)
	}
	l, err := s1.Claim(ctx, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**"), Notes: "increment 1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s1.Heartbeat(ctx, l.ID, "a", 7200); err != nil {
		t.Fatal(err)
	}
	l2, err := s1.Claim(ctx, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("y/**")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s1.Release(ctx, l2.ID, "b", false); err != nil {
		t.Fatal(err)
	}

	// a fresh store over the same snapshot must materialize identical state
	s2, err := NewStore(ctx, snap)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	active, _ := s2.ListLeases(ctx, false)
	if len(active) != 1 || active[0].ID != l.ID || active[0].TTLSeconds != 7200 || active[0].Notes != "increment 1" {
		t.Fatalf("replayed active view wrong: %+v", active)
	}
	all, _ := s2.ListLeases(ctx, true)
	if len(all) != 2 {
		t.Fatalf("replay lost leases: %+v", all)
	}
	evs, _ := s2.Events(ctx, 0)
	if len(evs) != 4 { // claimed, heartbeat, claimed, released
		t.Fatalf("want 4 replayed events, got %d", len(evs))
	}
	// event seq continues, never restarts (append-only across restarts)
	l3, err := s2.Claim(ctx, ClaimRequest{Agent: "c", Branches: []string{"b3"}, Claims: exclusive("z/**")})
	if err != nil {
		t.Fatal(err)
	}
	evs, _ = s2.Events(ctx, 0)
	if last := evs[len(evs)-1]; last.Seq != 5 || last.LeaseID != l3.ID {
		t.Fatalf("seq must continue after replay, got %+v", last)
	}
}

type failingSnapshotter struct {
	MemorySnapshotter
	failing bool
}

func (f *failingSnapshotter) Save(ctx context.Context, data []byte) error {
	if f.failing {
		return errors.New("storage down")
	}
	return f.MemorySnapshotter.Save(ctx, data)
}

func TestPersistFailureRollsBack(t *testing.T) {
	snap := &failingSnapshotter{}
	ctx := context.Background()
	s, err := NewStore(ctx, snap)
	if err != nil {
		t.Fatal(err)
	}
	mustClaim(t, s, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**")})

	snap.failing = true
	if _, err := s.Claim(ctx, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("y/**")}); err == nil {
		t.Fatal("claim must fail when persistence fails")
	}
	snap.failing = false

	// fail-closed: the unpersisted lease must NOT exist
	all, _ := s.ListLeases(ctx, true)
	if len(all) != 1 {
		t.Fatalf("rolled-back claim leaked into state: %+v", all)
	}
	// and the store still works afterwards
	mustClaim(t, s, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("y/**")})
}

// conflictOnceSnapshotter returns a definite ErrConcurrentWrite on the next
// Save, simulating another writer having advanced the snapshot generation.
type conflictOnceSnapshotter struct {
	MemorySnapshotter
	conflictNext bool
}

func (c *conflictOnceSnapshotter) Save(ctx context.Context, data []byte) error {
	if c.conflictNext {
		c.conflictNext = false
		return ErrConcurrentWrite
	}
	return c.MemorySnapshotter.Save(ctx, data)
}

// 412-reload-recover: a definite concurrent write must reload the snapshot
// (so the retry sees the other writer's events) and return a retryable
// ErrLedgerConflict — never a wedge, never a silent divergence.
func TestSaveConflictReloadsAndRetries(t *testing.T) {
	ctx := context.Background()
	snap := &conflictOnceSnapshotter{}
	s1, err := NewStore(ctx, snap)
	if err != nil {
		t.Fatal(err)
	}
	// "another writer": a second store over the same storage persists a lease
	// s1 has not seen.
	s2, err := NewStore(ctx, &snap.MemorySnapshotter)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s2.Claim(ctx, ClaimRequest{Agent: "b", Branches: []string{"lane-b"}, Claims: exclusive("y/**")}); err != nil {
		t.Fatal(err)
	}

	// s1's next save hits the generation conflict
	snap.conflictNext = true
	_, err = s1.Claim(ctx, ClaimRequest{Agent: "a", Branches: []string{"lane-a"}, Claims: exclusive("x/**")})
	if !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("want ErrLedgerConflict, got %v", err)
	}

	// the reload made the other writer's lease visible…
	all, _ := s1.ListLeases(ctx, true)
	if len(all) != 1 || all[0].Agent != "b" {
		t.Fatalf("reload did not adopt the other writer's state: %+v", all)
	}
	// …the store is NOT degraded (conflict is a normal, recovered condition)…
	if deg, _ := s1.Degraded(); deg {
		t.Fatal("a recovered conflict must not mark the store degraded")
	}
	// …and the retry succeeds.
	if _, err := s1.Claim(ctx, ClaimRequest{Agent: "a", Branches: []string{"lane-a"}, Claims: exclusive("x/**")}); err != nil {
		t.Fatalf("retry after conflict: %v", err)
	}
	// a retry that now overlaps the other writer's lease is properly rejected
	var oe *OverlapError
	if _, err := s1.Claim(ctx, ClaimRequest{Agent: "c", Branches: []string{"lane-c"}, Claims: exclusive("y/z.go")}); !errors.As(err, &oe) {
		t.Fatalf("overlap with reloaded lease must reject, got %v", err)
	}
}

// Degraded flag: unconfirmed persistence marks the store degraded (surfaced in
// list_leases/get_events + /healthz); the next successful persist clears it.
func TestDegradedFlagOnPersistFailure(t *testing.T) {
	ctx := context.Background()
	snap := &failingSnapshotter{}
	s, err := NewStore(ctx, snap)
	if err != nil {
		t.Fatal(err)
	}
	if deg, _ := s.Degraded(); deg {
		t.Fatal("fresh store must not be degraded")
	}

	snap.failing = true
	if _, err := s.Claim(ctx, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**")}); err == nil {
		t.Fatal("claim must fail while persistence fails")
	}
	deg, reason := s.Degraded()
	if !deg || reason == "" {
		t.Fatalf("store must be degraded with a reason, got (%v, %q)", deg, reason)
	}

	// reads still work while degraded
	if _, err := s.ListLeases(ctx, true); err != nil {
		t.Fatalf("degraded reads must serve from memory: %v", err)
	}

	// recovery clears the flag
	snap.failing = false
	if _, err := s.Claim(ctx, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**")}); err != nil {
		t.Fatalf("claim after recovery: %v", err)
	}
	if deg, _ := s.Degraded(); deg {
		t.Fatal("successful persist must clear the degraded flag")
	}
}

// Read paths must not persist: with the snapshotter DOWN and a lease past its
// TTL, list/check/events all succeed from memory, expiry is computed
// view-side, and no expired event is written.
func TestReadsSucceedWhenSnapshotterDown(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	clock := &now
	ctx := context.Background()
	snap := &failingSnapshotter{}
	s, err := NewStore(ctx, snap, WithClock(func() time.Time { return *clock }))
	if err != nil {
		t.Fatal(err)
	}
	l := mustClaim(t, s, ClaimRequest{Agent: "a", Branches: []string{"b"}, Claims: exclusive("x/**"), TTLSeconds: 120})

	// storage goes down, then the lease passes its TTL
	snap.failing = true
	now = now.Add(200 * time.Second)

	// list: no error; active view excludes the TTL-lapsed lease…
	active, err := s.ListLeases(ctx, false)
	if err != nil {
		t.Fatalf("ListLeases with storage down: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("TTL-lapsed lease must not list as active, got %+v", active)
	}
	// …and the inactive view reports it as expired (view-side status)
	all, err := s.ListLeases(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].Status != StatusExpired {
		t.Fatalf("view-side expiry missing: %+v", all)
	}

	// check_overlap: no error; the lapsed lease no longer blocks
	conflicts, err := s.CheckOverlap(ctx, []string{"x/a.go"}, "other")
	if err != nil {
		t.Fatalf("CheckOverlap with storage down: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("TTL-lapsed lease must not block, got %+v", conflicts)
	}

	// events: no error, and NO expired event was persisted by the reads
	evs, err := s.Events(ctx, 0)
	if err != nil {
		t.Fatalf("Events with storage down: %v", err)
	}
	if len(evs) != 1 || evs[0].Type != EventClaimed {
		t.Fatalf("reads must not write events, got %+v", evs)
	}

	// mutating ops still fail closed while storage is down
	if _, err := s.Heartbeat(ctx, l.ID, "a", 0); err == nil {
		t.Fatal("mutating op must fail while storage is down")
	}

	// when storage returns, the next mutating call persists the sweep
	snap.failing = false
	mustClaim(t, s, ClaimRequest{Agent: "b", Branches: []string{"b2"}, Claims: exclusive("x/a.go")})
	evs, _ = s.Events(ctx, 0)
	foundExpired := false
	for _, ev := range evs {
		if ev.Type == EventExpired && ev.LeaseID == l.ID {
			foundExpired = true
		}
	}
	if !foundExpired {
		t.Fatalf("mutating call must persist the deferred expiry, got %+v", evs)
	}
}

func TestParseGCSTarget(t *testing.T) {
	tests := []struct {
		in         string
		bucket, ob string
		wantErr    bool
	}{
		{"gs://agix-coord-mcp/ledger.json", "agix-coord-mcp", "ledger.json", false},
		{"gs://b/nested/path.json", "b", "nested/path.json", false},
		{"gs://bucketonly", "", "", true},
		{"/local/file.json", "", "", true},
	}
	for _, tt := range tests {
		b, o, err := ParseGCSTarget(tt.in)
		if tt.wantErr != (err != nil) {
			t.Fatalf("ParseGCSTarget(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if b != tt.bucket || o != tt.ob {
			t.Fatalf("ParseGCSTarget(%q) = (%q, %q)", tt.in, b, o)
		}
	}
}
