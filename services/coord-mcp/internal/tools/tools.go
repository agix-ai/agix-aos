// Package tools registers the coord-mcp MCP tools over the lease ledger — the
// coordination control plane exposed so any MCP-speaking agent (Claude Code,
// Cursor, the Agix fleet) can claim work, check overlaps, and read the audit
// log as tools.
package tools

import (
	"context"
	"errors"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/services/coord-mcp/internal/ledger"
	"github.com/agix-ai/agix/services/go-common/auth"
)

// CoordHeaders is coord-mcp's wire contract for the shared-key fallback and
// identity-attribution headers.
var CoordHeaders = auth.Headers{Key: "X-Coord-Key", Agent: "X-Coord-Agent"}

// Instructions is the server-level guidance surfaced to MCP clients.
const Instructions = `agix-coord-mcp — the agent-coordination lease ledger.

Claim a work lease over path globs BEFORE editing so parallel agents never
collide. Claims are atomic and race-free: an exclusive claim that overlaps
another agent's active claim is rejected. Leases are identity-keyed (your own
leases never block you across branches), carry a liveness TTL (heartbeat to
extend), and are NEVER auto-released — expiry marks a lease expired (preserving
all its events) but only the owning agent, or a coordinator, can release it.

Identity: your agent name comes from the X-Coord-Agent header (HTTP) or the
server's COORD_MCP_AGENT env (stdio). The append-only event log is the source
of truth; the current-leases view is a replay of it.`

// Config wires the tool handlers.
type Config struct {
	Store *ledger.Store
	Keys  auth.Keys
	// StdioIdentity is used when the transport carries no HTTP headers
	// (local stdio runs).
	StdioIdentity auth.Identity
	Version       string
	// Ledger, when set, enables the read-only audit-ledger tools
	// (ledger_read / ledger_stats) over the Agix governance JSONL.
	Ledger *AuditLedgerReader
}

type service struct {
	cfg Config
}

// NewServer builds the MCP server with all coord tools registered (plus the
// audit-ledger read tools when cfg.Ledger is set).
func NewServer(cfg Config) *mcp.Server {
	s := &service{cfg: cfg}
	srv := mcp.NewServer(
		&mcp.Implementation{Name: "agix-coord-mcp", Title: "Agix coordination ledger", Version: cfg.Version},
		&mcp.ServerOptions{Instructions: Instructions},
	)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "claim_lease",
		Description: "Claim a work lease over path globs before editing. Atomically REJECTS if any " +
			"exclusive claim overlaps another agent's active claims (race-free). Glob syntax: " +
			"`*` (within a segment), `**` (any depth), `?` (one char), bare dir = whole subtree; " +
			"excludes[] subtract from YOUR claims; mode \"shared-append\" coexists with other " +
			"shared-append holders. Pass leaseId to narrow/replace a lease you own.",
	}, s.claimLease)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "release_lease",
		Description: "Release a lease when your work has merged. ONLY the owning agent identity or a " +
			"coordinator key may release — leases are never auto-released, and never release " +
			"someone else's lease without coordinator authority.",
	}, s.releaseLease)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "heartbeat",
		Description: "Extend a lease's liveness (owner only). Leases with no heartbeat past their TTL " +
			"are marked expired (not deleted) by a lazy sweep and stop blocking claims. " +
			"Optionally update ttlSeconds.",
	}, s.heartbeat)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_leases",
		Description: "List current leases (active only by default; includeInactive for " +
			"released/expired). Compact — a handful of rows, not a whole-file read.",
	}, s.listLeases)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "check_overlap",
		Description: "Check whether specific FILES fall under another agent's active claim. Your own " +
			"leases never conflict with you; another lane's shared-append claim doesn't block you " +
			"if you also hold shared-append on the file.",
	}, s.checkOverlap)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "get_events",
		Description: "Tail the append-only audit log (claimed / released / heartbeat / expired / " +
			"narrowed). Events are never mutated or deleted.",
	}, s.getEvents)

	if cfg.Ledger != nil {
		s.registerLedgerTools(srv)
	}

	return srv
}

// identity resolves the caller identity. HTTP requests carry headers in
// req.Extra (re-verified here — defense in depth on top of the middleware);
// stdio requests fall back to the configured static identity.
func (s *service) identity(ctx context.Context, req *mcp.CallToolRequest) (auth.Identity, error) {
	if req != nil && req.Extra != nil && req.Extra.Header != nil {
		coordinator, ok := s.cfg.Keys.Authenticate(CoordHeaders.PresentedKey(req.Extra.Header))
		if !ok {
			return auth.Identity{}, errors.New("unauthorized: missing or invalid bearer key")
		}
		return CoordHeaders.Identity(req.Extra.Header, coordinator), nil
	}
	if id, ok := auth.FromContext(ctx); ok {
		return id, nil
	}
	return s.cfg.StdioIdentity, nil
}

