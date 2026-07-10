// realistic — the HONEST front-door retrieval test the overnight field report
// (2026-07-08 §3a) demanded. The shipped kmbench (bench.go) is rigged in the
// graph's favor: it feeds each seed's OWN embedding back as the query, so entity
// resolution is perfect by construction and the graph is always entered. That
// measures deductive closure over a graph, NOT whether the hive can find the
// right entity from a real, fuzzy, natural-language question.
//
// This harness measures the REAL front door. It builds a natural-language KM
// corpus with heavy shared boilerplate (so unrelated facts look similar to a
// bag-of-tokens embedder) and distinct semantic content, then asks a FUZZY
// PARAPHRASE of each fact — synonyms swapped in, the entity's name dropped — and
// checks whether the embedder resolves the correct entity as top-1 BEFORE any
// graph traversal happens. It scores, per embedder:
//
//   - self top-1     : query = the fact's own text (the rigged ceiling — should
//     be ~1.0 for any embedder; reproduces kmbench's premise)
//   - entity top-1   : fuzzy paraphrase resolves to the correct entity (THE GATE)
//   - recall@k       : correct entity within top-k
//   - graph entered  : fraction of relational seeds that resolve correctly, so a
//     2-hop traversal even starts from the right node
//   - 2-hop recall   : relational answer recall, GATED by resolution (a wrong
//     seed traverses the wrong subgraph)
//   - distinct vecs  : how many of N facts get distinct vectors (dim-64 hashing
//     collapses many to identical — the report's "320→109")
//   - unrelated cos  : mean cosine between unrelated facts (the "0.75 boilerplate"
//     false-similarity the report called out)
//
// plus a compounding curve (top-1 + 2-hop recall vs corpus size) to see whether
// resolution holds or DILUTES as the store grows. Everything is deterministic
// given a seed; only the embedder differs between arms, so the delta is clean.
//
// EVIDENCE CLASS [LOCAL]. The corpus/queries are model-free; the retrieval
// quality depends entirely on the injected Embedder.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"runtime"
	"sort"
	"time"
)

// RealisticOptions configures a realistic-retrieval run.
type RealisticOptions struct {
	N     int    // corpus size (facts); capped at the 320-combo vocabulary
	Seed  uint32 // determinism seed
	K     int    // recall@k cutoff
	Curve []int  // corpus sizes for the compounding curve
	Hops  int    // relational hops (default 2)
}

// DefaultRealisticOptions returns the standard sweep: N=320 (the report's size),
// k=10, a 40→320 compounding curve, 2-hop relational.
func DefaultRealisticOptions() RealisticOptions {
	return RealisticOptions{N: 320, Seed: 1, K: 10, Curve: []int{40, 80, 160, 320}, Hops: 2}
}

// RealisticArm is one embedder's scorecard.
type RealisticArm struct {
	Embedder         string                `json:"embedder"`
	Dim              int                   `json:"dim"`
	Facts            int                   `json:"facts"`
	Queries          int                   `json:"queries"`
	SelfTop1         float64               `json:"self_top1"`
	EntityTop1       float64               `json:"entity_top1"`
	RecallAtK        float64               `json:"recall_at_k"`
	K                int                   `json:"k"`
	GraphEntered     float64               `json:"graph_entered_frac"`
	TwoHopRecall     float64               `json:"two_hop_recall"`
	DistinctVectors  int                   `json:"distinct_vectors"`
	MeanUnrelatedCos float64               `json:"mean_unrelated_cosine"`
	EmbedSeconds     float64               `json:"embed_seconds"`
	Curve            []RealisticCurvePoint `json:"curve"`
}

// RealisticCurvePoint is one corpus size on the compounding curve.
type RealisticCurvePoint struct {
	N            int     `json:"n"`
	EntityTop1   float64 `json:"entity_top1"`
	TwoHopRecall float64 `json:"two_hop_recall"`
}

// RealisticReport is the whole realistic comparison (one arm per embedder).
type RealisticReport struct {
	Tool        string         `json:"tool"`
	GeneratedAt string         `json:"generated_at"`
	GoVersion   string         `json:"go_version"`
	Seed        uint32         `json:"seed"`
	N           int            `json:"n"`
	Arms        []RealisticArm `json:"arms"`
	Notes       []string       `json:"notes"`
}

