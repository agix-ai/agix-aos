// lineage — the bee-trace differentiator: turn a leaf's flat provenance fields
// into a QUERYABLE chain of actors, author → verifier → … → human root, each hop
// tagged with what recorded data grounds it (the leaf's own column, a concrete
// ledger frame, an apiary envelope's lineage, or an honest caste-model
// inference). This is the enterprise SSO / delegation seam (provenance +
// delegation + who-authorized-what) exposed as a Go API.
//
// HONEST LIMITS OF THE CURRENT DATA MODEL (do not fabricate a chain the data
// cannot support):
//
//   - A leaf records exactly TWO grounded actors: Author (who wrote it) and
//     Verifier (who attested it). Those two hops are backed by real columns.
//   - NOTHING on a leaf, and NO ledger frame, records an explicit parent→child
//     edge. agent_start / model_call frames name the actor that acted, not its
//     parent. So the climb from a worker up to its queen and on to the human
//     principal is an INFERENCE from the caste taxonomy (worker → queen/root →
//     human), flagged Gap=true, unless —
//   - an apiary Envelope.Lineage is supplied (TraceActor): that slice is the ONE
//     place a literal parent→…→human-rooted-queen chain is recorded, so those
//     hops become Evidence=EvEnvelope, Gap=false.
//   - The human PRINCIPAL itself is never a recorded actor ref; the human-rooted
//     queen is the terminal recorded actor. A ledger ratify frame naming a
//     non-bee operator lets us resolve a human heuristically; otherwise the
//     terminal hop is an inferred gap.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb

import (
	"strings"
	"time"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
)

// Relation names a hop's role in the provenance chain.
type Relation string

const (
	RelAuthor    Relation = "author"     // wrote the leaf
	RelVerifier  Relation = "verifier"   // vouched for it (actor≠author)
	RelParent    Relation = "parent"     // the actor's governing parent (a queen)
	RelHumanRoot Relation = "human-root" // the human principal the chain terminates at
)

// Evidence names WHAT grounds a hop — how confidently it was reconstructed. It is
// the honesty dial: EvInferred marks a hop the recorded data does not attest.
type Evidence string

const (
	EvLeafField   Evidence = "leaf-field"       // the leaf's own author/verifier column
	EvLedgerFrame Evidence = "ledger-frame"     // a concrete ledger Entry names this actor
	EvEnvelope    Evidence = "envelope-lineage" // an apiary Envelope.Lineage edge
	EvInferred    Evidence = "inferred"         // caste-model inference — NOT recorded anywhere
)

// Hop is one actor in the provenance chain.
type Hop struct {
	Actor       string   `json:"actor"`                 // canonical ref, or "" for an unresolved terminal
	Hive        string   `json:"hive,omitempty"`        // parsed from Actor
	Caste       string   `json:"caste,omitempty"`       // queen | worker | drone
	Role        string   `json:"role,omitempty"`        // designation minus the -<instance> suffix
	Designation string   `json:"designation,omitempty"` // full designation (e.g. "forager-1")
	Relation    Relation `json:"relation"`
	Evidence    Evidence `json:"evidence"`
	Attests     string   `json:"attests,omitempty"` // concrete backing: "leaf:<id>", "frame:<kind>", …
	Note        string   `json:"note,omitempty"`    // honesty note (esp. inferred / gap hops)
	Gap         bool     `json:"gap,omitempty"`     // true when this hop is NOT grounded in recorded data
}

// Trace is the ordered provenance chain for a leaf or actor: author → verifier →
// parent(s) → human root. Gaps lists, in plain language, what the current data
// model could not reconstruct — the SDK is honest about its own blind spots.
type Trace struct {
	LeafID string   `json:"leaf_id,omitempty"`
	Hops   []Hop    `json:"hops"`
	Gaps   []string `json:"gaps,omitempty"`
}

