package kmstore

// Benchmarks for the Go front door's brute-force scan. `VectorTopK` does two things and it is
// not obvious which dominates:
//
//	1. the cosine scan   — O(N·d), scalar, single-threaded
//	2. topK              — sorts ALL N scored entries, O(N log N), to return k of them
//
// The 2026-07-08 measurement (1.02 ms @1K → 1089 ms @1M, perfectly linear) is consistent with
// either being the bottleneck, so measure them apart before optimizing either.
//
// Run: go test ./kmstore/ -run XXX -bench 'BenchmarkFlat' -benchmem

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

func flatRandVecs(n, dim int, seed int64) ([]string, [][]float32) {
	rng := rand.New(rand.NewSource(seed))
	ids := make([]string, n)
	vecs := make([][]float32, n)
	for i := range vecs {
		v := make([]float32, dim)
		var s float64
		for j := range v {
			v[j] = float32(rng.NormFloat64())
			s += float64(v[j]) * float64(v[j])
		}
		inv := 1.0 / math.Sqrt(s)
		for j := range v {
			v[j] = float32(float64(v[j]) * inv)
		}
		ids[i], vecs[i] = fmt.Sprintf("leaf-%d", i), v
	}
	return ids, vecs
}

func flatBenchStore(n, dim int) (*FlatStore, []float32) {
	ids, vecs := flatRandVecs(n, dim, 1)
	s := NewFlatStore()
	leaves := make([]Leaf, n)
	for i := range leaves {
		leaves[i] = Leaf{ID: ids[i], Embedding: vecs[i]}
	}
	_ = s.Ingest(leaves)
	_, q := flatRandVecs(1, dim, 99)
	return s, q[0]
}

var sinkIDs []string

// End-to-end: what a caller actually pays.
func BenchmarkFlatVectorTopK(b *testing.B) {
	for _, n := range []int{1_000, 10_000, 50_000, 100_000} {
		s, q := flatBenchStore(n, 768)
		b.Run(fmt.Sprintf("N=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				sinkIDs, _ = s.VectorTopK(q, 64)
			}
		})
	}
}

var sinkScored []scored

// Stage 1 alone: the cosine scan, no ranking.
func BenchmarkFlatScanOnly(b *testing.B) {
	for _, n := range []int{10_000, 100_000} {
		s, q := flatBenchStore(n, 768)
		b.Run(fmt.Sprintf("N=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				sc := make([]scored, len(s.ids))
				for j := range s.ids {
					sc[j] = scored{id: s.ids[j], score: cosine(s.vecs[j], q)}
				}
				sinkScored = sc
			}
		})
	}
}

// Stage 2 alone: ranking a pre-scored slice. Re-materialized each iteration because topK
// sorts in place and would otherwise measure "sort an already-sorted slice" from iteration 2.
func BenchmarkFlatTopKOnly(b *testing.B) {
	for _, n := range []int{10_000, 100_000} {
		s, q := flatBenchStore(n, 768)
		base := make([]scored, len(s.ids))
		for j := range s.ids {
			base[j] = scored{id: s.ids[j], score: cosine(s.vecs[j], q)}
		}
		b.Run(fmt.Sprintf("N=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			buf := make([]scored, len(base))
			for i := 0; i < b.N; i++ {
				copy(buf, base)
				sinkIDs = topK(buf, 64)
			}
		})
	}
}
