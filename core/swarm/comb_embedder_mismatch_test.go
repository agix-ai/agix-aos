package swarm_test

// CHARACTERIZATION TESTS FOR A KNOWN, UNFIXED BUG.
//
// `km reembed` migrated the live Comb from hash-64 to nomic-768 (2026-07-08). But
// CombRetriever.Augment still embeds its query with `kmstore.HashEmbed(prompt, c.Dim)`
// (comb.go), NOT with the env-selected embedder that WROTE those leaves, and
// cmd/agix-core wires c.Dim from the `embedDim = 64` constant. KMStore.Retrieve skips
// candidates whose embedding dimension differs from the query's, so on the migrated
// store the swarm's KM-ON arm matches nothing and silently forages cold: `--km` is a
// no-op. The existing comb_test.go cannot see this because it writes AND reads at 64.
//
// These tests pin the current behavior so the bug is visible and tracked rather than
// silent. THEY ARE EXPECTED TO FAIL once the embedder seam is fixed (CombRetriever
// taking a kmstore.Embedder instead of calling HashEmbed) — when they do, invert them:
// the mismatch case should then retrieve, and the hash-vs-nomic case should not exist.
//
// See research/notes/nightly-research-log.md, 2026-07-09 §4.

import (
	"context"
	"math"
	"math/rand"
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/swarm"
)

const migratedDim = 768 // what `km reembed` leaves behind (nomic-embed-text)

// modelVec is a deterministic stand-in for a real model embedding at `dim`. Only its
// DIMENSION matters here: the point is that it is not a HashEmbed vector.
func modelVec(text string, dim int) []float32 {
	var seed int64
	for _, r := range text {
		seed = seed*31 + int64(r)
	}
	rng := rand.New(rand.NewSource(seed))
	v := make([]float32, dim)
	var n float64
	for i := range v {
		v[i] = float32(rng.NormFloat64())
		n += float64(v[i]) * float64(v[i])
	}
	inv := 1.0 / math.Sqrt(n)
	for i := range v {
		v[i] = float32(float64(v[i]) * inv)
	}
	return v
}

func migratedStore(t *testing.T) (*kmstore.KMStore, string) {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	st.RegisterVerifier("curator-bee")
	const fact = "The authentication service uses OAuth2 PKCE login tokens SENTINEL-HONEY-7788"
	res, err := st.Put(kmstore.Leaf{
		ID: "auth-fact", Content: fact,
		Author: "scribe-bee", Verifier: "curator-bee", TrustScore: 0.9,
		Embedding: modelVec(fact, migratedDim),
	})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if !res.Attested {
		t.Fatalf("seed leaf must be attested, got %+v", res)
	}
	return st, fact
}

// BUG: on a 768-dim store, the 64-dim retriever cmd/agix-core wires up matches nothing.
// `--km` silently degrades to KM-OFF instead of erroring.
func TestCombRetrieverDimMismatchSilentlyRetrievesNothing(t *testing.T) {
	st, _ := migratedStore(t)
	const subtask = "Implement the authentication login flow using OAuth2 tokens"

	cr := swarm.NewCombRetriever(st, 3, 64) // embedDim, as cmd/agix-core/swarm.go:77 passes it
	aug, hits, err := cr.Augment(context.Background(), subtask)
	if err != nil {
		t.Fatalf("Augment: %v", err)
	}
	if hits != 0 {
		t.Fatalf("hits = %d; KNOWN BUG expects 0. If this now retrieves, the embedder seam was "+
			"fixed — invert this test.", hits)
	}
	if aug != subtask {
		t.Errorf("prompt was augmented despite 0 hits")
	}
}

// TRAP: "fixing" the mismatch by passing Dim=768 makes retrieval succeed, but the query is
// still a HashEmbed vector scored against a nomic vector. The cosine is meaningless, and an
// entirely unrelated query still gets a "Context:" block prepended. The dimension is not the
// bug; the EMBEDDER is. This is why RetrieveOpts.MinScore must default OFF: a floor
// calibrated on nomic↔nomic cosine says nothing about hash↔nomic cosine.
func TestCombRetrieverMatchingDimStillUsesWrongEmbedder(t *testing.T) {
	st, _ := migratedStore(t)
	cr := swarm.NewCombRetriever(st, 3, migratedDim)

	_, hits, err := cr.Augment(context.Background(), "Implement the authentication login flow using OAuth2 tokens")
	if err != nil {
		t.Fatalf("Augment: %v", err)
	}
	if hits == 0 {
		t.Fatalf("precondition failed: matching dims should retrieve (however meaninglessly)")
	}

	const unrelated = "keeping secrets out of source control"
	aug, hits, err := cr.Augment(context.Background(), unrelated)
	if err != nil {
		t.Fatalf("Augment(unrelated): %v", err)
	}
	if hits == 0 || aug == unrelated {
		t.Fatalf("KNOWN BUG expects an unrelated query to still be augmented (hits=%d); if it no "+
			"longer is, a relevance floor or the embedder fix landed — update this test.", hits)
	}
}
