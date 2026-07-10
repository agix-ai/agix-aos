package coord

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemLedger is a working in-process LeaseLedger — the stigmergy substrate the
// agent path uses. Safe for concurrent use. Overlap semantics mirror
// coord-mcp: an exclusive claim overlapping another agent's active claim
// conflicts; your own leases never block you; two shared-append claims coexist.
type MemLedger struct {
	mu     sync.Mutex
	seq    int
	leases map[string]*Lease
}

// NewMemLedger returns an empty in-process lease ledger.
func NewMemLedger() *MemLedger {
	return &MemLedger{leases: map[string]*Lease{}}
}

// Claim atomically claims a lease, rejecting overlaps with other agents' active
// exclusive claims (race-free under the mutex). Pass LeaseID to narrow/replace
// a lease you already own.
func (m *MemLedger) Claim(_ context.Context, req ClaimRequest) (Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	claims := make([]Claim, len(req.Claims))
	for i, c := range req.Claims {
		if c.Mode == "" {
			c.Mode = ModeExclusive
		}
		claims[i] = c
	}

	// Conflict check against every OTHER agent's active lease.
	for _, other := range sortedLeases(m.leases) {
		if other.Status != StatusActive || other.Agent == req.Agent {
			continue
		}
		if req.LeaseID != "" && other.ID == req.LeaseID {
			continue
		}
		for _, nc := range claims {
			for _, oc := range other.Claims {
				if nc.Mode == ModeSharedAppend && oc.Mode == ModeSharedAppend {
					continue // two append-only lanes coexist
				}
				if globsOverlap(nc.Path, oc.Path) {
					return Lease{}, fmt.Errorf(
						"lease conflict: %q overlaps %s's active claim %q (lease %s)",
						nc.Path, other.Agent, oc.Path, other.ID)
				}
			}
		}
	}

	now := time.Now().UTC()

	// Narrow/replace an existing lease you own.
	if req.LeaseID != "" {
		ex, ok := m.leases[req.LeaseID]
		if !ok {
			return Lease{}, fmt.Errorf("no such lease %q to narrow", req.LeaseID)
		}
		if ex.Agent != req.Agent {
			return Lease{}, fmt.Errorf("lease %s owned by %s, not %s", req.LeaseID, ex.Agent, req.Agent)
		}
		ex.Claims = claims
		ex.Branches = req.Branches
		ex.Excludes = req.Excludes
		ex.HeartbeatAt = now
		if req.TTLSeconds > 0 {
			ex.TTLSeconds = req.TTLSeconds
		}
		ex.Notes = req.Notes
		return *ex, nil
	}

	ttl := req.TTLSeconds
	if ttl <= 0 {
		ttl = defaultTTLSeconds
	}
	m.seq++
	l := &Lease{
		ID:          fmt.Sprintf("lease-%04d", m.seq),
		Agent:       req.Agent,
		Branches:    req.Branches,
		Claims:      claims,
		Excludes:    req.Excludes,
		ClaimedAt:   now,
		HeartbeatAt: now,
		TTLSeconds:  ttl,
		Notes:       req.Notes,
		Status:      StatusActive,
	}
	m.leases[l.ID] = l
	return *l, nil
}

// Release marks a lease released. Only the owning agent may release it; leases
// are never auto-released (mirroring coord-mcp).
func (m *MemLedger) Release(_ context.Context, leaseID, agent string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[leaseID]
	if !ok {
		return fmt.Errorf("no such lease %q", leaseID)
	}
	if l.Agent != agent {
		return fmt.Errorf("lease %s owned by %s, not %s (only the owner may release)", leaseID, l.Agent, agent)
	}
	l.Status = StatusReleased
	return nil
}

// Heartbeat extends a lease's liveness (owner only).
func (m *MemLedger) Heartbeat(_ context.Context, leaseID, agent string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[leaseID]
	if !ok {
		return fmt.Errorf("no such lease %q", leaseID)
	}
	if l.Agent != agent {
		return fmt.Errorf("lease %s owned by %s, not %s (only the owner may heartbeat)", leaseID, l.Agent, agent)
	}
	l.HeartbeatAt = time.Now().UTC()
	return nil
}

// CheckOverlap reports which of files fall under another agent's active
// exclusive claim. Your own leases never conflict; shared-append claims do not
// block.
func (m *MemLedger) CheckOverlap(_ context.Context, files []string, agent string) ([]Conflict, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var conflicts []Conflict
	for _, f := range files {
		for _, l := range sortedLeases(m.leases) {
			if l.Status != StatusActive || l.Agent == agent {
				continue
			}
			if excluded(l.Excludes, f) {
				continue
			}
			for _, c := range l.Claims {
				if c.Mode != ModeExclusive {
					continue
				}
				if pathMatch(c.Path, f) {
					conflicts = append(conflicts, Conflict{
						File: f, LeaseID: l.ID, Agent: l.Agent, Glob: c.Path, Mode: c.Mode,
					})
					break
				}
			}
		}
	}
	return conflicts, nil
}
