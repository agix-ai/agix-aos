package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// SnapshotSchema identifies the persisted ledger format.
	SnapshotSchema = "agix.coord-mcp.ledger/v1"

	// DefaultTTLSeconds is applied when a claim omits ttlSeconds (the 6-hour
	// staleness default).
	DefaultTTLSeconds = 6 * 60 * 60
	// MinTTLSeconds / MaxTTLSeconds bound claimant-chosen TTLs.
	MinTTLSeconds = 60
	MaxTTLSeconds = 24 * 60 * 60

	// SweepActor is the recorded actor on system-generated expired events.
	SweepActor = "system:sweep"
)

// Sentinel errors — tool handlers map these to agent-visible messages.
var (
	ErrNotFound   = errors.New("lease not found")
	ErrNotOwner   = errors.New("not the lease owner (and not a coordinator)")
	ErrNotActive  = errors.New("lease is not active")
	ErrValidation = errors.New("invalid request")
	// ErrLedgerConflict: another writer updated the snapshot (a definite 412).
	// The store has already reloaded fresh state — the operation is retryable.
	ErrLedgerConflict = errors.New("ledger changed concurrently (state reloaded — retry the operation)")
)

// OverlapError is returned when a claim would overlap other agents' active
// exclusive claims. The claim is rejected atomically — no partial state.
type OverlapError struct {
	Conflicts []Conflict
}

func (e *OverlapError) Error() string {
	parts := make([]string, 0, len(e.Conflicts))
	for _, c := range e.Conflicts {
		parts = append(parts, fmt.Sprintf("%s ← %s (%s, lease %s)", c.File, c.Glob, c.Agent, c.LeaseID))
	}
	return "claim rejected — overlaps active claims: " + strings.Join(parts, "; ")
}

// Snapshotter persists the append-only event log. Save is called synchronously
// on every mutation (write-through) under the store mutex.
type Snapshotter interface {
	// Load returns the persisted snapshot bytes, or (nil, nil) if none exists.
	Load(ctx context.Context) ([]byte, error)
	// Save persists the snapshot bytes durably.
	Save(ctx context.Context, data []byte) error
}

type snapshot struct {
	Schema string  `json:"schema"`
	Events []Event `json:"events"`
}

// Store is the ledger: an append-only event log plus a materialized
// current-leases view rebuilt by replay. All operations are atomic under one
// mutex — the race-free property: two overlapping exclusive claims can never
// both succeed.
type Store struct {
	mu      sync.Mutex
	events  []Event
	leases  map[string]*Lease
	order   []string // lease IDs in creation order (deterministic listing)
	nextSeq int64
	snap    Snapshotter
	now     func() time.Time
	// degraded is set when a write could not be confirmed durable (ambiguous
	// save whose read-back diverged, or persistent storage failure). Reads keep
	// serving from memory; writes keep failing closed. Surfaced via Degraded()
	// → list_leases / get_events output and the /healthz body. Cleared by the
	// next successful persist.
	degraded       bool
	degradedReason string
}

// Degraded reports whether the last persist attempt left the store unable to
// confirm durability, plus the reason.
func (s *Store) Degraded() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.degraded, s.degradedReason
}

// Option customizes a Store (tests inject a fake clock).
type Option func(*Store)

// WithClock overrides the time source.
func WithClock(now func() time.Time) Option {
	return func(s *Store) { s.now = now }
}

// NewStore builds a Store, replaying any persisted snapshot from snap.
func NewStore(ctx context.Context, snap Snapshotter, opts ...Option) (*Store, error) {
	s := &Store{
		leases:  map[string]*Lease{},
		nextSeq: 1,
		snap:    snap,
		now:     time.Now,
	}
	for _, o := range opts {
		o(s)
	}
	data, err := snap.Load(ctx)
	if err != nil {
		return nil, fmt.Errorf("load snapshot: %w", err)
	}
	if len(data) > 0 {
		var sn snapshot
		if err := json.Unmarshal(data, &sn); err != nil {
			return nil, fmt.Errorf("parse snapshot: %w", err)
		}
		s.events = sn.Events
		s.rebuild()
	}
	return s, nil
}

// rebuild replays the full event log into a fresh materialized view.
func (s *Store) rebuild() {
	s.leases = map[string]*Lease{}
	s.order = nil
	s.nextSeq = 1
	for i := range s.events {
		s.apply(&s.events[i])
		if s.events[i].Seq >= s.nextSeq {
			s.nextSeq = s.events[i].Seq + 1
		}
	}
}

