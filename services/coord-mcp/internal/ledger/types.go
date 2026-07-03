// Package ledger implements the coord-mcp lease ledger: an append-only event
// log plus a materialized current-leases view. This is the coordination
// control plane — the substrate the loop-engineered SDLC's Integrate gate and
// parallel-agent safety assume (agents claim path globs before editing; the
// server refuses overlapping exclusive claims race-free).
package ledger

import "time"

// ClaimMode is one of the coordination scope-token kinds.
type ClaimMode string

const (
	// ModeExclusive blocks every other lane on the claimed paths.
	ModeExclusive ClaimMode = "exclusive"
	// ModeSharedAppend allows concurrent append-only claims: multiple lanes
	// may hold the same path as shared-append without mutually blocking. An
	// exclusive claim on the path still blocks everyone else, and a lane with
	// no claim at all on the path is still blocked (the consent model).
	ModeSharedAppend ClaimMode = "shared-append"
)

// Claim is one claimed path glob with its mode.
type Claim struct {
	Path string    `json:"path"`
	Mode ClaimMode `json:"mode"`
}

// LeaseStatus is the lifecycle state of a lease in the materialized view.
type LeaseStatus string

const (
	StatusActive LeaseStatus = "active"
	// StatusReleased means the owning agent (or a coordinator) explicitly
	// released the lease. Releases are never automatic.
	StatusReleased LeaseStatus = "released"
	// StatusExpired means the lease missed its heartbeat TTL and was marked
	// expired by the lazy sweep. Expired is NOT deleted: the lease and all its
	// events remain in the audit log. It simply stops blocking new claims.
	StatusExpired LeaseStatus = "expired"
)

// Lease is one structured lease row.
type Lease struct {
	ID          string      `json:"id"`
	Agent       string      `json:"agent"`
	Branches    []string    `json:"branches"`
	Claims      []Claim     `json:"claims"`
	Excludes    []string    `json:"excludes,omitempty"`
	PR          int         `json:"pr,omitempty"`
	ClaimedAt   time.Time   `json:"claimedAt"`
	HeartbeatAt time.Time   `json:"heartbeatAt"`
	TTLSeconds  int         `json:"ttlSeconds"`
	Notes       string      `json:"notes,omitempty"`
	Status      LeaseStatus `json:"status"`
	// ReleasedBy records WHO ended the lease (owner agent or coordinator) —
	// releases are attributable, never anonymous row edits.
	ReleasedBy string `json:"releasedBy,omitempty"`
}

// EventType enumerates the append-only event kinds.
type EventType string

const (
	EventClaimed   EventType = "claimed"
	EventReleased  EventType = "released"
	EventHeartbeat EventType = "heartbeat"
	EventExpired   EventType = "expired"
	EventNarrowed  EventType = "narrowed"
)

// Event is one append-only audit record. Events are never mutated or deleted.
type Event struct {
	Seq     int64     `json:"seq"`
	Type    EventType `json:"type"`
	LeaseID string    `json:"leaseId"`
	// Actor is the authenticated identity that performed the action (from the
	// X-Coord-Agent header). For "expired" events the actor is "system:sweep".
	Actor  string    `json:"actor"`
	At     time.Time `json:"at"`
	Detail string    `json:"detail,omitempty"`
	// TTLSeconds, on heartbeat events, records a TTL update (0 = unchanged).
	TTLSeconds int `json:"ttlSeconds,omitempty"`
	// Lease is a point-in-time snapshot of the lease for claimed/narrowed
	// events, so the audit log alone can reconstruct history.
	Lease *Lease `json:"lease,omitempty"`
}

// Conflict describes an overlap between a file (or claim glob) and another
// agent's active lease.
type Conflict struct {
	File    string    `json:"file"`
	LeaseID string    `json:"leaseId"`
	Agent   string    `json:"agent"`
	Branch  string    `json:"branch,omitempty"`
	Glob    string    `json:"glob"`
	Mode    ClaimMode `json:"mode"`
}