// ─────────────────────────────── corpus ─────────────────────────────────────

// realVerb is a capability verb with a genuine synonymous paraphrase.
type realVerb struct{ base, syn string }

// realObject is a capability object with a genuine synonymous paraphrase.
type realObject struct{ base, syn string }

var realVerbs = []realVerb{
	{"authenticates", "verifies the identity behind"},
	{"authorizes", "grants access permission for"},
	{"validates", "checks the correctness of"},
	{"indexes", "builds a searchable catalog of"},
	{"caches", "keeps fast local copies of"},
	{"encrypts", "scrambles for privacy"},
	{"compresses", "shrinks the storage size of"},
	{"replicates", "copies across regions"},
	{"aggregates", "rolls up and summarizes"},
	{"schedules", "plans the timing of"},
	{"routes", "directs the flow of"},
	{"throttles", "rate-limits the volume of"},
	{"reconciles", "matches up and settles"},
	{"archives", "moves to cold storage"},
	{"deduplicates", "removes the duplicate"},
	{"enriches", "adds extra detail to"},
}

var realObjects = []realObject{
	{"user sessions", "active sign-in states"},
	{"payment transactions", "money-movement records"},
	{"audit logs", "change-history trails"},
	{"catalog listings", "storefront product entries"},
	{"shipping manifests", "delivery paperwork"},
	{"inventory counts", "warehouse stock levels"},
	{"email notifications", "outbound message alerts"},
	{"incoming requests", "inbound service calls"},
	{"customer profiles", "account-holder details"},
	{"subscription plans", "recurring membership tiers"},
	{"fraud signals", "suspicious-activity flags"},
	{"telemetry metrics", "performance measurements"},
	{"configuration bundles", "settings packages"},
	{"media uploads", "user-submitted files"},
	{"search queries", "lookup phrases"},
	{"access tokens", "credential keys"},
	{"billing invoices", "charge statements"},
	{"support tickets", "customer help requests"},
	{"feature flags", "rollout toggles"},
	{"data exports", "bulk downloads"},
}

var realTeams = []string{"platform", "payments", "growth", "infrastructure", "security", "data", "mobile", "retention"}

var realCodenames = []string{
	"aurora", "borealis", "cascade", "drift", "ember", "frost", "glacier", "harbor",
	"ionize", "jasper", "kestrel", "lumen", "marlin", "nimbus", "onyx", "pyxis",
	"quartz", "raven", "summit", "tundra", "umbra", "vesper", "willow", "xenon",
	"yarrow", "zephyr",
}

// realFact is one natural-language knowledge leaf plus its fuzzy query.
type realFact struct {
	ID    string
	Text  string // the stored fact (heavy boilerplate + distinct content)
	Query string // a fuzzy paraphrase that must resolve to this fact
}

// maxCombos is the distinct (verb,object) capability space.
func maxCombos() int { return len(realVerbs) * len(realObjects) }

// buildRealFacts generates up to maxN facts. Each fact draws a DISTINCT
// (verb,object) capability (so facts are semantically distinct) while sharing
// heavy boilerplate; the query paraphrases the capability (verb always synonym-
// swapped, object swapped ~70% of the time — a realistic partial-overlap query)
// and never names the entity. Fact texts are independent of the final N (a prefix
// of the shuffled combo order), so a single embed pass serves every curve size.
func buildRealFacts(seed uint32, maxN int) []realFact {
	nc := maxCombos()
	if maxN > nc {
		maxN = nc
	}
	// Deterministic shuffle of the full combo space, then take a prefix.
	order := make([]int, nc)
	for i := range order {
		order[i] = i
	}
	p := newPRNG(seed ^ 0x2f6a88b3)
	for i := nc - 1; i > 0; i-- {
		j := p.intRange(0, i)
		order[i], order[j] = order[j], order[i]
	}
	facts := make([]realFact, maxN)
	for i := 0; i < maxN; i++ {
		c := order[i]
		v := realVerbs[c/len(realObjects)]
		o := realObjects[c%len(realObjects)]
		svc := realCodenames[i%len(realCodenames)]
		dep := realCodenames[(i*7+3)%len(realCodenames)]
		team := realTeams[i%len(realTeams)]
		// The stored fact: distinct capability wrapped in shared boilerplate.
		text := "The " + svc + " service " + v.base + " " + o.base +
			" for the " + team + " team; internally it depends on the " + dep +
			" service to keep the platform running."
		// The fuzzy query: paraphrased capability, entity name dropped.
		obj := o.syn
		if p.next() < 0.30 { // ~30% keep the object verbatim (realistic partial overlap)
			obj = o.base
		}
		query := "which internal service is responsible for how the platform " +
			v.syn + " " + obj + " across the product"
		facts[i] = realFact{ID: leafID(i), Text: text, Query: query}
	}
	return facts
}