// apply folds one event into the materialized view.
func (s *Store) apply(ev *Event) {
	switch ev.Type {
	case EventClaimed, EventNarrowed:
		if ev.Lease == nil {
			return // defensive: malformed event
		}
		cp := cloneLease(ev.Lease)
		if _, seen := s.leases[cp.ID]; !seen {
			s.order = append(s.order, cp.ID)
		}
		s.leases[cp.ID] = cp
	case EventReleased:
		if l, ok := s.leases[ev.LeaseID]; ok {
			l.Status = StatusReleased
			l.ReleasedBy = ev.Actor
		}
	case EventHeartbeat:
		if l, ok := s.leases[ev.LeaseID]; ok {
			l.HeartbeatAt = ev.At
			if ev.TTLSeconds > 0 {
				l.TTLSeconds = ev.TTLSeconds
			}
		}
	case EventExpired:
		if l, ok := s.leases[ev.LeaseID]; ok && l.Status == StatusActive {
			l.Status = StatusExpired
		}
	}
}

// appendAndSave appends events, applies them, and persists write-through.
// On persistence failure the mutation is rolled back (fail-closed): an
// unpersisted claim must never be handed out as held. Failure handling:
//   - definite concurrent write (ErrConcurrentWrite / 412): reload the
//     snapshot from storage, replay, and return ErrLedgerConflict (retryable);
//   - anything else: keep the rollback and mark the store DEGRADED so the
//     divergence is loud (cleared by the next successful persist).
func (s *Store) appendAndSave(ctx context.Context, evs ...*Event) error {
	n := len(s.events)
	for _, ev := range evs {
		ev.Seq = s.nextSeq
		s.nextSeq++
		s.events = append(s.events, *ev)
		s.apply(ev)
	}
	data, err := json.Marshal(snapshot{Schema: SnapshotSchema, Events: s.events})
	if err == nil {
		err = s.snap.Save(ctx, data)
	}
	if err == nil {
		s.degraded = false
		s.degradedReason = ""
		return nil
	}
	// roll the local mutation back before deciding how to report
	s.events = s.events[:n]
	s.rebuild()
	if errors.Is(err, ErrConcurrentWrite) {
		if rerr := s.reloadLocked(ctx); rerr != nil {
			s.degraded = true
			s.degradedReason = fmt.Sprintf("conflict reload failed: %v", rerr)
			return fmt.Errorf("persist ledger: %w (reload failed: %v)", err, rerr)
		}
		return fmt.Errorf("%w: %v", ErrLedgerConflict, err)
	}
	s.degraded = true
	s.degradedReason = err.Error()
	return fmt.Errorf("persist ledger: %w", err)
}

// reloadLocked replaces in-memory state with the persisted snapshot (callers
// hold s.mu). Used after a definite concurrent-write so a retry sees the other
// writer's events.
func (s *Store) reloadLocked(ctx context.Context) error {
	data, err := s.snap.Load(ctx)
	if err != nil {
		return err
	}
	var sn snapshot
	if len(data) > 0 {
		if err := json.Unmarshal(data, &sn); err != nil {
			return fmt.Errorf("parse snapshot: %w", err)
		}
	}
	s.events = sn.Events
	s.rebuild()
	return nil
}

// pastTTL reports whether an ACTIVE lease has missed its heartbeat TTL.
func pastTTL(l *Lease, now time.Time) bool {
	return l.Status == StatusActive &&
		now.After(l.HeartbeatAt.Add(time.Duration(l.TTLSeconds)*time.Second))
}

// viewStatus is the lease status AS OF now, computed view-side: an active
// lease past its TTL reads as expired even before a mutating operation has
// persisted the expired event. Read paths use this so they never need to
// write — reads must keep working from memory when storage is down.
func viewStatus(l *Lease, now time.Time) LeaseStatus {
	if pastTTL(l, now) {
		return StatusExpired
	}
	return l.Status
}

