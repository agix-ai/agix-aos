// reembed_test — correctness for the in-place embedding migration (reembed.go).
// Run with:
//
//	CGO_ENABLED=0 go test ./kmstore/...
//
// The suite pins the migration's load-bearing guarantees: every vector in BOTH
// tables (leaves incl. tombstoned + the quarantine audit trail) moves to the
// new embedder's dimension; nothing BUT the embedding changes (content,
// attested, ratified, trust, created_at all preserved); vector-less audit rows
// stay NULL; the dry run writes nothing; and a mid-migration embed failure
// rolls the whole transaction back. All embedders here are offline
// HashEmbedders at two dims — no network, no daemon.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"database/sql"
	"errors"
	"reflect"
	"testing"
)

// rowSnap captures everything about a leaf EXCEPT its vector bytes, plus the
// stored dimension — so "nothing but the embedding changed" is one comparison.
type rowSnap struct {
	content   string
	attested  int
	ratified  int
	trust     float64
	createdAt int64
	tomb      int
	pending   int
	dim       int // len(embedding)/4; -1 ⇔ stored NULL
}

// snapLeaves reads every leaves row (tombstoned included) keyed by id.
func snapLeaves(t *testing.T, st *KMStore) map[string]rowSnap {
	t.Helper()
	rows, err := st.db.Query(`SELECT id, content, attested, ratified, trust, created_at, tombstoned, pending_cosign, length(embedding) FROM leaves`)
	if err != nil {
		t.Fatalf("snap leaves: %v", err)
	}
	defer rows.Close()
	out := map[string]rowSnap{}
	for rows.Next() {
		var (
			id string
			s  rowSnap
			n  sql.NullInt64
		)
		if err := rows.Scan(&id, &s.content, &s.attested, &s.ratified, &s.trust, &s.createdAt, &s.tomb, &s.pending, &n); err != nil {
			t.Fatalf("snap leaves scan: %v", err)
		}
		s.dim = -1
		if n.Valid {
			s.dim = int(n.Int64) / 4
		}
		out[id] = s
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("snap leaves rows: %v", err)
	}
	return out
}

// qSnap is the quarantine analogue of rowSnap, keyed by rowid (quarantine ids
// are not unique — the audit trail is append-only).
type qSnap struct {
	kind      string
	content   string
	reason    string
	createdAt int64
	dim       int // -1 ⇔ stored NULL (a vector-less archive row)
}

func snapQuarantine(t *testing.T, st *KMStore) map[int64]qSnap {
	t.Helper()
	rows, err := st.db.Query(`SELECT rowid, kind, content, reason, created_at, length(embedding) FROM quarantine`)
	if err != nil {
		t.Fatalf("snap quarantine: %v", err)
	}
	defer rows.Close()
	out := map[int64]qSnap{}
	for rows.Next() {
		var (
			rowid           int64
			s               qSnap
			content, reason sql.NullString
			n               sql.NullInt64
		)
		if err := rows.Scan(&rowid, &s.kind, &content, &reason, &s.createdAt, &n); err != nil {
			t.Fatalf("snap quarantine scan: %v", err)
		}
		s.content, s.reason = content.String, reason.String
		s.dim = -1
		if n.Valid {
			s.dim = int(n.Int64) / 4
		}
		out[rowid] = s
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("snap quarantine rows: %v", err)
	}
	return out
}

// mustEmbed embeds via e or fails the test (HashEmbedder never errors, but the
// helper keeps call sites honest).
func mustEmbed(t *testing.T, e Embedder, text string) []float32 {
	t.Helper()
	v, err := e.Embed(text)
	if err != nil {
		t.Fatalf("embed %q: %v", text, err)
	}
	return v
}