// ── claim_lease ──────────────────────────────────────────────────────────

// claimSpec is the wire shape of one claim (mode optional, defaults exclusive).
type claimSpec struct {
	Path string `json:"path" jsonschema:"path glob to claim"`
	Mode string `json:"mode,omitempty" jsonschema:"exclusive (default) or shared-append"`
}

type claimArgs struct {
	Branches   []string    `json:"branches" jsonschema:"git branch names this lane works on (own leases never block you across branches)"`
	Claims     []claimSpec `json:"claims" jsonschema:"path globs to claim; mode is exclusive (default) or shared-append"`
	Excludes   []string    `json:"excludes,omitempty" jsonschema:"globs subtracted from this lease's claims"`
	PR         int         `json:"pr,omitempty" jsonschema:"open PR number for this lane, if any"`
	TTLSeconds int         `json:"ttlSeconds,omitempty" jsonschema:"liveness TTL in seconds (default 21600 = 6h, min 60, max 86400); heartbeat to extend"`
	Notes      string      `json:"notes,omitempty" jsonschema:"human-readable note about this lane"`
	LeaseID    string      `json:"leaseId,omitempty" jsonschema:"narrow/replace this existing lease you own instead of creating a new one"`
}

type leaseResult struct {
	Lease   *ledger.Lease `json:"lease"`
	Message string        `json:"message"`
}

func (s *service) claimLease(ctx context.Context, req *mcp.CallToolRequest, in claimArgs) (*mcp.CallToolResult, leaseResult, error) {
	id, err := s.identity(ctx, req)
	if err != nil {
		return nil, leaseResult{}, err
	}
	claims := make([]ledger.Claim, len(in.Claims))
	for i, c := range in.Claims {
		claims[i] = ledger.Claim{Path: c.Path, Mode: ledger.ClaimMode(c.Mode)}
	}
	lease, err := s.cfg.Store.Claim(ctx, ledger.ClaimRequest{
		Agent:       id.Agent,
		Branches:    in.Branches,
		Claims:      claims,
		Excludes:    in.Excludes,
		PR:          in.PR,
		TTLSeconds:  in.TTLSeconds,
		Notes:       in.Notes,
		LeaseID:     in.LeaseID,
		Coordinator: id.Coordinator,
	})
	if err != nil {
		return nil, leaseResult{}, err
	}
	verb := "claimed"
	if in.LeaseID != "" {
		verb = "narrowed"
	}
	return nil, leaseResult{
		Lease:   lease,
		Message: fmt.Sprintf("%s %s for %s (ttl %ds).", verb, lease.ID, lease.Agent, lease.TTLSeconds),
	}, nil
}

// ── release_lease ────────────────────────────────────────────────────────

type releaseArgs struct {
	LeaseID string `json:"leaseId" jsonschema:"the lease to release (owner or coordinator only)"`
}

func (s *service) releaseLease(ctx context.Context, req *mcp.CallToolRequest, in releaseArgs) (*mcp.CallToolResult, leaseResult, error) {
	id, err := s.identity(ctx, req)
	if err != nil {
		return nil, leaseResult{}, err
	}
	lease, err := s.cfg.Store.Release(ctx, in.LeaseID, id.Agent, id.Coordinator)
	if err != nil {
		return nil, leaseResult{}, err
	}
	return nil, leaseResult{
		Lease:   lease,
		Message: fmt.Sprintf("released %s.", lease.ID),
	}, nil
}

// ── heartbeat ────────────────────────────────────────────────────────────

type heartbeatArgs struct {
	LeaseID    string `json:"leaseId" jsonschema:"the lease to keep alive (owner only)"`
	TTLSeconds int    `json:"ttlSeconds,omitempty" jsonschema:"optionally update the TTL (seconds)"`
}

func (s *service) heartbeat(ctx context.Context, req *mcp.CallToolRequest, in heartbeatArgs) (*mcp.CallToolResult, leaseResult, error) {
	id, err := s.identity(ctx, req)
	if err != nil {
		return nil, leaseResult{}, err
	}
	lease, err := s.cfg.Store.Heartbeat(ctx, in.LeaseID, id.Agent, in.TTLSeconds)
	if err != nil {
		return nil, leaseResult{}, err
	}
	return nil, leaseResult{Lease: lease, Message: fmt.Sprintf("heartbeat recorded for %s", lease.ID)}, nil
}

