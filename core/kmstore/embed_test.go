package kmstore

import (
	"hash/fnv"
	"math"
	"strings"
	"testing"
	"unicode"
)

// refHashEmbed is a FROZEN, verbatim copy of the original embedder that lived in
// cmd/agix-core/km.go before it was promoted to kmstore.HashEmbed. The parity
// test below asserts HashEmbed stays byte-identical to it — if anyone ever
// "optimizes" HashEmbed, this catches the drift, because a drift silently makes
// governed retrieval miss facts written under the old path.
func refHashEmbed(text string, dim int) []float32 {
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

// TestHashEmbedParity is the CRITICAL parity gate: kmstore.HashEmbed must produce
// vectors byte-identical to the original km.go embedder, at the same dims and for
// the same inputs. `km put` and worker retrieval share this function, so any
// divergence here would make the swarm silently fail to forage written knowledge.
func TestHashEmbedParity(t *testing.T) {
	cases := []struct {
		text string
		dim  int
	}{
		{"", 64},
		{"the hive stores honey", 64},
		{"Add A Login Page!!!", 64},
		{"provenance gated graph km store", 64},
		{"punctuation, and   whitespace\tmix", 64},
		{"unicode café résumé naïve", 64},
		{"same tokens same tokens", 32},
		{"dimension check", 16},
		{"dimension check", 128},
	}
	for _, tc := range cases {
		want := refHashEmbed(tc.text, tc.dim)
		got := HashEmbed(tc.text, tc.dim)
		if len(got) != len(want) {
			t.Fatalf("HashEmbed(%q, %d): len=%d, want %d", tc.text, tc.dim, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("HashEmbed(%q, %d)[%d] = %v, want %v (parity broken)", tc.text, tc.dim, i, got[i], want[i])
			}
		}
	}
}

// TestHashEmbedDeterministicUnit freezes two invariants callers rely on: the same
// (text, dim) always yields the same vector (determinism), and every non-degenerate
// vector is unit-length (so cosine == dot product, as the store assumes).
func TestHashEmbedDeterministicUnit(t *testing.T) {
	const dim = 64
	a := HashEmbed("attested knowledge about authentication", dim)
	b := HashEmbed("attested knowledge about authentication", dim)
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("HashEmbed not deterministic at [%d]: %v vs %v", i, a[i], b[i])
		}
	}
	var norm float64
	for _, x := range a {
		norm += float64(x) * float64(x)
	}
	if math.Abs(norm-1.0) > 1e-5 {
		t.Errorf("HashEmbed vector not unit-length: |v|^2 = %v, want ~1", norm)
	}

	// The empty string embeds to the all-zero vector (no tokens ⇒ n forced to 1).
	zero := HashEmbed("", dim)
	for i, x := range zero {
		if x != 0 {
			t.Errorf("HashEmbed(\"\")[%d] = %v, want 0", i, x)
		}
	}
}