// TraceLeaf reconstructs the provenance chain for a single leaf. Hops 1–2 (author,
// verifier) are grounded in the leaf's own columns; the climb to the human root is
// a caste-model inference (flagged) unless the attached ledger grounds it. Pass a
// leaf straight out of Retrieve / Traverse (they populate Author / Verifier /
// Attested).
func (c *Comb) TraceLeaf(l kmstore.Leaf) Trace {
	frames := c.frames()
	tr := Trace{LeafID: l.ID}

	var climbFrom string

	// Hop 1 — author, grounded in the leaf's own author column.
	if strings.TrimSpace(l.Author) == "" {
		tr.Gaps = append(tr.Gaps, "leaf has no author: the provenance chain has no root actor")
	} else {
		h := actorHop(l.Author, RelAuthor, EvLeafField)
		h.Attests = "leaf:" + l.ID
		corroborate(&h, frames)
		tr.Hops = append(tr.Hops, h)
		climbFrom = l.Author
	}

	// Hop 2 — verifier, the actor≠author attestation. Only present when the leaf
	// actually attested; an un-attested leaf has no second-actor hop, which is
	// itself the point (governed reads refuse it).
	switch {
	case !l.Attested:
		tr.Gaps = append(tr.Gaps, "leaf is un-attested: no verifier hop (no second actor vouched — actor≠verifier gate not satisfied)")
	case strings.TrimSpace(l.Verifier) == "":
		tr.Gaps = append(tr.Gaps, "leaf is flagged attested but carries no verifier (store inconsistency)")
	default:
		h := actorHop(l.Verifier, RelVerifier, EvLeafField)
		h.Attests = "leaf:" + l.ID + " (attested, trust≥floor)"
		corroborate(&h, frames)
		tr.Hops = append(tr.Hops, h)
		if climbFrom == "" {
			climbFrom = l.Verifier
		}
	}

	// Hops 3+ — climb to the human root. No parent edge is recorded on a leaf, so
	// this is an inference from the caste taxonomy unless the ledger grounds it.
	c.climbToHuman(&tr, climbFrom, frames)
	return tr
}

// TraceActor reconstructs a chain from an actor and, when supplied, an apiary
// Envelope.Lineage — the ONE recorded parent→…→human-rooted-queen chain in the
// model (index 0 = the subject actor, last = the human-rooted queen). With a
// lineage the intermediate hops are Evidence=EvEnvelope (grounded); without one,
// only the subject actor is grounded and the parent/human chain is left as a
// declared gap rather than fabricated.
func (c *Comb) TraceActor(actor string, lineage []string) Trace {
	frames := c.frames()
	tr := Trace{}

	chain := lineage
	if len(chain) == 0 {
		chain = []string{actor}
	}

	for i, a := range chain {
		rel := RelParent
		ev := EvEnvelope
		switch {
		case i == 0:
			rel = RelAuthor
			if len(lineage) == 0 {
				ev = EvLeafField // just the subject actor, no recorded chain around it
			}
		case i == len(chain)-1:
			rel = RelHumanRoot
		}
		h := actorHop(a, rel, ev)
		if rel == RelHumanRoot {
			h.Note = "terminal recorded actor is the human-ROOTED queen; the human principal itself is not a recorded actor ref"
		}
		corroborate(&h, frames)
		tr.Hops = append(tr.Hops, h)
	}

	if len(lineage) == 0 {
		tr.Gaps = append(tr.Gaps, "no apiary lineage supplied: only the subject actor is grounded — the parent→human chain was not reconstructed")
	} else {
		tr.Gaps = append(tr.Gaps, "human principal is not a recorded actor ref; the human-rooted queen (last hop) is the terminal recorded actor")
	}
	return tr
}

