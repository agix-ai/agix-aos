// embed — the shared, model-free hashing embedder. It is the SINGLE source of
// truth for turning text into a vector across every KM entry point (the `km`
// CLI's put/query and the swarm's Comb retriever), so a fact written under one
// path is byte-identically retrievable under another. A drift between two copies
// of this function would silently return nothing on retrieval, so it lives here,
// exported, called by all.
//
// It is a deterministic, CGo-free stand-in for a real embedding model: signed
// feature hashing over lowercased alphanumeric tokens, L2-normalized to a unit
// vector. Overlapping tokens ⇒ higher cosine similarity. Production writes that
// carry a real model's embeddings pass them through the kmstore API directly and
// bypass this.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"hash/fnv"
	"math"
	"strings"
	"unicode"
)

// HashEmbed turns text into a deterministic unit vector via signed feature
// hashing over lowercased alphanumeric tokens. It is the frozen embedder shared
// by `km put`/`km query` and worker retrieval — the two MUST produce identical
// vectors for a given (text, dim) or governed retrieval silently misses.
func HashEmbed(text string, dim int) []float32 {
	v := make([]float64, dim)
	toks := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, t := range toks {
		h := fnv.New32a()
		_, _ = h.Write([]byte(t))
		sum := h.Sum32()
		sign := 1.0
		if sum&1 == 1 {
			sign = -1.0
		}
		v[int(sum%uint32(dim))] += sign
	}
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n == 0 {
		n = 1
	}
	inv := 1.0 / math.Sqrt(n)
	out := make([]float32, dim)
	for i, x := range v {
		out[i] = float32(x * inv)
	}
	return out
}
