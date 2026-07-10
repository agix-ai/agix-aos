package kmstore

import "testing"

// TestBuildRealFactsPrefixStable: fact i's text/query must be identical whether
// the corpus is built at N=40 or N=320 (a prefix of the same shuffled order), so
// one embed pass can serve every compounding-curve size. It also confirms facts
// draw DISTINCT (verb,object) capabilities up to the vocabulary bound.
func TestBuildRealFactsPrefixStable(t *testing.T) {
	small := buildRealFacts(1, 40)
	big := buildRealFacts(1, 320)
	if len(small) != 40 || len(big) != 320 {
		t.Fatalf("sizes: small=%d big=%d", len(small), len(big))
	}
	for i := 0; i < 40; i++ {
		if small[i].Text != big[i].Text || small[i].Query != big[i].Query {
			t.Fatalf("prefix not stable at %d:\n  small=%q\n  big=%q", i, small[i].Text, big[i].Text)
		}
	}
	// Distinct fact texts (distinct capabilities) up to the 320-combo bound.
	seen := make(map[string]struct{})
	for _, f := range big {
		if _, dup := seen[f.Text]; dup {
			t.Fatalf("duplicate fact text: %q", f.Text)
		}
		seen[f.Text] = struct{}{}
	}
	// Capped at the vocabulary.
	if got := buildRealFacts(1, 10000); len(got) != maxCombos() {
		t.Fatalf("over-cap N: got %d, want %d", len(got), maxCombos())
	}
}

// TestBFSHopsClosure: 2-hop closure over the deterministic depends-on graph is
// well-formed (excludes the seed, non-empty for a reasonable corpus).
func TestBFSHopsClosure(t *testing.T) {
	got := bfsHops(0, 2, 40)
	if len(got) == 0 {
		t.Fatal("empty 2-hop closure for seed 0")
	}
	if _, ok := got[leafID(0)]; ok {
		t.Fatal("closure must exclude the seed")
	}
}

// TestRunRealisticHashOffline is the offline (no-daemon, $0) exercise of the whole
// realistic harness with the frozen HashEmbedder — so CI runs it green. It asserts
// every metric is a valid rate, the collision + curve diagnostics are populated,
// and the run is deterministic.
func TestRunRealisticHashOffline(t *testing.T) {
	opt := RealisticOptions{N: 200, Seed: 1, K: 10, Curve: []int{40, 100, 200}, Hops: 2}
	a, err := RunRealistic(NewHashEmbedder(64), opt)
	if err != nil {
		t.Fatalf("RunRealistic: %v", err)
	}
	if a.Facts != 200 || a.Queries != 200 {
		t.Fatalf("facts/queries: %d/%d", a.Facts, a.Queries)
	}
	for _, m := range []struct {
		name string
		v    float64
	}{
		{"self_top1", a.SelfTop1}, {"entity_top1", a.EntityTop1}, {"recall@k", a.RecallAtK},
		{"graph_entered", a.GraphEntered}, {"two_hop_recall", a.TwoHopRecall}, {"unrelated_cos", a.MeanUnrelatedCos},
	} {
		if m.v < 0 || m.v > 1 {
			t.Errorf("%s=%v out of [0,1]", m.name, m.v)
		}
	}
	if a.DistinctVectors < 1 || a.DistinctVectors > a.Facts {
		t.Errorf("distinct_vectors=%d, want 1..%d", a.DistinctVectors, a.Facts)
	}
	if len(a.Curve) != 3 {
		t.Fatalf("curve points=%d, want 3", len(a.Curve))
	}
	// Recall@k is a superset of top-1, so it can never be lower.
	if a.RecallAtK+1e-9 < a.EntityTop1 {
		t.Errorf("recall@k (%.3f) < entity_top1 (%.3f)", a.RecallAtK, a.EntityTop1)
	}

	// Determinism: a second run yields identical metrics (embed time excepted).
	b, err := RunRealistic(NewHashEmbedder(64), opt)
	if err != nil {
		t.Fatalf("RunRealistic#2: %v", err)
	}
	if a.SelfTop1 != b.SelfTop1 || a.EntityTop1 != b.EntityTop1 || a.RecallAtK != b.RecallAtK ||
		a.GraphEntered != b.GraphEntered || a.TwoHopRecall != b.TwoHopRecall ||
		a.DistinctVectors != b.DistinctVectors || a.MeanUnrelatedCos != b.MeanUnrelatedCos {
		t.Errorf("non-deterministic run:\n a=%+v\n b=%+v", a, b)
	}
}

// TestRunRealisticCompareOffline exercises the multi-arm compare path with two
// offline hash embedders (dim 64 vs 768). Both arms must appear; higher dim must
// not COLLAPSE more (fewer distinct vectors) than low dim — the collision-control
// invariant the dim-768 arm exists to demonstrate.
func TestRunRealisticCompareOffline(t *testing.T) {
	opt := RealisticOptions{N: 200, Seed: 2, K: 10, Curve: []int{100, 200}, Hops: 2}
	rep := RunRealisticCompare(opt, NewHashEmbedder(64), NewHashEmbedder(768))
	if len(rep.Arms) != 2 {
		t.Fatalf("arms=%d, want 2", len(rep.Arms))
	}
	lo, hi := rep.Arms[0], rep.Arms[1]
	if lo.DistinctVectors > hi.DistinctVectors {
		t.Errorf("dim-64 has MORE distinct vectors (%d) than dim-768 (%d) — collision control broken",
			lo.DistinctVectors, hi.DistinctVectors)
	}
}