// climbToHuman appends the inferred parent-queen and human-root hops, grounding
// them from the ledger where it can and flagging them as gaps where it cannot.
func (c *Comb) climbToHuman(tr *Trace, fromActor string, frames []ledger.Entry) {
	hive, cst, _, ok := apiary.ParseActorRef(fromActor)
	if !ok {
		tr.Gaps = append(tr.Gaps, "cannot climb to the human root: no parseable actor to climb from")
		return
	}

	// A worker or drone's governing parent is the hive queen. This edge is NOT
	// recorded anywhere — it is inferred from the caste taxonomy.
	if cst == string(caste.Worker) || cst == string(caste.Drone) {
		q := apiary.ActorRef(hive, string(caste.Queen), "root")
		h := actorHop(q, RelParent, EvInferred)
		h.Gap = true
		h.Note = "parent queen INFERRED from the caste taxonomy — no leaf field or ledger frame records an explicit parent→child edge"
		corroborate(&h, frames) // a matching queen actor in the ledger sharpens the note
		tr.Hops = append(tr.Hops, h)
	}

	// The human principal. Try to resolve one heuristically from a ratify frame;
	// otherwise terminate at an inferred, gap-flagged human root.
	hr := Hop{
		Relation: RelHumanRoot,
		Evidence: EvInferred,
		Gap:      true,
		Note:     "human principal is not a recorded actor ref; the human-rooted queen is the terminal recorded actor. Pass an apiary Envelope.Lineage to TraceActor to ground this hop.",
	}
	if human := humanFromLedger(frames); human != "" {
		hr.Actor = human
		hr.Evidence = EvLedgerFrame
		hr.Gap = false
		hr.Attests = "frame:" + ledger.KindRatify
		hr.Note = "human principal resolved (heuristically) from a ledger ratify frame's non-bee operator"
	}
	tr.Hops = append(tr.Hops, hr)
	if hr.Gap {
		tr.Gaps = append(tr.Gaps, "human principal not grounded in recorded data (inferred terminal hop)")
	}
}

// actorHop parses an actor ref into a partially-filled Hop. An unparseable ref
// still yields a hop (so the chain is not silently truncated) marked as a gap.
func actorHop(actor string, rel Relation, ev Evidence) Hop {
	h := Hop{Actor: actor, Relation: rel, Evidence: ev}
	hive, cst, desg, ok := apiary.ParseActorRef(actor)
	if !ok {
		h.Gap = true
		h.Note = "actor ref is not a well-formed <hive>/<caste>/<designation>"
		return h
	}
	h.Hive, h.Caste, h.Designation = hive, cst, desg
	h.Role = roleOf(desg)
	return h
}

// roleOf strips a trailing "-<instance>" from a designation ("forager-1" →
// "forager"), matching caste.Actor's "<role>-<instance>" convention.
func roleOf(desg string) string {
	if i := strings.LastIndexByte(desg, '-'); i > 0 && allDigits(desg[i+1:]) {
		return desg[:i]
	}
	return desg
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// frames reads the whole ledger once (empty when no ledger is attached). Callers
// pass the slice down so a multi-hop trace scans the ledger a single time.
func (c *Comb) frames() []ledger.Entry {
	if c == nil || c.led == nil {
		return nil
	}
	fr, err := c.led.Read("", time.Time{})
	if err != nil {
		return nil
	}
	return fr
}

// corroborate looks for a ledger frame whose Agent is this hop's actor and, if
// found, annotates the hop with the frame that proves the actor was active. It
// never invents a parent edge — it only strengthens a hop already reconstructed.
func corroborate(h *Hop, frames []ledger.Entry) {
	if h.Actor == "" {
		return
	}
	for _, f := range frames {
		if f.Agent != h.Actor {
			continue
		}
		mark := "frame:" + f.Kind + "@" + f.TS.UTC().Format(time.RFC3339)
		if h.Attests == "" {
			h.Attests = mark
		} else {
			h.Attests += ", " + mark
		}
		note := "corroborated by ledger " + f.Kind + " frame"
		if h.Note == "" {
			h.Note = note
		} else {
			h.Note += "; " + note
		}
		return
	}
}

// humanFromLedger heuristically resolves the human principal from a ratify
// frame's operator: the first ratify frame whose "by" (or Agent) is a non-empty,
// non-reserved string that does NOT parse as a bee actor ref. It is deliberately
// conservative — "verifier"/"queen"/"worker"/"drone" and any parseable bee actor
// are rejected — and returns "" when no such operator is recorded.
func humanFromLedger(frames []ledger.Entry) string {
	reserved := map[string]bool{"": true, "verifier": true, "queen": true, "worker": true, "drone": true}
	for _, f := range frames {
		if f.Kind != ledger.KindRatify {
			continue
		}
		cand, _ := f.Data["by"].(string)
		cand = strings.TrimSpace(cand)
		if reserved[cand] {
			cand = strings.TrimSpace(f.Agent)
		}
		if reserved[cand] {
			continue
		}
		if _, _, _, ok := apiary.ParseActorRef(cand); ok {
			continue // a bee actor, not a human
		}
		return cand
	}
	return ""
}
