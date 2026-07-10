// Tests for the Comb SDK — all $0/offline: a temp file-backed kmstore, no
// network, no keys. They exercise the governed write/read path, the lineage
// walk's grounded + inferred hops, and the self-contained HTML emitter.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/comb"
	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
)

// actor refs used across the tests.
var (
	forager  = caste.Actor("agix", caste.Worker, "forager", 1)  // agix/worker/forager-1
	verifier = caste.Actor("agix", caste.Worker, "verifier", 1) // agix/worker/verifier-1
	queen    = apiary.ActorRef("agix", "queen", "root")         // agix/queen/root
)

// newComb opens a temp store with the verifier on the roster and returns a Comb.
func newComb(t *testing.T, opts ...comb.Option) *comb.Comb {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	st.RegisterVerifier(verifier)
	return comb.New(st, opts...)
}

// Put + Attest + Link + Retrieve: attested leaves come back, un-attested are
// excluded from the governed read by default, Attest raises an un-attested leaf,
// and an attested edge is traversable.
func TestPutAttestLinkRetrieve(t *testing.T) {
	c := newComb(t)

	att, err := c.Put(comb.Note{
		Content: "bees forage nectar from flowers", Author: forager, Verifier: verifier, Trust: 0.9,
	})
	if err != nil {
		t.Fatalf("put attested: %v", err)
	}
	if !att.Attested {
		t.Fatalf("expected attested leaf, got reason: %s", att.Reason)
	}

	un, err := c.Put(comb.Note{Content: "drones guard the hive boundary", Author: forager})
	if err != nil {
		t.Fatalf("put un-attested: %v", err)
	}
	if un.Attested {
		t.Fatalf("expected un-attested leaf (no verifier), got attested")
	}

	// Governed read returns ONLY the attested leaf; the un-attested one is refused.
	gov, err := c.Retrieve("nectar flowers", 10)
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if len(gov) != 1 {
		t.Fatalf("governed retrieve: want 1 attested leaf, got %d", len(gov))
	}
	if gov[0].ID != att.ID {
		t.Fatalf("governed retrieve returned %q, want %q", gov[0].ID, att.ID)
	}

	// Un-governed read sees both.
	all, err := c.RetrieveAll("hive", 10)
	if err != nil {
		t.Fatalf("retrieve all: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("un-governed retrieve: want 2 leaves, got %d", len(all))
	}

	// Attest raises the un-attested leaf via the idempotent-refresh path.
	raised, err := c.Attest(comb.Note{
		Content: "drones guard the hive boundary", Author: forager, Verifier: verifier, Trust: 0.9,
	})
	if err != nil {
		t.Fatalf("attest: %v", err)
	}
	if !raised.Attested {
		t.Fatalf("expected Attest to raise the leaf, got reason: %s", raised.Reason)
	}
	if raised.ID != un.ID {
		t.Fatalf("Attest wrote a different leaf: %q vs %q", raised.ID, un.ID)
	}
	if gov, _ := c.Retrieve("hive", 10); len(gov) != 2 {
		t.Fatalf("after Attest: want 2 attested leaves, got %d", len(gov))
	}

	// An attested edge is traversable under the governed walk.
	if err := c.Link(att.ID, "relates", raised.ID, kmstore.Provenance{
		Author: forager, Verifier: verifier, TrustScore: 0.9,
	}); err != nil {
		t.Fatalf("link: %v", err)
	}
	reached, err := c.Traverse(att.ID, "relates", 1)
	if err != nil {
		t.Fatalf("traverse: %v", err)
	}
	if len(reached) != 1 || reached[0].ID != raised.ID {
		t.Fatalf("traverse: want [%s], got %+v", raised.ID, reached)
	}
}

// The lineage walk on a worker-authored, distinct-verifier-attested leaf returns
// the ordered chain author → verifier → parent(queen) → human-root, with the
// grounded hops backed by leaf fields and the climb flagged as inferred.
func TestTraceLeafChain(t *testing.T) {
	c := newComb(t)
	res, err := c.Put(comb.Note{
		Content: "the queen mates once and stores sperm for life", Author: forager, Verifier: verifier, Trust: 0.9,
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := c.Retrieve("queen mates", 1)
	if err != nil || len(got) != 1 {
		t.Fatalf("retrieve leaf to trace: err=%v n=%d", err, len(got))
	}
	tr := c.TraceLeaf(got[0])

	if tr.LeafID != res.ID {
		t.Errorf("trace leaf id = %q, want %q", tr.LeafID, res.ID)
	}
	if len(tr.Hops) != 4 {
		t.Fatalf("want 4 hops (author, verifier, parent, human-root), got %d: %+v", len(tr.Hops), tr.Hops)
	}

	// Hop 0 — author, grounded in the leaf field.
	if h := tr.Hops[0]; h.Relation != comb.RelAuthor || h.Caste != "worker" || h.Role != "forager" {
		t.Errorf("author hop = %+v, want author/worker/forager", h)
	} else if h.Evidence != comb.EvLeafField || h.Gap {
		t.Errorf("author hop should be grounded leaf-field, got evidence=%q gap=%v", h.Evidence, h.Gap)
	}
	// Hop 1 — verifier, a DISTINCT worker.
	if h := tr.Hops[1]; h.Relation != comb.RelVerifier || h.Caste != "worker" || h.Role != "verifier" {
		t.Errorf("verifier hop = %+v, want verifier/worker/verifier", h)
	} else if h.Actor == tr.Hops[0].Actor {
		t.Errorf("verifier must differ from author (actor≠verifier), both = %q", h.Actor)
	}
	// Hop 2 — parent queen, INFERRED from the caste model (an honest gap).
	if h := tr.Hops[2]; h.Relation != comb.RelParent || h.Caste != "queen" {
		t.Errorf("parent hop = %+v, want parent/queen", h)
	} else if h.Evidence != comb.EvInferred || !h.Gap {
		t.Errorf("parent hop should be an inferred gap, got evidence=%q gap=%v", h.Evidence, h.Gap)
	}
	// Hop 3 — terminal human root.
	if h := tr.Hops[3]; h.Relation != comb.RelHumanRoot {
		t.Errorf("terminal hop = %+v, want human-root", h)
	}
	if len(tr.Gaps) == 0 {
		t.Errorf("expected the trace to declare gaps (uninferred human root), got none")
	}
}

// With a ledger attached, hops are corroborated by concrete frames and the human
// principal is resolved from a ratify frame's non-bee operator.
func TestTraceLeafLedgerEnrichment(t *testing.T) {
	led, err := ledger.Open(filepath.Join(t.TempDir(), "audit.jsonl"))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	// The forager actually ran (agent_start) and a human ratified (ratify by=…).
	_ = led.Append(ledger.Entry{Kind: ledger.KindAgentStart, Agent: forager, Data: map[string]any{"task": "forage"}})
	_ = led.Append(ledger.Entry{Kind: ledger.KindRatify, Agent: "operator", Data: map[string]any{"by": "operator", "approved": true}})

	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	st.RegisterVerifier(verifier)
	c := comb.New(st, comb.WithLedger(led))

	res, _ := c.Put(comb.Note{Content: "workers waggle-dance to signal distance", Author: forager, Verifier: verifier, Trust: 0.8})
	got, _ := c.Retrieve("waggle dance", 1)
	if len(got) != 1 {
		t.Fatalf("retrieve: got %d", len(got))
	}
	tr := c.TraceLeaf(got[0])

	if !strings.Contains(tr.Hops[0].Attests, ledger.KindAgentStart) {
		t.Errorf("author hop should be corroborated by the agent_start frame, attests=%q", tr.Hops[0].Attests)
	}
	last := tr.Hops[len(tr.Hops)-1]
	if last.Relation != comb.RelHumanRoot || last.Actor != "operator" {
		t.Errorf("human root should resolve to 'operator', got %+v", last)
	}
	if last.Evidence != comb.EvLedgerFrame || last.Gap {
		t.Errorf("resolved human root should be ledger-grounded, got evidence=%q gap=%v", last.Evidence, last.Gap)
	}
	_ = res
}

// With an apiary Envelope.Lineage, the parent→human chain is RECORDED, so the
// hops are envelope-grounded rather than inferred.
func TestTraceActorEnvelopeLineage(t *testing.T) {
	c := newComb(t)
	tr := c.TraceActor(forager, []string{forager, queen})
	if len(tr.Hops) != 2 {
		t.Fatalf("want 2 hops from the lineage, got %d", len(tr.Hops))
	}
	if h := tr.Hops[0]; h.Relation != comb.RelAuthor || h.Evidence != comb.EvEnvelope || h.Caste != "worker" {
		t.Errorf("subject hop = %+v, want author/envelope/worker", h)
	}
	if h := tr.Hops[1]; h.Relation != comb.RelHumanRoot || h.Evidence != comb.EvEnvelope || h.Caste != "queen" || h.Gap {
		t.Errorf("terminal hop = %+v, want grounded human-root/envelope/queen", h)
	}
}

// RenderHTML produces a non-empty, self-contained document: it carries the node
// content and provenance state, and references no external asset.
func TestRenderHTMLSelfContained(t *testing.T) {
	c := newComb(t)
	a, _ := c.Put(comb.Note{Content: "bees forage nectar from flowers", Author: forager, Verifier: verifier, Trust: 0.9})
	b, _ := c.Put(comb.Note{Content: "an unvouched claim about the hive", Author: forager}) // un-attested
	leaves, _ := c.RetrieveAll("hive", 10)
	tr := c.TraceActor(forager, []string{forager, queen})

	htmlStr, err := c.RenderHTMLString(comb.RenderOpts{
		Title:  "Test Comb",
		Leaves: leaves,
		Edges:  []comb.RenderEdge{{Src: a.ID, Type: "relates", Dst: b.ID, Attested: true}},
		Traces: []comb.Trace{tr},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(htmlStr) == 0 {
		t.Fatal("rendered HTML is empty")
	}
	for _, want := range []string{"<!DOCTYPE html>", "Test Comb", "bees forage nectar from flowers", "attested", "unattested"} {
		if !strings.Contains(htmlStr, want) {
			t.Errorf("rendered HTML missing %q", want)
		}
	}
	// Self-contained: no external asset references.
	for _, bad := range []string{"http://", "https://", "//cdn", "src=\"//", "@import"} {
		if strings.Contains(htmlStr, bad) {
			t.Errorf("rendered HTML is NOT self-contained: contains %q", bad)
		}
	}
}
