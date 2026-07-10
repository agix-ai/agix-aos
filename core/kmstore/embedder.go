// embedder — the selectable text→vector seam. HashEmbed (embed.go) is the frozen,
// $0, offline, CGo-free DEFAULT: it is deterministic and needs no daemon, so CI
// and an air-gapped install stay green. But it is a token-hashing stand-in with
// NO semantics — the overnight field report (2026-07-08 §3a) proved it cannot
// resolve entities on fuzzy / natural-language queries (top-1 0.0–0.34), so the
// KM graph path is never even entered. This file adds an OPTIONAL local embed
// model (nomic-embed-text via Ollama, ~275 MB, $0, no API key) behind a small
// Embedder interface, selectable by env, that cleanly degrades back to HashEmbed
// when the daemon/model is absent — never crashing, never hanging.
//
// Selection (NewEmbedderFromEnv):
//   - AGIX_EMBED unset | "hash"        → HashEmbedder{64}   (default, $0, offline)
//   - AGIX_EMBED = "nomic"             → NomicEmbedder (Ollama); falls back to
//     HashEmbedder{64} with a logged notice if the daemon/model is unreachable
//   - AGIX_EMBED_MODEL                 → override the Ollama embed tag (default
//     "nomic-embed-text")
//   - OLLAMA_HOST / AGIX_OLLAMA_HOST   → Ollama base URL (default :11434)
//
// Every Embedder returns a UNIT vector, so the store's cosine==dot assumption
// (store.go) holds regardless of which embedder produced the write.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"
)

// Embedder turns text into a unit vector for the KM store. Implementations must
// be deterministic in dimension (Dim is stable) and return L2-normalized vectors
// so cosine similarity equals the dot product the store computes.
type Embedder interface {
	// Embed returns the unit vector for text. It returns an error only for a
	// genuine backend failure (a network embedder); the offline HashEmbedder
	// never errors.
	Embed(text string) ([]float32, error)
	// Dim is the fixed output dimension.
	Dim() int
	// Name identifies the embedder in reports/logs (e.g. "hash-64", "nomic-768").
	Name() string
}

// ─────────────────────────── hash (frozen default) ──────────────────────────

// HashEmbedder wraps the frozen HashEmbed at a fixed dimension. It is the $0,
// offline, deterministic default — no daemon, no key, no network.
type HashEmbedder struct{ D int }

// NewHashEmbedder returns a HashEmbedder at dim d (d≤0 defaults to 64, the shared
// km-CLI dimension).
func NewHashEmbedder(d int) HashEmbedder {
	if d <= 0 {
		d = 64
	}
	return HashEmbedder{D: d}
}

// Embed hashes text into a unit vector; it never errors.
func (h HashEmbedder) Embed(text string) ([]float32, error) { return HashEmbed(text, h.D), nil }

// Dim returns the fixed dimension.
func (h HashEmbedder) Dim() int { return h.D }

// Name is "hash-<dim>".
func (h HashEmbedder) Name() string { return "hash-" + itoa(h.D) }

// ─────────────────────────── nomic (local, optional) ────────────────────────

// NomicEmbedder is a hand-written HTTP client for a local Ollama embed model
// (default nomic-embed-text). No SDK is vendored: it POSTs to /api/embeddings
// with stdlib net/http + encoding/json, and L2-normalizes the response (Ollama
// returns raw, non-unit embeddings). $0, no API key. A missing daemon is caught
// at construction (NewNomicEmbedder probes once) so callers can degrade cleanly.
type NomicEmbedder struct {
	Model   string
	BaseURL string
	dim     int
	http    *http.Client
}

// NewNomicEmbedder builds and PROBES a local Ollama embedder. It embeds a tiny
// fixed string to (a) confirm the daemon + model are reachable and (b) learn the
// output dimension. A failure (no daemon, model not pulled, timeout) returns an
// error so the caller can fall back to HashEmbedder rather than hang later.
func NewNomicEmbedder(model, baseURL string) (*NomicEmbedder, error) {
	if strings.TrimSpace(model) == "" {
		model = "nomic-embed-text"
	}
	baseURL = normalizeEmbedHost(baseURL)
	e := &NomicEmbedder{
		Model:   model,
		BaseURL: baseURL,
		// Bounded so a wedged daemon degrades instead of hanging the harness.
		http: &http.Client{Timeout: 20 * time.Second},
	}
	v, err := e.embedRaw(context.Background(), "agix embedder probe")
	if err != nil {
		return nil, fmt.Errorf("nomic probe (is `ollama serve` up with %q pulled at %s?): %w", model, baseURL, err)
	}
	if len(v) == 0 {
		return nil, fmt.Errorf("nomic probe returned an empty embedding from %s", baseURL)
	}
	e.dim = len(v)
	return e, nil
}

