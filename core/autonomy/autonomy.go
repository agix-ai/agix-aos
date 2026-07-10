// Package autonomy is the earned-autonomy gate — the net-new primitive the
// OSS-steward fleet needs and the one piece the reborn core did not already have.
//
// The fleet's workers PROPOSE; a single drone (core/caste: the only caste allowed
// to cross a hive boundary) is the one that could ACT on the outside world (label
// an issue, comment on a PR, merge a green dependency bump). The question this
// package answers is NOT "can the drone technically run `gh`" — core/tool/exec
// already governs that via an allowlist + a brokered token. It is "has the fleet
// EARNED the right to act, rather than merely propose, on THIS kind of action?"
//
// The model is an Autonomy Ladder, per Domain, fail-safe:
//
//	Shadow (0)  — write a proposal to a file only; take NO host action.
//	Propose (1) — open a PR / post a draft; a human still presses the button.
//	Act (2)     — perform the write directly.
//
// Every domain STARTS at Shadow: nothing acts on day one. A rung is earned by a
// run of accepted outcomes (the human kept the shadow/propose output), and LOST
// immediately on a rejected one (revocable demotion). Hysteresis makes climbing
// back after a demotion strictly harder than the first climb, so a domain that
// keeps getting it wrong does not oscillate at the boundary.
//
// The rung is meant to DRIVE the drone's exec allowlist: at Shadow the drone's
// write-`gh` prefixes are simply absent (it writes a file), and only the specific
// subcommand a domain needs becomes live once that domain reaches Act. So autonomy
// is ultimately enforced by the same fail-closed allowlist core/tool/exec already
// honors — this package decides the rung; the exec boundary enforces it.
//
// It is a pure, stdlib-only leaf (mirrors core/coord): an interface, a working
// in-process MemLedger, and a persistence seam. The Ladder policy is a pure
// function so promotion/demotion is exhaustively testable without any I/O.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package autonomy

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Rung is a level on the Autonomy Ladder. It is ordered: a higher rung subsumes
// the authority of every lower one (Act implies you may also Propose or Shadow).
type Rung int

const (
	// Shadow writes a proposal to a file only and takes no host action. The safe
	// default for every domain.
	Shadow Rung = iota
	// Propose may open a PR or post a draft; a human still presses the button.
	Propose
	// Act may perform the write directly.
	Act
)

// String renders a rung as its lowercase name (for ledgers, CLIs, and logs).
func (r Rung) String() string {
	switch r {
	case Shadow:
		return "shadow"
	case Propose:
		return "propose"
	case Act:
		return "act"
	default:
		return fmt.Sprintf("rung(%d)", int(r))
	}
}

// ParseRung is the inverse of String. An unknown value is an error, not a silent
// default — a misconfigured rung must fail loud.
func ParseRung(s string) (Rung, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "shadow", "0":
		return Shadow, nil
	case "propose", "1":
		return Propose, nil
	case "act", "2":
		return Act, nil
	default:
		return Shadow, fmt.Errorf("autonomy: unknown rung %q (want shadow|propose|act)", s)
	}
}

// Domain is a unit that autonomy is earned per — coarse enough to reason about,
// fine enough that a cheap safe action ("issue-label") is never blocked behind a
// dangerous one ("release"). Domains are free-form strings the fleet agrees on;
// the canonical seed set is documented in the pack spec.
type Domain string

// State is the earned autonomy for one domain plus the evidence that moved it.
// It is a value type: the Ladder computes a NEW State from an old one, never
// mutating in place, so a caller can reason about the transition.
type State struct {
	Domain    Domain    `json:"domain"`
	Rung      Rung      `json:"rung"`
	Streak    int       `json:"streak"`    // consecutive accepted outcomes at the current rung
	Demotions int       `json:"demotions"` // lifetime demotions (drives hysteresis)
	UpdatedAt time.Time `json:"updatedAt"`
}

// Allows reports whether an action that requires rung `want` is permitted by this
// earned state. This is the gate the drone calls before every would-be write.
func (s State) Allows(want Rung) bool { return s.Rung >= want }

// Ladder is the promotion/demotion POLICY — pure, no state, no I/O. It is safe to
// share one Ladder across all domains and ledgers.
type Ladder struct {
	// Promote is the base count of consecutive accepted outcomes needed to climb
	// one rung. <=0 uses DefaultPromote.
	Promote int
	// Hysteresis is the EXTRA accepted outcomes required per prior demotion, so
	// re-earning a rung after a bad run is strictly harder. <=0 uses DefaultHysteresis.
	Hysteresis int
	// Max is the ceiling a domain may ever reach. The zero value means Act.
	Max Rung
}

// Ladder defaults — conservative on purpose. Five clean outcomes to climb, and
// each demotion adds three to the next climb.
const (
	DefaultPromote    = 5
	DefaultHysteresis = 3
)

// threshold is the accepted-streak needed to climb the NEXT rung given prior
// demotions: base + hysteresis*demotions.
func (l Ladder) threshold(demotions int) int {
	p := l.Promote
	if p <= 0 {
		p = DefaultPromote
	}
	h := l.Hysteresis
	if h <= 0 {
		h = DefaultHysteresis
	}
	return p + h*demotions
}

func (l Ladder) max() Rung {
	if l.Max == 0 {
		return Act
	}
	return l.Max
}

