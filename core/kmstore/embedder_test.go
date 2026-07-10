package kmstore

import (
	"math"
	"testing"
)

// TestHashEmbedderIsEmbedder confirms HashEmbedder satisfies the Embedder seam,
// produces the frozen HashEmbed vector, and returns a unit vector — so a store
// write through the interface is byte-identical to a direct HashEmbed call.
func TestHashEmbedderIsEmbedder(t *testing.T) {
	var e Embedder = NewHashEmbedder(64)
	if e.Dim() != 64 {
		t.Fatalf("Dim()=%d, want 64", e.Dim())
	}
	if e.Name() != "hash-64" {
		t.Fatalf("Name()=%q, want hash-64", e.Name())
	}
	v, err := e.Embed("attested knowledge about authentication")
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	want := HashEmbed("attested knowledge about authentication", 64)
	if len(v) != len(want) {
		t.Fatalf("len=%d, want %d", len(v), len(want))
	}
	for i := range want {
		if v[i] != want[i] {
			t.Fatalf("Embed[%d]=%v, want %v (must equal HashEmbed)", i, v[i], want[i])
		}
	}
	var norm float64
	for _, x := range v {
		norm += float64(x) * float64(x)
	}
	if math.Abs(norm-1) > 1e-5 {
		t.Errorf("not unit-length: |v|^2=%v", norm)
	}
}

// TestNewHashEmbedderDefaultDim: a non-positive dim defaults to 64 (the shared
// km-CLI dimension).
func TestNewHashEmbedderDefaultDim(t *testing.T) {
	if d := NewHashEmbedder(0).Dim(); d != 64 {
		t.Fatalf("NewHashEmbedder(0).Dim()=%d, want 64", d)
	}
	if d := NewHashEmbedder(-5).Dim(); d != 64 {
		t.Fatalf("NewHashEmbedder(-5).Dim()=%d, want 64", d)
	}
}

// TestEnvDefaultIsOfflineHash: the DEFAULT (AGIX_EMBED unset) must be hash-64 and
// must NOT engage a network model — this is what keeps CI and air-gapped installs
// $0/offline/green.
func TestEnvDefaultIsOfflineHash(t *testing.T) {
	t.Setenv("AGIX_EMBED", "")
	e, engaged := NewEmbedderFromEnv()
	if engaged {
		t.Fatal("default must NOT engage a local model (engaged=true)")
	}
	if e.Name() != "hash-64" {
		t.Fatalf("default Name()=%q, want hash-64", e.Name())
	}
	// An unknown mode also degrades to hash, never crashes.
	t.Setenv("AGIX_EMBED", "banana")
	if e2, ok := NewEmbedderFromEnv(); ok || e2.Name() != "hash-64" {
		t.Fatalf("unknown mode: got (%s, %v), want (hash-64, false)", e2.Name(), ok)
	}
}

// TestEnvNomicUnavailableDegrades: AGIX_EMBED=nomic against a dead daemon must
// fall back to hash-64 cleanly (no crash, no hang) and report NOT engaged. Points
// the probe at a refused port so the failure is immediate.
func TestEnvNomicUnavailableDegrades(t *testing.T) {
	t.Setenv("AGIX_EMBED", "nomic")
	t.Setenv("OLLAMA_HOST", "")
	t.Setenv("AGIX_OLLAMA_HOST", "http://127.0.0.1:1") // connection refused, fast
	e, engaged := NewEmbedderFromEnv()
	if engaged {
		t.Fatal("a dead daemon must degrade (engaged=true)")
	}
	if e.Name() != "hash-64" {
		t.Fatalf("fallback Name()=%q, want hash-64", e.Name())
	}
	if _, err := e.Embed("still works offline"); err != nil {
		t.Fatalf("fallback embedder must never error: %v", err)
	}
}

// TestNormalizeF32Unit: normalizeF32 returns a unit vector (and a zero vector
// unchanged) — the invariant the store's cosine==dot assumption needs for the
// non-unit vectors Ollama returns.
func TestNormalizeF32Unit(t *testing.T) {
	v := normalizeF32([]float32{3, 0, 4}) // |v|=5
	var n float64
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	if math.Abs(n-1) > 1e-6 {
		t.Fatalf("|v|^2=%v, want 1", n)
	}
	z := normalizeF32([]float32{0, 0, 0})
	for i, x := range z {
		if x != 0 {
			t.Fatalf("zero vec normalized[%d]=%v, want 0", i, x)
		}
	}
}
