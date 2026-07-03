package ledger

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeGCS is a minimal in-memory GCS JSON-API double: media download with
// X-Goog-Generation, media upload with ifGenerationMatch preconditions, and
// switchable failure modes to reproduce write-result ambiguity.
type fakeGCS struct {
	mu         sync.Mutex
	data       []byte
	generation int64
	// mode controls the next upload's behavior:
	//   ""              normal
	//   "commit-500"    COMMIT the object, then answer 500 (ambiguous success)
	//   "drop-500"      do NOT commit, answer 500 (ambiguous failure)
	mode string
}

func (f *fakeGCS) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/storage/v1/b/"):
			if f.generation == 0 {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			w.Header().Set("X-Goog-Generation", strconv.FormatInt(f.generation, 10))
			_, _ = w.Write(f.data)
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/upload/storage/v1/b/"):
			want, _ := strconv.ParseInt(r.URL.Query().Get("ifGenerationMatch"), 10, 64)
			if want != f.generation {
				http.Error(w, "precondition failed", http.StatusPreconditionFailed)
				return
			}
			body := make([]byte, 0, 1024)
			buf := make([]byte, 4096)
			for {
				n, err := r.Body.Read(buf)
				body = append(body, buf[:n]...)
				if err != nil {
					break
				}
			}
			switch f.mode {
			case "commit-500":
				f.data = append([]byte(nil), body...)
				f.generation++
				f.mode = ""
				http.Error(w, "backend error (but the write committed)", http.StatusInternalServerError)
			case "drop-500":
				f.mode = ""
				http.Error(w, "backend error (write dropped)", http.StatusInternalServerError)
			default:
				f.data = append([]byte(nil), body...)
				f.generation++
				fmt.Fprintf(w, `{"generation":"%d"}`, f.generation)
			}
		default:
			http.Error(w, "unexpected request: "+r.Method+" "+r.URL.String(), http.StatusBadRequest)
		}
	})
}

func newGCSFixture(t *testing.T) (*fakeGCS, *GCSSnapshotter) {
	t.Helper()
	fake := &fakeGCS{}
	ts := httptest.NewServer(fake.handler())
	t.Cleanup(ts.Close)
	snap := &GCSSnapshotter{
		Bucket:      "test-bucket",
		Object:      "ledger.json",
		Endpoint:    ts.URL,
		HTTPClient:  ts.Client(),
		TokenSource: func(context.Context) (string, error) { return "test-token", nil },
	}
	return fake, snap
}

func TestGCSSaveLoadRoundTrip(t *testing.T) {
	_, snap := newGCSFixture(t)
	ctx := context.Background()
	if data, err := snap.Load(ctx); err != nil || data != nil {
		t.Fatalf("empty load = (%v, %v)", data, err)
	}
	if err := snap.Save(ctx, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := snap.Save(ctx, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("second save (generation must have advanced): %v", err)
	}
	data, err := snap.Load(ctx)
	if err != nil || string(data) != `{"v":2}` {
		t.Fatalf("load = (%q, %v)", data, err)
	}
}

// The P1 wedge scenario: GCS commits the object but the save response is lost
// (500). Save must read the object back, recognize its own bytes, adopt the
// new generation, and report SUCCESS — so the store neither rolls back a
// durable write nor 412-wedges on every later save.
func TestGCSAmbiguousSaveAdoptsCommittedWrite(t *testing.T) {
	fake, snap := newGCSFixture(t)
	ctx := context.Background()
	if err := snap.Save(ctx, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	fake.mu.Lock()
	fake.mode = "commit-500"
	fake.mu.Unlock()
	if err := snap.Save(ctx, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("ambiguous-but-committed save must resolve to success, got %v", err)
	}

	// generation was adopted: the next normal save must NOT 412
	if err := snap.Save(ctx, []byte(`{"v":3}`)); err != nil {
		t.Fatalf("post-ambiguity save wedged: %v", err)
	}
	if data, err := snap.Load(ctx); err != nil || string(data) != `{"v":3}` {
		t.Fatalf("final state = (%q, %v)", data, err)
	}
}

// Ambiguous save where the write did NOT land: read-back holds different
// content → ErrAmbiguousSave (the store rolls back and marks degraded), and
// the snapshotter still recovers once storage behaves again.
func TestGCSAmbiguousSaveMismatchReportsError(t *testing.T) {
	fake, snap := newGCSFixture(t)
	ctx := context.Background()
	if err := snap.Save(ctx, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	fake.mu.Lock()
	fake.mode = "drop-500"
	fake.mu.Unlock()
	err := snap.Save(ctx, []byte(`{"v":2}`))
	if !errors.Is(err, ErrAmbiguousSave) {
		t.Fatalf("want ErrAmbiguousSave, got %v", err)
	}

	// storage recovers → saving works again without a restart
	if err := snap.Save(ctx, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("retry after ambiguity: %v", err)
	}
}

// A DEFINITE 412 (another writer advanced the generation) must surface as
// ErrConcurrentWrite so the store reloads + returns a retryable conflict.
func TestGCSSaveConcurrentWriteIs412(t *testing.T) {
	fake, snap := newGCSFixture(t)
	ctx := context.Background()
	if err := snap.Save(ctx, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	// simulate another writer bumping the generation behind our back
	fake.mu.Lock()
	fake.data = []byte(`{"v":"theirs"}`)
	fake.generation++
	fake.mu.Unlock()

	err := snap.Save(ctx, []byte(`{"v":2}`))
	if !errors.Is(err, ErrConcurrentWrite) {
		t.Fatalf("want ErrConcurrentWrite, got %v", err)
	}

	// Load resyncs the generation; saving works again
	if _, err := snap.Load(ctx); err != nil {
		t.Fatalf("resync load: %v", err)
	}
	if err := snap.Save(ctx, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("save after resync: %v", err)
	}
}
