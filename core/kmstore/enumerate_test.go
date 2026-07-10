// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import (
	"path/filepath"
	"testing"
)

func TestLeaves_FilterByBranchAndAttested(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.RegisterVerifier("agix/worker/verifier-1")

	put := func(id, content, branch, verifier string, trust float64) {
		t.Helper()
		if _, err := st.Put(Leaf{
			ID:         id,
			Content:    content,
			Branch:     branch,
			Author:     "agix/worker/surgeon-1",
			Verifier:   verifier,
			TrustScore: trust,
			Embedding:  HashEmbed(content, 64),
		}); err != nil {
			t.Fatal(err)
		}
	}
	put("s1", "extract class from a God object", "software", "agix/worker/verifier-1", 0.9) // attested / software
	put("s2", "split a large class", "software", "agix/worker/verifier-1", 0.9)             // attested / software
	put("b1", "business capability map", "business", "agix/worker/verifier-1", 0.9)         // attested / business
	put("u1", "an unvouched claim", "software", "", 0)                                      // un-attested

	all, err := st.Leaves(LeafFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("all live leaves = %d, want 4", len(all))
	}

	attSoftware, err := st.Leaves(LeafFilter{Branch: "software", AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(attSoftware) != 2 {
		t.Fatalf("attested software leaves = %d, want 2", len(attSoftware))
	}
	for _, l := range attSoftware {
		if l.Branch != "software" {
			t.Errorf("leaf %s branch = %q, want software", l.ID, l.Branch)
		}
		if !l.Attested {
			t.Errorf("leaf %s should be attested", l.ID)
		}
		if len(l.Embedding) == 0 {
			t.Errorf("leaf %s embedding was not decoded", l.ID)
		}
	}

	attAll, err := st.Leaves(LeafFilter{AttestedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(attAll) != 3 {
		t.Fatalf("attested leaves (all branches) = %d, want 3", len(attAll))
	}
}
