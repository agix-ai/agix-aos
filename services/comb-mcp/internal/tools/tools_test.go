package tools

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/core/kmstore"
)

// newTestSession spins up the Comb MCP server against a fresh temp-file kmstore
// (WAL sqlite, no network, no keys) and returns a connected client session. The
// verifier "bob" is registered on the attestation roster so a distinct author
// can be vouched for — the actor≠verifier gate the whole test exercises.
func newTestSession(t *testing.T) (*mcp.ClientSession, *kmstore.KMStore) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "comb-test.db")
	store, err := kmstore.Open(dbPath)
	if err != nil {
		t.Fatalf("open kmstore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	store.RegisterVerifier("bob") // out-of-band roster seed — the non-forgeable seam

	server := NewServer(Config{Store: store, Dim: DefaultDim, Version: "test"})

	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, st, nil) // server must connect before the client
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	client := mcp.NewClient(&mcp.Implementation{Name: "comb-test", Version: "0"}, nil)
	session, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session, store
}

// call invokes a tool and decodes its structured content into out.
func call(t *testing.T, s *mcp.ClientSession, tool string, args, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%s): %v", tool, err)
	}
	if res.IsError {
		t.Fatalf("CallTool(%s) is a tool error: %s", tool, textOf(res))
	}
	if out != nil {
		raw, err := json.Marshal(res.StructuredContent)
		if err != nil {
			t.Fatalf("marshal structured content: %v", err)
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s structured content: %v", tool, err)
		}
	}
	return res
}

