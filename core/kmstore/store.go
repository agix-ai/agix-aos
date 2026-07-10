// store — the one interface every KM backend implements, plus the shared vector
// math and encoding. Two backends live behind it:
//
//   - SQLiteStore (sqlite.go): the recommended local primary — a pure-Go,
//     CGo-free graph store (nodes + typed edges) on modernc.org/sqlite, with
//     embeddings held as float32 BLOBs and cosine ranked IN GO. Deliberately
//     NOT sqlite-vec: the CGo-free sqlite-vec WASM path is version-brittle
//     (bindings ↔ ncruces ↔ wazero mismatch → panics). modernc + Go-side cosine
//     is rock-solid and stays CGo-free.
//   - FlatStore (flat.go): the "typical flat vector RAG" control — an in-memory
//     slice of embeddings, brute-force cosine top-k, NO graph.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"container/heap"
	"encoding/binary"
	"errors"
	"math"
	"sort"
)

// ErrNoGraph is returned by Traverse on a store that has no graph (the flat
// vector control). The harness treats it as "structurally cannot follow edges"
// and falls back to a pure vector top-k for that store's relational arm.
var ErrNoGraph = errors.New("kmstore: store has no graph (flat vector control)")

// Footprint reports how much space a store holds per leaf. Disk is authoritative
// for the SQLite store; Heap is authoritative for the in-memory flat store.
// Both are [LOCAL] machine-dependent.
type Footprint struct {
	Kind             string  `json:"kind"` // "disk" | "heap"
	TotalBytes       int64   `json:"total_bytes"`
	BytesPerLeaf     float64 `json:"bytes_per_leaf"`
	DiskBytesPerLeaf float64 `json:"disk_bytes_per_leaf,omitempty"`
	HeapBytesPerLeaf float64 `json:"heap_bytes_per_leaf,omitempty"`
}

// Store is the single seam across candidate KM data-store architectures.
type Store interface {
	// Name identifies the backend in results.
	Name() string
	// Ingest inserts (or upserts) leaves and their edges. Safe to call more
	// than once to append (the concurrency test relies on this).
	Ingest(leaves []Leaf) error
	// VectorTopK returns the ids of the k most cosine-similar leaves to query.
	VectorTopK(query []float32, k int) ([]string, error)
	// Traverse follows typed edges of edgeType from seedID for hops steps and
	// returns the reached ids. Graph stores implement it; flat stores return
	// ErrNoGraph.
	Traverse(seedID, edgeType string, hops int) ([]string, error)
	// Footprint reports space held (disk or heap) after ingest.
	Footprint() (Footprint, error)
	// Close releases resources.
	Close() error
}

// ───────────────────────────── vector math ──────────────────────────────────

// cosine is the dot product of two vectors (both are stored unit-length, so the
// dot product IS the cosine). Accumulated in float64 for stability.
func cosine(a, b []float32) float64 {
	var d float64
	for i := range a {
		d += float64(a[i]) * float64(b[i])
	}
	return d
}

// scored is an (id, score) pair for ranking.
type scored struct {
	id    string
	score float64
}

// ranksBefore is the total order every store ranks by: score descending, then id
// ascending (the premise tie-break, for determinism). Ids are unique within a store,
// so this is a strict total order and the resulting ranking is unambiguous.
func ranksBefore(a, b scored) bool {
	if a.score != b.score {
		return a.score > b.score
	}
	return a.id < b.id
}

// worstHeap is a min-heap under ranksBefore: its root is the entry that ranks LAST
// among those retained, i.e. the first to be evicted when a better one arrives.
type worstHeap []scored

func (h worstHeap) Len() int           { return len(h) }
func (h worstHeap) Less(i, j int) bool { return ranksBefore(h[j], h[i]) }
func (h worstHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *worstHeap) Push(x any)        { *h = append(*h, x.(scored)) }
func (h *worstHeap) Pop() any          { old := *h; n := len(old); x := old[n-1]; *h = old[:n-1]; return x }

// topK returns the ids of the k highest-scoring entries under ranksBefore.
//
// It selects into a bounded k-heap — O(N log k) — instead of sorting all N entries to
// return k of them. Once the scan was parallelized (flat.go), that full sort became the
// dominant cost: 15.3 ms of a 30.3 ms call at N=100K, k=64, i.e. 51% of the work spent
// ordering 99,936 entries nobody asked for.
//
// The result is identical to sort-then-truncate: ranksBefore is a strict total order, so
// "the k least elements" is uniquely defined and the k survivors are sorted by the same
// comparator before returning. When k approaches N the heap's bookkeeping outweighs the
// saving, so we fall back to the plain sort.
//
// NOTE: unlike the previous implementation, topK no longer sorts `s` in place. No caller
// relied on that side effect (all six discard the slice), and depending on it would now be
// a bug.
func topK(s []scored, k int) []string {
	if k > len(s) {
		k = len(s)
	}
	if k <= 0 {
		return []string{}
	}
	if k*4 >= len(s) { // heap bookkeeping stops paying for itself
		sort.Slice(s, func(i, j int) bool { return ranksBefore(s[i], s[j]) })
		out := make([]string, k)
		for i := 0; i < k; i++ {
			out[i] = s[i].id
		}
		return out
	}

	// Seed the first k directly and heapify in O(k), rather than k× heap.Push — Push takes
	// `any`, so every scored gets boxed onto the heap and that dominated the allocation
	// profile (103 allocs/op). Push/Pop remain only to satisfy heap.Interface; neither runs.
	h := make(worstHeap, 0, k)
	i := 0
	for ; i < len(s) && len(h) < k; i++ {
		h = append(h, s[i])
	}
	heap.Init(&h)
	for ; i < len(s); i++ {
		if ranksBefore(s[i], h[0]) { // better than the worst retained ⇒ evict the root
			h[0] = s[i]
			heap.Fix(&h, 0)
		}
	}
	sort.Slice(h, func(i, j int) bool { return ranksBefore(h[i], h[j]) })
	out := make([]string, len(h))
	for i := range h {
		out[i] = h[i].id
	}
	return out
}

// ───────────────────────────── encoding ─────────────────────────────────────

// encodeVec packs a float32 vector into a little-endian BLOB (4 bytes/dim) —
// the on-disk embedding format for the SQLite store.
func encodeVec(v []float32) []byte {
	b := make([]byte, len(v)*4)
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(x))
	}
	return b
}

// decodeVec unpacks a little-endian float32 BLOB into a vector.
func decodeVec(b []byte) []float32 {
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v
}

// ───────────────────────────── small helpers ────────────────────────────────

func leafID(i int) string { return "leaf-" + itoa(i) }

// itoa is a tiny base-10 formatter (avoids importing strconv here).
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

func dedupeInts(in []int) []int {
	seen := make(map[int]struct{}, len(in))
	out := in[:0:0]
	for _, x := range in {
		if _, ok := seen[x]; ok {
			continue
		}
		seen[x] = struct{}{}
		out = append(out, x)
	}
	return out
}

func containsInt(s []int, x int) bool {
	for _, v := range s {
		if v == x {
			return true
		}
	}
	return false
}

func normalize32(v []float64) []float32 {
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n == 0 {
		n = 1
	}
	inv := 1.0 / math.Sqrt(n)
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(x * inv)
	}
	return out
}

func mathSqrt(x float64) float64 { return math.Sqrt(x) }
