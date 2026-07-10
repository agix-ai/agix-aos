// kmstore — the PRODUCTION provenance-gated graph KM store: the Agix hive's
// durable "honey". It is the same CGo-free, single-binary substrate the ADR
// (docs/architecture/00-overview/ADR-2026-07-04-km-graph-store.md) and the
// benchmark validated — a property graph with embeddings on modernc.org/sqlite,
// cosine ranked IN GO — hardened for real writes with:
//
//   - a provenance-rich schema (author, verifier, attested, ratified, trust,
//     created_at, tombstoned on leaves; author + attested on edges),
//   - the ATTESTATION GATE: a leaf is attested iff a distinct verifier vouches
//     with trust ≥ floor (actor≠verifier — the governed-hive rule),
//   - the ANTI-POISONING SHIELD: an attested leaf can only be superseded by
//     another attested write; an un-attested contradiction is quarantined to an
//     append-only audit trail, never destructively overwritten (BEEHIVE §3),
//   - governed retrieval/traversal that can refuse un-attested knowledge.
//
// It reuses store.go's BLOB codec (encodeVec/decodeVec) and cosine, so it stays
// byte-compatible with the benchmarked engine and CGo-free (CGO_ENABLED=0).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go, CGo-free SQLite driver, registered as "sqlite"
)

// KMStore is a durable, CGo-free, provenance-gated property-graph KM store.
type KMStore struct {
	db         *sql.DB
	path       string
	trustFloor float64

	// verifiers is the ATTESTATION ROSTER: the allowlist of principals authorized
	// to vouch for a leaf/edge. It is the authentication seam behind the
	// actor≠verifier gate (see provenance.go's trust model). It is populated OUT
	// OF BAND from a write — a write's Verifier field is only honored if that
	// principal is on this roster — which is what makes attestation non-forgeable
	// via `km put --verifier <arbitrary>`. Guarded by mu for concurrent Put/read.
	mu        sync.RWMutex
	verifiers map[string]struct{}
}

const kmSchema = `
CREATE TABLE IF NOT EXISTS leaves (
  id             TEXT PRIMARY KEY,
  content        TEXT    NOT NULL DEFAULT '',
  embedding      BLOB    NOT NULL,
  branch         TEXT,
  author         TEXT,
  verifier       TEXT,
  attested       INTEGER NOT NULL DEFAULT 0,
  ratified       INTEGER NOT NULL DEFAULT 0,
  trust          REAL    NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT 0,
  tombstoned     INTEGER NOT NULL DEFAULT 0,
  pending_cosign INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS edges (
  src      TEXT    NOT NULL,
  type     TEXT    NOT NULL,
  dst      TEXT    NOT NULL,
  author   TEXT,
  attested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_km_edges_src_type ON edges(src, type);
-- Append-only provenance audit trail: every write the shield refuses
-- (kind='quarantine') and every attested content the shield archives on a
-- legitimate supersede (kind='supersede'). Nothing is ever lost.
CREATE TABLE IF NOT EXISTS quarantine (
  id         TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  content    TEXT,
  embedding  BLOB,
  branch     TEXT,
  author     TEXT,
  verifier   TEXT,
  trust      REAL,
  reason     TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_km_quarantine_id ON quarantine(id);
`

// Open opens (creating if needed) a file-backed store at path in WAL mode. The
// parent directory is created if absent, so a default like ~/.agix/km.db works
// on a fresh machine. WAL + busy_timeout let many readers snapshot while a
// single writer proceeds — the swarm read/write profile the ADR measured.
func Open(path string) (*KMStore, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("kmstore: mkdir %s: %w", dir, err)
		}
	}
	dsn := fmt.Sprintf(
		"file:%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)",
		path,
	)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(kmSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("kmstore: schema: %w", err)
	}
	// Additive migration for stores created before pending_cosign existed (the
	// prod db already holds leaves under the pre-cosign schema). CREATE TABLE IF
	// NOT EXISTS never alters an existing table, so add the column out of band and
	// tolerate the "duplicate column" error a freshly-created table returns.
	if err := addColumnIfMissing(db, "leaves", "pending_cosign", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		db.Close()
		return nil, fmt.Errorf("kmstore: migrate pending_cosign: %w", err)
	}
	return &KMStore{db: db, path: path, trustFloor: DefaultTrustFloor, verifiers: map[string]struct{}{}}, nil
}