// sweepExpired lazily marks active leases whose heartbeat is past TTL as
// expired. Called at the top of MUTATING operations only (no background
// daemon); read paths use viewStatus instead so they never persist. Expired is
// not deleted: events and the lease record are preserved.
func (s *Store) sweepExpired(ctx context.Context) error {
	now := s.now()
	var evs []*Event
	for _, id := range s.order {
		l := s.leases[id]
		if l.Status != StatusActive {
			continue
		}
		if pastTTL(l, now) {
			evs = append(evs, &Event{
				Type:    EventExpired,
				LeaseID: l.ID,
				Actor:   SweepActor,
				At:      now,
				Detail:  fmt.Sprintf("no heartbeat since %s (ttl %ds)", l.HeartbeatAt.UTC().Format(time.RFC3339), l.TTLSeconds),
			})
		}
	}
	if len(evs) == 0 {
		return nil
	}
	return s.appendAndSave(ctx, evs...)
}

// ClaimRequest is the input to Claim.
type ClaimRequest struct {
	Agent      string // authenticated identity (from transport, never client-chosen args)
	Branches   []string
	Claims     []Claim
	Excludes   []string
	PR         int
	TTLSeconds int
	Notes      string
	// LeaseID, when set, narrows/replaces an existing ACTIVE lease owned by
	// Agent instead of creating a new one (emits a "narrowed" event).
	LeaseID string
	// Coordinator permits narrowing another agent's lease (e.g. un-blocking an
	// over-broad claim) — attributable via the event actor.
	Coordinator bool
}

// Claim atomically registers a lease. It rejects (with *OverlapError) if any
// requested claim could overlap another agent's active claims — the race-free
// property: the check and the write happen under one lock.
func (s *Store) Claim(ctx context.Context, req ClaimRequest) (*Lease, error) {
	if err := validateClaim(&req); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.sweepExpired(ctx); err != nil {
		return nil, err
	}

	var target *Lease
	if req.LeaseID != "" {
		l, ok := s.leases[req.LeaseID]
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, req.LeaseID)
		}
		if l.Status != StatusActive {
			return nil, fmt.Errorf("%w: %s is %s", ErrNotActive, l.ID, l.Status)
		}
		if l.Agent != req.Agent && !req.Coordinator {
			return nil, fmt.Errorf("%w: lease %s belongs to %s", ErrNotOwner, l.ID, l.Agent)
		}
		target = l
	}

	// Overlap check against OTHER agents' active leases. Identity-keyed: an
	// agent's own leases never block it (fixes the branch-name-mismatch
	// false-block class).
	owner := req.Agent
	if target != nil {
		owner = target.Agent
	}
	if conflicts := s.claimConflicts(req.Claims, req.Excludes, owner, target); len(conflicts) > 0 {
		return nil, &OverlapError{Conflicts: conflicts}
	}

	now := s.now()
	if target != nil {
		updated := cloneLease(target)
		updated.Branches = req.Branches
		updated.Claims = req.Claims
		updated.Excludes = req.Excludes
		if req.PR != 0 {
			updated.PR = req.PR
		}
		updated.TTLSeconds = req.TTLSeconds
		if req.Notes != "" {
			updated.Notes = req.Notes
		}
		updated.HeartbeatAt = now
		ev := &Event{
			Type:    EventNarrowed,
			LeaseID: updated.ID,
			Actor:   req.Agent,
			At:      now,
			Detail:  "claims replaced",
			Lease:   updated,
		}
		if err := s.appendAndSave(ctx, ev); err != nil {
			return nil, err
		}
		return cloneLease(updated), nil
	}

	lease := &Lease{
		ID:          fmt.Sprintf("L-%d", s.nextSeq),
		Agent:       req.Agent,
		Branches:    req.Branches,
		Claims:      req.Claims,
		Excludes:    req.Excludes,
		PR:          req.PR,
		ClaimedAt:   now,
		HeartbeatAt: now,
		TTLSeconds:  req.TTLSeconds,
		Notes:       req.Notes,
		Status:      StatusActive,
	}
	ev := &Event{Type: EventClaimed, LeaseID: lease.ID, Actor: req.Agent, At: now, Lease: lease}
	if err := s.appendAndSave(ctx, ev); err != nil {
		return nil, err
	}
	return cloneLease(lease), nil
}

