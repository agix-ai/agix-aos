// comb — the swarm's bridge to the Comb (the kmstore graph): a Retriever that
// gives every worker bee GOVERNED access to the hive's durable "honey" before it
// forages. It is the KM-ON arm of the swarm×KM 2×2: set Options.Retriever to a
// *CombRetriever and each subtask prompt is prepended with attested context
// retrieved from the store; leave it nil and the swarm forages cold (KM-OFF).
//
// Governance is the non-negotiable part: retrieval passes AttestedOnly:true, so
// a worker can only forage knowledge a SECOND actor vouched for (actor≠verifier).
// Un-attested / quarantined / poisoned leaves are structurally unreachable — a
// worker never learns from unvouched knowledge. Reads are cosine top-k over the
// same embedder `km put` used (kmstore.HashEmbed), so a written fact is found.
// The store runs WAL-mode, so the N workers' parallel reads are race-safe.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package swarm

import (
	"context"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
)

// CombRetriever augments a worker's subtask prompt with attested context drawn
// from a kmstore.KMStore (the Comb). It implements swarm.Retriever.
type CombRetriever struct {
	Store *kmstore.KMStore // the durable provenance-gated graph KM store
	K     int              // max attested hits to merge per subtask
	Dim   int              // embedding dimension — MUST match how facts were `km put`
}

// NewCombRetriever builds a CombRetriever over store, retrieving up to k attested
// hits per subtask and embedding queries at dim (which must equal the dim used
// when the facts were written, or retrieval silently returns nothing).
func NewCombRetriever(store *kmstore.KMStore, k, dim int) *CombRetriever {
	return &CombRetriever{Store: store, K: k, Dim: dim}
}

// Augment embeds the subtask, retrieves the k most similar ATTESTED leaves
// (governed read — un-attested/poisoned knowledge is refused), and PREPENDS
// their contents as a "Context:\n…\n\n" block before the original prompt. It
// returns the augmented prompt and the number of merged hits. Zero hits is a
// no-op (original prompt, 0 hits, no error) — KM being cold is not a failure.
// A retrieval error degrades gracefully to the original prompt (heals posture),
// so a transient store hiccup never fails a worker.
func (c *CombRetriever) Augment(_ context.Context, subtaskPrompt string) (string, int, error) {
	if c == nil || c.Store == nil {
		return subtaskPrompt, 0, nil
	}
	vec := kmstore.HashEmbed(subtaskPrompt, c.Dim)
	hits, err := c.Store.Retrieve(vec, c.K, kmstore.RetrieveOpts{AttestedOnly: true})
	if err != nil {
		// Heals: a read hiccup must not fail the worker — forage cold instead.
		return subtaskPrompt, 0, nil
	}
	if len(hits) == 0 {
		return subtaskPrompt, 0, nil
	}

	var b strings.Builder
	b.WriteString("Context:\n")
	for _, h := range hits {
		b.WriteString(h.Content)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	b.WriteString(subtaskPrompt)
	return b.String(), len(hits), nil
}

// CombRetriever satisfies the frozen KM seam.
var _ Retriever = (*CombRetriever)(nil)
