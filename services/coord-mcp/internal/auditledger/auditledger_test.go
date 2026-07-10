package auditledger

import (
	"os"
	"path/filepath"
	"testing"
)

// sample lines match the Node audit-ledger record shape (agix-audit-ledger.mjs).
const sampleLedger = `{"entry_id":"e1","ts":"2026-07-01T10:00:00.000Z","scope":{"enterpriseId":"agix"},"actor":"director","phase":"vision","kind":"gate_decision","verifier":null,"verdict":"GO","authority_used":null,"inputs_hash":"h1","cost":null,"overridden_by_human":false}
{"entry_id":"e2","ts":"2026-07-01T11:00:00.000Z","scope":{"enterpriseId":"agix","runId":"r-9"},"actor":"curator","phase":"build","kind":"verdict","verifier":"held-out","verdict":"pass","authority_used":null,"inputs_hash":"h2","cost":null,"overridden_by_human":false}
{"entry_id":"e3","ts":"2026-07-02T09:00:00.000Z","scope":{"enterpriseId":"agix","runId":"r-9"},"actor":"integrator","phase":"build","kind":"merge","verifier":null,"verdict":null,"authority_used":null,"inputs_hash":"h3","cost":null,"overridden_by_human":false,"meta":{"pr":42}}
{"entry_id":"e4","ts":"2026-07-02T12:00:00.000Z","scope":{"enterpriseId":"other"},"actor":null,"phase":null,"kind":"verdict","verifier":"gate","verdict":"fail","authority_used":null,"inputs_hash":null,"cost":null,"overridden_by_human":true}
`

func writeLedger(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "ledger.jsonl")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadAll(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	entries, err := r.Read(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("want 4 entries, got %d", len(entries))
	}
	// chronological (append) order preserved
	if entries[0].EntryID != "e1" || entries[3].EntryID != "e4" {
		t.Fatalf("order wrong: %s..%s", entries[0].EntryID, entries[3].EntryID)
	}
	// free-form + nullable fields parsed
	if entries[0].Verdict == nil || *entries[0].Verdict != "GO" {
		t.Fatalf("verdict parse: %+v", entries[0].Verdict)
	}
	if entries[3].Actor != nil {
		t.Fatalf("null actor must parse to nil, got %v", *entries[3].Actor)
	}
	if string(entries[2].Meta) != `{"pr":42}` {
		t.Fatalf("meta raw JSON lost: %q", entries[2].Meta)
	}
}

func TestFilterByKind(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	got, err := r.Read(Filter{Kind: "verdict"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].EntryID != "e2" || got[1].EntryID != "e4" {
		t.Fatalf("kind filter: %+v", got)
	}
}

func TestFilterByScope(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	// enterprise filter excludes the "other" tenant
	got, _ := r.Read(Filter{Scope: Scope{EnterpriseID: "agix"}})
	if len(got) != 3 {
		t.Fatalf("enterprise scope: want 3, got %d", len(got))
	}
	// deeper scope: only the run r-9 entries
	got, _ = r.Read(Filter{Scope: Scope{EnterpriseID: "agix", RunID: "r-9"}})
	if len(got) != 2 || got[0].EntryID != "e2" || got[1].EntryID != "e3" {
		t.Fatalf("run scope: %+v", got)
	}
}

func TestFilterBySince(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	got, _ := r.Read(Filter{Since: "2026-07-02T00:00:00.000Z"})
	if len(got) != 2 || got[0].EntryID != "e3" {
		t.Fatalf("since filter: %+v", got)
	}
}

func TestLimitReturnsNewestTail(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	got, _ := r.Read(Filter{Limit: 2})
	if len(got) != 2 || got[0].EntryID != "e3" || got[1].EntryID != "e4" {
		t.Fatalf("limit tail: %+v", got)
	}
}

func TestMissingLedgerReadsEmpty(t *testing.T) {
	r := New(filepath.Join(t.TempDir(), "nope", "ledger.jsonl"))
	got, err := r.Read(Filter{})
	if err != nil {
		t.Fatalf("missing ledger must not error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("missing ledger must read empty, got %+v", got)
	}
	stats, err := r.Stats(Filter{})
	if err != nil || stats.Total != 0 {
		t.Fatalf("missing ledger stats: %+v err=%v", stats, err)
	}
}

func TestTornTailLineTolerated(t *testing.T) {
	r := New(writeLedger(t, sampleLedger+`{"entry_id":"e5","ts":"2026-07-`)) // truncated
	got, err := r.Read(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("torn tail must be skipped, got %d entries", len(got))
	}
}

func TestStats(t *testing.T) {
	r := New(writeLedger(t, sampleLedger))
	st, err := r.Stats(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if st.Total != 4 {
		t.Fatalf("total = %d", st.Total)
	}
	if st.ByKind["verdict"] != 2 || st.ByKind["gate_decision"] != 1 || st.ByKind["merge"] != 1 {
		t.Fatalf("byKind = %+v", st.ByKind)
	}
	if st.ByVerdict["GO"] != 1 || st.ByVerdict["pass"] != 1 || st.ByVerdict["fail"] != 1 {
		t.Fatalf("byVerdict = %+v", st.ByVerdict)
	}
	if st.ByPhase["build"] != 2 || st.ByPhase["vision"] != 1 {
		t.Fatalf("byPhase = %+v", st.ByPhase)
	}
	// stats honor a filter
	st, _ = r.Stats(Filter{Kind: "verdict"})
	if st.Total != 2 || st.ByVerdict["pass"] != 1 || st.ByVerdict["fail"] != 1 {
		t.Fatalf("filtered stats = %+v", st)
	}
}

func TestResolvePathFromEnv(t *testing.T) {
	t.Setenv("AGIX_LEDGER_PATH", "/explicit/ledger.jsonl")
	if p, _ := ResolvePathFromEnv(); p != "/explicit/ledger.jsonl" {
		t.Fatalf("explicit path = %q", p)
	}

	t.Setenv("AGIX_LEDGER_PATH", "")
	t.Setenv("AGIX_DATA_DIR", "/data")
	t.Setenv("AGIX_TENANT", "acme")
	want := filepath.Join("/data", "governance", "tenants", "acme", "ledger.jsonl")
	if p, _ := ResolvePathFromEnv(); p != want {
		t.Fatalf("derived path = %q, want %q", p, want)
	}

	// default tenant when unset
	t.Setenv("AGIX_TENANT", "")
	want = filepath.Join("/data", "governance", "tenants", "agix", "ledger.jsonl")
	if p, _ := ResolvePathFromEnv(); p != want {
		t.Fatalf("default-tenant path = %q, want %q", p, want)
	}
}
