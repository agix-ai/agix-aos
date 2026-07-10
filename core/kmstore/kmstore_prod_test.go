// kmstore_prod_test — CGo-free correctness for the PRODUCTION provenance-gated
// store. Run with:
//
//	CGO_ENABLED=0 go test ./kmstore/...
//
// The suite pins the load-bearing governed-hive semantics: the attestation gate
// (actor≠verifier + trust floor), governed retrieval, the anti-poisoning shield,
// typed-edge traversal, and durability across Close/Open.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"math"
	"path/filepath"
	"testing"
)

// mkVec returns a unit-normalized float32 vector (cosine == dot on unit vecs).
func mkVec(xs ...float32) []float32 {
	var n float64
	for _, x := range xs {
		n += float64(x) * float64(x)
	}
	if n == 0 {
		n = 1
	}
	inv := 1.0 / math.Sqrt(n)
	out := make([]float32, len(xs))
	for i, x := range xs {
		out[i] = float32(float64(x) * inv)
	}
	return out
}

func openTmp(t *testing.T) *KMStore {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// Register the legitimate verifier principals this suite uses. Attestation
	// now requires the verifier to be on the store's roster (see provenance.go's
	// trust model); these registrations are the "trusted setup" a real hive does
	// out of band. A verifier NOT registered here (e.g. a forged one) stays
	// un-attested — see TestForgedAttestationRefused.
	st.RegisterVerifier("bob", "b", "dave")
	t.Cleanup(func() { st.Close() })
	return st
}