// addColumnIfMissing runs an ALTER TABLE ADD COLUMN, treating SQLite's
// "duplicate column name" as success so Open is idempotent across old and new
// stores. Any other error is a real failure and is returned.
func addColumnIfMissing(db *sql.DB, table, column, decl string) error {
	_, err := db.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, decl))
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	return nil
}

// TrustFloor returns the attestation trust floor in force.
func (s *KMStore) TrustFloor() float64 { return s.trustFloor }

// SetTrustFloor overrides the default attestation floor (0..1). Useful for
// tightening or loosening the governed-write bar per deployment.
func (s *KMStore) SetTrustFloor(f float64) { s.trustFloor = f }

// RegisterVerifier adds one or more principals to the attestation roster — the
// allowlist of identities authorized to ATTEST a write (see the trust model in
// provenance.go). A write's Verifier is only honored if it was registered here,
// out of band from the write, so an arbitrary `--verifier` string cannot forge
// an attested leaf. Empty/whitespace names are ignored. Safe for concurrent use.
//
// Legitimate callers: trusted setup code, the swarm's real verifier caste actor
// (caste.Actor(hive, caste.Worker, "verifier", n)), and the CLI seeding from the
// AGIX_KM_VERIFIERS env. Registration is deliberately NOT a write-time flag.
func (s *KMStore) RegisterVerifier(actors ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.verifiers == nil {
		s.verifiers = map[string]struct{}{}
	}
	for _, a := range actors {
		if a = strings.TrimSpace(a); a != "" {
			s.verifiers[a] = struct{}{}
		}
	}
}

// isRegisteredVerifier reports whether actor is on the attestation roster.
func (s *KMStore) isRegisteredVerifier(actor string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.verifiers[actor]
	return ok
}

// Put writes a leaf through the provenance gate + anti-poisoning shield and
// reports the outcome. Semantics (the load-bearing part):
//
//   - The id is the collision key. If empty it is derived from content, so
//     identical knowledge dedupes and a reused id with different content is a
//     detectable collision.
//   - Attestation: attested iff Verifier != "" && Verifier != Author &&
//     Verifier is a REGISTERED roster principal (RegisterVerifier) &&
//     TrustScore ≥ trustFloor. A failing write (incl. an unregistered/forged
//     verifier) is stored UN-attested, not rejected (unless the shield
//     quarantines it). See provenance.go for the trust model.
//   - Shield: a write whose content DIFFERS from an existing attested leaf of
//     the same id is only allowed to supersede it if the new write is ITSELF
//     attested. An un-attested contradiction is quarantined (logged, live leaf
//     untouched) and returns Quarantined:true. An un-attested prior may be
//     freely overwritten; identical content is an idempotent provenance refresh.
func (s *KMStore) Put(l Leaf) (PutResult, error) {
	id := l.ID
	if id == "" {
		id = contentID(l.Content)
	}
	attested, reason := attest(l.Author, l.Verifier, l.TrustScore, s.trustFloor, s.isRegisteredVerifier)
	// pending_cosign is a property of an UN-attested leaf only: an attested leaf
	// is never pending (the two are mutually exclusive by construction).
	pending := l.PendingCosign && !attested
	now := l.CreatedAt
	if now == 0 {
		now = time.Now().Unix()
	}
	blob := encodeVec(l.Embedding)

	tx, err := s.db.Begin()
	if err != nil {
		return PutResult{}, err
	}
	defer tx.Rollback()

	// Existing LIVE (non-tombstoned) leaf with this id?
	var exContent string
	var exAttested int
	row := tx.QueryRow(`SELECT content, attested FROM leaves WHERE id=? AND tombstoned=0`, id)
	switch err := row.Scan(&exContent, &exAttested); {
	case errors.Is(err, sql.ErrNoRows):
		// Fresh insert.
		if err := insertLeaf(tx, id, l, blob, attested, pending, now); err != nil {
			return PutResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return PutResult{}, err
		}
		return PutResult{ID: id, Added: true, Attested: attested, PendingCosign: pending, Reason: reason}, nil

	case err != nil:
		return PutResult{}, err
	}

	// A live leaf exists. Same content => idempotent provenance refresh: never
	// downgrade an already-attested leaf, only ever raise attestation/trust.
	if exContent == l.Content {
		finalAttested := attested || exAttested == 1
		finalPending := l.PendingCosign && !finalAttested
		if _, err := tx.Exec(
			`UPDATE leaves SET embedding=?, branch=?, author=?, verifier=?, attested=?, ratified=?, trust=?, pending_cosign=? WHERE id=?`,
			blob, l.Branch, l.Author, l.Verifier, boolInt(finalAttested), boolInt(l.Ratified), l.TrustScore, boolInt(finalPending), id,
		); err != nil {
			return PutResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return PutResult{}, err
		}
		return PutResult{ID: id, Added: true, Attested: finalAttested, PendingCosign: finalPending, Reason: "idempotent content; provenance refreshed"}, nil
	}

	// Content DIFFERS — a collision. The shield decides.
	if exAttested == 1 {
		if !attested {
			// THE SHIELD: an un-attested write may not overwrite attested
			// knowledge. Quarantine it to the audit trail; live leaf untouched.
			shieldReason := "shield: un-attested write contradicts attested leaf — " + reason
			if err := auditWrite(tx, id, "quarantine", l, blob, shieldReason, now); err != nil {
				return PutResult{}, err
			}
			if err := tx.Commit(); err != nil {
				return PutResult{}, err
			}
			return PutResult{ID: id, Added: false, Attested: false, Quarantined: true, Reason: shieldReason}, nil
		}
		// Legitimate attested supersede: archive the old attested content to the
		// audit trail, then overwrite in place.
		if err := auditSupersede(tx, id, exContent, now); err != nil {
			return PutResult{}, err
		}
		if err := overwriteLeaf(tx, id, l, blob, true, false, now); err != nil {
			return PutResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return PutResult{}, err
		}
		return PutResult{ID: id, Added: true, Attested: true, Reason: "attested supersede of prior attested leaf"}, nil
	}

	// Prior is un-attested — freely superseded by anything.
	if err := overwriteLeaf(tx, id, l, blob, attested, pending, now); err != nil {
		return PutResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return PutResult{}, err
	}
	return PutResult{ID: id, Added: true, Attested: attested, PendingCosign: pending, Reason: "overwrote un-attested prior; " + reason}, nil
}