// ── list_leases ──────────────────────────────────────────────────────────

type listArgs struct {
	IncludeInactive bool `json:"includeInactive,omitempty" jsonschema:"also return released and expired leases"`
}

type listResult struct {
	Count  int             `json:"count"`
	Leases []*ledger.Lease `json:"leases"`
	// Degraded is true when the last persist could not be confirmed durable —
	// reads still serve from memory, writes fail closed. Treat verdicts with
	// extra caution and alert the operator.
	Degraded       bool   `json:"degraded,omitempty"`
	DegradedReason string `json:"degradedReason,omitempty"`
}

func (s *service) listLeases(ctx context.Context, _ *mcp.CallToolRequest, in listArgs) (*mcp.CallToolResult, listResult, error) {
	leases, err := s.cfg.Store.ListLeases(ctx, in.IncludeInactive)
	if err != nil {
		return nil, listResult{}, err
	}
	deg, reason := s.cfg.Store.Degraded()
	return nil, listResult{Count: len(leases), Leases: leases, Degraded: deg, DegradedReason: reason}, nil
}

// ── check_overlap ────────────────────────────────────────────────────────

type checkArgs struct {
	Files []string `json:"files" jsonschema:"concrete file paths to check against other agents' active claims"`
	Agent string   `json:"agent,omitempty" jsonschema:"coordinator only: check on behalf of this agent; everyone else is checked as their authenticated identity"`
}

type checkResult struct {
	OK        bool              `json:"ok"`
	Conflicts []ledger.Conflict `json:"conflicts"`
	Message   string            `json:"message"`
}

func (s *service) checkOverlap(ctx context.Context, req *mcp.CallToolRequest, in checkArgs) (*mcp.CallToolResult, checkResult, error) {
	id, err := s.identity(ctx, req)
	if err != nil {
		return nil, checkResult{}, err
	}
	// The effective agent (whose own leases are excluded from conflicts) is
	// ALWAYS the authenticated identity. Letting the caller pick it would let
	// any agent pass agent=<owner> and get a false "no overlap" on the owner's
	// files. Only the coordinator key may check on another agent's behalf.
	agent := id.Agent
	overrideIgnored := ""
	if in.Agent != "" && in.Agent != id.Agent {
		if id.Coordinator {
			agent = in.Agent
		} else {
			overrideIgnored = fmt.Sprintf(" (agent=%q ignored — checks run as your authenticated identity %q; coordinator key required to check on another agent's behalf)", in.Agent, id.Agent)
		}
	}
	conflicts, err := s.cfg.Store.CheckOverlap(ctx, in.Files, agent)
	if err != nil {
		return nil, checkResult{}, err
	}
	if len(conflicts) > 0 {
		return nil, checkResult{
			OK:        false,
			Conflicts: conflicts,
			Message: fmt.Sprintf("OVERLAP — %d file(s) fall under another agent's active claim. "+
				"Do NOT override: narrow your scope or route the change to the owner.%s", len(conflicts), overrideIgnored),
		}, nil
	}
	return nil, checkResult{
		OK:        true,
		Conflicts: []ledger.Conflict{},
		Message:   fmt.Sprintf("no lease overlap — %d file(s) clear of others' claims%s", len(in.Files), overrideIgnored),
	}, nil
}

// ── get_events ───────────────────────────────────────────────────────────

type eventsArgs struct {
	Tail int `json:"tail,omitempty" jsonschema:"return at most this many latest events (default 50, 0 = default)"`
}

type eventsResult struct {
	Count  int            `json:"count"`
	Events []ledger.Event `json:"events"`
	// Degraded mirrors listResult.Degraded (persistence unconfirmed).
	Degraded       bool   `json:"degraded,omitempty"`
	DegradedReason string `json:"degradedReason,omitempty"`
}

func (s *service) getEvents(ctx context.Context, _ *mcp.CallToolRequest, in eventsArgs) (*mcp.CallToolResult, eventsResult, error) {
	tail := in.Tail
	if tail <= 0 {
		tail = 50
	}
	events, err := s.cfg.Store.Events(ctx, tail)
	if err != nil {
		return nil, eventsResult{}, err
	}
	deg, reason := s.cfg.Store.Degraded()
	return nil, eventsResult{Count: len(events), Events: events, Degraded: deg, DegradedReason: reason}, nil
}
