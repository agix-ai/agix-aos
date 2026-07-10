// Tests for the read-only ledger-query tool: the capability aliases, the deny-by-
// default nil ledger, the counts/count_only frames, kind+actor+since filtering, the
// bounded most-recent window, and the read-only guarantee (no append path exists).
// All $0/offline against a temp ledger.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package ledger

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	ledgercore "github.com/agix-ai/agix/core/ledger"
)

var base = time.Date(2026, 7, 7, 1, 0, 0, 0, time.UTC)

// seed writes a small, deterministic trail to a temp ledger and returns it.
func seed(t *testing.T) *ledgercore.Ledger {
	t.Helper()
	l, err := ledgercore.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	entries := []ledgercore.Entry{
		{TS: base.Add(1 * time.Minute), Kind: ledgercore.KindAgentStart, Agent: "sentinel/queen/root"},
		{TS: base.Add(2 * time.Minute), Kind: ledgercore.KindToolCall, Agent: "sentinel/worker/forager-1", Data: map[string]any{"tool": "grep", "hits": 3}},
		{TS: base.Add(3 * time.Minute), Kind: ledgercore.KindToolCall, Agent: "sentinel/worker/forager-1", Data: map[string]any{"tool": "grep"}},
		{TS: base.Add(4 * time.Minute), Kind: ledgercore.KindRatify, Agent: "sentinel/worker/verifier-1", Data: map[string]any{"verdict": "GO"}},
		{TS: base.Add(5 * time.Minute), Kind: ledgercore.KindAgentDone, Agent: "sentinel/queen/root"},
	}
	for _, e := range entries {
		if err := l.Append(e); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	return l
}

func run(t *testing.T, l *ledgercore.Ledger, args string) map[string]any {
	t.Helper()
	tl, ok := Tool("ledger", l)
	if !ok {
		t.Fatal("Tool(ledger) not recognized")
	}
	out, err := tl.Execute(context.Background(), json.RawMessage(args))
	if err != nil {
		t.Fatalf("execute %s: %v", args, err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("unmarshal result: %v\n%s", err, out)
	}
	return m
}

func TestToolFactory(t *testing.T) {
	l := seed(t)
	for _, name := range []string{"ledger", "audit", "ledger-read", "provenance"} {
		if _, ok := Tool(name, l); !ok {
			t.Errorf("Tool(%q) should be recognized", name)
		}
	}
	if _, ok := Tool("nope", l); ok {
		t.Error("Tool(nope) should not be recognized")
	}
	// deny-by-default: a nil ledger never resolves (an unwired audit sink degrades).
	if _, ok := Tool("ledger", nil); ok {
		t.Error("Tool with nil ledger must not resolve")
	}
	if tl, _ := Tool("ledger", l); tl.Name() != "ledger" {
		t.Errorf("Name() = %q, want ledger", tl.Name())
	}
}

func TestCountsAndCountOnly(t *testing.T) {
	m := run(t, seed(t), `{"count_only":true}`)
	if got := m["total"].(float64); got != 5 {
		t.Errorf("total = %v, want 5", got)
	}
	byKind := m["counts_by_kind"].(map[string]any)
	if byKind["tool_call"].(float64) != 2 {
		t.Errorf("counts_by_kind[tool_call] = %v, want 2", byKind["tool_call"])
	}
	byActor := m["counts_by_actor"].(map[string]any)
	if byActor["sentinel/worker/forager-1"].(float64) != 2 {
		t.Errorf("counts_by_actor[forager-1] = %v, want 2", byActor["sentinel/worker/forager-1"])
	}
	// count_only omits the entries array entirely.
	if _, present := m["entries"]; present {
		t.Error("count_only must omit entries")
	}
}

func TestKindAndActorFilter(t *testing.T) {
	// kind filter: only the two tool_calls match; counts + entries reflect that set.
	byKind := run(t, seed(t), `{"kind":"tool_call"}`)
	if got := byKind["total"].(float64); got != 2 {
		t.Errorf("kind=tool_call total = %v, want 2", got)
	}
	entries := byKind["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("kind=tool_call entries = %d, want 2", len(entries))
	}
	for _, e := range entries {
		if e.(map[string]any)["kind"] != "tool_call" {
			t.Errorf("filtered entry has wrong kind: %v", e)
		}
	}

	// actor filter: queen/root emitted start + done.
	byActor := run(t, seed(t), `{"actor":"sentinel/queen/root"}`)
	if got := byActor["total"].(float64); got != 2 {
		t.Errorf("actor=queen/root total = %v, want 2", got)
	}
	// `agent` is an alias for `actor`.
	byAgent := run(t, seed(t), `{"agent":"sentinel/worker/verifier-1"}`)
	if got := byAgent["total"].(float64); got != 1 {
		t.Errorf("agent=verifier-1 total = %v, want 1", got)
	}
}

func TestRecentBounded(t *testing.T) {
	// limit bounds the returned entries to the most recent N; total/counts still
	// describe the full matching set.
	m := run(t, seed(t), `{"limit":2}`)
	if got := m["total"].(float64); got != 5 {
		t.Errorf("total = %v, want 5 (full set)", got)
	}
	entries := m["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("limit=2 entries = %d, want 2", len(entries))
	}
	// chronological → most recent last (agent_done).
	last := entries[len(entries)-1].(map[string]any)
	if last["kind"] != ledgercore.KindAgentDone {
		t.Errorf("most-recent kind = %v, want %v", last["kind"], ledgercore.KindAgentDone)
	}
}

func TestSinceFilter(t *testing.T) {
	// an RFC3339 cutoff between the 3rd and 4th entry keeps ratify + agent_done.
	cutoff := base.Add(3*time.Minute + 30*time.Second).Format(time.RFC3339)
	m := run(t, seed(t), `{"since":"`+cutoff+`"}`)
	if got := m["total"].(float64); got != 2 {
		t.Errorf("since cutoff total = %v, want 2", got)
	}
}

func TestInvalidSinceIsAnError(t *testing.T) {
	tl, _ := Tool("ledger", seed(t))
	if _, err := tl.Execute(context.Background(), json.RawMessage(`{"since":"last tuesday"}`)); err == nil {
		t.Error("a malformed `since` should surface an error, not silently no-op")
	}
}

func TestEmptyLedgerReadsClean(t *testing.T) {
	l, err := ledgercore.Open(filepath.Join(t.TempDir(), "empty.jsonl"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	m := run(t, l, `{}`)
	if got := m["total"].(float64); got != 0 {
		t.Errorf("empty ledger total = %v, want 0", got)
	}
	// an empty query still serializes an explicit entries array (not null).
	if _, present := m["entries"]; !present {
		t.Error("a non-count_only query should serialize entries even when empty")
	}
}
