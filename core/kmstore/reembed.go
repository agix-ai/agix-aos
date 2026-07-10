// reembed — the in-place embedding MIGRATION for the production KM store. The
// store's vectors are only useful when every row and every query share one
// embedder: Retrieve's dimension guard silently skips any candidate whose
// stored dimension differs from the query's, so a fleet that switches embedders
// (e.g. hash-64 → nomic-768 via AGIX_EMBED) instantly renders every previously
// written leaf invisible — no error, no hit, just an empty Comb. ReembedAll is
// the corrective: re-derive every stored vector from its OWN content with the
// new embedder, in one transaction, touching NOTHING but the embedding BLOB.
//
// Scope (deliberate):
//
//   - BOTH tables move together: live leaves AND the quarantine audit trail, so
//     the whole store stays dimension-uniform and an audit row remains
//     comparable to the corpus it was refused from.
//   - Tombstoned leaves are re-embedded too — harmless (they are never
//     retrieved) and it keeps the "one store, one dimension" invariant with no
//     carve-outs.
//   - Quarantine rows archived WITHOUT a vector (a supersede archives content
//     only, embedding NULL) are left NULL: they never carried a vector, and
//     fabricating one would alter what the audit trail attests to.
//   - Provenance is sacrosanct: attested/ratified/trust/author/verifier/
//     created_at/tombstoned/pending_cosign are not touched. A migration must
//     never be able to launder an un-attested leaf.
//   - All or nothing: a single transaction wraps every update; if the embedder
//     fails mid-way (a network embedder can), the whole migration rolls back
//     and the store is byte-identical to before — never a half-migrated,
//     mixed-dimension corpus.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"database/sql"
	"fmt"
	"sort"
)

// ReembedReport summarizes a migration (or, for ReembedPlan, what one WOULD
// do). Counts are rows whose embedding BLOB was (or would be) rewritten; rows
// with a NULL embedding (vector-less audit entries) are excluded.
type ReembedReport struct {
	LeavesUpdated     int    `json:"leaves_updated"`     // leaves rows rewritten (incl. tombstoned)
	QuarantineUpdated int    `json:"quarantine_updated"` // audit-trail rows rewritten (NULL-embedding rows skipped)
	OldDims           []int  `json:"old_dims"`           // distinct stored dimensions seen, ascending
	NewDim            int    `json:"new_dim"`            // the embedder's output dimension
	Embedder          string `json:"embedder"`           // the embedder that produced the new vectors
	DryRun            bool   `json:"dry_run,omitempty"`  // true ⇒ nothing was written
}

// ReembedAll re-embeds the content of EVERY row in leaves and quarantine with e
// and rewrites the embedding BLOB in place, inside one transaction. Only the
// embedding column changes — content, provenance bits, trust, and timestamps
// are preserved exactly. An Embed failure mid-way rolls the entire migration
// back. Run it whenever the fleet's AGIX_EMBED changes, or the store's history
// becomes unreachable to new queries (see the package comment).
func (s *KMStore) ReembedAll(e Embedder) (ReembedReport, error) {
	return s.reembed(e, false)
}

// ReembedPlan is the dry run: it reports what ReembedAll(e) would change — row
// counts per table and the distinct stored dimensions — without embedding or
// writing anything. Both tables are read in one transaction so the plan is a
// consistent snapshot.
func (s *KMStore) ReembedPlan(e Embedder) (ReembedReport, error) {
	return s.reembed(e, true)
}

// reembedRow is one migratable row: its rowid (the update key — quarantine ids
// are not unique, so the SQLite rowid is the only safe handle for both tables),
// the content to re-embed, and the current BLOB (nil ⇔ stored NULL).
type reembedRow struct {
	rowid   int64
	content string
	blob    []byte
}

// reembed is the shared engine behind ReembedAll (dryRun=false) and
// ReembedPlan (dryRun=true). Rows are slurped into memory before any update —
// the tx owns a single connection, so interleaving an Exec with an open Rows
// would wedge — which is fine at KM-store scale (thousands of leaves).
func (s *KMStore) reembed(e Embedder, dryRun bool) (ReembedReport, error) {
	rep := ReembedReport{NewDim: e.Dim(), Embedder: e.Name(), DryRun: dryRun}

	tx, err := s.db.Begin()
	if err != nil {
		return ReembedReport{}, err
	}
	defer tx.Rollback() // no-op after Commit; the all-or-nothing guarantee otherwise

	dims := map[int]struct{}{}
	for _, table := range []string{"leaves", "quarantine"} {
		rows, err := loadReembedRows(tx, table)
		if err != nil {
			return ReembedReport{}, fmt.Errorf("kmstore: reembed read %s: %w", table, err)
		}
		updated := 0
		for _, r := range rows {
			if r.blob == nil {
				continue // vector-less audit entry (e.g. a supersede archive) — leave NULL
			}
			dims[len(r.blob)/4] = struct{}{}
			updated++
			if dryRun {
				continue
			}
			v, err := e.Embed(r.content)
			if err != nil {
				// Rolls back via the deferred Rollback — the store is untouched.
				return ReembedReport{}, fmt.Errorf("kmstore: reembed %s rowid=%d via %s: %w (migration rolled back)", table, r.rowid, e.Name(), err)
			}
			if _, err := tx.Exec(`UPDATE `+table+` SET embedding=? WHERE rowid=?`, encodeVec(v), r.rowid); err != nil {
				return ReembedReport{}, fmt.Errorf("kmstore: reembed update %s rowid=%d: %w", table, r.rowid, err)
			}
		}
		switch table {
		case "leaves":
			rep.LeavesUpdated = updated
		case "quarantine":
			rep.QuarantineUpdated = updated
		}
	}

	rep.OldDims = make([]int, 0, len(dims))
	for d := range dims {
		rep.OldDims = append(rep.OldDims, d)
	}
	sort.Ints(rep.OldDims)

	if dryRun {
		return rep, nil // deferred Rollback discards the read-only tx
	}
	if err := tx.Commit(); err != nil {
		return ReembedReport{}, err
	}
	return rep, nil
}

// loadReembedRows reads every row of table (rowid, content, embedding) into
// memory. content is NULL-tolerant (quarantine allows it); a NULL embedding
// scans to a nil blob, which the caller uses to skip vector-less rows.
func loadReembedRows(tx *sql.Tx, table string) ([]reembedRow, error) {
	rows, err := tx.Query(`SELECT rowid, content, embedding FROM ` + table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []reembedRow
	for rows.Next() {
		var (
			r       reembedRow
			content sql.NullString
		)
		if err := rows.Scan(&r.rowid, &content, &r.blob); err != nil {
			return nil, err
		}
		r.content = content.String
		out = append(out, r)
	}
	return out, rows.Err()
}