func validateClaim(req *ClaimRequest) error {
	if req.Agent == "" {
		return fmt.Errorf("%w: agent identity required (X-Coord-Agent header)", ErrValidation)
	}
	if len(req.Branches) == 0 {
		return fmt.Errorf("%w: at least one branch required", ErrValidation)
	}
	if len(req.Claims) == 0 {
		return fmt.Errorf("%w: at least one claim required", ErrValidation)
	}
	for i := range req.Claims {
		c := &req.Claims[i]
		c.Path = strings.TrimSpace(c.Path)
		if c.Path == "" {
			return fmt.Errorf("%w: claim path must not be empty", ErrValidation)
		}
		if strings.HasPrefix(c.Path, "!") {
			return fmt.Errorf("%w: exclusions go in excludes[], not a %q claim path", ErrValidation, c.Path)
		}
		switch c.Mode {
		case "":
			c.Mode = ModeExclusive
		case ModeExclusive, ModeSharedAppend:
		default:
			return fmt.Errorf("%w: unknown claim mode %q (exclusive | shared-append)", ErrValidation, c.Mode)
		}
	}
	switch {
	case req.TTLSeconds == 0:
		req.TTLSeconds = DefaultTTLSeconds
	case req.TTLSeconds < MinTTLSeconds || req.TTLSeconds > MaxTTLSeconds:
		return fmt.Errorf("%w: ttlSeconds must be between %d and %d", ErrValidation, MinTTLSeconds, MaxTTLSeconds)
	}
	return nil
}

// claimConflicts checks requested claim GLOBS against other agents' active
// leases, using the coordination overlap semantics:
//   - my exclusive vs ALL of theirs (exclusive + shared-append) conflicts;
//   - my shared-append vs their EXCLUSIVE only (shared-append coexists);
//   - either side's excludes subtract best-effort (glob tokens compared as
//     concrete paths against the exclusion globs);
//   - glob-vs-glob intersection via literal-prefix comparison.
//
// skip (when non-nil) is the lease being narrowed — never conflicts with itself.
func (s *Store) claimConflicts(claims []Claim, excludes []string, agent string, skip *Lease) []Conflict {
	var out []Conflict
	for _, id := range s.order {
		other := s.leases[id]
		if other.Status != StatusActive || other.Agent == agent {
			continue
		}
		if skip != nil && other.ID == skip.ID {
			continue
		}
		for _, mine := range claims {
			for _, theirs := range other.Claims {
				if mine.Mode == ModeSharedAppend && theirs.Mode == ModeSharedAppend {
					continue // coexistence is the point of the token
				}
				if !globsIntersect(mine.Path, theirs.Path) {
					continue
				}
				if len(other.Excludes) > 0 && FileMatchesAnyGlob(mine.Path, other.Excludes) {
					continue
				}
				if len(excludes) > 0 && FileMatchesAnyGlob(theirs.Path, excludes) {
					continue
				}
				out = append(out, Conflict{
					File:    mine.Path,
					LeaseID: other.ID,
					Agent:   other.Agent,
					Branch:  firstBranch(other),
					Glob:    theirs.Path,
					Mode:    theirs.Mode,
				})
			}
		}
	}
	return out
}

// Release ends a lease. ONLY the owning agent identity or a coordinator may
// release — the anti-self-unclaim / never-auto-release property: expiry marks a
// lease expired but NEVER releases it; only an explicit, attributable call does.
func (s *Store) Release(ctx context.Context, leaseID, actor string, coordinator bool) (*Lease, error) {
	if actor == "" {
		return nil, fmt.Errorf("%w: agent identity required", ErrValidation)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.sweepExpired(ctx); err != nil {
		return nil, err
	}
	l, ok := s.leases[leaseID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, leaseID)
	}
	if l.Agent != actor && !coordinator {
		return nil, fmt.Errorf("%w: lease %s belongs to %s", ErrNotOwner, leaseID, l.Agent)
	}
	if l.Status == StatusReleased {
		return nil, fmt.Errorf("%w: %s already released", ErrNotActive, leaseID)
	}
	detail := "released by owner"
	if l.Agent != actor {
		detail = "released by coordinator"
	}
	ev := &Event{Type: EventReleased, LeaseID: leaseID, Actor: actor, At: s.now(), Detail: detail}
	if err := s.appendAndSave(ctx, ev); err != nil {
		return nil, err
	}
	return cloneLease(l), nil
}

