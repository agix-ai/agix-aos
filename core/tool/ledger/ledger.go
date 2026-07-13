// Package ledger is the reborn fleet's read-only ledger-QUERY tool — the capability
// that lets a bee READ the append-only audit ledger the rest of the fleet has been
// writing all along. Until now the ledger was a write sink (agents emit agent_start/
// model_call/tool_call/ratify frames) with no in-fleet reader, so an agent that wanted
// to ground a claim in what REALLY happened ("what shipped this week?", "who ratified
// last?") had a declared `ledger`/`audit` capability with nothing behind it (the exact
// gap an agent flagged as NOT PORTED). This closes it: a governed, $0/offline,
// deterministic query over the same JSONL, bounded so a result fits a model turn.
//
// It is READ-ONLY by construction — the tool holds a *ledger.Ledger and only ever calls
// its Read method; there is NO append/mutate path here — so a proposer bee can query
// provenance without any new capability to write. Three properties make it safe to hand
// a worker:
//
//   - Bounded. Every query is capped (maxEntries) and the returned slice is the MOST
//     RECENT window, so a long-lived ledger can never blow a model turn. `count_only`
//     returns just the tallies (no entries) for a cheap overview.
//   - Deterministic + offline. It reads a local file, filters in memory, and emits
//     STRICT JSON with sorted map keys (Go marshals maps sorted). No network, no clock
//     beyond resolving a relative `since` window.
//   - Inherits egress redaction. The ledger already runs secrets.EgressScanner on every
//     line at WRITE time (see core/ledger), so a credential shape never reaches disk and
//     therefore never reaches this reader. This tool adds NO new redaction — it would be
//     redundant — and never reconstructs a raw secret.
//
// It is a stdlib-plus-core leaf: it imports encoding/json + core/tool (the interface) +
// core/ledger (the store) and nothing heavier, so wiring it into the runner introduces
// no cycle. The runner gates it on a non-nil Runner.Ledger; with no ledger a declared
// `ledger` capability degrades honestly to UNRESOLVED (reported, not fatal).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package ledger

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	ledgercore "github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/tool"
)

// maxEntries is the hard cap on entries returned in one query — a result threads back
// into a model turn, so it must stay bounded. An unspecified or over-cap `limit`
// resolves to this; the returned window is always the MOST RECENT maxEntries.
const maxEntries = 200

// Tool returns the read-only ledger-query tool if name is one of the capability
// aliases a manifest declares it by — "ledger", "audit", "ledger-read", or
// "provenance" — and the ledger is non-nil, and whether it was recognized. The
// aliases name the CAPABILITY ("read the audit trail"); a nil ledger (no audit sink
// wired) returns (nil,false) so the runner reports the capability UNRESOLVED rather
// than handing back a tool with nothing to read. Mirrors exec/email.Tool's (Tool, bool)
// contract so one resolver can try fs, metric, exec, email, then ledger.
func Tool(name string, l *ledgercore.Ledger) (tool.Tool, bool) {
	if l == nil {
		return nil, false
	}
	switch strings.TrimSpace(name) {
	case "ledger", "audit", "ledger-read", "provenance":
		return &ledgerTool{l: l}, true
	}
	return nil, false
}

type ledgerTool struct{ l *ledgercore.Ledger }

func (t *ledgerTool) Name() string { return "ledger" }
func (t *ledgerTool) Description() string {
	return "Query the append-only audit ledger (read-only, deterministic, $0/offline). " +
		"Args: {\"kind\":\"tool_call\",\"actor\":\"research\",\"since\":\"168h\",\"limit\":50,\"count_only\":false}. " +
		"All fields optional: `kind` filters by entry kind (agent_start|model_call|tool_call|lease_claim|" +
		"lease_release|agent_done|node_start|node_done|gate_pause|ratify|…), `actor` (alias `agent`) filters by " +
		"the acting agent, `since` is an RFC3339 timestamp or a relative window like \"168h\"/\"7d\", `limit` " +
		"bounds the returned entries to the most recent N (hard cap 200), `count_only` returns just the " +
		"tallies. Returns STRICT JSON {total, counts_by_kind, counts_by_actor, entries}."
}

var schema = json.RawMessage(`{"type":"object","properties":{` +
	`"kind":{"type":"string","description":"filter by ledger entry kind (e.g. tool_call, agent_done, ratify); empty = all kinds"},` +
	`"actor":{"type":"string","description":"filter by the acting agent; empty = all actors"},` +
	`"agent":{"type":"string","description":"alias for actor"},` +
	`"since":{"type":"string","description":"only entries at/after this time: an RFC3339 timestamp or a relative window like \"168h\" or \"7d\"; empty = from the beginning"},` +
	`"limit":{"type":"integer","description":"bound the returned entries to the most recent N (hard cap 200); <=0 or over-cap uses 200"},` +
	`"count_only":{"type":"boolean","description":"return only the counts (total, counts_by_kind, counts_by_actor), no entries"}` +
	`}}`)

