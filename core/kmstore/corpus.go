// corpus — the synthetic Agix KM workload: a real relational knowledge graph
// with model-free, deterministic embeddings, plus a qrels query set with
// ground-truth relevance. Ported in concept from lib/agix-km-bench/premise.mjs.
//
// EVIDENCE CLASS [LOCAL]. Retrieval QUALITY (recall/precision) is deterministic
// and machine-independent — the embeddings are concept vectors, not a paid
// model, so quality needs zero API cost. Semantic structure is REAL, not
// random: each leaf carries 1-3 concepts and its embedding is the normalized
// sum of those concept vectors plus small noise, so leaves that share concepts
// are genuinely similar (a flat vector retriever CAN find them). Relational
// answers are defined by typed EDGES, not similarity — an edge target need
// share no concepts with its source — so flat vector structurally cannot follow
// them, and a graph traverser can. Whether that gap is large is the REPORTED
// result, never a tuned-in conclusion.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

// Edge is a typed relational link out of a leaf.
type Edge struct {
	Type string
	Dst  string
}

// Leaf is one knowledge node: an id, a model-free embedding, a TOGAF branch,
// an attestation bit (the Comb "operator-ratified" flag), and typed edges.
//
// The first block of fields is the benchmark corpus shape. The second block is
// the production provenance carried on a KMStore.Put write (kmstore.go +
// provenance.go): the benchmark leaves them zero, and the production store
// leaves Idx/Concepts zero — one struct, two lifecycles, no name clash on the
// package's shared vector codec.
type Leaf struct {
	ID        string
	Idx       int
	Concepts  []int
	Branch    string
	Embedding []float32
	Attested  bool
	Edges     []Edge

	// Production provenance (KMStore). Content is the leaf's text payload;
	// Author wrote it; Verifier attested it (must differ from Author to attest);
	// TrustScore is the verifier's confidence in 0..1; Ratified is the Comb
	// operator-ratified (trunk-merge) bit; CreatedAt is unix seconds set on Put.
	Content    string
	Author     string
	Verifier   string
	TrustScore float64
	Ratified   bool
	CreatedAt  int64

	// PendingCosign marks an un-attested leaf that is AWAITING a human co-sign: a
	// governed run APPROVED it, but its verification was LLM-judgment-only (no
	// external oracle backed the verdict), so the attestation policy holds it out
	// of the certified corpus until a registered human vouches (KMStore.Cosign).
	// It is only ever set on an un-attested leaf — an attested leaf is never
	// pending — so the two states are mutually exclusive by construction.
	PendingCosign bool

	// Score is the cosine similarity to the query that RETRIEVED this leaf. It is
	// a read-time annotation, never persisted and never read back: Put ignores it,
	// and every other path (Traverse, CertifiedLeaves) leaves it zero. Retrieve
	// sets it so a caller can see HOW WELL a leaf matched instead of trusting rank
	// order alone — the store used to return k leaves however poor the match and
	// discard the score, which is what let irrelevant leaves reach a worker's
	// prompt. See RetrieveOpts.MinScore.
	Score float64
}

// Query is one qrels entry with its ground-truth relevant set.
//   - "semantic":   target a concept; relevant = every leaf carrying it.
//   - "relational": a seed leaf + a typed edge path; relevant = the set reached
//     by following ONLY edges of EdgeType for Hops steps (BFS ground truth).
type Query struct {
	Kind     string
	QueryVec []float32
	Relevant map[string]struct{}

	// semantic-only
	Concept int

	// relational-only
	SeedID   string
	EdgeType string
	Hops     int
}

// Config parameterizes the corpus. Defaults mirror premise.mjs exactly (dim 48,
// 32 concepts, 1-3 concepts/leaf, 3 edges/leaf, 0.12 noise, 1-3 hop relations);
// Leaves is the scale knob N. Concepts and dim are held FIXED across scales so
// footprint/latency are comparable — at large N each concept simply has more
// leaves, which caps semantic recall@k by class size (precision@k is the fair
// semantic-competence signal, as the premise notes).
type Config struct {
	Dim             int
	Concepts        int
	Leaves          int
	ConceptsPerLeaf [2]int
	EdgesPerLeaf    int
	EdgeTypes       []string
	Branches        []string
	Noise           float64
	NSemanticQ      int
	NRelationalQ    int
	RelHops         [2]int
	K               int
}

// DefaultConfig returns the premise-faithful config for a given scale N and
// cutoff k. Query counts default to 300 each (up from the premise's 60) so the
// latency p50/p95/p99 percentiles have a stable sample.
func DefaultConfig(n, k int) Config {
	return Config{
		Dim:             48,
		Concepts:        32,
		Leaves:          n,
		ConceptsPerLeaf: [2]int{1, 3},
		EdgesPerLeaf:    3,
		EdgeTypes:       []string{"depends-on", "cites", "supersedes", "refines"},
		Branches:        []string{"ArchVision", "Business", "InfoSystems", "Knowledge", "Software"},
		Noise:           0.12,
		NSemanticQ:      300,
		NRelationalQ:    300,
		RelHops:         [2]int{1, 3},
		K:               k,
	}
}

// Corpus is a generated workload: leaves, an id index, and the concept basis.
type Corpus struct {
	Cfg      Config
	Leaves   []Leaf
	ByID     map[string]*Leaf
	Concepts [][]float32
}

// unitVec draws a random unit vector in dim d (d gaussian draws + normalize).
func unitVec(p *prng, d int) []float32 {
	v := make([]float32, d)
	var n float64
	for i := 0; i < d; i++ {
		g := p.gaussian(0, 1)
		v[i] = float32(g)
		n += g * g
	}
	if n == 0 {
		n = 1
	}
	inv := 1.0 / mathSqrt(n)
	for i := 0; i < d; i++ {
		v[i] = float32(float64(v[i]) * inv)
	}
	return v
}

