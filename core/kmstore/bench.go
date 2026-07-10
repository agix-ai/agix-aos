// bench — the efficiency harness. For each backend × scale it measures ingest
// throughput, footprint (disk or heap bytes/leaf), semantic retrieval latency
// (p50/p95/p99) and recall/precision, multi-hop relational recall + traversal
// latency, and a writer×reader concurrency test (throughput, read p99 under
// contention, zero-lost-writes). It also runs an in-memory, n=seeds premise
// summary so the load-bearing "graph beats flat on relational" claim is a curve,
// not an assertion.
//
// EVIDENCE CLASS [LOCAL]. Recall/precision are DETERMINISTIC (seeded, model-free
// embeddings) and machine-independent. Latency and footprint are [LOCAL]
// machine-dependent — reproducible on the same host, not portable numbers.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────── result types ───────────────────────────────

// Report is the whole benchmark output (also emitted as JSON).
type Report struct {
	Tool          string        `json:"tool"`
	GeneratedAt   string        `json:"generated_at"`
	GoVersion     string        `json:"go_version"`
	OS            string        `json:"os"`
	Arch          string        `json:"arch"`
	CPUs          int           `json:"cpus"`
	CGoFree       bool          `json:"cgo_free"`
	EvidenceClass string        `json:"evidence_class"`
	PrimarySeed   uint32        `json:"primary_seed"`
	RecallSeeds   []uint32      `json:"recall_seeds"`
	K             int           `json:"k"`
	Scales        []ScaleResult `json:"scales"`
	Premise       Premise       `json:"premise"`
	Notes         []string      `json:"notes"`
}

// ScaleResult holds every backend's metrics at one corpus size.
type ScaleResult struct {
	N           int           `json:"n"`
	QueryCounts QueryCounts   `json:"query_counts"`
	Stores      []StoreResult `json:"stores"`
}

// QueryCounts records how many qrels queries of each class scored the stores.
type QueryCounts struct {
	Semantic   int `json:"semantic"`
	Relational int `json:"relational"`
}

// StoreResult is one backend's metrics at one scale.
type StoreResult struct {
	Store             string              `json:"store"`
	N                 int                 `json:"n"`
	IngestItemsPerSec float64             `json:"ingest_items_per_sec"`
	IngestSeconds     float64             `json:"ingest_seconds"`
	Footprint         Footprint           `json:"footprint"`
	ProcHeapBytes     int64               `json:"proc_heap_delta_bytes,omitempty"`
	Semantic          RetrievalResult     `json:"semantic"`
	Relational        RelationalResult    `json:"relational"`
	Concurrency       []ConcurrencyResult `json:"concurrency"`
}

// RetrievalResult is the semantic (vector top-k) arm.
type RetrievalResult struct {
	K            int     `json:"k"`
	Queries      int     `json:"queries"`
	LatP50Us     float64 `json:"latency_p50_us"`
	LatP95Us     float64 `json:"latency_p95_us"`
	LatP99Us     float64 `json:"latency_p99_us"`
	RecallAtK    float64 `json:"recall_at_k"`
	PrecisionAtK float64 `json:"precision_at_k"`
}

// RelationalResult is the multi-hop arm: end-to-end relational answer latency,
// isolated traversal latency (graph stores only), and relational recall@k.
type RelationalResult struct {
	Queries         int     `json:"queries"`
	EndToEndP50Us   float64 `json:"end_to_end_p50_us"`
	EndToEndP95Us   float64 `json:"end_to_end_p95_us"`
	EndToEndP99Us   float64 `json:"end_to_end_p99_us"`
	TraversalP50Us  float64 `json:"traversal_p50_us"`
	TraversalP99Us  float64 `json:"traversal_p99_us"`
	HasGraph        bool    `json:"has_graph"`
	RecallAtK       float64 `json:"recall_at_k"`
	RecallAtKSeeded float64 `json:"recall_at_k_seeded"` // averaged over RecallSeeds
	Seeds           int     `json:"seeds"`
}

// ConcurrencyResult is one writer×reader contention level.
type ConcurrencyResult struct {
	Writers             int     `json:"writers"`
	Readers             int     `json:"readers"`
	ItemsWritten        int     `json:"items_written"`
	WriteItemsPerSec    float64 `json:"write_items_per_sec"`
	Reads               int     `json:"reads"`
	ReadP99Us           float64 `json:"read_p99_us"`
	LostWrites          int     `json:"lost_writes"`
	ZeroWriteContention bool    `json:"zero_lost_writes"`
}

