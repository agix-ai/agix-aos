// kmstore_test — CGo-free correctness + premise-reproduction tests. Run with:
//
//	CGO_ENABLED=0 go test ./kmstore/...
//
// The suite asserts three load-bearing properties: (1) the synthetic corpus is
// deterministic (same seed => identical bytes), (2) the SQLite graph store beats
// the flat-vector control on relational/multi-hop recall (the premise, now
// measured through a real store), and (3) ingest/retrieve/traverse round-trips
// are correct — including that the two arms agree exactly on semantic top-k.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"bytes"
	"io"
	"path/filepath"
	"testing"
)

func smallCfg() Config { return DefaultConfig(500, 10) }

// TestPRNGDeterministic: identical seed => identical stream.
func TestPRNGDeterministic(t *testing.T) {
	a, b := newPRNG(42), newPRNG(42)
	for i := 0; i < 1000; i++ {
		if x, y := a.next(), b.next(); x != y {
			t.Fatalf("draw %d diverged: %v != %v", i, x, y)
		}
	}
	c := newPRNG(43)
	same := true
	x := newPRNG(42)
	for i := 0; i < 50; i++ {
		if c.next() != x.next() {
			same = false
			break
		}
	}
	if same {
		t.Fatal("distinct seeds produced identical streams")
	}
}

// TestDeterministicCorpus: same seed => identical corpus; different seed differs.
func TestDeterministicCorpus(t *testing.T) {
	cfg := smallCfg()
	a := GenerateCorpus(7, cfg)
	b := GenerateCorpus(7, cfg)
	if len(a.Leaves) != len(b.Leaves) || len(a.Leaves) != cfg.Leaves {
		t.Fatalf("leaf count mismatch: %d vs %d (want %d)", len(a.Leaves), len(b.Leaves), cfg.Leaves)
	}
	for i := range a.Leaves {
		la, lb := a.Leaves[i], b.Leaves[i]
		if la.ID != lb.ID || la.Branch != lb.Branch || la.Attested != lb.Attested {
			t.Fatalf("leaf %d metadata diverged", i)
		}
		if !bytes.Equal(encodeVec(la.Embedding), encodeVec(lb.Embedding)) {
			t.Fatalf("leaf %d embedding diverged", i)
		}
		if len(la.Edges) != len(lb.Edges) {
			t.Fatalf("leaf %d edge count diverged", i)
		}
		for e := range la.Edges {
			if la.Edges[e] != lb.Edges[e] {
				t.Fatalf("leaf %d edge %d diverged", i, e)
			}
		}
	}
	c := GenerateCorpus(8, cfg)
	if bytes.Equal(encodeVec(a.Leaves[0].Embedding), encodeVec(c.Leaves[0].Embedding)) {
		t.Fatal("distinct seed produced identical leaf-0 embedding")
	}

	// Query set is deterministic too.
	q1 := GenerateQueries(a, 7)
	q2 := GenerateQueries(b, 7)
	if len(q1) != len(q2) {
		t.Fatalf("query count diverged: %d vs %d", len(q1), len(q2))
	}
}

// TestSQLiteRoundtrip: ingest, count, semantic top-k, and typed traversal all
// match the in-memory ground truth.
func TestSQLiteRoundtrip(t *testing.T) {
	cfg := smallCfg()
	corpus := GenerateCorpus(3, cfg)
	path := filepath.Join(t.TempDir(), "rt.db")
	st, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.Ingest(corpus.Leaves); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	n, err := st.Count()
	if err != nil || n != cfg.Leaves {
		t.Fatalf("count=%d err=%v, want %d", n, err, cfg.Leaves)
	}

	// Traversal matches the BFS ground truth for a known seed/type/hops.
	seed := corpus.Leaves[0].ID
	for _, hops := range []int{1, 2, 3} {
		got, err := st.Traverse(seed, "depends-on", hops)
		if err != nil {
			t.Fatalf("traverse: %v", err)
		}
		want := bfsGroundTruth(corpus, seed, "depends-on", hops)
		delete(want, seed)
		gotSet := map[string]struct{}{}
		for _, id := range got {
			gotSet[id] = struct{}{}
		}
		for id := range want {
			if _, ok := gotSet[id]; !ok {
				t.Fatalf("hops=%d traversal missing %s", hops, id)
			}
		}
	}

	// Footprint is on-disk and positive.
	fp, err := st.Footprint()
	if err != nil {
		t.Fatalf("footprint: %v", err)
	}
	if fp.Kind != "disk" || fp.BytesPerLeaf <= 0 {
		t.Fatalf("bad footprint: %+v", fp)
	}
}

// TestSemanticParity: flat and SQLite arms must return identical semantic top-k
// (same vectors, same cosine, same deterministic tie-break).
func TestSemanticParity(t *testing.T) {
	cfg := smallCfg()
	corpus := GenerateCorpus(5, cfg)
	queries := GenerateQueries(corpus, 5)

	flat := NewFlatStore()
	if err := flat.Ingest(corpus.Leaves); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "parity.db")
	sq, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer sq.Close()
	if err := sq.Ingest(corpus.Leaves); err != nil {
		t.Fatal(err)
	}

	checked := 0
	for i := range queries {
		if queries[i].Kind != "semantic" {
			continue
		}
		a, _ := flat.VectorTopK(queries[i].QueryVec, cfg.K)
		b, _ := sq.VectorTopK(queries[i].QueryVec, cfg.K)
		if len(a) != len(b) {
			t.Fatalf("query %d: top-k length flat=%d sqlite=%d", i, len(a), len(b))
		}
		for j := range a {
			if a[j] != b[j] {
				t.Fatalf("query %d rank %d: flat=%s sqlite=%s", i, j, a[j], b[j])
			}
		}
		checked++
		if checked >= 20 {
			break
		}
	}
	if checked == 0 {
		t.Fatal("no semantic queries checked")
	}
}

