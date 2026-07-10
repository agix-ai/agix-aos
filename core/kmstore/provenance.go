// provenance — the governed-hive gate for the production KM store. This is the
// load-bearing, non-negotiable part: knowledge only becomes "attested" (and so
// retrievable under AttestedOnly) when a SECOND actor vouches for it with
// sufficient trust, and an attested leaf can never be silently overwritten by an
// un-attested contradiction (the BEEHIVE §3 anti-poisoning shield). The rules
// here are pure functions + small value types so they read like a policy and are
// trivial to test in isolation.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// DefaultTrustFloor is the minimum verifier trust for an attestation to stand.
// Below it, a write is stored but left un-attested (retrievable only when the
// caller does NOT ask for AttestedOnly).
const DefaultTrustFloor = 0.35

// PutResult reports the outcome of a Put against the provenance gate + shield.
//
//   - Added         — the leaf was written (fresh insert, idempotent refresh, an
//     attested supersede, or an overwrite of an un-attested prior).
//   - Attested      — the resulting stored leaf is attested (actor≠verifier gate
//     passed). Independent of Added: an un-attested leaf can still be Added.
//   - PendingCosign — the leaf was written UN-attested and flagged as awaiting a
//     human co-sign (a judgment-only governed verdict under the attestation
//     policy). Mutually exclusive with Attested.
//   - Quarantined   — the write was REFUSED by the shield (an un-attested write
//     that contradicts an existing attested leaf); it is logged to the audit
//     trail and did NOT touch the live leaf.
//   - Reason        — human-readable explanation of the decision.
type PutResult struct {
	ID            string `json:"id"`
	Added         bool   `json:"added"`
	Attested      bool   `json:"attested"`
	PendingCosign bool   `json:"pending_cosign,omitempty"`
	Quarantined   bool   `json:"quarantined"`
	Reason        string `json:"reason"`
}

// Provenance is the actor/verifier/trust triple carried on an edge write
// (Link). The same actor≠verifier gate that governs leaves governs edges.
type Provenance struct {
	Author     string  // who asserted the edge
	Verifier   string  // who attested it (must differ from Author to attest)
	TrustScore float64 // verifier confidence, 0..1
}

// RetrieveOpts tunes semantic retrieval. AttestedOnly makes the store refuse
// un-attested (and tombstoned) knowledge — the governed read path.
type RetrieveOpts struct {
	AttestedOnly bool

	// MinScore drops candidates whose cosine similarity to the query is strictly
	// below it, so a query with no relevant leaf returns NOTHING instead of the k
	// least-bad ones. Zero (the default) disables the floor entirely: retrieval
	// behaves exactly as it did before this field existed. Because embeddings are
	// unit vectors, cosine lies in [-1,1]; a floor of 0 would only drop
	// anti-correlated leaves, which is not a use anyone has, hence 0 == off.
	//
	// WHY THIS IS OPT-IN, AND MUST STAY OPT-IN. A useful floor is a property of the
	// (embedder, corpus) pair, not of the store:
	//
	//   - EMBEDDER. Calibrated on nomic-768, ≥95% of true hits survive τ≈0.66–0.70
	//     and 100% of out-of-domain queries are suppressed. Under HashEmbed the same
	//     exercise is impossible: the true leaf scores BELOW an irrelevant one
	//     (positives p50 0.414 vs distractors 0.58–0.61), so no τ separates them.
	//     A floor tuned for one embedder is meaningless — often inverted — for the other.
	//   - CORPUS. The live 62-leaf Comb separates near τ≈0.55; the 10k synthetic
	//     corpus near τ≈0.70. The best wrong leaf's score also creeps up as the
	//     corpus grows (more draws ⇒ higher max), so a fixed τ decays over time.
	//
	// It suppresses IRRELEVANCE, not AMBIGUITY. When a near-duplicate of the true
	// leaf exists, it scores about as high as the truth (leave-one-out suppression
	// ≤0.02 at 95% retention) and no floor will filter it. Use it to stop a worker's
	// Augment() prepending off-topic "Context:", not to make retrieval precise.
	//
	// Calibrate with research/agix_lab/retrieve_floor.py against YOUR embedder and
	// YOUR corpus before setting it. See
	// research/results/2026-07-09-retrieve-floor.json.
	MinScore float64
}

