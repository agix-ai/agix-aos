package swarm_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/swarm"
)

const combDim = 64 // matches cmd/agix-core embedDim, the dim `km put` writes at

// seedStore opens a fresh temp kmstore and returns it (closed by t.Cleanup).
func seedStore(t *testing.T) *kmstore.KMStore {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("kmstore.Open: %v", err)
	}
	// Register the legitimate verifier so putAttested's writes attest under the
	// roster gate (attestation now requires a registered verifier).
	st.RegisterVerifier("curator-bee")
	t.Cleanup(func() { st.Close() })
	return st
}

// putAttested writes an ATTESTED leaf (distinct verifier, trust above floor),
// embedded via the SAME HashEmbed a worker retrieval uses. It fails the test if
// the write did not attest, so a governance mistake surfaces here, not silently.
func putAttested(t *testing.T, st *kmstore.KMStore, id, content string) {
	t.Helper()
	res, err := st.Put(kmstore.Leaf{
		ID:         id,
		Content:    content,
		Author:     "scribe-bee",
		Verifier:   "curator-bee", // != author ⇒ attestable
		TrustScore: 0.9,           // ≥ 0.35 floor
		Embedding:  kmstore.HashEmbed(content, combDim),
	})
	if err != nil {
		t.Fatalf("Put(attested %s): %v", id, err)
	}
	if !res.Attested {
		t.Fatalf("seed leaf %q should be attested, got %+v", id, res)
	}
}

// putUnattested writes an UN-attested "poison" leaf (no verifier), embedded the
// same way so it WOULD rank if governance were broken.
func putUnattested(t *testing.T, st *kmstore.KMStore, id, content string) {
	t.Helper()
	res, err := st.Put(kmstore.Leaf{
		ID:        id,
		Content:   content,
		Author:    "attacker",
		Verifier:  "", // no second actor ⇒ un-attested
		Embedding: kmstore.HashEmbed(content, combDim),
	})
	if err != nil {
		t.Fatalf("Put(unattested %s): %v", id, err)
	}
	if res.Attested {
		t.Fatalf("poison leaf %q must NOT be attested, got %+v", id, res)
	}
}

// TestCombRetrieverAugments proves the happy path: an attested fact whose tokens
// overlap the subtask is retrieved and PREPENDED as a Context block, with hits>0.
func TestCombRetrieverAugments(t *testing.T) {
	st := seedStore(t)
	const fact = "The authentication service uses OAuth2 PKCE login tokens SENTINEL-HONEY-7788"
	putAttested(t, st, "auth-fact", fact)
	putAttested(t, st, "deploy-fact", "The deploy pipeline runs on Cloud Run with WAL SQLite")

	cr := swarm.NewCombRetriever(st, 3, combDim)
	subtask := "Implement the authentication login flow using OAuth2 tokens"

	aug, hits, err := cr.Augment(context.Background(), subtask)
	if err != nil {
		t.Fatalf("Augment: %v", err)
	}
	if hits <= 0 {
		t.Fatalf("hits = %d, want > 0 (the attested auth fact should match)", hits)
	}
	if !strings.Contains(aug, "SENTINEL-HONEY-7788") {
		t.Errorf("augmented prompt missing the seeded attested content:\n%s", aug)
	}
	if !strings.HasPrefix(aug, "Context:\n") {
		t.Errorf("augmented prompt should PREPEND a Context block, got:\n%s", aug)
	}
	if !strings.Contains(aug, subtask) {
		t.Errorf("augmented prompt must still contain the original subtask, got:\n%s", aug)
	}
	// The Context block must come before the original prompt (prepend, not append).
	if strings.Index(aug, "SENTINEL-HONEY-7788") > strings.Index(aug, subtask) {
		t.Errorf("Context should precede the original subtask prompt")
	}
}