// dependsOn returns fact i's out-edges within an active corpus of size n (two
// deterministic targets, self-avoiding). The graph is defined over the active
// size so the compounding curve stays well-formed at every n.
func dependsOn(i, n int) []int {
	if n <= 1 {
		return nil
	}
	a := (i*7 + 3) % n
	b := (i*13 + 5) % n
	out := make([]int, 0, 2)
	for _, t := range []int{a, b} {
		if t != i {
			out = append(out, t)
		}
	}
	return out
}

// bfsHops returns the ids reached from seed by following dependsOn for `hops`
// steps within a size-n corpus (seed excluded) — the relational ground truth.
func bfsHops(seed, hops, n int) map[string]struct{} {
	frontier := []int{seed}
	reached := make(map[string]struct{})
	for h := 0; h < hops; h++ {
		var next []int
		for _, id := range frontier {
			for _, dst := range dependsOn(id, n) {
				if _, ok := reached[leafID(dst)]; !ok {
					reached[leafID(dst)] = struct{}{}
					next = append(next, dst)
				}
			}
		}
		frontier = next
	}
	delete(reached, leafID(seed))
	return reached
}

// ─────────────────────────────── driver ─────────────────────────────────────

// RunRealistic scores one embedder on the realistic front-door workload.
func RunRealistic(emb Embedder, opt RealisticOptions) (RealisticArm, error) {
	if opt.N <= 0 {
		opt.N = 320
	}
	if opt.N > maxCombos() {
		opt.N = maxCombos()
	}
	if opt.K <= 0 {
		opt.K = 10
	}
	if opt.Hops <= 0 {
		opt.Hops = 2
	}
	facts := buildRealFacts(opt.Seed, opt.N)

	// Embed every fact + query ONCE (the full corpus); curve sizes reuse prefixes.
	t0 := time.Now()
	factVecs, err := embedAll(emb, textsOf(facts, false))
	if err != nil {
		return RealisticArm{}, fmt.Errorf("embed facts: %w", err)
	}
	queryVecs, err := embedAll(emb, textsOf(facts, true))
	if err != nil {
		return RealisticArm{}, fmt.Errorf("embed queries: %w", err)
	}
	embedSecs := time.Since(t0).Seconds()

	arm := RealisticArm{
		Embedder: emb.Name(), Dim: emb.Dim(),
		Facts: opt.N, Queries: opt.N, K: opt.K, EmbedSeconds: round4(embedSecs),
	}

	// self top-1 (rigged ceiling): the fact's own text as the query.
	arm.SelfTop1 = round4(top1Rate(factVecs, factVecs, opt.N))
	// entity top-1 + recall@k (the real front door): fuzzy paraphrase.
	arm.EntityTop1 = round4(top1Rate(queryVecs, factVecs, opt.N))
	arm.RecallAtK = round4(recallAtKRate(queryVecs, factVecs, opt.N, opt.K))
	// collapse + boilerplate diagnostics.
	arm.DistinctVectors = distinctVectorCount(factVecs)
	arm.MeanUnrelatedCos = round4(meanUnrelatedCosine(factVecs, opt.Seed))
	// relational: graph-entered + 2-hop recall gated by resolution.
	arm.GraphEntered, arm.TwoHopRecall = relationalGated(queryVecs, factVecs, opt.N, opt.Hops, opt.K)

	// compounding curve.
	for _, s := range opt.Curve {
		if s <= 0 || s > opt.N {
			continue
		}
		e := round4(top1Rate(queryVecs[:s], factVecs[:s], s))
		_, r := relationalGated(queryVecs[:s], factVecs[:s], s, opt.Hops, opt.K)
		arm.Curve = append(arm.Curve, RealisticCurvePoint{N: s, EntityTop1: e, TwoHopRecall: r})
	}
	return arm, nil
}

