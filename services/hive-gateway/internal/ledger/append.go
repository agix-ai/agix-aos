// SPDX-License-Identifier: Apache-2.0
// Package ledger appends cross-hive events to a hive's append-only JSONL audit
// ledger. The on-disk entry shape mirrors lib/agix-audit-ledger.mjs (the Node
// per-tenant governance ledger) so the two write byte-compatible rows: same
// fields, same null semantics for the governance columns a cross-hive report
// does not fill. Append-only by construction — there is no code path that
// rewrites or truncates the log.
package ledger

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Entry is one governance-ledger row. The field set + null defaults match the
// Node ledger's stored record (agix-audit-ledger.mjs): the columns a cross-hive
// report does not populate (phase/verifier/verdict/inputs_hash/cost) serialize
// as null, and overridden_by_human defaults to false.
type Entry struct {
	EntryID           string            `json:"entry_id"`
	TS                string            `json:"ts"`
	Scope             map[string]string `json:"scope"`
	Actor             string            `json:"actor"`
	Phase             *string           `json:"phase"`
	Kind              string            `json:"kind"`
	Verifier          *string           `json:"verifier"`
	Verdict           *string           `json:"verdict"`
	AuthorityUsed     string            `json:"authority_used"`
	InputsHash        *string           `json:"inputs_hash"`
	Cost              *float64          `json:"cost"`
	OverriddenByHuman bool              `json:"overridden_by_human"`
	Meta              map[string]any    `json:"meta,omitempty"`
}

// Append writes entry as one JSON line to path. The parent dir is created
// (mkdir -p) and the file is opened O_APPEND|O_CREATE with 0600 perms, so
// concurrent single-line appends interleave cleanly and never truncate.
func Append(path string, entry Entry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("ledger: mkdir dir: %w", err)
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("ledger: marshal entry: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("ledger: open %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("ledger: append: %w", err)
	}
	return nil
}

// NewEntryID returns a UUIDv7 (time-ordered, RFC 9562) string — the same
// time-sortable id family the Node ledger's idgen (uuidv7) produces, so entries
// sort by creation order. Stdlib-only: unix-millis prefix + crypto/rand tail.
func NewEntryID() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		// crypto/rand never fails on supported platforms; if it somehow does,
		// a zeroed tail still yields a well-formed, time-ordered id.
		_ = err
	}
	b[6] = (b[6] & 0x0f) | 0x70 // version 7
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
