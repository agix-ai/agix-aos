// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb_test

import (
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/comb"
	"github.com/agix-ai/agix/core/distill"
	"github.com/agix-ai/agix/core/kmstore"
)

const (
	attAuthor   = "agix/queen/root"
	attVerifier = "agix/worker/verifier-1"
	// refactorArtifact is the coarse-prose certified record the refactor pack
	// writes today (behavior-guard's verdict summary) — a training-shaped leaf
	// distill-export consumes, so an attested one is a certified example.
	refactorArtifact = "Verdict APPROVE (2026-07-08) for extract-class-src/pkg/foo.go:12 " +
		"[behavior=true structure=true tangling=false]: Extracted FooCalculator; moved 3 methods."
)

func openStore(t *testing.T) *kmstore.KMStore {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// distillExamples runs the distill-export read side over the store's certified
// leaves and returns the certified-example count (the metric distill-export
// reports).
func distillExamples(t *testing.T, st *kmstore.KMStore) int {
	t.Helper()
	leaves, err := comb.New(st).CertifiedLeaves("software")
	if err != nil {
		t.Fatal(err)
	}
	stats, err := distill.Export(leaves, distill.Options{OutDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return stats.Examples
}

func attested(t *testing.T, st *kmstore.KMStore) int {
	t.Helper()
	s, err := st.Stats()
	if err != nil {
		t.Fatal(err)
	}
	return s.Attested
}

// THE headline metric: an externally-grounded, approved verdict takes the corpus
// from empty to non-empty — km stats attested 0 -> 1 AND distill-export 0 -> 1.
func TestAttestRunExternalGroundedFlowsToCorpus(t *testing.T) {
	st := openStore(t)
	st.RegisterVerifier(attVerifier) // the operator trusts this verifier
	c := comb.New(st)

	// Baseline: the flywheel is an empty room.
	if got := attested(t, st); got != 0 {
		t.Fatalf("baseline attested = %d, want 0", got)
	}
	if got := distillExamples(t, st); got != 0 {
		t.Fatalf("baseline distill examples = %d, want 0", got)
	}

	out, err := c.AttestRun(comb.RunLeaf{
		Content: refactorArtifact, Branch: "software",
		Author: attAuthor, Verifier: attVerifier,
		Approved: true, Grounding: comb.GroundingExternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Attested || out.PendingCosign {
		t.Fatalf("outcome = %+v, want attested (externally grounded)", out)
	}

	if got := attested(t, st); got != 1 {
		t.Fatalf("km stats attested = %d, want 1 (0 -> 1)", got)
	}
	if got := distillExamples(t, st); got < 1 {
		t.Fatalf("distill-export examples = %d, want >= 1 (0 -> 1)", got)
	}
}

// A judgment-only approval is HELD OUT of the corpus (pending_cosign) and only a
// human co-sign promotes it — km stats attested stays 0 until the co-sign, then 1.
func TestAttestRunJudgmentOnlyPendingUntilCosign(t *testing.T) {
	st := openStore(t)
	st.RegisterVerifier(attVerifier) // the grading bee is even on the roster …
	c := comb.New(st)

	out, err := c.AttestRun(comb.RunLeaf{
		Content: refactorArtifact, Branch: "software",
		Author: attAuthor, Verifier: attVerifier,
		Approved: true, Grounding: comb.GroundingJudgment, // … but the verdict is prose-only
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Attested || !out.PendingCosign {
		t.Fatalf("outcome = %+v, want pending_cosign (judgment-only never auto-attests)", out)
	}
	if s, _ := st.Stats(); s.Attested != 0 || s.PendingCosign != 1 {
		t.Fatalf("stats attested=%d pending=%d, want 0/1", s.Attested, s.PendingCosign)
	}
	if got := distillExamples(t, st); got != 0 {
		t.Fatalf("distill examples = %d, want 0 (a pending leaf is not corpus)", got)
	}

	// A human (a distinct, registered verifier) co-signs → into the corpus.
	st.RegisterVerifier("operator")
	cs, err := c.Cosign(out.ID, "operator", 0.95)
	if err != nil {
		t.Fatal(err)
	}
	if !cs.Attested {
		t.Fatalf("cosign = %+v, want attested", cs)
	}
	if s, _ := st.Stats(); s.Attested != 1 || s.PendingCosign != 0 {
		t.Fatalf("post-cosign stats attested=%d pending=%d, want 1/0", s.Attested, s.PendingCosign)
	}
	if got := distillExamples(t, st); got < 1 {
		t.Fatalf("post-cosign distill examples = %d, want >= 1", got)
	}
}

// A rejected verdict certifies nothing — no leaf is written at all.
func TestAttestRunRejectedRecordsNothing(t *testing.T) {
	st := openStore(t)
	st.RegisterVerifier(attVerifier)
	out, err := comb.New(st).AttestRun(comb.RunLeaf{
		Content: refactorArtifact, Branch: "software",
		Author: attAuthor, Verifier: attVerifier,
		Approved: false, Grounding: comb.GroundingExternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Written || out.Attested || out.PendingCosign {
		t.Fatalf("outcome = %+v, want nothing written for a rejected verdict", out)
	}
	if s, _ := st.Stats(); s.Leaves != 0 {
		t.Fatalf("leaves = %d, want 0 (rejected records nothing)", s.Leaves)
	}
}

// Who counts as a trusted verifier is the OPERATOR's decision: an
// externally-grounded verdict whose verifier is NOT on the roster does NOT
// auto-attest (it lands un-attested), so actor≠verifier is not weakened.
func TestAttestRunExternalUnregisteredVerifierNotAttested(t *testing.T) {
	st := openStore(t) // roster deliberately empty
	out, err := comb.New(st).AttestRun(comb.RunLeaf{
		Content: refactorArtifact, Branch: "software",
		Author: attAuthor, Verifier: attVerifier,
		Approved: true, Grounding: comb.GroundingExternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Attested {
		t.Fatalf("outcome = %+v, want un-attested (verifier not on the roster)", out)
	}
	if got := attested(t, st); got != 0 {
		t.Fatalf("attested = %d, want 0", got)
	}
}
