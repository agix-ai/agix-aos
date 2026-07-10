// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
)

// The `km cosign` verb promotes a pending-cosign leaf (a judgment-only run's
// held-out artifact) into the certified corpus when a registered human vouches —
// km stats attested 0 -> 1, pending 1 -> 0 — and REFUSES an off-roster co-signer
// (a co-sign cannot forge attestation any more than a write can).
func TestKMCosignPromotesPendingLeaf(t *testing.T) {
	db := filepath.Join(t.TempDir(), "km.db")

	// Seed a pending-cosign leaf directly (as a judgment-only run would leave it):
	// un-attested, flagged pending, with an author distinct from the co-signer.
	st, err := kmstore.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(kmstore.Leaf{
		ID: "leaf-pending", Content: "certified artifact awaiting co-sign", Branch: "software",
		Author: "agix/queen/root", PendingCosign: true, Embedding: kmstore.HashEmbed("x", embedDim),
	}); err != nil {
		t.Fatal(err)
	}
	if s, _ := st.Stats(); s.Attested != 0 || s.PendingCosign != 1 {
		t.Fatalf("seed stats attested=%d pending=%d, want 0/1", s.Attested, s.PendingCosign)
	}
	st.Close()

	// An off-roster co-signer is refused (exit 3), leaf untouched.
	if code := kmCosign([]string{"--db", db, "--id", "leaf-pending", "--verifier", "stranger"}); code != 3 {
		t.Fatalf("off-roster cosign exit = %d, want 3 (refused)", code)
	}

	// A registered human (via AGIX_KM_VERIFIERS) co-signs → attested.
	t.Setenv(verifierEnv, "operator")
	if code := kmCosign([]string{"--db", db, "--id", "leaf-pending", "--verifier", "operator", "--trust", "1.0"}); code != 0 {
		t.Fatalf("cosign exit = %d, want 0", code)
	}

	st2, err := kmstore.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	if s, _ := st2.Stats(); s.Attested != 1 || s.PendingCosign != 0 {
		t.Fatalf("post-cosign stats attested=%d pending=%d, want 1/0", s.Attested, s.PendingCosign)
	}
}
