package kmstore_test

// Tests for RetrieveOpts.MinScore and Leaf.Score.
//
// Vectors here are hand-built orthogonal/unit vectors rather than HashEmbed output, so every
// expected cosine is exact and the assertions carry no embedder assumptions. The floor values
// are chosen to sit between those exact scores — they are NOT the calibrated production floor
// (that is embedder- and corpus-specific: see research/results/2026-07-09-retrieve-floor.json).

import (
	"math"
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
)

const invSqrt2 = float32(0.70710678)

// floorStore seeds four leaves at known cosines to the query [1,0,0]:
//
//	exact   [1,0,0]            cos = 1.0
//	partial [.707,.707,0]      cos ≈ 0.7071
//	orthog  [0,1,0]            cos = 0.0
//	anti    [-1,0,0]           cos = -1.0
func floorStore(t *testing.T) *kmstore.KMStore {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	seed := []struct {
		id  string
		vec []float32
	}{
		{"exact", []float32{1, 0, 0}},
		{"partial", []float32{invSqrt2, invSqrt2, 0}},
		{"orthog", []float32{0, 1, 0}},
		{"anti", []float32{-1, 0, 0}},
	}
	for _, s := range seed {
		if _, err := st.Put(kmstore.Leaf{
			ID: s.id, Content: "content of " + s.id, Author: "scribe", Embedding: s.vec,
		}); err != nil {
			t.Fatalf("Put(%s): %v", s.id, err)
		}
	}
	return st
}

func ids(ls []kmstore.Leaf) []string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = l.ID
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The default (MinScore unset) must behave EXACTLY as before the field existed: k leaves
// returned however poor the match, including the anti-correlated one. Zero means OFF, not
// "drop negative scores" — this is the guarantee that adding the field changed no behavior.
func TestRetrieveMinScoreZeroIsOffNotDropNegatives(t *testing.T) {
	st := floorStore(t)
	got, err := st.Retrieve([]float32{1, 0, 0}, 4, kmstore.RetrieveOpts{})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	want := []string{"exact", "partial", "orthog", "anti"}
	if !eq(ids(got), want) {
		t.Errorf("default retrieve = %v, want %v (all four, ranked)", ids(got), want)
	}
}

// A floor between the partial and orthogonal scores keeps the two relevant leaves and drops
// the irrelevant ones — the fix for "Augment prepends off-topic Context".
func TestRetrieveMinScoreFiltersIrrelevant(t *testing.T) {
	st := floorStore(t)
	got, err := st.Retrieve([]float32{1, 0, 0}, 4, kmstore.RetrieveOpts{MinScore: 0.5})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if want := []string{"exact", "partial"}; !eq(ids(got), want) {
		t.Errorf("MinScore=0.5 → %v, want %v", ids(got), want)
	}
}

// The operator's actual failure: a query whose answer is in no leaf. Without a floor the store
// returns confidently-ranked noise; with one it must return NOTHING. k is not a lower bound.
func TestRetrieveMinScoreNoRelevantLeafReturnsEmpty(t *testing.T) {
	st := floorStore(t)
	got, err := st.Retrieve([]float32{0, 0, 1}, 4, kmstore.RetrieveOpts{MinScore: 0.5})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("orthogonal query with MinScore=0.5 returned %d leaves (%v), want 0 — "+
			"a query with no relevant leaf must return nothing, not the k least-bad", len(got), ids(got))
	}
	// And without the floor, the same query returns noise — this is the bug being fixed.
	noisy, err := st.Retrieve([]float32{0, 0, 1}, 4, kmstore.RetrieveOpts{})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(noisy) == 0 {
		t.Fatal("precondition failed: floor-off retrieval should still return the noise")
	}
}

// A floor above every score empties the result even though relevant-ish leaves exist.
func TestRetrieveMinScoreAboveAllScoresReturnsEmpty(t *testing.T) {
	st := floorStore(t)
	got, err := st.Retrieve([]float32{1, 0, 0}, 4, kmstore.RetrieveOpts{MinScore: 1.5})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("MinScore=1.5 → %v, want empty", ids(got))
	}
}

// Score must be surfaced, exact, and monotonically non-increasing across the result.
func TestRetrieveSurfacesScoreDescending(t *testing.T) {
	st := floorStore(t)
	got, err := st.Retrieve([]float32{1, 0, 0}, 4, kmstore.RetrieveOpts{})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	want := map[string]float64{"exact": 1.0, "partial": 0.70710678, "orthog": 0.0, "anti": -1.0}
	for _, l := range got {
		if math.Abs(l.Score-want[l.ID]) > 1e-6 {
			t.Errorf("leaf %s Score = %v, want %v", l.ID, l.Score, want[l.ID])
		}
	}
	for i := 1; i < len(got); i++ {
		if got[i].Score > got[i-1].Score {
			t.Errorf("scores not descending: %v(%f) after %v(%f)",
				got[i].ID, got[i].Score, got[i-1].ID, got[i-1].Score)
		}
	}
}

// Score is a read-time annotation. A bogus Score on the way IN must never survive to the way
// OUT — the retrieved value is always recomputed from the embedding, never echoed from disk.
func TestRetrieveScoreIsComputedNotPersisted(t *testing.T) {
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()
	if _, err := st.Put(kmstore.Leaf{
		ID: "poisoned", Content: "c", Author: "scribe",
		Embedding: []float32{0, 1, 0}, Score: 99.0, // orthogonal to the query, but claims 99
	}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := st.Retrieve([]float32{1, 0, 0}, 1, kmstore.RetrieveOpts{})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d leaves, want 1", len(got))
	}
	if math.Abs(got[0].Score) > 1e-6 {
		t.Errorf("Score = %v, want ~0 (recomputed); a persisted Score would let a writer forge relevance", got[0].Score)
	}
}

// The floor composes with the governed read rather than bypassing it: an un-attested leaf that
// clears the floor must still be refused under AttestedOnly.
func TestRetrieveMinScoreComposesWithAttestedOnly(t *testing.T) {
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()
	st.RegisterVerifier("curator")
	// Perfect match, but un-attested (no verifier).
	if _, err := st.Put(kmstore.Leaf{ID: "unattested", Content: "c", Author: "a", Embedding: []float32{1, 0, 0}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := st.Retrieve([]float32{1, 0, 0}, 5, kmstore.RetrieveOpts{AttestedOnly: true, MinScore: 0.5})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("un-attested leaf cleared the floor and escaped the governed read: %v", ids(got))
	}
}