// seedReembedStore populates st at dim-8 with the full zoo the migration must
// handle: an attested+ratified leaf, a plain un-attested leaf, a TOMBSTONED
// leaf (direct SQL, as no public API tombstones), a quarantine row WITH a
// vector (an un-attested contradiction the shield refused), and a quarantine
// row WITHOUT one (the content-only archive an attested supersede leaves).
func seedReembedStore(t *testing.T, st *KMStore, embA Embedder) {
	t.Helper()
	if r, err := st.Put(Leaf{
		ID: "att", Content: "verified fact", Branch: "Software",
		Author: "alice", Verifier: "bob", TrustScore: 0.9, Ratified: true,
		Embedding: mustEmbed(t, embA, "verified fact"),
	}); err != nil || !r.Attested {
		t.Fatalf("seed attested leaf: %+v err=%v", r, err)
	}
	if _, err := st.Put(Leaf{ID: "plain", Content: "plain note", Author: "alice", Embedding: mustEmbed(t, embA, "plain note")}); err != nil {
		t.Fatalf("seed plain leaf: %v", err)
	}
	if _, err := st.Put(Leaf{ID: "tomb", Content: "dead leaf", Author: "alice", Embedding: mustEmbed(t, embA, "dead leaf")}); err != nil {
		t.Fatalf("seed tomb leaf: %v", err)
	}
	if _, err := st.db.Exec(`UPDATE leaves SET tombstoned=1 WHERE id='tomb'`); err != nil {
		t.Fatalf("tombstone: %v", err)
	}
	// Shield-quarantined poison — carries the attacker's vector into the trail.
	if r, err := st.Put(Leaf{ID: "att", Content: "POISON", Author: "mallory", Verifier: "mallory", TrustScore: 0.99, Embedding: mustEmbed(t, embA, "POISON")}); err != nil || !r.Quarantined {
		t.Fatalf("seed quarantined poison: %+v err=%v", r, err)
	}
	// Attested supersede — archives the OLD content with a NULL embedding.
	if r, err := st.Put(Leaf{
		ID: "att", Content: "revised fact", Branch: "Software",
		Author: "carol", Verifier: "dave", TrustScore: 0.9, Ratified: true,
		Embedding: mustEmbed(t, embA, "revised fact"),
	}); err != nil || !r.Attested {
		t.Fatalf("seed attested supersede: %+v err=%v", r, err)
	}
}

// TestReembedAllMigratesLeavesAndQuarantine: the happy-path migration. Every
// vector in both tables moves from dim 8 to dim 16, provenance and timestamps
// are byte-identical, vector-less audit rows stay NULL, the new vectors are
// exactly what the new embedder produces from the stored content, and — the
// bug this exists to fix — a new-dim query resolves the store again.
func TestReembedAllMigratesLeavesAndQuarantine(t *testing.T) {
	st := openTmp(t) // registers bob + dave on the roster
	embA, embB := NewHashEmbedder(8), NewHashEmbedder(16)
	seedReembedStore(t, st, embA)

	before := snapLeaves(t, st)
	qBefore := snapQuarantine(t, st)
	if before["plain"].dim != 8 {
		t.Fatalf("seed sanity: plain leaf dim=%d, want 8", before["plain"].dim)
	}

	rep, err := st.ReembedAll(embB)
	if err != nil {
		t.Fatalf("ReembedAll: %v", err)
	}
	if rep.LeavesUpdated != 3 || rep.QuarantineUpdated != 1 {
		t.Fatalf("report counts leaves=%d quarantine=%d, want 3/1 (tombstoned migrates; NULL audit row skipped): %+v", rep.LeavesUpdated, rep.QuarantineUpdated, rep)
	}
	if !reflect.DeepEqual(rep.OldDims, []int{8}) || rep.NewDim != 16 || rep.Embedder != "hash-16" || rep.DryRun {
		t.Fatalf("report metadata wrong: %+v", rep)
	}

	// Leaves: dimension moved, EVERYTHING else preserved (incl. the tombstone).
	after := snapLeaves(t, st)
	for id, b := range before {
		a, ok := after[id]
		if !ok {
			t.Fatalf("leaf %q vanished during reembed", id)
		}
		if a.dim != 16 {
			t.Errorf("leaf %q dim=%d after reembed, want 16", id, a.dim)
		}
		b.dim, a.dim = 0, 0
		if a != b {
			t.Errorf("leaf %q mutated beyond its embedding:\n before %+v\n after  %+v", id, b, a)
		}
	}

	// The new vector is exactly the new embedder's output for the stored content.
	var blob []byte
	if err := st.db.QueryRow(`SELECT embedding FROM leaves WHERE id='plain'`).Scan(&blob); err != nil {
		t.Fatalf("read migrated blob: %v", err)
	}
	if want := mustEmbed(t, embB, "plain note"); !reflect.DeepEqual(decodeVec(blob), want) {
		t.Fatalf("migrated vector != embB(content)")
	}

	// Quarantine: the vectorful poison row migrated; the supersede archive stays
	// NULL; kind/content/reason/created_at untouched on both.
	qAfter := snapQuarantine(t, st)
	if len(qAfter) != len(qBefore) {
		t.Fatalf("quarantine row count changed: %d -> %d", len(qBefore), len(qAfter))
	}
	for rowid, b := range qBefore {
		a := qAfter[rowid]
		switch {
		case b.dim == -1 && a.dim != -1:
			t.Errorf("vector-less audit row %d gained a fabricated embedding", rowid)
		case b.dim != -1 && a.dim != 16:
			t.Errorf("quarantine row %d dim=%d after reembed, want 16", rowid, a.dim)
		}
		b.dim, a.dim = 0, 0
		if a != b {
			t.Errorf("quarantine row %d mutated beyond its embedding:\n before %+v\n after  %+v", rowid, b, a)
		}
	}

	// The point of it all: a query at the NEW dimension resolves the store.
	hits, err := st.Retrieve(mustEmbed(t, embB, "plain note"), 3, RetrieveOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0].ID != "plain" {
		t.Fatalf("post-migration retrieval at new dim failed: %v", ids(hits))
	}
}

