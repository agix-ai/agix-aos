// Package ledger is the append-only JSONL audit ledger — the "feed the hive"
// honey and the stigmergy trace of record. Every agent action lands as one JSON
// line; readers replay the file. This is the born-clean analog of the
// governance ledger: an event log, never mutated in place.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package ledger

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/agix-ai/agix/core/secrets"
)

// egress is the shared, stateless pre-write redactor. A ledger line is
// append-only, committed, and ingested — so a credential shape in any entry
// field (a provider error carrying a leaked URL, model output, a lease note)
// must never persist in plaintext. This is the boundary secrets.EgressScanner's
// header promises to guard; it is wired here (and in apiary report-home), not
// left to the manual `secret scan` CLI. Known-shape redaction only, so a UUID or
// lease id in the audit trail is preserved (see EgressScanner.RedactKnown).
var egress = secrets.NewEgressScanner()

// Kinds of ledger entries the agent path emits.
const (
	KindAgentStart   = "agent_start"
	KindModelCall    = "model_call"
	KindToolCall     = "tool_call"
	KindLeaseClaim   = "lease_claim"
	KindLeaseRelease = "lease_release"
	KindAgentDone    = "agent_done"

	// Orchestrator (graph) frame kinds. The graph runner brackets every node
	// with node_start/node_done; a governance gate emits gate_pause when it
	// hands off for ratification and ratify when the verifier's verdict lands
	// on resume — the actor≠verifier trail of record.
	KindNodeStart = "node_start"
	KindNodeDone  = "node_done"
	KindGatePause = "gate_pause"
	KindRatify    = "ratify"
)

// Entry is one append-only audit record.
type Entry struct {
	TS    time.Time      `json:"ts"`
	Kind  string         `json:"kind"`
	Agent string         `json:"agent"`
	Data  map[string]any `json:"data,omitempty"`
}

// Ledger is a file-backed append-only JSONL log.
type Ledger struct {
	path string
	mu   sync.Mutex
}

// Open returns a Ledger writing to path, creating the parent directory.
func Open(path string) (*Ledger, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	return &Ledger{path: path}, nil
}

// Append writes one entry as a JSON line (O_APPEND). TS defaults to now (UTC).
func (l *Ledger) Append(e Entry) error {
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	// Egress redaction over the whole marshaled line: no credential shape in any
	// field reaches disk. The [REDACTED:kind] marker is JSON-safe, so the line
	// stays valid and Read round-trips it.
	line = []byte(egress.RedactKnown(string(line)))
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}

// Read replays the ledger, filtering by kind (empty = all kinds) and since
// (zero = from the beginning; inclusive). A missing file reads as empty.
func (l *Ledger) Read(kind string, since time.Time) ([]Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var out []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e Entry
		if err := json.Unmarshal(line, &e); err != nil {
			// Skip corrupt lines rather than fail the whole replay.
			continue
		}
		if kind != "" && e.Kind != kind {
			continue
		}
		if !since.IsZero() && e.TS.Before(since) {
			continue
		}
		out = append(out, e)
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	return out, nil
}