// Heartbeat refreshes a lease's liveness (owner only) and optionally updates
// its TTL.
func (s *Store) Heartbeat(ctx context.Context, leaseID, actor string, ttlSeconds int) (*Lease, error) {
	if actor == "" {
		return nil, fmt.Errorf("%w: agent identity required", ErrValidation)
	}
	if ttlSeconds != 0 && (ttlSeconds < MinTTLSeconds || ttlSeconds > MaxTTLSeconds) {
		return nil, fmt.Errorf("%w: ttlSeconds must be between %d and %d", ErrValidation, MinTTLSeconds, MaxTTLSeconds)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.sweepExpired(ctx); err != nil {
		return nil, err
	}
	l, ok := s.leases[leaseID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, leaseID)
	}
	if l.Agent != actor {
		return nil, fmt.Errorf("%w: lease %s belongs to %s", ErrNotOwner, leaseID, l.Agent)
	}
	if l.Status != StatusActive {
		return nil, fmt.Errorf("%w: %s is %s (claim again)", ErrNotActive, leaseID, l.Status)
	}
	ev := &Event{Type: EventHeartbeat, LeaseID: leaseID, Actor: actor, At: s.now(), TTLSeconds: ttlSeconds}
	if err := s.appendAndSave(ctx, ev); err != nil {
		return nil, err
	}
	return cloneLease(l), nil
}

// CheckOverlap reports which of the given FILES fall under another agent's
// active claims (the coordination check semantics), including the shared-append
// consent model: another lane's shared-append claim does not block an agent
// that ALSO holds an active shared-append claim on the file; an agent with no
// claim on the path is still blocked.
func (s *Store) CheckOverlap(_ context.Context, files []string, agent string) ([]Conflict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// READ PATH: no sweep, no persist — expiry is computed view-side so this
	// keeps answering from memory when the snapshotter is unavailable.
	now := s.now()
	var mine []*Lease
	var others []*Lease
	for _, id := range s.order {
		l := s.leases[id]
		if viewStatus(l, now) != StatusActive {
			continue
		}
		if l.Agent == agent {
			mine = append(mine, l)
		} else {
			others = append(others, l)
		}
	}
	var out []Conflict
	for _, f := range files {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		for _, l := range others {
			mode := leaseClaimMode(f, l)
			if mode == "" {
				continue
			}
			if mode == ModeSharedAppend {
				consented := false
				for _, m := range mine {
					if leaseClaimMode(f, m) == ModeSharedAppend {
						consented = true
						break
					}
				}
				if consented {
					continue
				}
			}
			out = append(out, Conflict{
				File:    f,
				LeaseID: l.ID,
				Agent:   l.Agent,
				Branch:  firstBranch(l),
				Glob:    claimGlobFor(f, l),
				Mode:    mode,
			})
		}
	}
	return out, nil
}

// ListLeases returns the current view (active only unless includeInactive),
// oldest claim first. READ PATH: expiry is computed view-side (a returned
// lease past its TTL reads as expired even before a mutating call persists
// the expired event) — no persist, so listing works when storage is down.
func (s *Store) ListLeases(_ context.Context, includeInactive bool) ([]*Lease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var out []*Lease
	for _, id := range s.order {
		l := s.leases[id]
		st := viewStatus(l, now)
		if !includeInactive && st != StatusActive {
			continue
		}
		cp := cloneLease(l)
		cp.Status = st
		out = append(out, cp)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ClaimedAt.Before(out[j].ClaimedAt) })
	return out, nil
}

// Events returns the last `tail` events of the append-only audit log
// (all events if tail <= 0). READ PATH: no sweep, no persist — an expired
// event for a TTL-lapsed lease appears only after the next mutating call.
func (s *Store) Events(_ context.Context, tail int) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := 0
	if tail > 0 && len(s.events) > tail {
		start = len(s.events) - tail
	}
	out := make([]Event, len(s.events)-start)
	copy(out, s.events[start:])
	return out, nil
}

// ── helpers ──────────────────────────────────────────────────────────────

func cloneLease(l *Lease) *Lease {
	cp := *l
	cp.Branches = append([]string(nil), l.Branches...)
	cp.Claims = append([]Claim(nil), l.Claims...)
	cp.Excludes = append([]string(nil), l.Excludes...)
	return &cp
}

func firstBranch(l *Lease) string {
	if len(l.Branches) > 0 {
		return l.Branches[0]
	}
	return ""
}

// claimGlobFor returns the specific glob in l that claims file (for messages).
func claimGlobFor(file string, l *Lease) string {
	for _, c := range l.Claims {
		if FileMatchesGlob(file, c.Path) {
			return c.Path
		}
	}
	return ""
}
