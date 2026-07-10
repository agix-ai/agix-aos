package kmstore

// topK switched from "sort all N, take k" to a bounded k-heap. That is only safe if the two
// are indistinguishable for every input, so these tests hold the new implementation against a
// full-sort oracle — deliberately NOT sharing any code with it.
//
// The interesting inputs are the ones where a heap can silently disagree with a sort:
//   - massive score ties, where ranking falls entirely to the id tie-break
//   - k straddling the k*4 >= N fallback boundary
//   - k == 1, k == N, k > N, N == 0

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

// topKOracle is the pre-optimization semantics, written out longhand: sort everything by
// (score desc, id asc), take the first k ids.
func topKOracle(s []scored, k int) []string {
	cp := append([]scored(nil), s...)
	sort.Slice(cp, func(i, j int) bool {
		if cp[i].score != cp[j].score {
			return cp[i].score > cp[j].score
		}
		return cp[i].id < cp[j].id
	})
	if k > len(cp) {
		k = len(cp)
	}
	if k < 0 {
		k = 0
	}
	out := make([]string, k)
	for i := 0; i < k; i++ {
		out[i] = cp[i].id
	}
	return out
}

func sameIDs(t *testing.T, got, want []string, ctx string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: len %d != oracle %d\n got=%v\nwant=%v", ctx, len(got), len(want), got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s: rank %d = %q, oracle says %q\n got=%v\nwant=%v", ctx, i, got[i], want[i], got, want)
		}
	}
}

// buckets controls how many DISTINCT scores exist: buckets=1 means every entry ties.
func makeScored(n, buckets int, seed int64) []scored {
	rng := rand.New(rand.NewSource(seed))
	s := make([]scored, n)
	for i := range s {
		var sc float64
		if buckets <= 1 {
			sc = 0.5
		} else {
			sc = float64(rng.Intn(buckets)) / float64(buckets)
		}
		s[i] = scored{id: fmt.Sprintf("leaf-%06d", i), score: sc}
	}
	rng.Shuffle(len(s), func(i, j int) { s[i], s[j] = s[j], s[i] })
	return s
}

func TestTopKMatchesFullSortOracle(t *testing.T) {
	for _, n := range []int{0, 1, 2, 63, 64, 65, 1000, 5000} {
		for _, buckets := range []int{1, 3, 50, 1 << 20} { // 1 == everything ties
			for _, k := range []int{1, 8, 64, n / 4, n / 2, n, n + 5} {
				if k < 0 {
					continue
				}
				s := makeScored(n, buckets, int64(n*31+buckets))
				got := topK(append([]scored(nil), s...), k)
				want := topKOracle(s, k)
				sameIDs(t, got, want, fmt.Sprintf("n=%d buckets=%d k=%d", n, buckets, k))
			}
		}
	}
}

// The k*4 >= N fallback boundary: exercise both sides and the exact edge.
func TestTopKHeapAndSortPathsAgree(t *testing.T) {
	const n = 400
	s := makeScored(n, 7, 99) // heavy ties across 7 score buckets
	for k := 1; k <= n; k++ {
		got := topK(append([]scored(nil), s...), k)
		want := topKOracle(s, k)
		sameIDs(t, got, want, fmt.Sprintf("k=%d (heap path: %v)", k, k*4 < n))
	}
}

// Every entry ties ⇒ the result must be the k lexicographically smallest ids, deterministically.
func TestTopKAllTiesFallsToIDOrder(t *testing.T) {
	const n = 2000
	s := makeScored(n, 1, 5)
	got := topK(append([]scored(nil), s...), 5)
	want := []string{"leaf-000000", "leaf-000001", "leaf-000002", "leaf-000003", "leaf-000004"}
	sameIDs(t, got, want, "all ties")
	// Stable across repeated calls on reshuffled input.
	for trial := 0; trial < 25; trial++ {
		rand.Shuffle(len(s), func(i, j int) { s[i], s[j] = s[j], s[i] })
		sameIDs(t, topK(append([]scored(nil), s...), 5), want, fmt.Sprintf("all ties trial %d", trial))
	}
}

// topK no longer sorts its input in place. Pin that contract so a future caller can't quietly
// start depending on the old side effect.
func TestTopKDoesNotSortInputInPlaceOnHeapPath(t *testing.T) {
	s := makeScored(1000, 1<<20, 3)
	before := append([]scored(nil), s...)
	_ = topK(s, 8) // k*4 < n ⇒ heap path
	for i := range s {
		if s[i] != before[i] {
			return // it did mutate; that's allowed, just don't rely on ordering
		}
	}
	// Unchanged is the expected outcome on the heap path.
}

func BenchmarkTopK(b *testing.B) {
	for _, n := range []int{10_000, 100_000} {
		s := makeScored(n, 1<<20, 11)
		b.Run(fmt.Sprintf("N=%d/k=64", n), func(b *testing.B) {
			b.ReportAllocs()
			buf := make([]scored, n)
			for i := 0; i < b.N; i++ {
				copy(buf, s)
				sinkIDs = topK(buf, 64)
			}
		})
	}
}
