// Enumeration over the store. Retrieve is cosine top-k; Leaves is the full
// governed scan the distillation corpus-export needs — "give me every certified
// leaf on this branch", not "the k most similar to a query".
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

// LeafFilter selects which live leaves Leaves returns. The zero value enumerates
// every live (non-tombstoned) leaf.
type LeafFilter struct {
	// Branch, when non-empty, restricts to leaves on that TOGAF branch.
	Branch string
	// AttestedOnly, when true, restricts to verifier-attested leaves — the
	// governed corpus (the same attested=1 predicate Retrieve uses).
	AttestedOnly bool
}

// Leaves enumerates all live leaves matching opts, embeddings decoded. It is a
// full-table scan (no ranking, no k cutoff) modeled on Retrieve's scan loop:
// tombstoned rows are always excluded; attested/branch filters are applied in SQL.
// Like the other reads it does not take s.mu (that guards only the verifier
// roster); SQLite WAL handles read concurrency.
func (s *KMStore) Leaves(opts LeafFilter) ([]Leaf, error) {
	where := "WHERE tombstoned=0"
	var args []any
	if opts.AttestedOnly {
		where += " AND attested=1"
	}
	if opts.Branch != "" {
		where += " AND branch=?"
		args = append(args, opts.Branch)
	}
	// Column list MUST match scanLeaf's Scan order.
	rows, err := s.db.Query(
		`SELECT id, content, embedding, branch, author, verifier, attested, ratified, trust, created_at, pending_cosign FROM leaves `+where,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Leaf
	for rows.Next() {
		l, blob, err := scanLeaf(rows)
		if err != nil {
			return nil, err
		}
		l.Embedding = decodeVec(blob)
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