// GenerateCorpus builds the synthetic KM graph for a seed. The PRNG draw ORDER
// is fixed (all concept vectors, then per-leaf concepts+noise, then a second
// pass for edges) so the corpus is byte-for-byte reproducible.
func GenerateCorpus(seed uint32, cfg Config) *Corpus {
	p := newPRNG(seed ^ 0x6b3a1c9d)

	conceptVecs := make([][]float32, cfg.Concepts)
	for c := 0; c < cfg.Concepts; c++ {
		conceptVecs[c] = unitVec(p, cfg.Dim)
	}

	leaves := make([]Leaf, cfg.Leaves)
	for i := 0; i < cfg.Leaves; i++ {
		nC := p.intRange(cfg.ConceptsPerLeaf[0], cfg.ConceptsPerLeaf[1])
		concepts := make([]int, 0, nC)
		for j := 0; j < nC; j++ {
			concepts = append(concepts, p.intRange(0, cfg.Concepts-1))
		}
		// embedding = normalize(Σ concept-vectors + noise) — real semantic structure.
		emb := make([]float64, cfg.Dim)
		for _, c := range concepts {
			cv := conceptVecs[c]
			for d := 0; d < cfg.Dim; d++ {
				emb[d] += float64(cv[d])
			}
		}
		for d := 0; d < cfg.Dim; d++ {
			emb[d] += p.gaussian(0, cfg.Noise)
		}
		leaves[i] = Leaf{
			ID:        leafID(i),
			Idx:       i,
			Concepts:  dedupeInts(concepts),
			Branch:    cfg.Branches[i%len(cfg.Branches)],
			Embedding: normalize32(emb),
			// Attest a deterministic ~30% of leaves (the Comb "ratified" bit),
			// so the store's attested column carries real signal to persist.
			Attested: i%10 < 3,
		}
	}

	// Typed relational edges — a real graph, NOT correlated with embedding
	// similarity (targets are random), so relational answers are unreachable by
	// semantic similarity. Second pass to match the premise draw order.
	for i := range leaves {
		for e := 0; e < cfg.EdgesPerLeaf; e++ {
			typ := cfg.EdgeTypes[e%len(cfg.EdgeTypes)]
			to := p.intRange(0, cfg.Leaves-1)
			if to == leaves[i].Idx {
				to = (to + 1) % cfg.Leaves
			}
			leaves[i].Edges = append(leaves[i].Edges, Edge{Type: typ, Dst: leafID(to)})
		}
	}

	byID := make(map[string]*Leaf, len(leaves))
	for i := range leaves {
		byID[leaves[i].ID] = &leaves[i]
	}
	return &Corpus{Cfg: cfg, Leaves: leaves, ByID: byID, Concepts: conceptVecs}
}

// GenerateQueries builds the qrels set (semantic + relational) with ground-truth
// relevance. Draw order mirrors premise.mjs (all semantic queries, then all
// relational), keyed on a distinct salt so queries are independent of the
// corpus stream yet reproducible.
func GenerateQueries(c *Corpus, seed uint32) []Query {
	cfg := c.Cfg
	p := newPRNG(seed ^ 0x51a7e300)
	queries := make([]Query, 0, cfg.NSemanticQ+cfg.NRelationalQ)

	// SEMANTIC — target a concept; relevant = every leaf carrying it. The
	// fair-to-vector class: a flat retriever SHOULD do well here.
	for q := 0; q < cfg.NSemanticQ; q++ {
		concept := p.intRange(0, cfg.Concepts-1)
		rel := make(map[string]struct{})
		for i := range c.Leaves {
			if containsInt(c.Leaves[i].Concepts, concept) {
				rel[c.Leaves[i].ID] = struct{}{}
			}
		}
		if len(rel) == 0 {
			continue
		}
		queries = append(queries, Query{
			Kind:     "semantic",
			Concept:  concept,
			QueryVec: c.Concepts[concept],
			Relevant: rel,
		})
	}

	// RELATIONAL — a seed leaf + a typed edge path; relevant = the BFS closure
	// following ONLY edges of `type` for `hops` steps. Defined by STRUCTURE.
	for q := 0; q < cfg.NRelationalQ; q++ {
		seedLeaf := &c.Leaves[p.intRange(0, len(c.Leaves)-1)]
		hops := p.intRange(cfg.RelHops[0], cfg.RelHops[1])
		typ := cfg.EdgeTypes[p.intRange(0, len(cfg.EdgeTypes)-1)]
		reached := bfsGroundTruth(c, seedLeaf.ID, typ, hops)
		delete(reached, seedLeaf.ID)
		if len(reached) == 0 {
			continue
		}
		queries = append(queries, Query{
			Kind:     "relational",
			SeedID:   seedLeaf.ID,
			EdgeType: typ,
			Hops:     hops,
			QueryVec: seedLeaf.Embedding,
			Relevant: reached,
		})
	}
	return queries
}

// bfsGroundTruth walks the graph following ONLY edges of the given type for the
// given number of hops — the reference multi-hop answer the stores are scored
// against.
func bfsGroundTruth(c *Corpus, seedID, edgeType string, hops int) map[string]struct{} {
	frontier := []string{seedID}
	reached := make(map[string]struct{})
	for h := 0; h < hops; h++ {
		var next []string
		for _, id := range frontier {
			leaf := c.ByID[id]
			if leaf == nil {
				continue
			}
			for _, ed := range leaf.Edges {
				if ed.Type == edgeType {
					next = append(next, ed.Dst)
					reached[ed.Dst] = struct{}{}
				}
			}
		}
		frontier = next
	}
	return reached
}
