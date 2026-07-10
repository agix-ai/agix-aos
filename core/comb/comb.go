// Package comb is the developer-facing Go SDK over the Comb — the hive's durable
// provenance-gated knowledge store (kmstore). It is the ergonomic client the MCP
// server (services/comb-mcp) transports and the swarm's CombRetriever consumes
// under the hood, but with a provenance-FIRST surface: reads are attested-only by
// default, writes carry their author/verifier/trust, and two value-adds the raw
// store does not offer — a queryable LINEAGE / bee-trace walk (author → verifier
// → … → human root) and a self-contained HTML-Comb artifact emitter.
//
// This package only READS from kmstore / apiary / caste / ledger; it never
// reimplements the attestation gate or the anti-poisoning shield — those stay in
// kmstore. It is a thin, stdlib-plus-core-leaf facade: the value is ergonomics
// plus lineage.go and html.go, not a 1:1 re-wrap.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb

import (
	"errors"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
)

// DefaultDim is the embedding dimension the SDK hashes text at when a Note does
// not carry its own vector. It matches core/cmd/agix-core/km.go's embedDim (64)
// and the swarm CombRetriever's dim, so a note written through this SDK is
// byte-identically retrievable by the `km` CLI and by worker foraging — a drift
// would silently return nothing on retrieval (see kmstore.HashEmbed's contract).
const DefaultDim = 64

// errNoStore guards the nil-store paths so a misconstructed Comb fails loudly
// rather than panicking on a nil dereference.
var errNoStore = errors.New("comb: nil store (build with comb.New(store))")

// Comb is the ergonomic, provenance-first client facade over a *kmstore.KMStore.
// It is safe for concurrent use to the same degree kmstore is (WAL-mode reads,
// single-writer). Build one with New and, optionally, an audit ledger to enrich
// lineage traces with the trail of record.
type Comb struct {
	store *kmstore.KMStore
	led   *ledger.Ledger // optional: corroborates lineage hops with recorded frames
	dim   int            // embedding dimension for text-query / text-write ergonomics
}

// Option configures a Comb at construction.
type Option func(*Comb)

// WithDim overrides the embedding dimension (default DefaultDim). It MUST equal
// the dim the store's existing leaves were written at, or text retrieval misses.
func WithDim(dim int) Option {
	return func(c *Comb) {
		if dim > 0 {
			c.dim = dim
		}
	}
}

// WithLedger attaches the append-only audit ledger so TraceLeaf / TraceActor can
// corroborate each provenance hop with concrete recorded frames (agent_start,
// model_call, ratify …) and, heuristically, resolve the human principal from a
// ratify frame. Lineage still reconstructs without it — just less grounded.
func WithLedger(l *ledger.Ledger) Option {
	return func(c *Comb) { c.led = l }
}

// New builds a Comb over an already-open store. The store owns its lifecycle
// (Open/Close); this facade never closes it.
func New(store *kmstore.KMStore, opts ...Option) *Comb {
	c := &Comb{store: store, dim: DefaultDim}
	for _, o := range opts {
		o(c)
	}
	if c.dim <= 0 {
		c.dim = DefaultDim
	}
	return c
}

// Dim reports the embedding dimension this client hashes text at.
func (c *Comb) Dim() int { return c.dim }

// RegisterVerifier adds principals to the store's attestation roster — the
// out-of-band allowlist of identities authorized to vouch for a write (the fix
// for forgeable attestation; see kmstore/provenance.go). A verifier named on a
// Put/Attest is only honored if it was registered here first.
func (c *Comb) RegisterVerifier(actors ...string) {
	if c == nil || c.store == nil {
		return
	}
	c.store.RegisterVerifier(actors...)
}

// TrustFloor returns the store's attestation trust floor in force.
func (c *Comb) TrustFloor() float64 {
	if c == nil || c.store == nil {
		return 0
	}
	return c.store.TrustFloor()
}

// Note is the ergonomic input for writing one leaf into the Comb. Content is the
// text payload; Author wrote it; Verifier (a distinct, REGISTERED actor) attests
// it; Trust is the verifier's confidence in 0..1. Leave Embedding nil to hash
// Content at the client's dim; supply it to carry a real model's vector.
type Note struct {
	ID            string    // optional; empty → content-derived id (dedupes identical knowledge)
	Content       string    // the leaf's text payload
	Branch        string    // optional TOGAF branch tag
	Author        string    // actor ref that asserted the note, e.g. "agix/worker/forager-1"
	Verifier      string    // distinct, registered actor that vouches (empty → un-attested)
	Trust         float64   // verifier confidence, 0..1 (must clear TrustFloor to attest)
	Ratified      bool      // operator-ratified (trunk-merge) bit
	PendingCosign bool      // un-attested leaf awaiting a human co-sign (judgment-only verdict)
	Embedding     []float32 // optional; nil → kmstore.HashEmbed(Content, dim)
}

func (n Note) leaf(dim int) kmstore.Leaf {
	emb := n.Embedding
	if emb == nil {
		emb = kmstore.HashEmbed(n.Content, dim)
	}
	return kmstore.Leaf{
		ID:            n.ID,
		Content:       n.Content,
		Branch:        n.Branch,
		Author:        n.Author,
		Verifier:      n.Verifier,
		TrustScore:    n.Trust,
		Ratified:      n.Ratified,
		PendingCosign: n.PendingCosign,
		Embedding:     emb,
	}
}