func (t *ledgerTool) InputSchema() json.RawMessage { return schema }

// query is the parsed model-facing input.
type query struct {
	Kind      string `json:"kind"`
	Actor     string `json:"actor"`
	Agent     string `json:"agent"`
	Since     string `json:"since"`
	Limit     int    `json:"limit"`
	CountOnly bool   `json:"count_only"`
}

// result is the STRICT JSON shape returned to the model. counts_by_kind /
// counts_by_actor tally the WHOLE matching set (pre-limit) so `total` and the counts
// describe everything that matched, while `entries` is the bounded most-recent window.
// Entries is a pointer so count_only can OMIT it entirely (a nil pointer) while a normal
// query with zero matches still serializes an explicit "entries": [].
type result struct {
	Total         int                 `json:"total"`
	CountsByKind  map[string]int      `json:"counts_by_kind"`
	CountsByActor map[string]int      `json:"counts_by_actor"`
	Entries       *[]ledgercore.Entry `json:"entries,omitempty"`
}

// Execute runs one read-only ledger query: it delegates kind + since filtering to the
// ledger's own Read (which skips corrupt lines gracefully and reads a missing file as
// empty), filters by actor in memory, tallies the full matching set, then bounds the
// returned entries to the most recent `limit` (capped). It never mutates and never
// touches the network. A malformed `since` is the only input error; everything else
// degrades to a well-formed, possibly-empty result.
func (t *ledgerTool) Execute(_ context.Context, raw json.RawMessage) (string, error) {
	var in query
	if err := json.Unmarshal(raw, &in); err != nil && len(raw) > 0 {
		return "", fmt.Errorf("ledger: invalid arguments: %v", err)
	}

	since, err := parseSince(in.Since)
	if err != nil {
		return "", err
	}

	// Kind + since filtering is the ledger's own contract (empty kind = all kinds,
	// zero since = from the beginning). Corrupt lines are skipped there.
	entries, err := t.l.Read(strings.TrimSpace(in.Kind), since)
	if err != nil {
		return "", fmt.Errorf("ledger: read failed: %v", err)
	}

	// Actor filter (in memory) — `actor` wins, `agent` is an alias.
	actor := strings.TrimSpace(in.Actor)
	if actor == "" {
		actor = strings.TrimSpace(in.Agent)
	}
	if actor != "" {
		kept := entries[:0]
		for _, e := range entries {
			if e.Agent == actor {
				kept = append(kept, e)
			}
		}
		entries = kept
	}

	// Tally the WHOLE matching set (pre-limit). Init non-nil so empty → "{}", not null.
	countsByKind := map[string]int{}
	countsByActor := map[string]int{}
	for _, e := range entries {
		countsByKind[e.Kind]++
		countsByActor[e.Agent]++
	}

	res := result{
		Total:         len(entries),
		CountsByKind:  countsByKind,
		CountsByActor: countsByActor,
	}

	if !in.CountOnly {
		// Bound to the MOST RECENT `limit` (Read returns chronological order). An
		// unspecified or over-cap limit clamps to maxEntries.
		limit := in.Limit
		if limit <= 0 || limit > maxEntries {
			limit = maxEntries
		}
		bounded := entries
		if len(bounded) > limit {
			bounded = bounded[len(bounded)-limit:]
		}
		if bounded == nil {
			bounded = []ledgercore.Entry{}
		}
		res.Entries = &bounded
	}

	out, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return "", fmt.Errorf("ledger: marshal failed: %v", err)
	}
	return string(out), nil
}

// parseSince resolves the `since` frame: empty → zero time (from the beginning); a
// relative window ("168h", "7d", "2w", or any Go duration) → now minus the window; an
// RFC3339 timestamp → that instant. Anything else is a query error rather than a silent
// no-op, so a mistyped window is surfaced to the model, not ignored.
func parseSince(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, nil
	}
	if d, ok := parseWindow(s); ok {
		return time.Now().Add(-d), nil
	}
	if ts, err := time.Parse(time.RFC3339, s); err == nil {
		return ts, nil
	}
	return time.Time{}, fmt.Errorf("ledger: invalid `since` %q (want an RFC3339 timestamp or a relative window like \"168h\" or \"7d\")", s)
}

// parseWindow parses a relative duration: a standard Go duration ("168h", "90m"), or a
// day/week suffix ("7d", "2w") Go's time.ParseDuration does not support.
func parseWindow(s string) (time.Duration, bool) {
	if d, err := time.ParseDuration(s); err == nil {
		return d, true
	}
	if len(s) >= 2 {
		unit := s[len(s)-1]
		if unit == 'd' || unit == 'w' {
			if n, err := strconv.Atoi(s[:len(s)-1]); err == nil && n >= 0 {
				switch unit {
				case 'd':
					return time.Duration(n) * 24 * time.Hour, true
				case 'w':
					return time.Duration(n) * 7 * 24 * time.Hour, true
				}
			}
		}
	}
	return 0, false
}

var _ tool.Tool = (*ledgerTool)(nil)
