package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/services/coord-mcp/internal/auditledger"
	"github.com/agix-ai/agix/services/coord-mcp/internal/ledger"
	"github.com/agix-ai/agix/services/go-common/auth"
)

const testLedger = `{"entry_id":"e1","ts":"2026-07-01T10:00:00.000Z","scope":{"enterpriseId":"agix"},"actor":"director","phase":"vision","kind":"gate_decision","verdict":"GO","overridden_by_human":false}
{"entry_id":"e2","ts":"2026-07-02T11:00:00.000Z","scope":{"enterpriseId":"agix","runId":"r-9"},"actor":"curator","phase":"build","kind":"verdict","verifier":"held-out","verdict":"pass","overridden_by_human":false}
`

func newLedgerTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := ledger.NewStore(context.Background(), &ledger.MemorySnapshotter{})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	if err := os.WriteFile(path, []byte(testLedger), 0o644); err != nil {
		t.Fatal(err)
	}
	keys := auth.Keys{FleetKey: "fleet-secret"}
	server := NewServer(Config{Store: store, Keys: keys, Version: "test", Ledger: auditledger.New(path)})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth.Middleware(keys, CoordHeaders, handler))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestLedgerToolsRegisteredOnlyWithReader(t *testing.T) {
	// without a Ledger, the ledger tools are absent
	ts, _ := newTestServer(t)
	sess := connect(t, ts, "fleet-secret", "agent-a")
	list, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range list.Tools {
		if tool.Name == "ledger_read" || tool.Name == "ledger_stats" {
			t.Fatalf("ledger tools must not register without a reader (found %s)", tool.Name)
		}
	}

	// with a Ledger, they appear
	lts := newLedgerTestServer(t)
	lsess := connect(t, lts, "fleet-secret", "agent-a")
	list, err = lsess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, tool := range list.Tools {
		found[tool.Name] = true
	}
	if !found["ledger_read"] || !found["ledger_stats"] {
		t.Fatalf("ledger tools missing: %v", found)
	}
}

func TestLedgerReadTool(t *testing.T) {
	ts := newLedgerTestServer(t)
	sess := connect(t, ts, "fleet-secret", "reader")

	// read all
	var rr ledgerReadResult
	res := call(t, sess, "ledger_read", map[string]any{}, &rr)
	if res.IsError {
		t.Fatalf("ledger_read: %s", textOf(res))
	}
	if rr.Count != 2 || rr.Entries[0].EntryID != "e1" {
		t.Fatalf("ledger_read all: %+v", rr)
	}

	// filter by kind
	call(t, sess, "ledger_read", map[string]any{"kind": "verdict"}, &rr)
	if rr.Count != 1 || rr.Entries[0].EntryID != "e2" {
		t.Fatalf("ledger_read kind filter: %+v", rr)
	}

	// filter by scope (runId)
	call(t, sess, "ledger_read", map[string]any{"runId": "r-9"}, &rr)
	if rr.Count != 1 || rr.Entries[0].EntryID != "e2" {
		t.Fatalf("ledger_read scope filter: %+v", rr)
	}

	// since bound
	call(t, sess, "ledger_read", map[string]any{"since": "2026-07-02T00:00:00.000Z"}, &rr)
	if rr.Count != 1 || rr.Entries[0].EntryID != "e2" {
		t.Fatalf("ledger_read since filter: %+v", rr)
	}
}

// TestLedgerReadPopulatedFreeformFields is the RECYCLE regression: a realistic
// entry carrying populated meta / cost / authority_used (JSON object + number)
// must round-trip through ledger_read. Without the output-schema override those
// json.RawMessage fields reflect to a byte-array schema and the server rejects
// the whole response.
func TestLedgerReadPopulatedFreeformFields(t *testing.T) {
	store, err := ledger.NewStore(context.Background(), &ledger.MemorySnapshotter{})
	if err != nil {
		t.Fatal(err)
	}
	// held-out verdict entry: meta object, cost number, authority_used object.
	const populated = `{"entry_id":"e9","ts":"2026-07-03T08:00:00.000Z","scope":{"enterpriseId":"agix","runId":"r-1"},"actor":"curator","phase":"build","kind":"verdict","verifier":"held-out","verdict":"RECYCLE","authority_used":{"role":"curator","grant":"gate"},"inputs_hash":"h9","cost":0.42,"overridden_by_human":false,"meta":{"note":"2 fixable defects","gaps":["schema","stdout"]}}
`
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	if err := os.WriteFile(path, []byte(populated), 0o644); err != nil {
		t.Fatal(err)
	}
	keys := auth.Keys{FleetKey: "fleet-secret"}
	server := NewServer(Config{Store: store, Keys: keys, Version: "test", Ledger: auditledger.New(path)})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth.Middleware(keys, CoordHeaders, handler))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	sess := connect(t, ts, "fleet-secret", "reader")
	var rr ledgerReadResult
	res := call(t, sess, "ledger_read", map[string]any{}, &rr)
	if res.IsError {
		t.Fatalf("ledger_read on populated entry must not error: %s", textOf(res))
	}
	if rr.Count != 1 {
		t.Fatalf("want 1 entry, got %d", rr.Count)
	}
	e := rr.Entries[0]
	if e.EntryID != "e9" || e.Verdict == nil || *e.Verdict != "RECYCLE" {
		t.Fatalf("entry mangled: %+v", e)
	}
	// The free-form JSON fields came through intact (object + number). Compare
	// semantically: the MCP structured-content round-trip decodes into a
	// map[string]any and re-marshals with sorted keys, so byte-exact ordering
	// isn't preserved on the client side (server-side raw preservation is
	// asserted in auditledger's own tests). The point of this regression test is
	// that the response is NOT rejected and the fields are present + correct.
	assertJSONEqual(t, "meta", e.Meta, `{"note":"2 fixable defects","gaps":["schema","stdout"]}`)
	assertJSONEqual(t, "cost", e.Cost, `0.42`)
	assertJSONEqual(t, "authority_used", e.AuthorityUsed, `{"role":"curator","grant":"gate"}`)
}

// assertJSONEqual compares two JSON documents for semantic (value) equality,
// ignoring object-key ordering and insignificant whitespace.
func assertJSONEqual(t *testing.T, name string, got json.RawMessage, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("%s not valid JSON: %q (%v)", name, got, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s want not valid JSON: %v", name, err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("%s = %q, want equivalent to %s", name, got, want)
	}
}

func TestLedgerStatsTool(t *testing.T) {
	ts := newLedgerTestServer(t)
	sess := connect(t, ts, "fleet-secret", "reader")

	var sr ledgerStatsResult
	res := call(t, sess, "ledger_stats", map[string]any{}, &sr)
	if res.IsError {
		t.Fatalf("ledger_stats: %s", textOf(res))
	}
	if sr.Total != 2 {
		t.Fatalf("stats total = %d", sr.Total)
	}
	if sr.ByKind["gate_decision"] != 1 || sr.ByKind["verdict"] != 1 {
		t.Fatalf("stats byKind = %+v", sr.ByKind)
	}
	if sr.ByVerdict["GO"] != 1 || sr.ByVerdict["pass"] != 1 {
		t.Fatalf("stats byVerdict = %+v", sr.ByVerdict)
	}
}