// Cosign raises an EXISTING pending-cosign (un-attested) leaf to attested by
// having a distinct, REGISTERED verifier vouch for it — the human co-sign half
// of the attestation policy. A governed run whose verification was
// LLM-judgment-only is written attested=false + pending_cosign=true; a human (a
// registered verifier ≠ the leaf's author) later co-signs it here, promoting it
// into the certified corpus. Attestation follows the SAME actor≠verifier gate as
// Put — the co-signer must be registered, distinct from the author, and clear
// the trust floor — so co-sign cannot forge attestation any more than a write
// can. An already-attested leaf is a no-op success; an absent leaf is an error.
func (s *KMStore) Cosign(id, verifier string, trust float64) (PutResult, error) {
	if strings.TrimSpace(id) == "" {
		return PutResult{}, errors.New("kmstore: Cosign needs a leaf id")
	}
	l, ok, err := s.getLeaf(id, false)
	if err != nil {
		return PutResult{}, err
	}
	if !ok {
		return PutResult{ID: id}, fmt.Errorf("kmstore: no live leaf %q to co-sign", id)
	}
	if l.Attested {
		return PutResult{ID: id, Attested: true, Reason: "already attested; co-sign is a no-op"}, nil
	}
	attested, reason := attest(l.Author, verifier, trust, s.trustFloor, s.isRegisteredVerifier)
	if !attested {
		return PutResult{ID: id, Attested: false, PendingCosign: l.PendingCosign, Reason: "co-sign refused — " + reason}, nil
	}
	if _, err := s.db.Exec(
		`UPDATE leaves SET verifier=?, attested=1, trust=?, pending_cosign=0 WHERE id=? AND tombstoned=0`,
		verifier, trust, id,
	); err != nil {
		return PutResult{}, err
	}
	return PutResult{ID: id, Added: true, Attested: true, Reason: reason}, nil
}

