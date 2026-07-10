package kmstore

// Equivalence tests for the parallel scan in FlatStore.VectorTopK.
//
// The optimization is only safe if it is INVISIBLE: identical ids, identical order, for every
// N on both sides of parallelScanMinN, and — the case that would actually break — when many
// leaves share a score and ranking falls to the id tie-break.

import (
	"fmt"
	"testing"
)

// serialTopK is the pre-optimization implementation, kept verbatim as the oracle.
func serialTopK(s *FlatStore, query []float32, k int) []string {
	sc := make([]scored, len(s.ids))
	for i := range s.ids {
		sc[i] = scored{id: s.ids[i], score: cosine(s.vecs[i], query)}
	}
	return topK(sc, k)
}

func mustEqual(t *testing.T, got, want []string, ctx string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: len %d != %d", ctx, len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s: rank %d = %q, serial oracle says %q", ctx, i, got[i], want[i])
		}
	}
}

// Straddle the threshold, including the exact boundary and N=0.
func TestVectorTopKParallelMatchesSerial(t *testing.T) {
	for _, n := range []int{0, 1, 7, parallelScanMinN - 1, parallelScanMinN, parallelScanMinN + 1, 5000} {
		ids, vecs := flatRandVecs(n, 64, 7)
		s := NewFlatStore()
		leaves := make([]Leaf, n)
		for i := range leaves {
			leaves[i] = Leaf{ID: ids[i], Embedding: vecs[i]}
		}
		if err := s.Ingest(leaves); err != nil {
			t.Fatalf("Ingest: %v", err)
		}
		_, q := flatRandVecs(1, 64, 42)
		got, err := s.VectorTopK(q[0], 10)
		if err != nil {
			t.Fatalf("VectorTopK: %v", err)
		}
		mustEqual(t, got, serialTopK(s, q[0], 10), fmt.Sprintf("N=%d", n))
	}
}

// The dangerous case: every leaf carries the SAME vector, so every score ties and the entire
// ranking is decided by the id tie-break. A racy or order-dependent scan shows up here.
func TestVectorTopKParallelTieBreakIsDeterministic(t *testing.T) {
	const n = 4096
	s := NewFlatStore()
	leaves := make([]Leaf, n)
	for i := range leaves {
		// Identical embeddings ⇒ identical cosine ⇒ ranking is purely by id.
		leaves[i] = Leaf{ID: fmt.Sprintf("leaf-%05d", i), Embedding: []float32{1, 0, 0, 0}}
	}
	if err := s.Ingest(leaves); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	q := []float32{1, 0, 0, 0}

	want := serialTopK(s, q, 8)
	for trial := 0; trial < 50; trial++ {
		got, err := s.VectorTopK(q, 8)
		if err != nil {
			t.Fatalf("VectorTopK: %v", err)
		}
		mustEqual(t, got, want, fmt.Sprintf("all-ties trial %d", trial))
	}
	// Sanity: the tie-break really is id-ascending, so the oracle isn't vacuous.
	if want[0] != "leaf-00000" || want[7] != "leaf-00007" {
		t.Fatalf("tie-break is not id-ascending: %v", want)
	}
}

// Duplicate scores in CLUSTERS spanning worker chunk boundaries — a chunk-off-by-one would
// drop or duplicate a leaf here.
func TestVectorTopKParallelChunkBoundaries(t *testing.T) {
	const n = 3000 // not a multiple of any likely GOMAXPROCS
	s := NewFlatStore()
	leaves := make([]Leaf, n)
	for i := range leaves {
		v := []float32{float32(i % 13), float32(i % 7), 1, 0}
		leaves[i] = Leaf{ID: fmt.Sprintf("leaf-%05d", i), Embedding: normalizeF32(v)}
	}
	if err := s.Ingest(leaves); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	q := normalizeF32([]float32{3, 2, 1, 0})

	got, err := s.VectorTopK(q, 64)
	if err != nil {
		t.Fatalf("VectorTopK: %v", err)
	}
	mustEqual(t, got, serialTopK(s, q, 64), "chunk boundaries")

	// No leaf may appear twice.
	seen := map[string]bool{}
	for _, id := range got {
		if seen[id] {
			t.Fatalf("duplicate id %q in result", id)
		}
		seen[id] = true
	}
}
