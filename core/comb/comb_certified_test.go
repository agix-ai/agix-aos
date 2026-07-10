// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb_test

import (
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/comb"
	"github.com/agix-ai/agix/core/kmstore"
)

func TestCertifiedLeaves(t *testing.T) {
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.RegisterVerifier("agix/worker/verifier-1")
	c := comb.New(st)

	mustPut := func(n comb.Note) {
		t.Helper()
		if _, err := c.Put(n); err != nil {
			t.Fatal(err)
		}
	}
	mustPut(comb.Note{Content: "extracted BillingCalculator from Invoice", Branch: "software", Author: "agix/worker/surgeon-1", Verifier: "agix/worker/verifier-1", Trust: 0.9})
	mustPut(comb.Note{Content: "split the God controller", Branch: "software", Author: "agix/worker/surgeon-1", Verifier: "agix/worker/verifier-1", Trust: 0.9})
	mustPut(comb.Note{Content: "a business capability", Branch: "business", Author: "agix/worker/surgeon-1", Verifier: "agix/worker/verifier-1", Trust: 0.9})
	mustPut(comb.Note{Content: "an unvouched refactoring claim", Branch: "software", Author: "agix/worker/surgeon-1"}) // un-attested

	sw, err := c.CertifiedLeaves("software")
	if err != nil {
		t.Fatal(err)
	}
	if len(sw) != 2 {
		t.Fatalf("certified software leaves = %d, want 2 (un-attested excluded)", len(sw))
	}

	all, err := c.CertifiedLeaves("")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("all certified leaves = %d, want 3", len(all))
	}
}