func textOf(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

type putOut struct {
	ID          string `json:"id"`
	Added       bool   `json:"added"`
	Attested    bool   `json:"attested"`
	Quarantined bool   `json:"quarantined"`
	Reason      string `json:"reason"`
	Message     string `json:"message"`
}

type hitView struct {
	ID       string `json:"id"`
	Content  string `json:"content"`
	Attested bool   `json:"attested"`
}

type retrieveOut struct {
	Count        int       `json:"count"`
	AttestedOnly bool      `json:"attestedOnly"`
	Hits         []hitView `json:"hits"`
}

type traverseOut struct {
	Count        int       `json:"count"`
	AttestedOnly bool      `json:"attestedOnly"`
	Reached      []hitView `json:"reached"`
}

func hasID(hits []hitView, id string) (hitView, bool) {
	for _, h := range hits {
		if h.ID == id {
			return h, true
		}
	}
	return hitView{}, false
}

// TestAllToolsRegistered asserts the coherent tool surface is present + described.
func TestAllToolsRegistered(t *testing.T) {
	session, _ := newTestSession(t)
	list, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"comb.put": true, "comb.link": true, "comb.retrieve": true,
		"comb.traverse": true, "comb.stats": true,
	}
	for _, tool := range list.Tools {
		delete(want, tool.Name)
		if tool.Description == "" {
			t.Errorf("tool %s missing a description", tool.Name)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing tools: %v", want)
	}
}

// TestRetrieveAttestationGate is the load-bearing test: an un-attested write is
// NOT returned by the default governed read, and even when explicitly included
// it is never labeled attested; an attested write IS returned by the default read.
func TestRetrieveAttestationGate(t *testing.T) {
	session, _ := newTestSession(t)

	// (1) An un-attested write (no verifier) — stored, but not attested.
	var unattested putOut
	call(t, session, "comb.put", map[string]any{
		"content": "photosynthesis converts sunlight into chemical energy",
		"author":  "alice",
	}, &unattested)
	if unattested.Attested {
		t.Fatalf("write with no verifier must be un-attested, got %+v", unattested)
	}

	// (2) An attested write: distinct + registered verifier, trust over the floor.
	var attested putOut
	call(t, session, "comb.put", map[string]any{
		"content":  "the queen bee governs the hive",
		"author":   "alice",
		"verifier": "bob",
		"trust":    0.9,
	}, &attested)
	if !attested.Attested {
		t.Fatalf("write vouched by a distinct registered verifier must attest, got %+v", attested)
	}

	// (3) The GOVERNED default read of the un-attested leaf's own words returns
	// it NOT — the gate excludes un-vouched knowledge.
	var gov retrieveOut
	call(t, session, "comb.retrieve", map[string]any{
		"query": "photosynthesis sunlight chemical energy",
	}, &gov)
	if !gov.AttestedOnly {
		t.Fatalf("comb.retrieve must default to attested-only, got %+v", gov)
	}
	if _, ok := hasID(gov.Hits, unattested.ID); ok {
		t.Fatalf("attestation gate breached: un-attested leaf %s returned by the governed read: %+v", unattested.ID, gov.Hits)
	}

	// (4) The attested leaf IS returned by the governed default read.
	call(t, session, "comb.retrieve", map[string]any{
		"query": "queen bee governs the hive",
	}, &gov)
	h, ok := hasID(gov.Hits, attested.ID)
	if !ok {
		t.Fatalf("attested leaf %s must be returned by the governed read, got %+v", attested.ID, gov.Hits)
	}
	if !h.Attested {
		t.Fatalf("attested leaf must report attested=true, got %+v", h)
	}

	// (5) Only with the explicit opt-out is the un-attested leaf visible — and
	// even then it is honestly marked attested=false, never as attested.
	var open retrieveOut
	call(t, session, "comb.retrieve", map[string]any{
		"query":             "photosynthesis sunlight chemical energy",
		"includeUnattested": true,
	}, &open)
	if open.AttestedOnly {
		t.Fatalf("includeUnattested must flip the governed read off, got %+v", open)
	}
	h, ok = hasID(open.Hits, unattested.ID)
	if !ok {
		t.Fatalf("un-attested leaf %s must be visible with includeUnattested, got %+v", unattested.ID, open.Hits)
	}
	if h.Attested {
		t.Fatalf("un-attested leaf must never be labeled attested, got %+v", h)
	}
}

// TestShieldQuarantinesContradiction proves the anti-poisoning shield at the MCP
// boundary: an un-attested write that contradicts an existing attested leaf (same
// id, different content) is quarantined, not applied.
func TestShieldQuarantinesContradiction(t *testing.T) {
	session, _ := newTestSession(t)

	var first putOut
	call(t, session, "comb.put", map[string]any{
		"id":       "fact-1",
		"content":  "the mitochondria is the powerhouse of the cell",
		"author":   "alice",
		"verifier": "bob",
		"trust":    0.9,
	}, &first)
	if !first.Attested {
		t.Fatalf("seed write must attest, got %+v", first)
	}

	var contra putOut
	call(t, session, "comb.put", map[string]any{
		"id":      "fact-1",
		"content": "the mitochondria is irrelevant to the cell",
		"author":  "mallory", // no verifier → un-attested contradiction
	}, &contra)
	if !contra.Quarantined {
		t.Fatalf("un-attested contradiction of an attested leaf must be quarantined, got %+v", contra)
	}
	if contra.Added {
		t.Fatalf("a quarantined write must not be added, got %+v", contra)
	}
}

// TestTraverseGovernedWalk proves attested-only traversal follows only attested
// edges to attested leaves by default, and widens with includeUnattested.
func TestTraverseGovernedWalk(t *testing.T) {
	session, _ := newTestSession(t)

	vouch := func(id, content string) {
		var p putOut
		call(t, session, "comb.put", map[string]any{
			"id": id, "content": content, "author": "alice", "verifier": "bob", "trust": 0.9,
		}, &p)
		if !p.Attested {
			t.Fatalf("put %s must attest, got %+v", id, p)
		}
	}
	vouch("x", "root architecture decision")
	vouch("y", "downstream attested consequence")

	// An un-attested leaf + an un-attested edge from the seed.
	var z putOut
	call(t, session, "comb.put", map[string]any{"id": "z", "content": "unvouched downstream note", "author": "alice"}, &z)
	if z.Attested {
		t.Fatalf("z must be un-attested, got %+v", z)
	}

	// Attested edge x -> y (author≠verifier, verifier registered).
	call(t, session, "comb.link", map[string]any{
		"src": "x", "type": "depends-on", "dst": "y", "author": "alice", "verifier": "bob", "trust": 0.9,
	}, nil)
	// Un-attested edge x -> z (no verifier).
	call(t, session, "comb.link", map[string]any{
		"src": "x", "type": "depends-on", "dst": "z", "author": "alice",
	}, nil)

	// Governed walk: only the attested leaf y is reached.
	var gov traverseOut
	call(t, session, "comb.traverse", map[string]any{"seed": "x", "type": "depends-on"}, &gov)
	if !gov.AttestedOnly {
		t.Fatalf("comb.traverse must default to attested-only, got %+v", gov)
	}
	if _, ok := hasID(gov.Reached, "y"); !ok {
		t.Fatalf("governed traverse must reach attested y, got %+v", gov.Reached)
	}
	if _, ok := hasID(gov.Reached, "z"); ok {
		t.Fatalf("governed traverse must NOT reach un-attested z, got %+v", gov.Reached)
	}

	// Widened walk: both are reached.
	var open traverseOut
	call(t, session, "comb.traverse", map[string]any{
		"seed": "x", "type": "depends-on", "includeUnattested": true,
	}, &open)
	if _, ok := hasID(open.Reached, "y"); !ok {
		t.Fatalf("widened traverse must reach y, got %+v", open.Reached)
	}
	if _, ok := hasID(open.Reached, "z"); !ok {
		t.Fatalf("widened traverse must reach z, got %+v", open.Reached)
	}
}

// TestStats confirms the store snapshot surfaces through the MCP boundary.
func TestStats(t *testing.T) {
	session, _ := newTestSession(t)
	call(t, session, "comb.put", map[string]any{
		"content": "a vouched fact", "author": "alice", "verifier": "bob", "trust": 0.9,
	}, nil)
	call(t, session, "comb.put", map[string]any{"content": "an un-vouched fact", "author": "alice"}, nil)

	var st struct {
		Leaves     int     `json:"leaves"`
		Attested   int     `json:"attested"`
		TrustFloor float64 `json:"trust_floor"`
	}
	call(t, session, "comb.stats", map[string]any{}, &st)
	if st.Leaves != 2 {
		t.Fatalf("stats leaves = %d, want 2", st.Leaves)
	}
	if st.Attested != 1 {
		t.Fatalf("stats attested = %d, want 1", st.Attested)
	}
	if st.TrustFloor != kmstore.DefaultTrustFloor {
		t.Fatalf("stats trust_floor = %v, want %v", st.TrustFloor, kmstore.DefaultTrustFloor)
	}
}