// RunRealisticCompare runs the realistic workload for every embedder and returns
// a combined report (the before/after table). Embedders that fail to embed (e.g.
// a nomic daemon that dies mid-run) are recorded as a note, not fatal.
func RunRealisticCompare(opt RealisticOptions, embs ...Embedder) *RealisticReport {
	rep := &RealisticReport{
		Tool:        "agix-kmbench-realistic",
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		GoVersion:   runtime.Version(),
		Seed:        opt.Seed,
		N:           opt.N,
		Notes: []string{
			"Front-door test: a FUZZY natural-language paraphrase must resolve the correct entity BEFORE the graph is entered — unlike kmbench, which feeds the seed's own embedding (rigged).",
			"self_top1 is the rigged ceiling (query = fact's own text); entity_top1 is the honest gate.",
			"distinct_vectors < facts ⇒ the embedder collapses distinct facts to identical vectors (dim-64 hashing collision).",
			"two_hop_recall is gated by resolution: a wrong seed traverses the wrong subgraph.",
		},
	}
	for _, e := range embs {
		arm, err := RunRealistic(e, opt)
		if err != nil {
			rep.Notes = append(rep.Notes, fmt.Sprintf("embedder %s FAILED: %v", e.Name(), err))
			continue
		}
		rep.Arms = append(rep.Arms, arm)
	}
	return rep
}

// ─────────────────────────────── scoring ────────────────────────────────────

// textsOf returns fact texts (query=false) or query texts (query=true).
func textsOf(facts []realFact, query bool) []string {
	out := make([]string, len(facts))
	for i, f := range facts {
		if query {
			out[i] = f.Query
		} else {
			out[i] = f.Text
		}
	}
	return out
}

// embedAll embeds every text, retrying once on a transient backend error so a
// single dropped HTTP call doesn't sink a whole run.
func embedAll(emb Embedder, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v, err := emb.Embed(t)
		if err != nil {
			v, err = emb.Embed(t) // one retry
			if err != nil {
				return nil, fmt.Errorf("text %d: %w", i, err)
			}
		}
		out[i] = v
	}
	return out, nil
}

// top1Rate: fraction of queries whose top-1 nearest fact (by cosine) is the fact
// at the same index (ground truth). Candidate set = first n facts.
func top1Rate(queries, facts [][]float32, n int) float64 {
	if n == 0 {
		return 0
	}
	var hit int
	for i := 0; i < n; i++ {
		if argmaxCosine(queries[i], facts, n) == i {
			hit++
		}
	}
	return float64(hit) / float64(n)
}

// recallAtKRate: fraction of queries with the correct fact in the top-k.
func recallAtKRate(queries, facts [][]float32, n, k int) float64 {
	if n == 0 {
		return 0
	}
	var hit int
	for i := 0; i < n; i++ {
		if inTopK(queries[i], facts, n, k, i) {
			hit++
		}
	}
	return float64(hit) / float64(n)
}

// relationalGated: for each seed with a non-empty 2-hop closure, resolve the seed
// via its query's top-1, then traverse the (deterministic) graph from the
// RESOLVED seed. Returns (graph-entered fraction, mean 2-hop recall). A wrong
// resolution traverses the wrong subgraph — honestly counted.
func relationalGated(queries, facts [][]float32, n, hops, k int) (float64, float64) {
	var entered, scored int
	var recallSum float64
	for i := 0; i < n; i++ {
		truth := bfsHops(i, hops, n)
		if len(truth) == 0 {
			continue
		}
		scored++
		resolved := argmaxCosine(queries[i], facts, n)
		if resolved == i {
			entered++
		}
		// Traverse from whatever the embedder resolved (right or wrong).
		got := make([]string, 0, k)
		for id := range bfsHops(resolved, hops, n) {
			got = append(got, id)
		}
		sort.Strings(got)
		if len(got) > k {
			got = got[:k]
		}
		var h int
		for _, id := range got {
			if _, ok := truth[id]; ok {
				h++
			}
		}
		recallSum += float64(h) / float64(len(truth))
	}
	if scored == 0 {
		return 0, 0
	}
	return round4(float64(entered) / float64(scored)), round4(recallSum / float64(scored))
}

