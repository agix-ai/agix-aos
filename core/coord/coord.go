// Package coord is the coordination lease seam — the "shares" beehive property
// and the stigmergy substrate. Agents coordinate THROUGH a shared medium (the
// lease ledger), not by chatter: claim a path scope before working so parallel
// bees never collide.
//
// The LeaseLedger interface mirrors the tools of services/coord-mcp
// (claim_lease / release_lease / heartbeat / check_overlap). MemLedger is a
// working in-process implementation the agent path uses (real and testable).
// A future MCPLeaseLedger will speak to the real coord-mcp server over stdio so
// a whole hive can share ONE ledger across processes/machines — see the seam
// note on MCPLeaseLedger below.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package coord

import (
	"context"
	"errors"
	"path"
	"sort"
	"strings"
	"time"
)

// ClaimMode is a coordination scope-token kind, mirroring coord-mcp.
type ClaimMode string

const (
	// ModeExclusive blocks every other lane on the claimed paths.
	ModeExclusive ClaimMode = "exclusive"
	// ModeSharedAppend lets multiple lanes hold the same path without
	// mutually blocking; an exclusive claim still blocks everyone else.
	ModeSharedAppend ClaimMode = "shared-append"
)

// LeaseStatus is the lifecycle state of a lease.
type LeaseStatus string

const (
	StatusActive   LeaseStatus = "active"
	StatusReleased LeaseStatus = "released"
	StatusExpired  LeaseStatus = "expired"
)

// Claim is one claimed path glob with its mode.
type Claim struct {
	Path string    `json:"path"`
	Mode ClaimMode `json:"mode"`
}

// ClaimRequest is the input to Claim, mirroring coord-mcp's claim args.
type ClaimRequest struct {
	Agent      string   `json:"agent"`
	Branches   []string `json:"branches,omitempty"`
	Claims     []Claim  `json:"claims"`
	Excludes   []string `json:"excludes,omitempty"`
	TTLSeconds int      `json:"ttlSeconds,omitempty"`
	Notes      string   `json:"notes,omitempty"`
	// LeaseID narrows/replaces an existing lease you own instead of creating one.
	LeaseID string `json:"leaseId,omitempty"`
}

// Lease is one structured lease row.
type Lease struct {
	ID          string      `json:"id"`
	Agent       string      `json:"agent"`
	Branches    []string    `json:"branches,omitempty"`
	Claims      []Claim     `json:"claims"`
	Excludes    []string    `json:"excludes,omitempty"`
	ClaimedAt   time.Time   `json:"claimedAt"`
	HeartbeatAt time.Time   `json:"heartbeatAt"`
	TTLSeconds  int         `json:"ttlSeconds"`
	Notes       string      `json:"notes,omitempty"`
	Status      LeaseStatus `json:"status"`
}

// Conflict describes an overlap between a file and another agent's active lease.
type Conflict struct {
	File    string    `json:"file"`
	LeaseID string    `json:"leaseId"`
	Agent   string    `json:"agent"`
	Glob    string    `json:"glob"`
	Mode    ClaimMode `json:"mode"`
}

// LeaseLedger is the coordination control plane. Implementations must be safe
// for concurrent use.
type LeaseLedger interface {
	Claim(ctx context.Context, req ClaimRequest) (Lease, error)
	Release(ctx context.Context, leaseID, agent string) error
	Heartbeat(ctx context.Context, leaseID, agent string) error
	CheckOverlap(ctx context.Context, files []string, agent string) ([]Conflict, error)
}

const defaultTTLSeconds = 21600 // 6h, mirroring coord-mcp

// pathMatch reports whether glob pattern matches the concrete path name.
// Supports `*`/`?`/`[]` within a segment, `**` across segments, and a bare
// directory (no metachars) matching its whole subtree — mirroring coord-mcp.
func pathMatch(pattern, name string) bool {
	pattern = strings.TrimSuffix(pattern, "/")
	if pattern == name {
		return true
	}
	if !strings.ContainsAny(pattern, "*?[") && strings.HasPrefix(name, pattern+"/") {
		return true
	}
	return segMatch(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func segMatch(pat, name []string) bool {
	if len(pat) == 0 {
		return len(name) == 0
	}
	if pat[0] == "**" {
		for i := 0; i <= len(name); i++ {
			if segMatch(pat[1:], name[i:]) {
				return true
			}
		}
		return false
	}
	if len(name) == 0 {
		return false
	}
	ok, err := path.Match(pat[0], name[0])
	if err != nil || !ok {
		return false
	}
	return segMatch(pat[1:], name[1:])
}

// globsOverlap reports whether two claim globs can match a common path. A
// heuristic sufficient for the seed: treat each glob as a representative name
// for the other.
func globsOverlap(a, b string) bool {
	return a == b || pathMatch(a, b) || pathMatch(b, a)
}

// excluded reports whether any exclude glob covers the file.
func excluded(excludes []string, file string) bool {
	for _, ex := range excludes {
		if pathMatch(ex, file) {
			return true
		}
	}
	return false
}

var _ LeaseLedger = (*MemLedger)(nil)
var _ LeaseLedger = (*MCPLeaseLedger)(nil)

// ─── seam: MCPLeaseLedger ──────────────────────────────────────────────────
//
// seam: MCPLeaseLedger will speak to the real services/coord-mcp MCP server
// over stdio (the claim_lease / release_lease / heartbeat / check_overlap
// tools) so a whole hive can share ONE coordination ledger across processes and
// machines — the true stigmergy substrate. Tonight it is an HONEST stub: the
// interface above is the contract, MemLedger below is the working in-process
// implementation, and this adapter is the next step. Do NOT hand-roll the MCP
// client here yet.
type MCPLeaseLedger struct {
	// Command is the stdio command to launch services/coord-mcp, e.g.
	// []string{"go", "run", "./services/coord-mcp"}.
	Command []string
}

// ErrMCPNotImplemented is returned by every MCPLeaseLedger method until the
// stdio MCP client is built.
var ErrMCPNotImplemented = errors.New("coord: MCP-client LeaseLedger not implemented yet (seam) — use MemLedger")

func (*MCPLeaseLedger) Claim(context.Context, ClaimRequest) (Lease, error) {
	return Lease{}, ErrMCPNotImplemented
}
func (*MCPLeaseLedger) Release(context.Context, string, string) error { return ErrMCPNotImplemented }
func (*MCPLeaseLedger) Heartbeat(context.Context, string, string) error {
	return ErrMCPNotImplemented
}
func (*MCPLeaseLedger) CheckOverlap(context.Context, []string, string) ([]Conflict, error) {
	return nil, ErrMCPNotImplemented
}

// sortedLeases returns the ledger's leases in a stable ID order (deterministic
// conflict reporting despite map iteration).
func sortedLeases(m map[string]*Lease) []*Lease {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*Lease, 0, len(ids))
	for _, id := range ids {
		out = append(out, m[id])
	}
	return out
}
