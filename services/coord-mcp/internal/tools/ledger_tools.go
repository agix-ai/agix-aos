// Ledger tools — the READ side of the Node↔Go shared substrate. ledger_read
// and ledger_stats expose the Agix governance audit ledger (the append-only
// JSONL system of record) so an external agent can inspect the fleet's verified
// verdicts, gate history, and governance rollups. Read-only by design: the
// append side stays on the Node runtime, the authority that shapes entries.
//
// Deferred (see DESIGN.md): ledger_append (governed writes) and the
// agent-invocation tools (list_agents / run_agent shelling to `agix agent run`)
// are follow-on work.
package tools

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/services/coord-mcp/internal/auditledger"
)

// AuditLedgerReader reads the governance audit-ledger JSONL (read-only).
type AuditLedgerReader = auditledger.Reader

// NewAuditLedgerReaderFromEnv resolves the audit-ledger path from the
// environment (AGIX_LEDGER_PATH, else AGIX_DATA_DIR/AGIX_TENANT, else the
// hidden default) and returns a reader plus a description. A not-yet-existent
// ledger reads as empty, so the tools are always safe to register.
func NewAuditLedgerReaderFromEnv() (*AuditLedgerReader, string) {
	return auditledger.ReaderFromEnv()
}

// ledgerReadOutputSchema is the output schema for ledger_read with the entry's
// free-form fields (meta / cost / authority_used) given an accept-anything
// schema. Those fields are json.RawMessage internally (raw-JSON preservation),
// and reflection would otherwise emit a []byte (byte-array) output schema — so
// an entry that actually carries a JSON object/number there (the common case:
// meta on rides-along extras, cost on merge entries, authority_used on governed
// entries) would fail the server's own output-schema validation and the whole
// ledger_read response would be rejected. Overriding json.RawMessage → {} (a
// schema that accepts any JSON value) fixes that while keeping the raw bytes.
var ledgerReadOutputSchema = buildLedgerReadOutputSchema()

func buildLedgerReadOutputSchema() *jsonschema.Schema {
	schema, err := jsonschema.For[ledgerReadResult](&jsonschema.ForOptions{
		TypeSchemas: map[reflect.Type]*jsonschema.Schema{
			// An empty schema accepts any JSON value (object / number / string
			// / array / bool / null) — exactly what a raw-JSON field may hold.
			reflect.TypeFor[json.RawMessage](): {},
		},
	})
	if err != nil {
		panic("tools: build ledger_read output schema: " + err.Error())
	}
	return schema
}

// registerLedgerTools mounts ledger_read + ledger_stats when cfg.Ledger is set.
func (s *service) registerLedgerTools(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "ledger_read",
		Description: "Read the Agix governance audit ledger (the append-only system of record: gate " +
			"decisions, verifier verdicts, merges, leases, releases, version bumps, launches). " +
			"Filter by kind, governance scope (enterpriseId/userId/roleId/mandateId/runId), and a " +
			"`since` ISO-8601 timestamp; `limit` returns the newest N. Read-only.",
		OutputSchema: ledgerReadOutputSchema,
	}, s.ledgerRead)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "ledger_stats",
		Description: "Summarize the Agix governance audit ledger over an optional filter (kind, scope, " +
			"since): totals plus counts by kind, verdict, and phase. Read-only.",
	}, s.ledgerStats)
}

// ── shared arg shapes ──────────────────────────────────────────────────────

type ledgerReadArgs struct {
	Kind         string `json:"kind,omitempty" jsonschema:"filter to one ledger kind (gate_decision, verdict, merge, lease, release, version_bump, launch)"`
	EnterpriseID string `json:"enterpriseId,omitempty" jsonschema:"scope filter: enterprise/tenant id"`
	UserID       string `json:"userId,omitempty" jsonschema:"scope filter: user id"`
	RoleID       string `json:"roleId,omitempty" jsonschema:"scope filter: role id"`
	MandateID    string `json:"mandateId,omitempty" jsonschema:"scope filter: mandate id"`
	RunID        string `json:"runId,omitempty" jsonschema:"scope filter: run id"`
	Since        string `json:"since,omitempty" jsonschema:"inclusive lower bound on the entry ts (ISO-8601)"`
	Limit        int    `json:"limit,omitempty" jsonschema:"return at most this many newest matching entries (0 = all)"`
}

func (a ledgerReadArgs) filter() auditledger.Filter {
	return auditledger.Filter{
		Kind: a.Kind,
		Scope: auditledger.Scope{
			EnterpriseID: a.EnterpriseID,
			UserID:       a.UserID,
			RoleID:       a.RoleID,
			MandateID:    a.MandateID,
			RunID:        a.RunID,
		},
		Since: a.Since,
		Limit: a.Limit,
	}
}

// ── ledger_read ────────────────────────────────────────────────────────────

type ledgerReadResult struct {
	Count   int                 `json:"count"`
	Entries []auditledger.Entry `json:"entries"`
}

func (s *service) ledgerRead(_ context.Context, _ *mcp.CallToolRequest, in ledgerReadArgs) (*mcp.CallToolResult, ledgerReadResult, error) {
	entries, err := s.cfg.Ledger.Read(in.filter())
	if err != nil {
		return nil, ledgerReadResult{}, err
	}
	return nil, ledgerReadResult{Count: len(entries), Entries: entries}, nil
}

// ── ledger_stats ───────────────────────────────────────────────────────────

type ledgerStatsResult struct {
	auditledger.Stats
}

func (s *service) ledgerStats(_ context.Context, _ *mcp.CallToolRequest, in ledgerReadArgs) (*mcp.CallToolResult, ledgerStatsResult, error) {
	stats, err := s.cfg.Ledger.Stats(in.filter())
	if err != nil {
		return nil, ledgerStatsResult{}, err
	}
	return nil, ledgerStatsResult{Stats: stats}, nil
}
