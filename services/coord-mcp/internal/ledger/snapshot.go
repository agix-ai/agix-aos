package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Storage backends. The store is in-memory with a write-through JSON snapshot
// (see DESIGN.md for why this beat SQLite-on-a-volume for Cloud Run):
//
//   - MemorySnapshotter — tests / ephemeral local runs.
//   - FileSnapshotter   — local persistence (atomic tmp+rename).
//   - GCSSnapshotter    — production: one JSON object in a GCS bucket, written
//     with a generation precondition (compare-and-swap) so a second writer —
//     which should never exist given max-instances=1 — corrupts nothing and
//     trips loudly instead.
//
// GCSSnapshotter deliberately uses the raw GCS JSON API + the Cloud Run
// metadata-server token instead of cloud.google.com/go/storage: zero extra
// dependencies keeps the supply-chain argument for Go honest.

// ErrConcurrentWrite means another process wrote the snapshot since we loaded
// it (a DEFINITE 412 generation mismatch). The store reloads from storage and
// returns a retryable conflict to the caller.
var ErrConcurrentWrite = errors.New("concurrent snapshot write detected (generation mismatch)")

// ErrAmbiguousSave means a save had an ambiguous outcome (network error / 5xx
// / lost response) AND the read-back could not confirm our bytes landed. The
// store rolls the mutation back and marks itself DEGRADED rather than silently
// diverging from storage.
var ErrAmbiguousSave = errors.New("ambiguous snapshot save (storage state unconfirmed)")

// ── memory ───────────────────────────────────────────────────────────────

// MemorySnapshotter keeps the snapshot in RAM only.
type MemorySnapshotter struct {
	mu   sync.Mutex
	data []byte
}

func (m *MemorySnapshotter) Load(context.Context) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]byte(nil), m.data...), nil
}

func (m *MemorySnapshotter) Save(_ context.Context, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data = append([]byte(nil), data...)
	return nil
}

// ── file ─────────────────────────────────────────────────────────────────

// FileSnapshotter persists the snapshot to a local JSON file.
type FileSnapshotter struct {
	Path string
}

