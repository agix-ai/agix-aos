// Package auditledger reads the Agix governance audit ledger — the per-tenant,
// append-only JSONL system of record (gate decisions, verifier verdicts,
// merges, leases, releases, version bumps, launches). It is the READ side of
// the Node↔Go shared substrate: the Node fleet writes governed entries, the Go
// MCP server reads and serves them so an external agent can inspect the fleet's
// verified verdicts and gate history.
//
// The on-disk shape matches the Node audit ledger's entry record:
//
//	{ "entry_id", "ts", "scope": {enterpriseId,userId,roleId,mandateId,runId},
//	  "actor", "phase", "kind", "verifier", "verdict", "authority_used",
//	  "inputs_hash", "cost", "overridden_by_human", "meta"? }
//
// one JSON object per line. This package is READ-ONLY — it never writes the
// ledger (appends stay on the Node side, the authority that shapes entries).
package auditledger

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Scope is the governance scope carried on every entry. Only enterpriseId is
// always present; deeper segments appear as the scope deepens toward a run.
type Scope struct {
	EnterpriseID string `json:"enterpriseId,omitempty"`
	UserID       string `json:"userId,omitempty"`
	RoleID       string `json:"roleId,omitempty"`
	MandateID    string `json:"mandateId,omitempty"`
	RunID        string `json:"runId,omitempty"`
}

// Entry is one governed audit-ledger record. Free-form fields (authority_used,
// cost, meta) are preserved as raw JSON so the reader never loses or reshapes
// what the Node writer recorded.
type Entry struct {
	EntryID           string          `json:"entry_id"`
	TS                string          `json:"ts"`
	Scope             Scope           `json:"scope"`
	Actor             *string         `json:"actor"`
	Phase             *string         `json:"phase"`
	Kind              string          `json:"kind"`
	Verifier          *string         `json:"verifier"`
	Verdict           *string         `json:"verdict"`
	AuthorityUsed     json.RawMessage `json:"authority_used,omitempty"`
	InputsHash        *string         `json:"inputs_hash"`
	Cost              json.RawMessage `json:"cost,omitempty"`
	OverriddenByHuman bool            `json:"overridden_by_human"`
	Meta              json.RawMessage `json:"meta,omitempty"`
}

// Filter narrows a read. Every set field must match; empty fields are
// wildcards. Since is an inclusive lower bound on the ISO-8601 ts. Limit, when
// > 0, keeps only the last Limit matching entries (the newest tail).
type Filter struct {
	Kind  string
	Scope Scope
	Since string
	Limit int
}

// Stats is a governance rollup over the matched entries.
type Stats struct {
	Total     int            `json:"total"`
	ByKind    map[string]int `json:"byKind"`
	ByVerdict map[string]int `json:"byVerdict"`
	ByPhase   map[string]int `json:"byPhase"`
}

// Reader reads a single audit-ledger JSONL file. The zero value is unusable;
// build one with New or ReaderFromEnv.
type Reader struct {
	// Path is the absolute path to the ledger.jsonl file.
	Path string
}

// New builds a Reader over an explicit ledger.jsonl path.
func New(path string) *Reader { return &Reader{Path: path} }

// Read returns the entries matching f, in append (chronological) order. A
// missing ledger file reads as empty (the system of record may not exist yet),
// never an error. A torn/partial trailing line is tolerated (skipped).
func (r *Reader) Read(f Filter) ([]Entry, error) {
	raw, err := os.ReadFile(r.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Entry{}, nil
		}
		return nil, err
	}
	var matched []Entry
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e Entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue // tolerate a torn tail line, exactly like the Node reader
		}
		if !entryMatches(e, f) {
			continue
		}
		matched = append(matched, e)
	}
	if f.Limit > 0 && len(matched) > f.Limit {
		matched = matched[len(matched)-f.Limit:]
	}
	if matched == nil {
		matched = []Entry{}
	}
	return matched, nil
}

// Stats computes a rollup over the entries matching f (counts by kind, verdict,
// and phase). Limit is ignored for stats — a summary is over the full match.
func (r *Reader) Stats(f Filter) (Stats, error) {
	f.Limit = 0
	entries, err := r.Read(f)
	if err != nil {
		return Stats{}, err
	}
	out := Stats{
		Total:     len(entries),
		ByKind:    map[string]int{},
		ByVerdict: map[string]int{},
		ByPhase:   map[string]int{},
	}
	for _, e := range entries {
		if e.Kind != "" {
			out.ByKind[e.Kind]++
		}
		if e.Verdict != nil && *e.Verdict != "" {
			out.ByVerdict[*e.Verdict]++
		}
		if e.Phase != nil && *e.Phase != "" {
			out.ByPhase[*e.Phase]++
		}
	}
	return out, nil
}

func entryMatches(e Entry, f Filter) bool {
	if f.Kind != "" && e.Kind != f.Kind {
		return false
	}
	if f.Since != "" && e.TS < f.Since {
		return false
	}
	return scopeMatches(e.Scope, f.Scope)
}

// scopeMatches reports whether an entry's scope satisfies a (possibly partial)
// filter scope: every field the filter names must match exactly; unspecified
// fields are wildcards.
func scopeMatches(entry, filter Scope) bool {
	if filter.EnterpriseID != "" && entry.EnterpriseID != filter.EnterpriseID {
		return false
	}
	if filter.UserID != "" && entry.UserID != filter.UserID {
		return false
	}
	if filter.RoleID != "" && entry.RoleID != filter.RoleID {
		return false
	}
	if filter.MandateID != "" && entry.MandateID != filter.MandateID {
		return false
	}
	if filter.RunID != "" && entry.RunID != filter.RunID {
		return false
	}
	return true
}

// ResolvePathFromEnv derives the audit-ledger file path, mirroring the Node
// runtime's getLedger() FileLedger location. Precedence (highest first):
//
//  1. AGIX_LEDGER_PATH — explicit full path to the ledger.jsonl file.
//  2. <root>/governance/tenants/<tenant>/ledger.jsonl, where
//     root   = AGIX_DATA_DIR, else $XDG_STATE_HOME/agix, else ~/.local/state/agix
//     tenant = AGIX_TENANT, else "agix" (the single-operator default).
//
// It returns the resolved path and a short human-readable description.
func ResolvePathFromEnv() (path, desc string) {
	if p := os.Getenv("AGIX_LEDGER_PATH"); p != "" {
		return p, "explicit AGIX_LEDGER_PATH"
	}
	var root string
	if d := os.Getenv("AGIX_DATA_DIR"); d != "" {
		root = d
	} else if x := os.Getenv("XDG_STATE_HOME"); x != "" {
		root = filepath.Join(x, "agix")
	} else if home, err := os.UserHomeDir(); err == nil {
		root = filepath.Join(home, ".local", "state", "agix")
	} else {
		root = filepath.Join(".local", "state", "agix")
	}
	tenant := os.Getenv("AGIX_TENANT")
	if tenant == "" {
		tenant = "agix"
	}
	p := filepath.Join(root, "governance", "tenants", tenant, "ledger.jsonl")
	return p, "derived (tenant " + tenant + ")"
}

// ReaderFromEnv builds a Reader from the environment (see ResolvePathFromEnv).
func ReaderFromEnv() (*Reader, string) {
	p, desc := ResolvePathFromEnv()
	return New(p), desc + " → " + p
}