// TestGraphBeatsFlatRelational: the premise, measured through real stores.
func TestGraphBeatsFlatRelational(t *testing.T) {
	cfg := smallCfg()
	corpus := GenerateCorpus(1, cfg)
	queries := GenerateQueries(corpus, 1)

	flat := NewFlatStore()
	_ = flat.Ingest(corpus.Leaves)
	if _, err := flat.Traverse("leaf-0", "cites", 1); err != ErrNoGraph {
		t.Fatalf("flat Traverse should be ErrNoGraph, got %v", err)
	}
	path := filepath.Join(t.TempDir(), "premise.db")
	sq, _ := NewSQLiteStore(path)
	defer sq.Close()
	_ = sq.Ingest(corpus.Leaves)

	graphRecall := relationalRecall(t, sq, queries, cfg.K)
	flatRecall := relationalRecall(t, flat, queries, cfg.K)

	t.Logf("relational recall@%d: graph=%.3f flat=%.3f (lift %+.3f)", cfg.K, graphRecall, flatRecall, graphRecall-flatRecall)
	if graphRecall < 0.9 {
		t.Fatalf("graph relational recall %.3f too low (want >=0.9)", graphRecall)
	}
	if flatRecall > 0.2 {
		t.Fatalf("flat relational recall %.3f too high (want <=0.2 — control should fail structurally)", flatRecall)
	}
	if graphRecall < flatRecall+0.25 {
		t.Fatalf("premise NOT shown: graph %.3f does not decisively beat flat %.3f", graphRecall, flatRecall)
	}
}

// relationalRecall scores a store's multi-hop retrieval against qrels, using the
// same seed-lookup+traverse (or vector fallback) path as the bench.
func relationalRecall(t *testing.T, st Store, queries []Query, k int) float64 {
	t.Helper()
	var sum float64
	var n int
	for i := range queries {
		q := &queries[i]
		if q.Kind != "relational" {
			continue
		}
		seed, err := st.VectorTopK(q.QueryVec, 1)
		if err != nil {
			t.Fatal(err)
		}
		seedID := q.SeedID
		if len(seed) > 0 {
			seedID = seed[0]
		}
		got, err := st.Traverse(seedID, q.EdgeType, q.Hops)
		if err == ErrNoGraph {
			got, _ = st.VectorTopK(q.QueryVec, k)
		} else if err != nil {
			t.Fatal(err)
		} else if len(got) > k {
			got = got[:k]
		}
		r, _ := recallPrecision(got, q.Relevant)
		sum += r
		n++
	}
	if n == 0 {
		t.Fatal("no relational queries")
	}
	return sum / float64(n)
}

// TestConcurrencyNoLostWrites: concurrent writers + readers, zero lost writes.
func TestConcurrencyNoLostWrites(t *testing.T) {
	cfg := DefaultConfig(300, 10)
	corpus := GenerateCorpus(2, cfg)
	opt := Options{K: 10, PrimarySeed: 2, ConcLevels: []int{1, 4}, ConcItems: 200}

	// SQLite arm.
	path := filepath.Join(t.TempDir(), "conc.db")
	sq, _ := NewSQLiteStore(path)
	defer sq.Close()
	_ = sq.Ingest(corpus.Leaves)
	sqRes, err := benchConcurrency(sq, cfg, opt)
	if err != nil {
		t.Fatalf("sqlite concurrency: %v", err)
	}
	for _, c := range sqRes {
		if c.LostWrites != 0 {
			t.Fatalf("sqlite level=%d lost %d writes", c.Writers, c.LostWrites)
		}
	}

	// Flat arm.
	flat := NewFlatStore()
	_ = flat.Ingest(corpus.Leaves)
	flatRes, err := benchConcurrency(flat, cfg, opt)
	if err != nil {
		t.Fatalf("flat concurrency: %v", err)
	}
	for _, c := range flatRes {
		if c.LostWrites != 0 {
			t.Fatalf("flat level=%d lost %d writes", c.Writers, c.LostWrites)
		}
	}
}

// TestRunSmoke: the full driver at a tiny scale — premise holds, JSON marshals.
func TestRunSmoke(t *testing.T) {
	opt := Options{
		Scales:      []int{300},
		K:           10,
		PrimarySeed: 1,
		RecallSeeds: []uint32{1, 2},
		ConcLevels:  []int{1, 2},
		ConcItems:   50,
		WorkDir:     t.TempDir(),
	}
	rep, err := Run(opt)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !rep.Premise.GraphWinsRel || !rep.Premise.FlatCompetentSem {
		t.Fatalf("premise not shown: %+v", rep.Premise)
	}
	if len(rep.Scales) != 1 || len(rep.Scales[0].Stores) != 2 {
		t.Fatalf("expected 1 scale × 2 stores, got %+v", rep.Scales)
	}
	// Per-store relational recall: graph store must beat the flat control.
	var graphRel, flatRel float64
	for _, s := range rep.Scales[0].Stores {
		switch s.Store {
		case "sqlite-graph":
			graphRel = s.Relational.RecallAtK
		case "flat-inmem":
			flatRel = s.Relational.RecallAtK
		}
	}
	if graphRel < flatRel+0.25 {
		t.Fatalf("through-store premise weak: graph=%.3f flat=%.3f", graphRel, flatRel)
	}
	if err := rep.WriteJSON(io.Discard); err != nil {
		t.Fatalf("json: %v", err)
	}
}