func (f *FileSnapshotter) Load(context.Context) ([]byte, error) {
	data, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (f *FileSnapshotter) Save(_ context.Context, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}

// ── GCS ──────────────────────────────────────────────────────────────────

// GCSSnapshotter persists the snapshot as a single GCS object using the JSON
// API with ifGenerationMatch preconditions (optimistic concurrency).
//
// Write-result ambiguity: a save whose response is lost (network error, 5xx)
// may or may not have committed. Returning a plain error there would wedge the
// process — the store rolls memory back while GCS holds the new generation, so
// every later write 412s. Save therefore RESOLVES ambiguity by reading the
// object back: if the stored bytes equal what we tried to write, the write
// committed — adopt the new generation and report success; otherwise report
// ErrAmbiguousSave (the store degrades loudly instead of diverging silently).
type GCSSnapshotter struct {
	Bucket string
	Object string
	// Endpoint overrides the GCS API base URL (tests); default
	// https://storage.googleapis.com.
	Endpoint string
	// HTTPClient defaults to a 15s-timeout client.
	HTTPClient *http.Client
	// TokenSource defaults to the GCE/Cloud Run metadata server.
	TokenSource func(ctx context.Context) (string, error)

	mu         sync.Mutex
	generation int64 // generation we last observed; 0 = object absent

	tokMu     sync.Mutex
	tok       string
	tokExpiry time.Time
}

// ParseGCSTarget splits "gs://bucket/path/to/object" into (bucket, object).
func ParseGCSTarget(target string) (bucket, object string, err error) {
	rest, ok := strings.CutPrefix(target, "gs://")
	if !ok {
		return "", "", fmt.Errorf("not a gs:// URL: %q", target)
	}
	bucket, object, ok = strings.Cut(rest, "/")
	if !ok || bucket == "" || object == "" {
		return "", "", fmt.Errorf("gs:// URL must be gs://bucket/object: %q", target)
	}
	return bucket, object, nil
}

func (g *GCSSnapshotter) client() *http.Client {
	if g.HTTPClient != nil {
		return g.HTTPClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (g *GCSSnapshotter) token(ctx context.Context) (string, error) {
	if g.TokenSource != nil {
		return g.TokenSource(ctx)
	}
	g.tokMu.Lock()
	defer g.tokMu.Unlock()
	if g.tok != "" && time.Now().Before(g.tokExpiry) {
		return g.tok, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := g.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("metadata token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata token: HTTP %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	g.tok = body.AccessToken
	g.tokExpiry = time.Now().Add(time.Duration(body.ExpiresIn-60) * time.Second)
	return g.tok, nil
}

func (g *GCSSnapshotter) endpoint() string {
	if g.Endpoint != "" {
		return g.Endpoint
	}
	return "https://storage.googleapis.com"
}

// read fetches the object bytes + generation WITHOUT touching g.generation.
// Callers must hold g.mu. A missing object returns (nil, 0, nil).
func (g *GCSSnapshotter) read(ctx context.Context) ([]byte, int64, error) {
	tok, err := g.token(ctx)
	if err != nil {
		return nil, 0, err
	}
	u := fmt.Sprintf("%s/storage/v1/b/%s/o/%s?alt=media",
		g.endpoint(), url.PathEscape(g.Bucket), url.PathEscape(g.Object))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := g.client().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotFound:
		return nil, 0, nil
	case http.StatusOK:
		var gen int64
		if h := resp.Header.Get("X-Goog-Generation"); h != "" {
			gen, _ = strconv.ParseInt(h, 10, 64)
		}
		data, err := io.ReadAll(resp.Body)
		return data, gen, err
	default:
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, 0, fmt.Errorf("gcs load: HTTP %d: %s", resp.StatusCode, string(b))
	}
}

func (g *GCSSnapshotter) Load(ctx context.Context) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	data, gen, err := g.read(ctx)
	if err != nil {
		return nil, err
	}
	g.generation = gen
	return data, nil
}

func (g *GCSSnapshotter) Save(ctx context.Context, data []byte) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	tok, err := g.token(ctx)
	if err != nil {
		return err // definite: the request was never sent
	}
	u := fmt.Sprintf(
		"%s/upload/storage/v1/b/%s/o?uploadType=media&name=%s&ifGenerationMatch=%d",
		g.endpoint(), url.PathEscape(g.Bucket), url.QueryEscape(g.Object), g.generation)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.client().Do(req)
	if err != nil {
		// AMBIGUOUS: the write may have committed with its response lost.
		return g.resolveAmbiguousSave(ctx, data, fmt.Errorf("gcs save: %w", err))
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		var body struct {
			Generation string `json:"generation"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err == nil {
			if gen, perr := strconv.ParseInt(body.Generation, 10, 64); perr == nil {
				g.generation = gen
				return nil
			}
		}
		// 200 but no readable generation: confirm via read-back.
		return g.resolveAmbiguousSave(ctx, data, errors.New("gcs save: 200 with unreadable generation"))
	case resp.StatusCode == http.StatusPreconditionFailed:
		return ErrConcurrentWrite // DEFINITE: object unchanged, another writer got there
	case resp.StatusCode >= 500:
		// AMBIGUOUS: 5xx after the body was sent — commit state unknown.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return g.resolveAmbiguousSave(ctx, data,
			fmt.Errorf("gcs save: HTTP %d: %s", resp.StatusCode, string(b)))
	default:
		// DEFINITE 4xx: request rejected, object unchanged.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("gcs save: HTTP %d: %s", resp.StatusCode, string(b))
	}
}

// resolveAmbiguousSave reads the object back after an ambiguous write result.
// Bytes match what we tried to write → the write committed: adopt the observed
// generation and report success. Anything else (mismatch, or the read-back
// itself failing) → ErrAmbiguousSave wrapping the original cause; g.generation
// is left untouched. Callers hold g.mu.
func (g *GCSSnapshotter) resolveAmbiguousSave(ctx context.Context, data []byte, cause error) error {
	stored, gen, rerr := g.read(ctx)
	if rerr == nil && stored != nil && bytes.Equal(stored, data) {
		g.generation = gen
		return nil // our write landed; only the response was lost
	}
	if rerr != nil {
		return fmt.Errorf("%w: %v (read-back also failed: %v)", ErrAmbiguousSave, cause, rerr)
	}
	return fmt.Errorf("%w: %v (read-back holds different content)", ErrAmbiguousSave, cause)
}

// NewSnapshotterFromTarget builds a Snapshotter from the COORD_MCP_STORE value:
// "" → memory (ephemeral, warns), "gs://bucket/object" → GCS, else local file.
func NewSnapshotterFromTarget(target string) (Snapshotter, string, error) {
	switch {
	case target == "":
		return &MemorySnapshotter{}, "memory (EPHEMERAL — set COORD_MCP_STORE)", nil
	case strings.HasPrefix(target, "gs://"):
		bucket, object, err := ParseGCSTarget(target)
		if err != nil {
			return nil, "", err
		}
		return &GCSSnapshotter{Bucket: bucket, Object: object}, "gcs " + target, nil
	default:
		return &FileSnapshotter{Path: target}, "file " + target, nil
	}
}