// argmaxCosine returns the index of the highest-cosine fact among the first n
// (deterministic: ties broken by lower index).
func argmaxCosine(q []float32, facts [][]float32, n int) int {
	best := -1
	bestScore := math.Inf(-1)
	for i := 0; i < n; i++ {
		if len(facts[i]) != len(q) {
			continue
		}
		s := cosine(facts[i], q)
		if s > bestScore {
			bestScore = s
			best = i
		}
	}
	return best
}

// inTopK reports whether target is among the k highest-cosine facts (of n).
func inTopK(q []float32, facts [][]float32, n, k, target int) bool {
	sc := make([]scored, 0, n)
	for i := 0; i < n; i++ {
		if len(facts[i]) != len(q) {
			continue
		}
		sc = append(sc, scored{id: leafID(i), score: cosine(facts[i], q)})
	}
	ids := topK(sc, k)
	want := leafID(target)
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// distinctVectorCount counts how many vectors are distinct after rounding — the
// "320 facts collapse to 109 vectors" collision signal for low-dim hashing.
func distinctVectorCount(vecs [][]float32) int {
	seen := make(map[string]struct{}, len(vecs))
	for _, v := range vecs {
		seen[vecKey(v)] = struct{}{}
	}
	return len(seen)
}

// vecKey quantizes a vector to a stable string key (1e-4 buckets).
func vecKey(v []float32) string {
	b := make([]byte, 0, len(v)*3)
	for _, x := range v {
		q := int32(math.Round(float64(x) * 1e4))
		b = append(b, byte(q), byte(q>>8), byte(q>>16))
	}
	return string(b)
}

// meanUnrelatedCosine averages cosine over a deterministic sample of distinct
// fact pairs — the boilerplate false-similarity signal.
func meanUnrelatedCosine(vecs [][]float32, seed uint32) float64 {
	n := len(vecs)
	if n < 2 {
		return 0
	}
	p := newPRNG(seed ^ 0x71c3a5df)
	const samples = 2000
	var sum float64
	var cnt int
	for s := 0; s < samples; s++ {
		i := p.intRange(0, n-1)
		j := p.intRange(0, n-1)
		if i == j || len(vecs[i]) != len(vecs[j]) {
			continue
		}
		sum += cosine(vecs[i], vecs[j])
		cnt++
	}
	if cnt == 0 {
		return 0
	}
	return sum / float64(cnt)
}

// ─────────────────────────── output rendering ───────────────────────────────

// WriteJSON emits the report as indented JSON.
func (r *RealisticReport) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// WriteSummary prints the before/after comparison table.
func (r *RealisticReport) WriteSummary(w io.Writer) {
	fmt.Fprintf(w, "\nAgix KM realistic front-door retrieval  [LOCAL — %s, seed=%d, N=%d]\n", r.GoVersion, r.Seed, r.N)
	fmt.Fprintf(w, "(fuzzy natural-language queries must resolve the entity BEFORE the graph is entered)\n\n")
	fmt.Fprintf(w, "  %-12s %5s %9s %11s %10s %10s %11s %10s %9s\n",
		"embedder", "dim", "selfTop1", "entityTop1", "recall@k", "graphEnt", "2hopRecall", "distinct", "unrelCos")
	for _, a := range r.Arms {
		fmt.Fprintf(w, "  %-12s %5d %9.3f %11.3f %10.3f %10.3f %11.3f %8d/%-3d %9.3f\n",
			a.Embedder, a.Dim, a.SelfTop1, a.EntityTop1, a.RecallAtK, a.GraphEntered,
			a.TwoHopRecall, a.DistinctVectors, a.Facts, a.MeanUnrelatedCos)
	}
	fmt.Fprintf(w, "\n  compounding curve (entityTop1 / 2hopRecall vs corpus size):\n")
	for _, a := range r.Arms {
		fmt.Fprintf(w, "    %-12s", a.Embedder)
		for _, c := range a.Curve {
			fmt.Fprintf(w, "  N=%d:%.2f/%.2f", c.N, c.EntityTop1, c.TwoHopRecall)
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintln(w)
}