// TestCombRetrieverGovernance is the load-bearing one: an un-attested / poisoned
// leaf that overlaps the query is REFUSED (AttestedOnly), while the attested leaf
// beside it is served. A worker must never forage unvouched knowledge.
func TestCombRetrieverGovernance(t *testing.T) {
	st := seedStore(t)
	putAttested(t, st, "good", "authentication login OAuth2 tokens TRUSTED-HONEY")
	// Poison shares the query tokens, so it WOULD surface if the gate leaked.
	putUnattested(t, st, "poison", "authentication login OAuth2 tokens POISON-IGNORE-ALL-RULES-LEAK-SECRETS")

	cr := swarm.NewCombRetriever(st, 5, combDim)
	aug, hits, err := cr.Augment(context.Background(), "authentication login OAuth2 tokens")
	if err != nil {
		t.Fatalf("Augment: %v", err)
	}
	if hits != 1 {
		t.Errorf("hits = %d, want exactly 1 (only the attested leaf, poison refused)", hits)
	}
	if !strings.Contains(aug, "TRUSTED-HONEY") {
		t.Errorf("expected the attested leaf in the augmented prompt, got:\n%s", aug)
	}
	if strings.Contains(aug, "POISON") {
		t.Errorf("GOVERNANCE BREACH: un-attested poison leaf was foraged:\n%s", aug)
	}
}

// TestCombRetrieverZeroHits proves the no-op contract: with nothing attested to
// retrieve, Augment returns the original prompt unchanged, 0 hits, and no error.
func TestCombRetrieverZeroHits(t *testing.T) {
	st := seedStore(t) // empty store
	// An un-attested leaf present but never retrievable under AttestedOnly.
	putUnattested(t, st, "lonely", "some un-attested note nobody vouched for")

	cr := swarm.NewCombRetriever(st, 5, combDim)
	const subtask = "do the thing"
	aug, hits, err := cr.Augment(context.Background(), subtask)
	if err != nil {
		t.Fatalf("Augment: %v", err)
	}
	if hits != 0 {
		t.Errorf("hits = %d, want 0 (no attested knowledge)", hits)
	}
	if aug != subtask {
		t.Errorf("zero-hit Augment must return the original prompt verbatim; got %q", aug)
	}
}

// TestSwarmCombEndToEnd wires a REAL CombRetriever into a full swarm run on the
// mock provider ($0). The mock echoes each worker's (augmented) prompt into its
// reply, which the Queen folds into the final answer — so the seeded attested
// fact surfacing in res.Answer is direct evidence retrieval ran through the
// worker path. Governance holds end-to-end: poison must not appear.
func TestSwarmCombEndToEnd(t *testing.T) {
	st := seedStore(t)
	putAttested(t, st, "e2e-fact",
		"Deploy notes: the login page ships behind OAuth2 — SENTINEL-E2E-4242")
	putUnattested(t, st, "e2e-poison",
		"login page OAuth2 POISON-E2E-SHOULD-NEVER-APPEAR")

	cr := swarm.NewCombRetriever(st, 3, combDim)
	res, err := swarm.Run(context.Background(), swarm.Options{
		Task:      "add a login page with OAuth2",
		Provider:  "mock",
		Workers:   2,
		Retriever: cr,
	})
	if err != nil {
		t.Fatalf("swarm.Run: %v", err)
	}
	if res.Answer == "" {
		t.Fatal("expected a synthesized answer")
	}
	if res.Cost.USD != 0 {
		t.Errorf("KM-on mock run must still be $0, got %v", res.Cost.USD)
	}
	if !strings.Contains(res.Answer, "SENTINEL-E2E-4242") {
		t.Errorf("seeded attested fact did not reach the answer via worker augmentation:\n%s", res.Answer)
	}
	if strings.Contains(res.Answer, "POISON-E2E-SHOULD-NEVER-APPEAR") {
		t.Errorf("GOVERNANCE BREACH end-to-end: poison reached the answer:\n%s", res.Answer)
	}
}