// Premise is the n=seeds in-memory quality headline (graph vs flat on relational).
type Premise struct {
	Seeds             []uint32 `json:"seeds"`
	RelGraphRecallAvg float64  `json:"rel_graph_recall_avg"`
	RelFlatRecallAvg  float64  `json:"rel_flat_recall_avg"`
	RelationalLift    float64  `json:"relational_lift"`
	WorstRelLift      float64  `json:"worst_relational_lift"`
	SemFlatPrecAvg    float64  `json:"sem_flat_precision_avg"`
	GraphWinsRel      bool     `json:"graph_wins_relational"`
	FlatCompetentSem  bool     `json:"flat_competent_semantic"`
	Verdict           string   `json:"verdict"`
}

// ─────────────────────────────── options ────────────────────────────────────

// Options configures a benchmark run.
type Options struct {
	Scales      []int    // corpus sizes to sweep
	K           int      // retrieval cutoff
	PrimarySeed uint32   // seed for all store-measured (efficiency) metrics
	RecallSeeds []uint32 // seeds averaged for the recall headline
	ConcLevels  []int    // writer=reader levels for the concurrency test
	ConcItems   int      // writer leaves added during the concurrency test
	WorkDir     string   // scratch dir for SQLite files (temp if empty)
}

// DefaultOptions returns a sensible sweep: N∈{1000,10000,100000}, k=10.
func DefaultOptions() Options {
	return Options{
		Scales:      []int{1000, 10000, 100000},
		K:           10,
		PrimarySeed: 1,
		RecallSeeds: []uint32{1, 2, 3},
		ConcLevels:  []int{1, 4, 8, 16},
		ConcItems:   1000,
	}
}

// ─────────────────────────────── driver ─────────────────────────────────────

// Run executes the full benchmark and returns a populated Report.
func Run(opt Options) (*Report, error) {
	if opt.K <= 0 {
		opt.K = 10
	}
	if len(opt.ConcLevels) == 0 {
		opt.ConcLevels = []int{1, 4, 8, 16}
	}
	if opt.ConcItems <= 0 {
		opt.ConcItems = 1000
	}
	workDir := opt.WorkDir
	if workDir == "" {
		d, err := os.MkdirTemp("", "agix-kmbench-*")
		if err != nil {
			return nil, err
		}
		workDir = d
		defer os.RemoveAll(d)
	}

	rep := &Report{
		Tool:        "agix-kmbench",
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		GoVersion:   runtime.Version(),
		OS:          runtime.GOOS,
		Arch:        runtime.GOARCH,
		CPUs:        runtime.NumCPU(),
		CGoFree:     true,
		EvidenceClass: "[LOCAL] — recall/precision deterministic (seeded, model-free); " +
			"latency + footprint machine-dependent",
		PrimarySeed: opt.PrimarySeed,
		RecallSeeds: opt.RecallSeeds,
		K:           opt.K,
		Notes: []string{
			"CGo-free: modernc.org/sqlite (pure Go) + Go-side cosine; sqlite-vec deliberately avoided (WASM version-brittle).",
			"SQLite semantic top-k is an O(N) scan (no native vector index) — the reported latency trade-off vs the in-memory flat arm.",
			"Footprint: SQLite = on-disk bytes/leaf (authoritative); flat = in-heap bytes/leaf (structural estimate).",
			"Concurrency levels set writers = readers = level; lost_writes counts rows expected but missing after concurrent append.",
		},
	}

	for _, n := range opt.Scales {
		sr, err := runScale(n, opt, workDir)
		if err != nil {
			return nil, fmt.Errorf("scale %d: %w", n, err)
		}
		rep.Scales = append(rep.Scales, sr)
	}
	rep.Premise = runPremise(opt.RecallSeeds, opt.K)
	return rep, nil
}