// Observe applies one outcome to a domain's state and returns the new state.
//
//   - accepted=true  → streak++. On reaching the threshold (and below Max), climb
//     one rung and reset the streak.
//   - accepted=false → immediate revocable demotion: drop one rung (never below
//     Shadow), record a demotion (raising the next threshold via hysteresis), and
//     reset the streak. A rejection at Shadow simply resets the streak.
//
// It is a pure function of (state, outcome, now): the same inputs always yield the
// same output, which is what makes the ladder exhaustively testable.
func (l Ladder) Observe(s State, accepted bool, now time.Time) State {
	s.UpdatedAt = now
	if accepted {
		s.Streak++
		if s.Rung < l.max() && s.Streak >= l.threshold(s.Demotions) {
			s.Rung++
			s.Streak = 0
		}
		return s
	}
	// Rejected: demote if we can, and remember it.
	if s.Rung > Shadow {
		s.Rung--
		s.Demotions++
	}
	s.Streak = 0
	return s
}

// Ledger records earned autonomy per domain and applies the Ladder on each
// observed outcome. Implementations must be safe for concurrent use.
type Ledger interface {
	// Rung returns the current earned state for a domain (a fresh domain starts at
	// Shadow with a zero streak).
	Rung(ctx context.Context, domain Domain) (State, error)
	// Observe applies one accepted/rejected outcome, persists it, and returns the
	// resulting state.
	Observe(ctx context.Context, domain Domain, accepted bool) (State, error)
	// Allowed is the gate: may an action requiring `want` proceed for this domain?
	Allowed(ctx context.Context, domain Domain, want Rung) (bool, error)
	// Snapshot returns every domain's state in stable domain order (for the CLI/audit).
	Snapshot(ctx context.Context) ([]State, error)
}

// Sink receives one record per applied outcome — the append-only audit/persistence
// hook, injected exactly like core/secrets' AuditFunc so the drone can wire it to
// governance/tenants/agix/autonomy.jsonl without this package importing the ledger.
// It is handed the resulting State and the outcome that produced it, never a secret.
type Sink func(s State, accepted bool)

// MemLedger is the working in-process Ledger. It is real and testable; a process
// that wants durability across runs supplies a Sink that appends to the JSONL file
// and seeds the map from it on start (see the seam note below).
type MemLedger struct {
	mu     sync.Mutex
	ladder Ladder
	states map[Domain]State
	sink   Sink
	clock  func() time.Time
}

// NewMemLedger builds a ledger with the given policy and optional audit/persistence
// sink. A zero-value Ladder uses the conservative defaults.
func NewMemLedger(ladder Ladder, sink Sink) *MemLedger {
	return &MemLedger{
		ladder: ladder,
		states: make(map[Domain]State),
		sink:   sink,
		clock:  time.Now,
	}
}

// Seed installs known states (e.g. loaded from the JSONL file at startup) without
// emitting outcomes. It overwrites any existing in-memory state for those domains.
func (m *MemLedger) Seed(states ...State) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range states {
		if s.Domain == "" {
			continue
		}
		m.states[s.Domain] = s
	}
}

func (m *MemLedger) get(domain Domain) State {
	if s, ok := m.states[domain]; ok {
		return s
	}
	return State{Domain: domain, Rung: Shadow}
}

// Rung returns the current state for a domain.
func (m *MemLedger) Rung(_ context.Context, domain Domain) (State, error) {
	if domain == "" {
		return State{}, ErrNoDomain
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(domain), nil
}

// Observe applies one outcome under the Ladder, persists via the Sink, and returns
// the new state.
func (m *MemLedger) Observe(_ context.Context, domain Domain, accepted bool) (State, error) {
	if domain == "" {
		return State{}, ErrNoDomain
	}
	m.mu.Lock()
	next := m.ladder.Observe(m.get(domain), accepted, m.clock())
	m.states[domain] = next
	sink := m.sink
	m.mu.Unlock()
	if sink != nil {
		sink(next, accepted)
	}
	return next, nil
}

// Allowed is the gate. A fresh/unknown domain is at Shadow, so anything above
// Shadow is denied until earned — deny-by-default, the safe direction.
func (m *MemLedger) Allowed(_ context.Context, domain Domain, want Rung) (bool, error) {
	if domain == "" {
		return false, ErrNoDomain
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(domain).Allows(want), nil
}

// Snapshot returns all known domains' states in stable domain order.
func (m *MemLedger) Snapshot(_ context.Context) ([]State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.states))
	for d := range m.states {
		names = append(names, string(d))
	}
	sort.Strings(names)
	out := make([]State, 0, len(names))
	for _, n := range names {
		out = append(out, m.states[Domain(n)])
	}
	return out, nil
}

// ErrNoDomain is returned when a domain argument is empty — a missing domain must
// never resolve to a permissive default.
var ErrNoDomain = errors.New("autonomy: domain is required")

var _ Ledger = (*MemLedger)(nil)

// ─── seam: durable ledger ─────────────────────────────────────────────────────
//
// seam: durability is provided by the injected Sink + Seed pair, NOT by this
// package doing file I/O. The drone wiring will: (1) on startup, read
// governance/tenants/agix/autonomy.jsonl, replay the last State per domain, and
// Seed() them; (2) pass a Sink that appends one JSON line per Observe. That keeps
// this leaf pure (no os/encoding imports) and matches how core/secrets injects its
// AuditFunc. Do NOT hand-roll file paths here.