// Put writes a note through kmstore's provenance gate + anti-poisoning shield and
// reports the outcome (added / attested / quarantined + a reason). Attestation is
// decided inline by the actor≠verifier rule — a note becomes attested iff a
// distinct, registered Verifier vouches with Trust ≥ TrustFloor. A note that
// fails the gate is stored UN-attested (retrievable only via RetrieveAll), never
// silently rejected — unless it contradicts an existing attested leaf, in which
// case the shield quarantines it (PutResult.Quarantined).
func (c *Comb) Put(n Note) (kmstore.PutResult, error) {
	if c == nil || c.store == nil {
		return kmstore.PutResult{}, errNoStore
	}
	return c.store.Put(n.leaf(c.dim))
}

// Attest raises an EXISTING leaf to attested by having a distinct, registered
// verifier vouch for it. kmstore keys attestation on content identity and its
// idempotent-refresh path only ever RAISES attestation (never downgrades), so
// this is a re-Put of the same Content carrying the vouching Verifier. Because
// the store exposes no fetch-by-id, the caller must supply the leaf's Content
// (and its original Author, so the actor≠verifier gate still holds). The returned
// PutResult.Attested / .Reason report whether the vouch landed.
func (c *Comb) Attest(n Note) (kmstore.PutResult, error) {
	if c == nil || c.store == nil {
		return kmstore.PutResult{}, errNoStore
	}
	if n.Verifier == "" {
		return kmstore.PutResult{}, errors.New("comb: Attest needs a Verifier (a second actor must vouch)")
	}
	return c.store.Put(n.leaf(c.dim))
}

// Cosign promotes an EXISTING pending-cosign leaf to attested by having a
// distinct, registered human verifier vouch for it — the manual half of the
// attestation policy (a judgment-only governed verdict was held out of the
// corpus; a human now certifies it). It follows the same actor≠verifier gate as
// a write, so the co-signer must be registered, distinct from the leaf's author,
// and clear the trust floor. The returned PutResult.Attested reports whether the
// co-sign landed.
func (c *Comb) Cosign(id, verifier string, trust float64) (kmstore.PutResult, error) {
	if c == nil || c.store == nil {
		return kmstore.PutResult{}, errNoStore
	}
	if verifier == "" {
		return kmstore.PutResult{}, errors.New("comb: Cosign needs a verifier (a human must vouch)")
	}
	return c.store.Cosign(id, verifier, trust)
}

// Link asserts a typed edge src -[edgeType]-> dst carrying its own provenance.
// The edge is attested by the same actor≠verifier rule as leaves; an un-attested
// edge is skipped by governed (attested-only) Traverse.
func (c *Comb) Link(src, edgeType, dst string, prov kmstore.Provenance) error {
	if c == nil || c.store == nil {
		return errNoStore
	}
	return c.store.Link(src, edgeType, dst, prov)
}

// Retrieve is the GOVERNED read: it embeds the query text and returns the k
// most cosine-similar ATTESTED leaves (un-attested / quarantined / tombstoned
// knowledge is structurally unreachable). This is the provenance-first default —
// the same posture the swarm's CombRetriever forages under.
func (c *Comb) Retrieve(query string, k int) ([]kmstore.Leaf, error) {
	return c.retrieve(query, k, true)
}

// RetrieveAll is the UN-governed read: it returns the k most similar leaves
// regardless of attestation (still excluding tombstoned). Use it for audit /
// rendering — e.g. to show attested vs un-attested state in an HTML artifact —
// never for foraging.
func (c *Comb) RetrieveAll(query string, k int) ([]kmstore.Leaf, error) {
	return c.retrieve(query, k, false)
}

func (c *Comb) retrieve(query string, k int, attestedOnly bool) ([]kmstore.Leaf, error) {
	if c == nil || c.store == nil {
		return nil, errNoStore
	}
	vec := kmstore.HashEmbed(query, c.dim)
	return c.store.Retrieve(vec, k, kmstore.RetrieveOpts{AttestedOnly: attestedOnly})
}

// CertifiedLeaves enumerates EVERY attested leaf on branch (all of it, not a
// cosine top-k) — the corpus source for distillation. Only verifier-vouched
// (actor≠verifier, trust ≥ floor) knowledge is returned, which is exactly the
// clean training signal the flywheel distills: plausible-but-wrong edits are never
// attested, so they never reach the weights. Pass "" for branch to enumerate all
// attested leaves; refactoring records live on the "software" branch.
func (c *Comb) CertifiedLeaves(branch string) ([]kmstore.Leaf, error) {
	if c == nil || c.store == nil {
		return nil, errNoStore
	}
	return c.store.Leaves(kmstore.LeafFilter{Branch: branch, AttestedOnly: true})
}

// Traverse follows attested edges of edgeType from seedID for hops steps and
// returns the reached attested leaves in breadth-first discovery order (seed
// excluded). It is always governed — un-attested edges and leaves are refused.
func (c *Comb) Traverse(seedID, edgeType string, hops int) ([]kmstore.Leaf, error) {
	if c == nil || c.store == nil {
		return nil, errNoStore
	}
	return c.store.Traverse(seedID, edgeType, hops, kmstore.TraverseOpts{AttestedOnly: true})
}

// Stats returns a snapshot of the store's contents and governing floor.
func (c *Comb) Stats() (kmstore.Stats, error) {
	if c == nil || c.store == nil {
		return kmstore.Stats{}, errNoStore
	}
	return c.store.Stats()
}