// Link asserts a typed edge src -[type]-> dst carrying its own provenance. The
// edge is attested by the same actor≠verifier rule as leaves.
func (s *KMStore) Link(src, edgeType, dst string, prov Provenance) error {
	if src == "" || edgeType == "" || dst == "" {
		return errors.New("kmstore: Link needs src, type, and dst")
	}
	attested, _ := attest(prov.Author, prov.Verifier, prov.TrustScore, s.trustFloor, s.isRegisteredVerifier)
	_, err := s.db.Exec(
		`INSERT INTO edges(src, type, dst, author, attested) VALUES(?,?,?,?,?)`,
		src, edgeType, dst, prov.Author, boolInt(attested),
	)
	return err
}

// scoredLeaf pairs a decoded leaf with its cosine score for ranking.
type scoredLeaf struct {
	leaf  Leaf
	score float64
}

// Retrieve returns the k leaves most cosine-similar to query, each annotated with
// its Score. With opts.AttestedOnly it filters WHERE attested=1 AND tombstoned=0 —
// the governed read that refuses un-attested knowledge; otherwise it excludes only
// tombstoned leaves. Candidates whose embedding dimension differs from the query
// are skipped (never panic on a mixed-dim store).
//
// With opts.MinScore > 0, candidates scoring strictly below the floor are dropped,
// so a query with no relevant leaf returns an EMPTY slice rather than the k
// least-bad matches. The floor defaults to 0 (disabled) — see RetrieveOpts.MinScore
// for why it is opt-in and how to calibrate it.
//
// Fewer than k leaves are returned whenever fewer than k qualify; a caller must
// never assume len(out) == k.
func (s *KMStore) Retrieve(query []float32, k int, opts RetrieveOpts) ([]Leaf, error) {
	where := "WHERE tombstoned=0"
	if opts.AttestedOnly {
		where += " AND attested=1"
	}
	rows, err := s.db.Query(`SELECT id, content, embedding, branch, author, verifier, attested, ratified, trust, created_at, pending_cosign FROM leaves ` + where)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sc []scoredLeaf
	for rows.Next() {
		l, blob, err := scanLeaf(rows)
		if err != nil {
			return nil, err
		}
		l.Embedding = decodeVec(blob)
		if len(l.Embedding) != len(query) {
			continue // dimension guard
		}
		score := cosine(l.Embedding, query)
		if opts.MinScore > 0 && score < opts.MinScore {
			continue // below the relevance floor — never reaches a worker's prompt
		}
		sc = append(sc, scoredLeaf{leaf: l, score: score})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(sc, func(i, j int) bool {
		if sc[i].score != sc[j].score {
			return sc[i].score > sc[j].score
		}
		return sc[i].leaf.ID < sc[j].leaf.ID // deterministic tie-break
	})
	if k > len(sc) {
		k = len(sc)
	}
	out := make([]Leaf, k)
	for i := 0; i < k; i++ {
		out[i] = sc[i].leaf
		out[i].Score = sc[i].score // read-time annotation; never persisted
	}
	return out, nil
}

// Traverse follows typed edges of edgeType from seedID for hops steps and
// returns the reached leaves in breadth-first discovery order (seed excluded).
// With opts.AttestedOnly it follows only attested edges and returns only
// attested, non-tombstoned leaves — a fully governed walk.
func (s *KMStore) Traverse(seedID, edgeType string, hops int, opts TraverseOpts) ([]Leaf, error) {
	edgeSQL := `SELECT dst FROM edges WHERE src=? AND type=?`
	if opts.AttestedOnly {
		edgeSQL += ` AND attested=1`
	}
	stmt, err := s.db.Prepare(edgeSQL)
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

	// Materialize reached leaves in discovery order, applying the read filter.
	out := make([]Leaf, 0, len(order))
	for _, id := range order {
		if id == seedID {
			continue
		}
		l, ok, err := s.getLeaf(id, opts.AttestedOnly)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, l)
		}
	}
	return out, nil
}

