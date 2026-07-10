// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
)

// seedDim8Leaf writes one leaf embedded at dim 8 — the "old embedder" world a
// migration starts from — and returns the db path.
func seedDim8Leaf(t *testing.T) string {
	t.Helper()
	db := filepath.Join(t.TempDir(), "km.db")
	st, err := kmstore.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(kmstore.Leaf{
		ID: "leaf-a", Content: "durable fact", Author: "agix/queen/root",
		Embedding: kmstore.HashEmbed("durable fact", 8),
	}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	return db
}

// hitsAt64 reopens db and counts retrieval hits for a hash-64 query — 0 while
// the store still holds dim-8 vectors (the dimension guard skips them), 1 once
// the migration has moved the store to the query's dimension.
func hitsAt64(t *testing.T, db string) int {
	t.Helper()
	st, err := kmstore.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	hits, err := st.Retrieve(kmstore.HashEmbed("durable fact", embedDim), 5, kmstore.RetrieveOpts{})
	if err != nil {
		t.Fatal(err)
	}
	return len(hits)
}

// The `km reembed` verb fixes the exact bug it exists for: a store written at
// one dimension is invisible to a query at another until the migration moves
// the whole store to the env-selected embedder. --dry-run must report without
// writing (query still blind), the real run must make the same query resolve.
func TestKMReembedMigratesStoreToEnvEmbedder(t *testing.T) {
	t.Setenv("AGIX_EMBED", "hash") // deterministic hash-64; no daemon, no network
	db := seedDim8Leaf(t)

	if got := hitsAt64(t, db); got != 0 {
		t.Fatalf("seed sanity: dim-64 query on a dim-8 store returned %d hits, want 0", got)
	}
	if code := kmReembed([]string{"--db", db, "--dry-run"}); code != 0 {
		t.Fatalf("reembed --dry-run exit = %d, want 0", code)
	}
	if got := hitsAt64(t, db); got != 0 {
		t.Fatalf("--dry-run wrote to the store: dim-64 query returned %d hits, want 0", got)
	}
	if code := kmReembed([]string{"--db", db}); code != 0 {
		t.Fatalf("reembed exit = %d, want 0", code)
	}
	if got := hitsAt64(t, db); got != 1 {
		t.Fatalf("post-migration dim-64 query returned %d hits, want 1", got)
	}
}

// A DEGRADED embedder must be a loud refusal, not a silent hash migration:
// AGIX_EMBED=nomic pointed at a daemon that fails the probe falls back to
// hash-64 (engaged=false), and reembed without --force must exit non-zero with
// the store untouched. --force overrides (checked with --dry-run so the test
// still writes nothing).
func TestKMReembedRefusesDegradedEmbedder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"model not found"}`, http.StatusInternalServerError)
	}))
	defer srv.Close()
	t.Setenv("AGIX_EMBED", "nomic")
	t.Setenv("AGIX_OLLAMA_HOST", srv.URL) // probe fails fast ⇒ degrade to hash-64

	db := seedDim8Leaf(t)
	if code := kmReembed([]string{"--db", db}); code != 1 {
		t.Fatalf("degraded embedder without --force: exit = %d, want 1 (refuse)", code)
	}
	if got := hitsAt64(t, db); got != 0 {
		t.Fatalf("refused run must not touch the store: dim-64 query returned %d hits, want 0", got)
	}
	if code := kmReembed([]string{"--db", db, "--dry-run", "--force"}); code != 0 {
		t.Fatalf("degraded embedder with --force --dry-run: exit = %d, want 0", code)
	}
}