// runScale benchmarks every backend at one corpus size.
func runScale(n int, opt Options, workDir string) (ScaleResult, error) {
	cfg := DefaultConfig(n, opt.K)
	corpus := GenerateCorpus(opt.PrimarySeed, cfg)
	queries := GenerateQueries(corpus, opt.PrimarySeed)

	var semN, relN int
	for i := range queries {
		if queries[i].Kind == "semantic" {
			semN++
		} else {
			relN++
		}
	}

	sr := ScaleResult{N: n, QueryCounts: QueryCounts{Semantic: semN, Relational: relN}}

	// Arm B — flat in-memory vector baseline.
	flatRes, err := benchStore(func() (Store, error) { return NewFlatStore(), nil },
		corpus, queries, opt, "flat")
	if err != nil {
		return sr, err
	}
	sr.Stores = append(sr.Stores, flatRes)

	// Arm A — modernc SQLite graph store.
	dbPath := filepath.Join(workDir, fmt.Sprintf("km-%d.db", n))
	_ = os.Remove(dbPath)
	sqliteRes, err := benchStore(func() (Store, error) { return NewSQLiteStore(dbPath) },
		corpus, queries, opt, "sqlite")
	if err != nil {
		return sr, err
	}
	sr.Stores = append(sr.Stores, sqliteRes)

	return sr, nil
}

// benchStore runs the full metric suite against one freshly-built store.
func benchStore(open func() (Store, error), corpus *Corpus, queries []Query, opt Options, tag string) (StoreResult, error) {
	st, err := open()
	if err != nil {
		return StoreResult{}, err
	}
	defer st.Close()

	res := StoreResult{Store: st.Name(), N: len(corpus.Leaves)}

	// ── ingest throughput + process-heap delta ──
	heapBefore := HeapAllocNow()
	t0 := time.Now()
	if err := st.Ingest(corpus.Leaves); err != nil {
		return res, fmt.Errorf("ingest: %w", err)
	}
	res.IngestSeconds = time.Since(t0).Seconds()
	if res.IngestSeconds > 0 {
		res.IngestItemsPerSec = float64(len(corpus.Leaves)) / res.IngestSeconds
	}
	heapAfter := HeapAllocNow()
	if heapAfter > heapBefore {
		res.ProcHeapBytes = int64(heapAfter - heapBefore)
	}

	// ── footprint ──
	fp, err := st.Footprint()
	if err != nil {
		return res, fmt.Errorf("footprint: %w", err)
	}
	res.Footprint = fp

	// ── semantic retrieval: latency + recall/precision ──
	res.Semantic, err = benchSemantic(st, queries, opt.K)
	if err != nil {
		return res, err
	}

	// ── relational retrieval: latency + recall ──
	res.Relational, err = benchRelational(st, corpus, queries, opt)
	if err != nil {
		return res, err
	}

	// ── concurrency ──
	res.Concurrency, err = benchConcurrency(st, corpus.Cfg, opt)
	if err != nil {
		return res, err
	}
	return res, nil
}

// benchSemantic times VectorTopK and scores recall/precision over the semantic
// qrels.
func benchSemantic(st Store, queries []Query, k int) (RetrievalResult, error) {
	var lat []float64
	var recallSum, precSum float64
	var n int
	for i := range queries {
		q := &queries[i]
		if q.Kind != "semantic" {
			continue
		}
		t0 := time.Now()
		got, err := st.VectorTopK(q.QueryVec, k)
		lat = append(lat, float64(time.Since(t0).Microseconds()))
		if err != nil {
			return RetrievalResult{}, err
		}
		r, p := recallPrecision(got, q.Relevant)
		recallSum += r
		precSum += p
		n++
	}
	sort.Float64s(lat)
	out := RetrievalResult{K: k, Queries: n, LatP50Us: pct(lat, 50), LatP95Us: pct(lat, 95), LatP99Us: pct(lat, 99)}
	if n > 0 {
		out.RecallAtK = recallSum / float64(n)
		out.PrecisionAtK = precSum / float64(n)
	}
	return out, nil
}