// TestGateSelfAttestationRefused: (a) Author == Verifier ⇒ NOT attested, but the
// write is still stored (un-attested), not rejected.
func TestGateSelfAttestationRefused(t *testing.T) {
	st := openTmp(t)
	res, err := st.Put(Leaf{
		ID: "self", Content: "self-vouched fact", Branch: "Knowledge",
		Author: "alice", Verifier: "alice", TrustScore: 0.99,
		Embedding: mkVec(1, 0, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Attested {
		t.Fatalf("self-attestation must NOT attest (actor≠verifier): %+v", res)
	}
	if !res.Added || res.Quarantined {
		t.Fatalf("un-attested write should still be Added, not quarantined: %+v", res)
	}

	// Trust below the floor with distinct actors is also un-attested.
	res2, err := st.Put(Leaf{
		ID: "lowtrust", Content: "shaky claim", Author: "alice", Verifier: "bob",
		TrustScore: 0.10, Embedding: mkVec(0, 1, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res2.Attested {
		t.Fatalf("trust below floor must NOT attest: %+v", res2)
	}
}

// TestGateAttestsWithDistinctVerifier: (b) Verifier != Author && trust ≥ floor ⇒
// attested.
func TestGateAttestsWithDistinctVerifier(t *testing.T) {
	st := openTmp(t)
	res, err := st.Put(Leaf{
		ID: "good", Content: "verified fact", Branch: "Software",
		Author: "alice", Verifier: "bob", TrustScore: 0.80,
		Embedding: mkVec(1, 1, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Attested || !res.Added {
		t.Fatalf("distinct verifier above floor must attest + add: %+v", res)
	}
}

// TestForgedAttestationRefused is the SECURITY regression for BUG 2: a write
// naming an UNREGISTERED verifier (the `km put --author a --verifier b` forgery)
// must NOT attest, must be excluded from AttestedOnly retrieval, and must NOT be
// able to supersede a real attested leaf — while a REGISTERED verifier still
// attests normally.
func TestForgedAttestationRefused(t *testing.T) {
	// Fresh store with NO auto-registered roster (do not use openTmp here).
	st, err := Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	q := mkVec(1, 0, 0, 0)

	// FORGERY: author a, verifier b, high trust, distinct strings — but b is not
	// on the roster. Pre-fix this self-attested in one line; now it must not.
	forged, err := st.Put(Leaf{
		ID: "forged", Content: "attacker-injected fact", Author: "a", Verifier: "b",
		TrustScore: 0.99, Embedding: mkVec(1, 0.05, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if forged.Attested {
		t.Fatalf("FORGERY: unregistered verifier must NOT attest: %+v", forged)
	}
	if !forged.Added || forged.Quarantined {
		t.Fatalf("forged write should store un-attested (added, not quarantined): %+v", forged)
	}

	// A legitimately REGISTERED verifier attests normally.
	st.RegisterVerifier("registered-verifier")
	legit, err := st.Put(Leaf{
		ID: "legit", Content: "vouched fact", Author: "a", Verifier: "registered-verifier",
		TrustScore: 0.9, Embedding: mkVec(1, 0.1, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !legit.Attested || !legit.Added {
		t.Fatalf("registered verifier must attest: %+v", legit)
	}

	// AttestedOnly retrieval returns ONLY the legit leaf; the forged one is excluded.
	gated, err := st.Retrieve(q, 10, RetrieveOpts{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(gated) != 1 || gated[0].ID != "legit" {
		t.Fatalf("AttestedOnly must exclude the forged leaf, got %v", ids(gated))
	}

	// The forged write also cannot supersede an attested leaf (the shield holds):
	// re-put "legit"'s id with contradicting content and an unregistered verifier.
	poison, err := st.Put(Leaf{
		ID: "legit", Content: "attacker overwrite", Author: "a", Verifier: "b",
		TrustScore: 0.99, Embedding: mkVec(1, 0.1, 0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !poison.Quarantined || poison.Attested {
		t.Fatalf("forged contradiction of an attested leaf must be quarantined: %+v", poison)
	}
	got, _, _ := st.getLeaf("legit", true)
	if got.Content != "vouched fact" {
		t.Fatalf("shield failed: attested content overwritten to %q", got.Content)
	}
}

// TestForgedEdgeAttestationRefused: the same roster gate governs edge (Link)
// attestation — an unregistered verifier cannot forge an attested edge.
func TestForgedEdgeAttestationRefused(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	put := func(id string, v ...float32) {
		if _, err := st.Put(Leaf{ID: id, Content: id, Embedding: mkVec(v...)}); err != nil {
			t.Fatalf("put %s: %v", id, err)
		}
	}
	put("x", 1, 0, 0)
	put("y", 0, 1, 0)

	// Forged edge: unregistered verifier ⇒ un-attested ⇒ skipped by a governed walk.
	if err := st.Link("x", "depends-on", "y", Provenance{Author: "a", Verifier: "b", TrustScore: 0.99}); err != nil {
		t.Fatal(err)
	}
	gov, err := st.Traverse("x", "depends-on", 1, TraverseOpts{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(gov) != 0 {
		t.Fatalf("governed walk must not follow a forged (un-attested) edge, reached %v", ids(gov))
	}
}

// TestRetrieveAttestedOnly: (c) AttestedOnly retrieval excludes un-attested.
func TestRetrieveAttestedOnly(t *testing.T) {
	st := openTmp(t)
	q := mkVec(1, 0, 0, 0)

	// One attested, one un-attested, both near the query.
	if _, err := st.Put(Leaf{ID: "att", Content: "attested", Author: "a", Verifier: "b", TrustScore: 0.9, Embedding: mkVec(1, 0.1, 0, 0)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(Leaf{ID: "un", Content: "unattested", Author: "a", Verifier: "a", TrustScore: 0.9, Embedding: mkVec(1, 0.2, 0, 0)}); err != nil {
		t.Fatal(err)
	}

	all, err := st.Retrieve(q, 10, RetrieveOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("open retrieve should see both leaves, got %d", len(all))
	}

	gated, err := st.Retrieve(q, 10, RetrieveOpts{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(gated) != 1 || gated[0].ID != "att" {
		t.Fatalf("AttestedOnly must return only the attested leaf, got %+v", ids(gated))
	}
}

// TestShieldQuarantinesPoison: (d) an un-attested write that contradicts an
// attested leaf is QUARANTINED and does NOT overwrite it — but a later ATTESTED
// write may legitimately supersede.
func TestShieldQuarantinesPoison(t *testing.T) {
	st := openTmp(t)
	emb := mkVec(1, 0, 0, 0)

	// Attested truth.
	if r, err := st.Put(Leaf{ID: "fact", Content: "original truth", Author: "alice", Verifier: "bob", TrustScore: 0.9, Embedding: emb}); err != nil || !r.Attested {
		t.Fatalf("seed attested leaf: %+v err=%v", r, err)
	}

	// Un-attested contradiction (self-vouched poison) — must be quarantined.
	poison, err := st.Put(Leaf{ID: "fact", Content: "POISON", Author: "mallory", Verifier: "mallory", TrustScore: 0.99, Embedding: emb})
	if err != nil {
		t.Fatal(err)
	}
	if !poison.Quarantined || poison.Added || poison.Attested {
		t.Fatalf("un-attested contradiction must be quarantined, not added: %+v", poison)
	}

	// The attested truth is untouched.
	got, ok, err := st.getLeaf("fact", true)
	if err != nil || !ok {
		t.Fatalf("attested leaf lookup: ok=%v err=%v", ok, err)
	}
	if got.Content != "original truth" {
		t.Fatalf("shield failed: content overwritten to %q", got.Content)
	}

	// The poison is logged to the audit trail.
	stats, err := st.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Quarantined < 1 {
		t.Fatalf("quarantined write should be audited, stats=%+v", stats)
	}

	// A later ATTESTED write legitimately supersedes.
	sup, err := st.Put(Leaf{ID: "fact", Content: "revised truth", Author: "carol", Verifier: "dave", TrustScore: 0.9, Embedding: emb})
	if err != nil {
		t.Fatal(err)
	}
	if !sup.Added || !sup.Attested || sup.Quarantined {
		t.Fatalf("attested supersede should succeed: %+v", sup)
	}
	got2, _, _ := st.getLeaf("fact", true)
	if got2.Content != "revised truth" {
		t.Fatalf("attested supersede did not apply: %q", got2.Content)
	}
}

// TestRoundtripAndTraverse: put/retrieve roundtrip + typed-edge traversal, incl.
// the governed AttestedOnly edge walk.
func TestRoundtripAndTraverse(t *testing.T) {
	st := openTmp(t)
	put := func(id, content string, v ...float32) {
		if _, err := st.Put(Leaf{ID: id, Content: content, Author: "a", Verifier: "b", TrustScore: 0.9, Embedding: mkVec(v...)}); err != nil {
			t.Fatalf("put %s: %v", id, err)
		}
	}
	put("a", "alpha", 1, 0, 0)
	put("b", "bravo", 0, 1, 0)
	put("c", "charlie", 0, 0, 1)
	put("d", "delta", 1, 1, 1)

	// Retrieve roundtrips content + ranks the nearest first.
	got, err := st.Retrieve(mkVec(0, 1, 0), 1, RetrieveOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "b" || got[0].Content != "bravo" {
		t.Fatalf("retrieve nearest failed: %+v", got)
	}

	// Attested edges a->b->c; traverse 2 hops reaches both.
	if err := st.Link("a", "depends-on", "b", Provenance{Author: "a", Verifier: "b", TrustScore: 0.9}); err != nil {
		t.Fatal(err)
	}
	if err := st.Link("b", "depends-on", "c", Provenance{Author: "a", Verifier: "b", TrustScore: 0.9}); err != nil {
		t.Fatal(err)
	}
	// An un-attested edge b->d (self-vouched) that the governed walk must skip.
	if err := st.Link("b", "depends-on", "d", Provenance{Author: "a", Verifier: "a", TrustScore: 0.9}); err != nil {
		t.Fatal(err)
	}

	walk, err := st.Traverse("a", "depends-on", 2, TraverseOpts{})
	if err != nil {
		t.Fatal(err)
	}
	set := func(ls []Leaf) map[string]bool {
		m := map[string]bool{}
		for _, l := range ls {
			m[l.ID] = true
		}
		return m
	}
	// Open walk follows every edge: a->b, then b->c and b->d ⇒ {b,c,d}.
	if w := set(walk); !w["b"] || !w["c"] || !w["d"] {
		t.Fatalf("open traverse should reach {b,c,d}, got %v", ids(walk))
	}

	gov, err := st.Traverse("a", "depends-on", 2, TraverseOpts{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	// Attested edges only: a->b (att), b->c (att); b->d is un-attested, skipped.
	if g := set(gov); !g["b"] || !g["c"] || g["d"] {
		t.Fatalf("governed traverse should reach {b,c} only, got %v", ids(gov))
	}
}

// TestPersistenceAcrossReopen: (e) attested state survives Close/Open.
func TestPersistenceAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "persist.db")

	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.RegisterVerifier("bob") // trusted-setup roster on the write store
	if _, err := st.Put(Leaf{ID: "durable", Content: "survives restart", Branch: "Business", Author: "alice", Verifier: "bob", TrustScore: 0.9, Ratified: true, Embedding: mkVec(1, 0, 0, 0)}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer st2.Close()

	got, err := st2.Retrieve(mkVec(1, 0, 0, 0), 5, RetrieveOpts{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "durable" || got[0].Content != "survives restart" {
		t.Fatalf("attested leaf did not persist: %+v", got)
	}
	if !got[0].Attested || !got[0].Ratified {
		t.Fatalf("provenance bits did not persist: %+v", got[0])
	}
	stats, err := st2.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Leaves != 1 || stats.Attested != 1 || stats.Ratified != 1 {
		t.Fatalf("stats after reopen wrong: %+v", stats)
	}
}

func ids(ls []Leaf) []string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = l.ID
	}
	return out
}
