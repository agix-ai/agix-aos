// sqlite — the modernc SQLite graph store (arm A), the recommended local
// primary. Pure Go, CGo-free (modernc.org/sqlite compiles SQLite to Go), so it
// builds with CGO_ENABLED=0 and ships in the single Agix binary. It holds the
// graph as two tables — leaves(id, embedding BLOB, branch, attested) and
// edges(src, type, dst) — with an index on (src, type) for fast typed
// traversal. Semantic top-k loads candidate vectors and ranks by cosine IN GO;
// multi-hop traversal is a Go BFS over the indexed edge table.
//
// WHY NOT sqlite-vec: the CGo-free sqlite-vec WASM path (asg017 bindings +
// ncruces + wazero) is version-brittle and panics on feature mismatch. modernc
// for the graph + Go-side cosine sidesteps that entirely and stays robust.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"database/sql"
	"fmt"
	"os"

	_ "modernc.org/sqlite" // pure-Go, CGo-free SQLite driver, registered as "sqlite"
)

// SQLiteStore is a durable, CGo-free graph + vector store.
type SQLiteStore struct {
	db   *sql.DB
	path string
}

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS leaves (
  id        TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  branch    TEXT,
  attested  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS edges (
  src  TEXT NOT NULL,
  type TEXT NOT NULL,
  dst  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_src_type ON edges(src, type);
`

// NewSQLiteStore opens (creating if needed) a store at path. WAL mode +
// busy_timeout are set via DSN pragmas so every pooled connection inherits them
// — the basis for the concurrency test's single-writer / many-reader behavior.
func NewSQLiteStore(path string) (*SQLiteStore, error) {
	dsn := fmt.Sprintf(
		"file:%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)",
		path,
	)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(sqliteSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &SQLiteStore{db: db, path: path}, nil
}

// Name implements Store.
func (s *SQLiteStore) Name() string { return "sqlite-graph" }

// Ingest bulk-inserts leaves and edges in one transaction with prepared
// statements. Leaves upsert (INSERT OR REPLACE); edges append (the benchmark
// only ever appends unique ids, so this stays on the fast path).
func (s *SQLiteStore) Ingest(leaves []Leaf) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	leafStmt, err := tx.Prepare(`INSERT OR REPLACE INTO leaves(id, embedding, branch, attested) VALUES(?,?,?,?)`)
	if err != nil {
		return err
	}
	defer leafStmt.Close()
	edgeStmt, err := tx.Prepare(`INSERT INTO edges(src, type, dst) VALUES(?,?,?)`)
	if err != nil {
		return err
	}
	defer edgeStmt.Close()

	for i := range leaves {
		l := &leaves[i]
		attested := 0
		if l.Attested {
			attested = 1
		}
		if _, err := leafStmt.Exec(l.ID, encodeVec(l.Embedding), l.Branch, attested); err != nil {
			return err
		}
		for _, e := range l.Edges {
			if _, err := edgeStmt.Exec(l.ID, e.Type, e.Dst); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// VectorTopK scans candidate vectors and ranks by cosine in Go. This store has
// no native vector index (sqlite-vec was rejected as brittle), so semantic
// retrieval is an O(N) table scan + decode — an honest, reported trade-off
// against the flat in-memory arm.
func (s *SQLiteStore) VectorTopK(query []float32, k int) ([]string, error) {
	rows, err := s.db.Query(`SELECT id, embedding FROM leaves`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sc []scored
	for rows.Next() {
		var id string
		var blob []byte
		if err := rows.Scan(&id, &blob); err != nil {
			return nil, err
		}
		sc = append(sc, scored{id: id, score: cosine(decodeVec(blob), query)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return topK(sc, k), nil
}

// Traverse follows typed edges via an indexed Go BFS (equivalently a recursive
// CTE) — the graph store's fast path, and the capability the flat arm lacks.
func (s *SQLiteStore) Traverse(seedID, edgeType string, hops int) ([]string, error) {
	stmt, err := s.db.Prepare(`SELECT dst FROM edges WHERE src=? AND type=?`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	frontier := []string{seedID}
	reached := make(map[string]struct{})
	var order []string
	for h := 0; h < hops; h++ {
		var next []string
		for _, src := range frontier {
			rows, err := stmt.Query(src, edgeType)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var dst string
				if err := rows.Scan(&dst); err != nil {
					rows.Close()
					return nil, err
				}
				next = append(next, dst)
				if _, seen := reached[dst]; !seen {
					reached[dst] = struct{}{}
					order = append(order, dst)
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
		frontier = next
	}
	delete(reached, seedID)
	// Return in discovery order minus the seed.
	out := order[:0:0]
	for _, id := range order {
		if id == seedID {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

// Count returns the number of leaves (the concurrency lost-writes check).
func (s *SQLiteStore) Count() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM leaves`).Scan(&n)
	return n, err
}

// Footprint checkpoints the WAL and sums the on-disk bytes (db + wal + shm).
// On-disk bytes/leaf is the authoritative footprint for this durable store.
func (s *SQLiteStore) Footprint() (Footprint, error) {
	// Fold the WAL back into the main db so the file size reflects real data.
	_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)

	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM leaves`).Scan(&n); err != nil {
		return Footprint{}, err
	}
	var total int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if fi, err := os.Stat(s.path + suffix); err == nil {
			total += fi.Size()
		}
	}
	fp := Footprint{Kind: "disk", TotalBytes: total}
	if n > 0 {
		fp.BytesPerLeaf = float64(total) / float64(n)
		fp.DiskBytesPerLeaf = fp.BytesPerLeaf
	}
	return fp, nil
}

// Close releases the database.
func (s *SQLiteStore) Close() error { return s.db.Close() }