// benchRelational scores multi-hop recall and times the relational answer path:
// end-to-end (seed lookup + traversal, or vector fallback for the flat arm) and
// the isolated traversal for graph stores. Recall is also averaged over
// RecallSeeds for the n=seeds headline.
func benchRelational(st Store, corpus *Corpus, queries []Query, opt Options) (RelationalResult, error) {
	out := RelationalResult{Seeds: 1}
	var e2e, trav []float64
	var recallSum float64
	var n int
	hasGraph := true

	for i := range queries {
		q := &queries[i]
		if q.Kind != "relational" {
			continue
		}
		t0 := time.Now()
		seed, err := st.VectorTopK(q.QueryVec, 1)
		if err != nil {
			return out, err
		}
		var got []string
		seedID := q.SeedID
		if len(seed) > 0 {
			seedID = seed[0]
		}
		tt := time.Now()
		got, err = st.Traverse(seedID, q.EdgeType, q.Hops)
		travUs := float64(time.Since(tt).Microseconds())
		if err == ErrNoGraph {
			hasGraph = false
			// Flat control: structurally cannot follow edges → pure vector top-k.
			got, err = st.VectorTopK(q.QueryVec, opt.K)
			if err != nil {
				return out, err
			}
		} else if err != nil {
			return out, err
		} else {
			trav = append(trav, travUs)
			if len(got) > opt.K {
				got = got[:opt.K]
			}
		}
		e2e = append(e2e, float64(time.Since(t0).Microseconds()))
		r, _ := recallPrecision(got, q.Relevant)
		recallSum += r
		n++
	}

	sort.Float64s(e2e)
	sort.Float64s(trav)
	out.Queries = n
	out.HasGraph = hasGraph
	out.EndToEndP50Us = pct(e2e, 50)
	out.EndToEndP95Us = pct(e2e, 95)
	out.EndToEndP99Us = pct(e2e, 99)
	out.TraversalP50Us = pct(trav, 50)
	out.TraversalP99Us = pct(trav, 99)
	if n > 0 {
		out.RecallAtK = recallSum / float64(n)
	}

	// n=seeds recall headline for this store (deterministic, quality-only).
	out.RecallAtKSeeded, out.Seeds = seededRelationalRecall(st, corpus, opt)
	return out, nil
}

// seededRelationalRecall multi-samples relational recall on the fixed, already
// ingested corpus by reseeding ONLY the query set. The corpus edges stay fixed
// (from PrimarySeed), so each reseeded qrels set has valid ground truth for this
// store — a genuine n=seeds sample of the store's relational recall. Returns the
// averaged recall and the number of seeds that contributed.
func seededRelationalRecall(st Store, corpus *Corpus, opt Options) (float64, int) {
	seeds := opt.RecallSeeds
	if len(seeds) == 0 {
		seeds = []uint32{opt.PrimarySeed}
	}
	var sum float64
	var cnt int
	for _, s := range seeds {
		qs := GenerateQueries(corpus, s)
		var rsum float64
		var n int
		for i := range qs {
			q := &qs[i]
			if q.Kind != "relational" {
				continue
			}
			seed, err := st.VectorTopK(q.QueryVec, 1)
			if err != nil {
				return 0, 0
			}
			seedID := q.SeedID
			if len(seed) > 0 {
				seedID = seed[0]
			}
			got, err := st.Traverse(seedID, q.EdgeType, q.Hops)
			if err == ErrNoGraph {
				got, _ = st.VectorTopK(q.QueryVec, opt.K)
			} else if err != nil {
				return 0, 0
			} else if len(got) > opt.K {
				got = got[:opt.K]
			}
			r, _ := recallPrecision(got, q.Relevant)
			rsum += r
			n++
		}
		if n > 0 {
			sum += rsum / float64(n)
			cnt++
		}
	}
	if cnt == 0 {
		return 0, 0
	}
	return sum / float64(cnt), cnt
}