// Embed returns the L2-normalized embedding of text.
func (e *NomicEmbedder) Embed(text string) ([]float32, error) {
	v, err := e.embedRaw(context.Background(), text)
	if err != nil {
		return nil, err
	}
	return normalizeF32(v), nil
}

// Dim returns the probed output dimension.
func (e *NomicEmbedder) Dim() int { return e.dim }

// Name is "nomic-<dim>" (the model tag is elided so reports stay stable across
// tag aliases of the same 768-dim model).
func (e *NomicEmbedder) Name() string { return "nomic-" + itoa(e.dim) }

// embedRaw POSTs one prompt to Ollama /api/embeddings and returns the raw (un-
// normalized) vector. Ollama can return HTTP 200 with a top-level "error" body,
// which is surfaced honestly.
func (e *NomicEmbedder) embedRaw(ctx context.Context, text string) ([]float32, error) {
	body, err := json.Marshal(map[string]any{"model": e.Model, "prompt": text})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.BaseURL+"/api/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("ollama http %d: %s", resp.StatusCode, truncEmbed(data))
	}
	var out struct {
		Embedding []float32 `json:"embedding"`
		Error     string    `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decode embedding: %w", err)
	}
	if strings.TrimSpace(out.Error) != "" {
		return nil, fmt.Errorf("ollama error: %s", out.Error)
	}
	return out.Embedding, nil
}

// ───────────────────────────── env selection ────────────────────────────────

// NewEmbedderFromEnv returns the embedder selected by AGIX_EMBED. The default
// (unset or "hash") is the $0/offline HashEmbedder{64} — so CI and air-gapped
// installs never touch the network. "nomic" attempts a local Ollama embedder and
// falls back to HashEmbedder{64} with a clear one-line notice on stderr if the
// daemon/model is unavailable. It NEVER crashes and NEVER hangs (the probe is
// bounded). The bool reports whether the requested local model was actually
// engaged (false ⇒ degraded to hash).
func NewEmbedderFromEnv() (Embedder, bool) {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("AGIX_EMBED")))
	switch mode {
	case "", "hash":
		return NewHashEmbedder(64), false
	case "nomic":
		model := firstNonEmptyEmbed(os.Getenv("AGIX_EMBED_MODEL"), "nomic-embed-text")
		host := firstNonEmptyEmbed(os.Getenv("AGIX_OLLAMA_HOST"), os.Getenv("OLLAMA_HOST"))
		e, err := NewNomicEmbedder(model, host)
		if err != nil {
			fmt.Fprintf(os.Stderr, "kmstore: AGIX_EMBED=nomic unavailable, falling back to hash-64 ($0/offline): %v\n", err)
			return NewHashEmbedder(64), false
		}
		return e, true
	default:
		fmt.Fprintf(os.Stderr, "kmstore: unknown AGIX_EMBED=%q, using hash-64 ($0/offline)\n", mode)
		return NewHashEmbedder(64), false
	}
}

// ───────────────────────────── small helpers ────────────────────────────────

// normalizeF32 L2-normalizes a float32 vector to unit length (a zero vector maps
// to itself). Accumulates in float64 for stability.
func normalizeF32(v []float32) []float32 {
	var n float64
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	if n == 0 {
		return v
	}
	inv := 1.0 / math.Sqrt(n)
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(float64(x) * inv)
	}
	return out
}

func firstNonEmptyEmbed(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// normalizeEmbedHost accepts a bare host:port or a full URL and returns a scheme-
// qualified base URL with no trailing slash (default http://localhost:11434).
func normalizeEmbedHost(h string) string {
	h = strings.TrimRight(strings.TrimSpace(h), "/")
	if h == "" {
		return "http://localhost:11434"
	}
	if !strings.HasPrefix(h, "http://") && !strings.HasPrefix(h, "https://") {
		h = "http://" + h
	}
	return h
}

func truncEmbed(b []byte) string {
	const max = 256
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}