// getLeaf loads one live leaf by id, applying the attested filter when asked.
// ok is false when the leaf is absent, tombstoned, or filtered out.
func (s *KMStore) getLeaf(id string, attestedOnly bool) (Leaf, bool, error) {
	where := "WHERE id=? AND tombstoned=0"
	if attestedOnly {
		where += " AND attested=1"
	}
	rows, err := s.db.Query(`SELECT id, content, embedding, branch, author, verifier, attested, ratified, trust, created_at, pending_cosign FROM leaves `+where, id)
	if err != nil {
		return Leaf{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Leaf{}, false, rows.Err()
	}
	l, blob, err := scanLeaf(rows)
	if err != nil {
		return Leaf{}, false, err
	}
	l.Embedding = decodeVec(blob)
	return l, true, nil
}

// Stats returns a snapshot of the store's contents and governing floor.
func (s *KMStore) Stats() (Stats, error) {
	st := Stats{Path: s.path, TrustFloor: s.trustFloor}
	q := func(sql string, dst *int) error { return s.db.QueryRow(sql).Scan(dst) }
	if err := q(`SELECT COUNT(*) FROM leaves WHERE tombstoned=0`, &st.Leaves); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM leaves WHERE tombstoned=0 AND attested=1`, &st.Attested); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM leaves WHERE tombstoned=0 AND ratified=1`, &st.Ratified); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM leaves WHERE tombstoned=0 AND pending_cosign=1`, &st.PendingCosign); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM leaves WHERE tombstoned=1`, &st.Tombstoned); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM edges`, &st.Edges); err != nil {
		return st, err
	}
	if err := q(`SELECT COUNT(*) FROM quarantine`, &st.Quarantined); err != nil {
		return st, err
	}
	return st, nil
}

// Close releases the database.
func (s *KMStore) Close() error { return s.db.Close() }

// ───────────────────────────── internals ────────────────────────────────────

// execer is satisfied by *sql.Tx (and *sql.DB), so the write helpers work inside
// or outside a transaction.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func insertLeaf(tx execer, id string, l Leaf, blob []byte, attested, pending bool, now int64) error {
	_, err := tx.Exec(
		`INSERT INTO leaves(id, content, embedding, branch, author, verifier, attested, ratified, trust, created_at, tombstoned, pending_cosign)
		 VALUES(?,?,?,?,?,?,?,?,?,?,0,?)`,
		id, l.Content, blob, l.Branch, l.Author, l.Verifier, boolInt(attested), boolInt(l.Ratified), l.TrustScore, now, boolInt(pending),
	)
	return err
}

func overwriteLeaf(tx execer, id string, l Leaf, blob []byte, attested, pending bool, now int64) error {
	_, err := tx.Exec(
		`UPDATE leaves SET content=?, embedding=?, branch=?, author=?, verifier=?, attested=?, ratified=?, trust=?, created_at=?, tombstoned=0, pending_cosign=? WHERE id=?`,
		l.Content, blob, l.Branch, l.Author, l.Verifier, boolInt(attested), boolInt(l.Ratified), l.TrustScore, now, boolInt(pending), id,
	)
	return err
}

// auditWrite appends a refused/quarantined write to the audit trail.
func auditWrite(tx execer, id, kind string, l Leaf, blob []byte, reason string, now int64) error {
	_, err := tx.Exec(
		`INSERT INTO quarantine(id, kind, content, embedding, branch, author, verifier, trust, reason, created_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?)`,
		id, kind, l.Content, blob, l.Branch, l.Author, l.Verifier, l.TrustScore, reason, now,
	)
	return err
}

// auditSupersede archives the prior attested content before it is overwritten.
func auditSupersede(tx execer, id, oldContent string, now int64) error {
	_, err := tx.Exec(
		`INSERT INTO quarantine(id, kind, content, reason, created_at) VALUES(?,?,?,?,?)`,
		id, "supersede", oldContent, "archived: superseded by a newer attested write", now,
	)
	return err
}

// scanLeaf reads a leaf row (embedding returned separately as a raw BLOB so the
// caller decodes once). Column order must match the SELECT lists above.
func scanLeaf(rows *sql.Rows) (Leaf, []byte, error) {
	var (
		l                           Leaf
		blob                        []byte
		attested, ratified, pending int
	)
	if err := rows.Scan(&l.ID, &l.Content, &blob, &l.Branch, &l.Author, &l.Verifier, &attested, &ratified, &l.TrustScore, &l.CreatedAt, &pending); err != nil {
		return Leaf{}, nil, err
	}
	l.Attested = attested == 1
	l.Ratified = ratified == 1
	l.PendingCosign = pending == 1
	return l, blob, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