// benchConcurrency runs writer×reader contention levels against the (already
// ingested) store: writers append fresh leaves while readers hammer VectorTopK.
// It reports write throughput, read p99 under contention, and lost-writes.
func benchConcurrency(st Store, cfg Config, opt Options) ([]ConcurrencyResult, error) {
	var results []ConcurrencyResult
	// A stable query vector for readers (concept 0 direction).
	probe := make([]float32, cfg.Dim)
	probe[0] = 1

	for _, level := range opt.ConcLevels {
		before, err := storeCount(st)
		if err != nil {
			return nil, err
		}
		// Build writer leaves for this level (disjoint id namespace).
		writerLeaves := makeWriterLeaves(cfg, opt.ConcItems, uint32(level)*7919+opt.PrimarySeed)
		batches := splitLeaves(writerLeaves, level)

		var readCount int64
		latCh := make(chan []float64, level)
		stop := make(chan struct{})

		// Readers.
		var rwg sync.WaitGroup
		for r := 0; r < level; r++ {
			rwg.Add(1)
			go func() {
				defer rwg.Done()
				var lats []float64
				for {
					select {
					case <-stop:
						latCh <- lats
						return
					default:
					}
					t0 := time.Now()
					if _, err := st.VectorTopK(probe, opt.K); err == nil {
						lats = append(lats, float64(time.Since(t0).Microseconds()))
						atomic.AddInt64(&readCount, 1)
					}
				}
			}()
		}

		// Writers.
		var wwg sync.WaitGroup
		tW := time.Now()
		for w := 0; w < level; w++ {
			wwg.Add(1)
			go func(batch []Leaf) {
				defer wwg.Done()
				_ = st.Ingest(batch)
			}(batches[w])
		}
		wwg.Wait()
		writeElapsed := time.Since(tW).Seconds()
		close(stop)
		rwg.Wait()
		close(latCh)

		var allLat []float64
		for l := range latCh {
			allLat = append(allLat, l...)
		}
		sort.Float64s(allLat)

		after, err := storeCount(st)
		if err != nil {
			return nil, err
		}
		expected := before + len(writerLeaves)
		lost := expected - after
		if lost < 0 {
			lost = 0
		}
		var wtp float64
		if writeElapsed > 0 {
			wtp = float64(len(writerLeaves)) / writeElapsed
		}
		results = append(results, ConcurrencyResult{
			Writers:             level,
			Readers:             level,
			ItemsWritten:        len(writerLeaves),
			WriteItemsPerSec:    wtp,
			Reads:               int(readCount),
			ReadP99Us:           pct(allLat, 99),
			LostWrites:          lost,
			ZeroWriteContention: lost == 0,
		})
	}
	return results, nil
}

// ─────────────────────────── in-memory premise ──────────────────────────────

// runPremise is the n=seeds quality headline computed purely in memory (no
// store): does graph-traversal retrieval decisively beat flat vector on the
// relational class, while flat stays competent on the semantic class?
func runPremise(seeds []uint32, k int) Premise {
	if len(seeds) == 0 {
		seeds = []uint32{1, 2, 3}
	}
	cfg := DefaultConfig(2000, k) // fixed modest scale for the quality curve
	var relGraph, relFlat, semFlatPrec []float64
	for _, s := range seeds {
		corpus := GenerateCorpus(s, cfg)
		qs := GenerateQueries(corpus, s)
		var rg, rf, sp float64
		var rn, sn int
		for i := range qs {
			q := &qs[i]
			switch q.Kind {
			case "relational":
				g := memGraphRetrieve(corpus, q, k)
				f := memFlatRetrieve(corpus, q, k)
				rgr, _ := recallPrecision(g, q.Relevant)
				rfr, _ := recallPrecision(f, q.Relevant)
				rg += rgr
				rf += rfr
				rn++
			case "semantic":
				f := memFlatRetrieve(corpus, q, k)
				_, p := recallPrecision(f, q.Relevant)
				sp += p
				sn++
			}
		}
		if rn > 0 {
			relGraph = append(relGraph, rg/float64(rn))
			relFlat = append(relFlat, rf/float64(rn))
		}
		if sn > 0 {
			semFlatPrec = append(semFlatPrec, sp/float64(sn))
		}
	}
	relGraphAvg := avg(relGraph)
	relFlatAvg := avg(relFlat)
	semFlatPrecAvg := avg(semFlatPrec)
	worst := math.Inf(1)
	for i := range relGraph {
		if d := relGraph[i] - relFlat[i]; d < worst {
			worst = d
		}
	}
	if math.IsInf(worst, 1) {
		worst = 0
	}
	graphWins := relGraphAvg >= relFlatAvg+0.25
	flatCompetent := semFlatPrecAvg >= 0.6
	verdict := "PREMISE NOT SHOWN — graph-at-core unproven on this workload"
	if graphWins && flatCompetent {
		verdict = "PREMISE HOLDS — graph-at-core justified for relational KM"
	}
	return Premise{
		Seeds:             seeds,
		RelGraphRecallAvg: round4(relGraphAvg),
		RelFlatRecallAvg:  round4(relFlatAvg),
		RelationalLift:    round4(relGraphAvg - relFlatAvg),
		WorstRelLift:      round4(worst),
		SemFlatPrecAvg:    round4(semFlatPrecAvg),
		GraphWinsRel:      graphWins,
		FlatCompetentSem:  flatCompetent,
		Verdict:           verdict,
	}
}