// TestReembedPlanWritesNothing: the dry run reports the exact counts and dims a
// real run would touch, and leaves every byte of both tables unchanged.
func TestReembedPlanWritesNothing(t *testing.T) {
	st := openTmp(t)
	seedReembedStore(t, st, NewHashEmbedder(8))
	before := snapLeaves(t, st)
	qBefore := snapQuarantine(t, st)

	rep, err := st.ReembedPlan(NewHashEmbedder(16))
	if err != nil {
		t.Fatalf("ReembedPlan: %v", err)
	}
	if !rep.DryRun || rep.LeavesUpdated != 3 || rep.QuarantineUpdated != 1 {
		t.Fatalf("plan report wrong: %+v", rep)
	}
	if !reflect.DeepEqual(rep.OldDims, []int{8}) || rep.NewDim != 16 {
		t.Fatalf("plan dims wrong: %+v", rep)
	}
	if after := snapLeaves(t, st); !reflect.DeepEqual(before, after) {
		t.Fatalf("dry run touched leaves:\n before %+v\n after  %+v", before, after)
	}
	if qAfter := snapQuarantine(t, st); !reflect.DeepEqual(qBefore, qAfter) {
		t.Fatalf("dry run touched quarantine:\n before %+v\n after  %+v", qBefore, qAfter)
	}
}

// failNthEmbedder wraps a HashEmbedder and errors on exactly the failAt-th
// Embed call — the stand-in for a network embedder whose daemon dies
// mid-migration.
type failNthEmbedder struct {
	inner  HashEmbedder
	failAt int
	calls  int
}

func (f *failNthEmbedder) Embed(text string) ([]float32, error) {
	f.calls++
	if f.calls == f.failAt {
		return nil, errors.New("synthetic embed failure (daemon died mid-migration)")
	}
	return f.inner.Embed(text)
}
func (f *failNthEmbedder) Dim() int     { return f.inner.Dim() }
func (f *failNthEmbedder) Name() string { return "fail-at-" + itoa(f.failAt) }

// TestReembedRollsBackOnMidFailure: an Embed error after some rows have
// already been rewritten inside the transaction must surface as an error AND
// leave the store byte-identical — all or nothing, never a mixed-dim corpus.
func TestReembedRollsBackOnMidFailure(t *testing.T) {
	st := openTmp(t)
	seedReembedStore(t, st, NewHashEmbedder(8)) // 3 leaves + 1 vectorful quarantine row
	before := snapLeaves(t, st)
	qBefore := snapQuarantine(t, st)

	// Row 1 embeds + updates inside the tx; row 2 fails ⇒ everything unwinds.
	_, err := st.ReembedAll(&failNthEmbedder{inner: NewHashEmbedder(16), failAt: 2})
	if err == nil {
		t.Fatal("mid-migration embed failure must return an error")
	}
	if after := snapLeaves(t, st); !reflect.DeepEqual(before, after) {
		t.Fatalf("mid-failure did not roll back leaves:\n before %+v\n after  %+v", before, after)
	}
	if qAfter := snapQuarantine(t, st); !reflect.DeepEqual(qBefore, qAfter) {
		t.Fatalf("mid-failure did not roll back quarantine:\n before %+v\n after  %+v", qBefore, qAfter)
	}
}
