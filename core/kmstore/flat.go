// flat — the in-memory pure-Go flat-vector baseline (arm B): the "typical flat
// vector RAG" control. A slice of embeddings, brute-force cosine top-k, and NO
// graph. It is the honest floor the graph store must beat on relational,
// multi-hop queries — and the arm to watch for raw semantic-retrieval speed,
// since it pays no SQL / decode / disk cost.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"runtime"
	"sync"
)

// FlatStore is a concurrency-safe in-memory vector index with no graph.
type FlatStore struct {
	mu    sync.RWMutex
	ids   []string
	vecs  [][]float32
	index map[string]int // id -> slot, so re-ingest upserts
}

// NewFlatStore returns an empty flat vector store.
func NewFlatStore() *FlatStore {
	return &FlatStore{index: make(map[string]int)}
}

// Name implements Store.
func (s *FlatStore) Name() string { return "flat-inmem" }

// Ingest appends (or upserts) leaves. Edges are discarded — this arm has no
// graph by design.
func (s *FlatStore) Ingest(leaves []Leaf) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range leaves {
		l := &leaves[i]
		if slot, ok := s.index[l.ID]; ok {
			s.vecs[slot] = l.Embedding
			continue
		}
		s.index[l.ID] = len(s.ids)
		s.ids = append(s.ids, l.ID)
		s.vecs = append(s.vecs, l.Embedding)
	}
	return nil
}

// parallelScanMinN is the corpus size below which fanning the scan across cores costs
// more in goroutine setup than it saves. Measured on an M3 (12 logical / 8 performance
// cores): the serial scan runs at ~0.94 µs per leaf at d=768, so a 512-leaf scan is
// ~0.5 ms while the fan-out costs tens of µs — the crossover sits well below this.
// The guard's real job is to make sure today's 62-leaf Comb never pays for a thread pool.
const parallelScanMinN = 512

// VectorTopK brute-force ranks every vector by cosine similarity.
//
// The scan is the bottleneck, not the ranking: measured at d=768/k=64, it is 90% of the
// call at N=10K (9.45 ms of 10.53 ms) and 88% at N=100K (93.01 ms of 105.68 ms). So it is
// fanned across GOMAXPROCS workers over disjoint index ranges.
//
// The result is bit-identical to the serial scan, by construction: each slot sc[i] is
// written by exactly one worker (no reduction, no accumulation order to vary), and topK
// still applies the same total order — score descending, then id ascending. Parallelism
// here cannot perturb ranking even when scores tie.
func (s *FlatStore) VectorTopK(query []float32, k int) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	n := len(s.ids)
	sc := make([]scored, n)
	if n < parallelScanMinN {
		for i := 0; i < n; i++ {
			sc[i] = scored{id: s.ids[i], score: cosine(s.vecs[i], query)}
		}
		return topK(sc, k), nil
	}

	workers := runtime.GOMAXPROCS(0)
	if workers > n {
		workers = n
	}
	chunk := (n + workers - 1) / workers
	var wg sync.WaitGroup
	for lo := 0; lo < n; lo += chunk {
		hi := lo + chunk
		if hi > n {
			hi = n
		}
		wg.Add(1)
		go func(lo, hi int) {
			defer wg.Done()
			for i := lo; i < hi; i++ {
				sc[i] = scored{id: s.ids[i], score: cosine(s.vecs[i], query)}
			}
		}(lo, hi)
	}
	wg.Wait()
	return topK(sc, k), nil
}

// Traverse always returns ErrNoGraph — the flat control cannot follow edges.
func (s *FlatStore) Traverse(seedID, edgeType string, hops int) ([]string, error) {
	return nil, ErrNoGraph
}

// Count returns the number of leaves held (for the concurrency lost-writes
// check).
func (s *FlatStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.ids)
}

// Footprint reports heap bytes per leaf, sampled around a GC. This is
// approximate and [LOCAL] machine-dependent — it captures the process heap
// delta, which is the honest "what does an in-memory index cost" signal.
func (s *FlatStore) Footprint() (Footprint, error) {
	s.mu.RLock()
	n := len(s.ids)
	s.mu.RUnlock()
	if n == 0 {
		return Footprint{Kind: "heap"}, nil
	}
	// Estimate the retained bytes structurally: id strings + slice headers +
	// float32 backing + map buckets. Structural estimate avoids the noise of a
	// whole-process HeapAlloc reading; the bench also records a process-level
	// delta separately.
	var total int64
	s.mu.RLock()
	for i := range s.ids {
		total += int64(len(s.ids[i]))      // id bytes
		total += int64(len(s.vecs[i]) * 4) // float32 embedding
		total += 16 + 24                   // string header + slice header, approx
	}
	total += int64(n) * 48 // map entry overhead, approx
	s.mu.RUnlock()
	return Footprint{
		Kind:             "heap",
		TotalBytes:       total,
		BytesPerLeaf:     float64(total) / float64(n),
		HeapBytesPerLeaf: float64(total) / float64(n),
	}, nil
}

// Close is a no-op for the in-memory store.
func (s *FlatStore) Close() error { return nil }

// HeapAllocNow returns the current process heap allocation after a GC — the
// bench uses it to record a coarse process-level footprint alongside the
// structural estimate.
func HeapAllocNow() uint64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}