// memFlatRetrieve: pure in-memory brute-force vector top-k.
func memFlatRetrieve(c *Corpus, q *Query, k int) []string {
	sc := make([]scored, len(c.Leaves))
	for i := range c.Leaves {
		sc[i] = scored{id: c.Leaves[i].ID, score: cosine(c.Leaves[i].Embedding, q.QueryVec)}
	}
	return topK(sc, k)
}

// memGraphRetrieve: relational → find seed by top-1 cosine, then traverse the
// query's relation; semantic → vector top-k + 1-hop expansion.
func memGraphRetrieve(c *Corpus, q *Query, k int) []string {
	if q.Kind == "relational" {
		sc := make([]scored, len(c.Leaves))
		for i := range c.Leaves {
			sc[i] = scored{id: c.Leaves[i].ID, score: cosine(c.Leaves[i].Embedding, q.QueryVec)}
		}
		seed := topK(sc, 1)
		if len(seed) == 0 {
			return nil
		}
		reached := bfsGroundTruth(c, seed[0], q.EdgeType, q.Hops)
		delete(reached, seed[0])
		out := make([]string, 0, len(reached))
		for id := range reached {
			out = append(out, id)
		}
		sort.Strings(out)
		if len(out) > k {
			out = out[:k]
		}
		return out
	}
	base := memFlatRetrieve(c, q, k)
	seen := make(map[string]struct{}, len(base))
	out := append([]string(nil), base...)
	for _, id := range base {
		seen[id] = struct{}{}
	}
	for _, id := range base {
		if l := c.ByID[id]; l != nil {
			for _, e := range l.Edges {
				if _, ok := seen[e.Dst]; !ok {
					seen[e.Dst] = struct{}{}
					out = append(out, e.Dst)
				}
			}
		}
	}
	if len(out) > k {
		out = out[:k]
	}
	return out
}

// ─────────────────────────────── helpers ────────────────────────────────────

func recallPrecision(retrieved []string, relevant map[string]struct{}) (recall, precision float64) {
	if len(relevant) == 0 {
		if len(retrieved) == 0 {
			return 1, 1
		}
		return 1, 0
	}
	var hit int
	for _, id := range retrieved {
		if _, ok := relevant[id]; ok {
			hit++
		}
	}
	recall = float64(hit) / float64(len(relevant))
	if len(retrieved) > 0 {
		precision = float64(hit) / float64(len(retrieved))
	}
	return recall, precision
}

