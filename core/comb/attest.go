// attest — the write side of the flywheel: the ATTESTATION POLICY that decides
// whether a governed run's certified artifact flows into the clean training
// corpus, is held for a human co-sign, or is dropped. This is the single seam
// the fleet/hivekit run path invokes on completion; before it existed, no leaf
// was ever attested through a run, so `distill-export` carried nothing (the
// corpus was empty end to end).
//
// THE POLICY (operator decision, 2026-07-08) — a leaf AUTO-ATTESTS into the
// certified corpus ONLY when its verification is EXTERNALLY GROUNDED (a
// deterministic/external oracle backed the verdict: tests passed, code executed
// to exit 0, a deterministic gate fired). A leaf whose verification is
// LLM-judgment-only (a critic bee's prose verdict, no oracle) does NOT
// auto-attest: it is written attested=false + pending_cosign=true so a human can
// co-sign it later (Comb.Cosign). A rejected verdict attests nothing. Rationale:
// same-family LLM critics grade style, not correctness — the corpus must stay
// clean, so only oracle-backed work updates the weights.
//
// This file adds NO new trust primitive: attestation is still decided by
// kmstore's actor≠verifier gate (a distinct, REGISTERED verifier vouching above
// the floor). AttestRun only chooses WHICH write to make from the run's verdict
// + grounding; the store enforces whether the vouch is legitimate.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb

import "strings"

// DefaultAttestTrust is the verifier confidence stamped on an auto-attested leaf
// when a RunLeaf carries none. It sits at the distill APPROVE tier (≥ 0.9) so an
// externally-grounded leaf is not only attested but immediately usable by
// distill-export (which drops leaves below 0.9 by default).
const DefaultAttestTrust = 0.95

// GroundingExternal / GroundingJudgment mirror swarm.Verdict's grounding classes
// so a caller can map a run's verdict to a RunLeaf without importing the swarm
// engine (comb stays a read/write leaf under kmstore, not a swarm dependency).
const (
	GroundingExternal = "external"
	GroundingJudgment = "judgment"
)

// RunLeaf is a governed run's certified artifact plus the verdict facts the
// attestation policy reasons over. It is deliberately a flat value type (no
// swarm import) so hivekit/fleet map a swarm.Result onto it directly.
type RunLeaf struct {
	Content   string    // the certified artifact — the leaf's payload (the answer / structured record)
	Branch    string    // TOGAF branch (refactoring records live on "software")
	Author    string    // the actor that produced the artifact (e.g. the queen/root)
	Verifier  string    // the DISTINCT verifier bee (actor≠verifier); must be registered to auto-attest
	Trust     float64   // verifier confidence to stamp on an attested leaf (0 → DefaultAttestTrust)
	Approved  bool      // the verifier's verdict
	Grounding string    // GroundingExternal | GroundingJudgment (empty → treated as judgment)
	Embedding []float32 // optional; nil → hashed from Content at the client dim
}

// AttestOutcome reports what the policy did with a RunLeaf.
type AttestOutcome struct {
	Written       bool   // a leaf was written (attested or pending); false when rejected/empty
	ID            string // the written leaf's id
	Attested      bool   // the leaf is attested (externally grounded + a registered verifier vouched)
	PendingCosign bool   // the leaf awaits a human co-sign (approved but judgment-only)
	Reason        string // human-readable explanation of the decision
}

// AttestRun applies the attestation policy to one governed run's certified
// artifact and writes the corresponding leaf. It is the write side of the
// flywheel — the point at which certified work becomes (or waits to become)
// corpus. Return values:
//
//   - rejected / empty  → nothing written (Written=false).
//   - approved+external → an ATTESTED leaf (Attested=true), IFF the verifier is
//     registered on the store and clears the floor; otherwise it lands
//     un-attested and Reason explains why (an un-trusted verifier is the
//     operator's call, surfaced honestly).
//   - approved+judgment → a PENDING-cosign leaf (attested=false,
//     pending_cosign=true), recording the grading bee so a human can co-sign.
func (c *Comb) AttestRun(rl RunLeaf) (AttestOutcome, error) {
	if c == nil || c.store == nil {
		return AttestOutcome{}, errNoStore
	}
	if strings.TrimSpace(rl.Content) == "" {
		return AttestOutcome{Reason: "no artifact content to record"}, nil
	}
	if !rl.Approved {
		// Rejected work never attests and is not recorded as knowledge — a
		// rejected verdict is not a certification.
		return AttestOutcome{Reason: "rejected verdict — nothing attested"}, nil
	}

	if rl.Grounding == GroundingExternal {
		trust := rl.Trust
		if trust <= 0 {
			trust = DefaultAttestTrust
		}
		res, err := c.Put(Note{
			Content:   rl.Content,
			Branch:    rl.Branch,
			Author:    rl.Author,
			Verifier:  rl.Verifier,
			Trust:     trust,
			Embedding: rl.Embedding,
		})
		if err != nil {
			return AttestOutcome{}, err
		}
		return AttestOutcome{
			Written:       res.Added,
			ID:            res.ID,
			Attested:      res.Attested,
			PendingCosign: res.PendingCosign,
			Reason:        "externally grounded verdict — " + res.Reason,
		}, nil
	}

	// Judgment-only (or unspecified) grounding: record the artifact UN-attested
	// and flag it pending co-sign, preserving WHICH bee graded it (Verifier) with
	// a zero trust so it cannot attest without a human. The content stays the pure
	// artifact — a later Cosign promotes it into the corpus verbatim.
	res, err := c.Put(Note{
		Content:       rl.Content,
		Branch:        rl.Branch,
		Author:        rl.Author,
		Verifier:      rl.Verifier,
		Trust:         0, // below floor by construction → stays un-attested
		PendingCosign: true,
		Embedding:     rl.Embedding,
	})
	if err != nil {
		return AttestOutcome{}, err
	}
	return AttestOutcome{
		Written:       res.Added,
		ID:            res.ID,
		Attested:      res.Attested, // false by construction
		PendingCosign: res.PendingCosign,
		Reason:        "judgment-only verdict — held for human co-sign",
	}, nil
}