// TraverseOpts tunes graph traversal. AttestedOnly follows only attested edges
// and returns only attested, non-tombstoned leaves.
type TraverseOpts struct {
	AttestedOnly bool
}

// Stats is a cheap snapshot of the store's contents + governing floor.
type Stats struct {
	Path          string  `json:"path"`
	TrustFloor    float64 `json:"trust_floor"`
	Leaves        int     `json:"leaves"`         // live (non-tombstoned)
	Attested      int     `json:"attested"`       // live AND attested
	Ratified      int     `json:"ratified"`       // live AND ratified
	PendingCosign int     `json:"pending_cosign"` // live, un-attested, awaiting human co-sign
	Tombstoned    int     `json:"tombstoned"`     // soft-deleted
	Edges         int     `json:"edges"`          // total edges
	Quarantined   int     `json:"quarantined"`    // audit-trail entries (rejected + superseded)
}

// attest is the ATTESTATION RULE. A write is attested iff ALL of:
//
//  1. a verifier is named,
//  2. the verifier is a DIFFERENT actor than the author (actor≠verifier — no
//     self-attestation),
//  3. the verifier is a REGISTERED principal (the `registered` predicate) — a
//     known hive verifier on the store's roster, and
//  4. the trust score clears the floor.
//
// It never rejects — a failing write is simply left un-attested — so the second
// return value is an explanation, not an error.
//
// TRUST MODEL (why the roster matters — the fix for the forgeable-attestation
// audit finding). Before this gate existed, author/verifier/trust were all
// free strings on the write, so `km put --author a --verifier b --trust 0.9`
// self-attested in one line: an attacker named any second string as the
// "verifier" and produced an attested leaf that could supersede real knowledge
// and be foraged under AttestedOnly. Requiring the verifier to be REGISTERED
// closes that: the roster (KMStore.RegisterVerifier) is an allowlist populated
// OUT OF BAND from the write — by trusted setup, the swarm's real verifier
// caste, or the CLI's AGIX_KM_VERIFIERS env — so the write payload cannot add
// its own verifier. An unknown `b` is not on the roster ⇒ the write stores
// UN-attested (and the anti-poisoning shield quarantines it if it contradicts an
// attested leaf), exactly as an unvouched write.
//
// v1 SCOPE / FOLLOW-UP: registration is identity-by-allowlist (a principal name
// the store trusts), not a cryptographic proof. It stops the trivial one-line
// forgery and makes the trust boundary explicit and testable. A stronger
// follow-up binds attestation to a signed verifier TOKEN the store validates
// (so even roster membership can't be asserted without the key) and
// authenticates/persists the roster itself. Tracked as a hardening item.
func attest(author, verifier string, trust, floor float64, registered func(string) bool) (bool, string) {
	switch {
	case verifier == "":
		return false, "un-attested: no verifier (a second actor must vouch)"
	case verifier == author:
		return false, "un-attested: verifier == author (actor≠verifier — self-attestation refused)"
	case registered == nil || !registered(verifier):
		return false, fmt.Sprintf("un-attested: verifier %q is not a registered hive verifier (an unknown principal cannot vouch — register it via KMStore.RegisterVerifier / AGIX_KM_VERIFIERS)", verifier)
	case trust < floor:
		return false, fmt.Sprintf("un-attested: trust %.2f below floor %.2f", trust, floor)
	default:
		return true, fmt.Sprintf("attested by registered verifier %q (trust %.2f ≥ floor %.2f, actor≠verifier)", verifier, trust, floor)
	}
}

// contentID derives a stable id from content when the caller supplies none, so
// identical knowledge dedupes to one leaf and a reused id carrying DIFFERENT
// content is detectable as a collision (the shield's trigger).
func contentID(content string) string {
	sum := sha256.Sum256([]byte(content))
	return "leaf-" + hex.EncodeToString(sum[:8])
}