// pct returns the nearest-rank percentile of a pre-sorted slice (microseconds).
func pct(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

func avg(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func round4(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	return math.Round(x*1e4) / 1e4
}

// storeCount reads a store's leaf count via the optional Count method.
func storeCount(st Store) (int, error) {
	switch s := st.(type) {
	case *FlatStore:
		return s.Count(), nil
	case *SQLiteStore:
		return s.Count()
	}
	return 0, nil
}

// makeWriterLeaves builds `count` fresh leaves in a disjoint id namespace for
// the concurrency test (embeddings + edges included for realistic write cost).
func makeWriterLeaves(cfg Config, count int, seed uint32) []Leaf {
	p := newPRNG(seed ^ 0x9e3779b1)
	// A small concept basis so writers carry real embeddings.
	basis := make([][]float32, cfg.Concepts)
	for c := 0; c < cfg.Concepts; c++ {
		basis[c] = unitVec(p, cfg.Dim)
	}
	leaves := make([]Leaf, count)
	prefix := "w" + itoa(int(seed)) + "-"
	for i := 0; i < count; i++ {
		nC := p.intRange(cfg.ConceptsPerLeaf[0], cfg.ConceptsPerLeaf[1])
		emb := make([]float64, cfg.Dim)
		for j := 0; j < nC; j++ {
			c := p.intRange(0, cfg.Concepts-1)
			for d := 0; d < cfg.Dim; d++ {
				emb[d] += float64(basis[c][d])
			}
		}
		for d := 0; d < cfg.Dim; d++ {
			emb[d] += p.gaussian(0, cfg.Noise)
		}
		leaves[i] = Leaf{
			ID:        prefix + itoa(i),
			Branch:    cfg.Branches[i%len(cfg.Branches)],
			Embedding: normalize32(emb),
			Edges:     []Edge{{Type: cfg.EdgeTypes[0], Dst: prefix + itoa((i+1)%count)}},
		}
	}
	return leaves
}

// splitLeaves partitions leaves into n roughly-equal batches.
func splitLeaves(leaves []Leaf, n int) [][]Leaf {
	if n < 1 {
		n = 1
	}
	batches := make([][]Leaf, n)
	per := (len(leaves) + n - 1) / n
	for i := 0; i < n; i++ {
		lo := i * per
		if lo > len(leaves) {
			lo = len(leaves)
		}
		hi := lo + per
		if hi > len(leaves) {
			hi = len(leaves)
		}
		batches[i] = leaves[lo:hi]
	}
	return batches
}

// ─────────────────────────── output rendering ───────────────────────────────

// WriteJSON emits the report as indented JSON.
func (r *Report) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// WriteSummary prints a readable table of the headline metrics.
func (r *Report) WriteSummary(w io.Writer) {
	fmt.Fprintf(w, "\nAgix KM store efficiency benchmark  [LOCAL — %s/%s, %d CPU, %s]\n",
		r.OS, r.Arch, r.CPUs, r.GoVersion)
	fmt.Fprintf(w, "CGo-free: %v   k=%d   primary seed=%d   recall seeds=%d\n",
		r.CGoFree, r.K, r.PrimarySeed, len(r.RecallSeeds))

	fmt.Fprintf(w, "\nPREMISE (n=%d seeds, in-memory quality):  %s\n", len(r.Premise.Seeds), r.Premise.Verdict)
	fmt.Fprintf(w, "  relational recall@k  graph=%.3f  flat=%.3f  lift=%+.3f (worst %+.3f)   semantic flat precision=%.3f\n",
		r.Premise.RelGraphRecallAvg, r.Premise.RelFlatRecallAvg, r.Premise.RelationalLift,
		r.Premise.WorstRelLift, r.Premise.SemFlatPrecAvg)

	for _, sc := range r.Scales {
		fmt.Fprintf(w, "\n── N=%d  (semantic q=%d, relational q=%d) ──────────────────────\n",
			sc.N, sc.QueryCounts.Semantic, sc.QueryCounts.Relational)
		fmt.Fprintf(w, "  %-14s %12s %11s %11s %11s %9s %9s %11s %9s\n",
			"store", "ingest/s", "foot B/leaf", "sem p50 us", "sem p99 us", "sem rec", "sem prec", "rel rec@k", "trav p50")
		for _, s := range sc.Stores {
			fmt.Fprintf(w, "  %-14s %12s %11s %11.1f %11.1f %9.3f %9.3f %11.3f %9.1f\n",
				s.Store,
				commas(int64(s.IngestItemsPerSec)),
				fmt.Sprintf("%.0f(%s)", s.Footprint.BytesPerLeaf, s.Footprint.Kind),
				s.Semantic.LatP50Us, s.Semantic.LatP99Us,
				s.Semantic.RecallAtK, s.Semantic.PrecisionAtK,
				s.Relational.RecallAtK, s.Relational.TraversalP50Us,
			)
		}
		// Concurrency table.
		fmt.Fprintf(w, "  concurrency (writers=readers):\n")
		fmt.Fprintf(w, "    %-14s %6s %14s %11s %11s\n", "store", "level", "write items/s", "read p99us", "lost")
		for _, s := range sc.Stores {
			for _, c := range s.Concurrency {
				fmt.Fprintf(w, "    %-14s %6d %14s %11.1f %11d\n",
					s.Store, c.Writers, commas(int64(c.WriteItemsPerSec)), c.ReadP99Us, c.LostWrites)
			}
		}
	}
	fmt.Fprintln(w)
}

// commas formats an integer with thousands separators.
func commas(n int64) string {
	s := itoa(int(n))
	neg := false
	if len(s) > 0 && s[0] == '-' {
		neg = true
		s = s[1:]
	}
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, c)
	}
	if neg {
		return "-" + string(out)
	}
	return string(out)
}
