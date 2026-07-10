// Package hivekit is the Agix developer kit (ADK) — the ergonomic, born-clean
// front door to the governed swarm. It is a thin, stdlib-only builder that wraps
// the already-tested core seams (swarm.Run, caste, router, ledger) rather than
// reinventing any of them: you declare a hive fluently and Run it, and hivekit
// translates that declaration into a swarm.Options and hands it to the tested
// engine.
//
//	res, err := hivekit.New().
//	    Provider("mock").                     // $0/offline by default
//	    Queen("claude-opus-4-8").             // per-role model tiering …
//	    Workers(4, "claude-sonnet-5", "claude-haiku-4-5"). // … round-robin across N bees
//	    Verifier("claude-sonnet-5").          // the DISTINCT grader (actor≠verifier)
//	    WithComb(retriever).                  // knowledge-management augmentation
//	    Run(ctx, "add a login page")
//
// The whole point of the ADK layer is to make the governed shape hard to get
// wrong. Two governance invariants are first-class here, not optional:
//
//   - actor≠verifier. Every hive built by hivekit runs a DISTINCT verifier bee
//     through the swarm's ratify gate. There is deliberately no "disable
//     verifier" knob — the verifier's identity is a structural part of the run
//     and is inspectable up front via VerifierActor() (which never equals
//     QueenActor()). Verifier(model) tiers the verifier's MODEL; the verifier's
//     distinct IDENTITY and independent grading pass are guaranteed regardless.
//   - $0 by default. New() defaults to the mock provider, so a hive is a
//     legitimate offline system-under-test with no key and no network until you
//     opt into a real Provider(...).
//
// hivekit stays inside the zero-dep core module (github.com/agix-ai/agix/core)
// on purpose: the ADK and the engine ship as one born-clean artifact, so the
// builder can never drift from the swarm.Options contract it wraps. It is a leaf
// — nothing in core imports it — so wrapping swarm/caste/apiary here introduces
// no import cycle.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package hivekit

import (
	"context"
	"fmt"
	"strings"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/swarm"
	"github.com/agix-ai/agix/core/tool"
)

// Re-exported core types so an ADK caller can build and consume a hive without
// importing the engine packages directly. These are type aliases (not wrappers),
// so a hivekit.Result IS a swarm.Result — the wire contract is identical.
type (
	// Result is the frozen outcome contract of a governed swarm run.
	Result = swarm.Result
	// Verdict is the distinct verifier's certification of the answer.
	Verdict = swarm.Verdict
	// Subtask is one independent slice of the task as decomposed by the Queen.
	Subtask = swarm.Subtask
	// Retriever is the Comb (knowledge-management) augmentation seam handed to
	// WithComb; nil is the KM-off no-op.
	Retriever = swarm.Retriever
	// Capability is a task-shaped routing key for the per-role capability tiers.
	Capability = router.Capability
	// Tool is one capability a worker bee can invoke during its forage — see
	// WithTools. Re-exported so a caller builds tools without importing core/tool.
	Tool = tool.Tool
)

// The default provider and worker count New() starts from. They are set
// explicitly (rather than left to swarm.withDefaults) so Build() returns an
// honest picture of the two choices a caller reasons about first; every other
// unset field inherits the engine's defaults at Run time.
const (
	defaultProvider = "mock"
	defaultWorkers  = 2
)

// Hive is a fluent, declarative specification of one governed swarm. The zero
// value is not usable — start from New(). Every builder method mutates and
// returns the same *Hive so calls chain; a Hive is single-goroutine (build it,
// then Run it), matching how a session assembles a run.
type Hive struct {
	opts  swarm.Options
	tools []tool.Tool
}

// New starts a hive builder with born-clean defaults: the $0/offline mock
// provider and two workers. Chain the builder methods to tier models, size the
// swarm, attach a Comb, or point it at a real provider, then Run.
func New() *Hive {
	return &Hive{opts: swarm.Options{
		Provider: defaultProvider,
		Workers:  defaultWorkers,
	}}
}

// Named sets the hive name that scopes actor refs and coordination leases
// (default "agix"). It also determines QueenActor()/VerifierActor().
func (h *Hive) Named(hive string) *Hive {
	h.opts.Hive = hive
	return h
}

// Provider selects the model provider: "mock" (default, $0/offline), "anthropic",
// "openai", or "gemini". The whole run targets the one provider.
func (h *Hive) Provider(name string) *Hive {
	h.opts.Provider = name
	return h
}

// Queen sets the model for BOTH Queen calls — the decompose and the synthesize.
// Empty (the default) routes the Queen by its capability tier instead.
func (h *Hive) Queen(model string) *Hive {
	h.opts.QueenModel = model
	return h
}

// Workers sets the worker-bee count and, optionally, the per-worker models to
// assign round-robin across them (e.g. Workers(4, "sonnet", "haiku") →
// sonnet,haiku,sonnet,haiku). Pass no models to route every worker by the worker
// capability tier. n<=0 is ignored, leaving the current count.
func (h *Hive) Workers(n int, models ...string) *Hive {
	if n > 0 {
		h.opts.Workers = n
	}
	if len(models) > 0 {
		h.opts.WorkerModels = models
	}
	return h
}

// Verifier sets the model for the DISTINCT verifier bee that certifies the
// synthesized answer (actor≠verifier). This tiers the verifier's model only; its
// separate identity and independent grading pass are guaranteed by hivekit
// regardless of whether you call this. Empty routes the verifier by its
// capability tier.
func (h *Hive) Verifier(model string) *Hive {
	h.opts.VerifyModel = model
	return h
}

// WithComb attaches a Comb (knowledge-management) retriever so each worker's
// subtask prompt is augmented with retrieved context before it forages. nil is
// the KM-off no-op (the default).
func (h *Hive) WithComb(r Retriever) *Hive {
	h.opts.Retriever = r
	return h
}

// WithTools gives every WORKER bee these tools to use during its forage: when a
// worker's model calls a tool, the bee runs the bounded tool-use loop (execute →
// append result → re-call) transparently through the tested agent path. The Queen
// and the distinct verifier deliberately get no tools, so the actor≠verifier
// guarantee and the governance shape are untouched. Duplicate or empty tool names
// are rejected at Run time. Pass none to keep the historical single-call forage.
func (h *Hive) WithTools(tools ...Tool) *Hive {
	h.tools = append(h.tools, tools...)
	return h
}

// Concurrency caps how many workers forage at once (default 4). It bounds
// parallelism without changing the worker count.
func (h *Hive) Concurrency(n int) *Hive {
	if n > 0 {
		h.opts.Concurrency = n
	}
	return h
}

// MaxTokens caps the per-slice output budget (the Queen's decompose, each
// worker's forage, and the verifier's grade). <=0 keeps the engine default.
func (h *Hive) MaxTokens(n int) *Hive {
	if n > 0 {
		h.opts.MaxTokens = n
	}
	return h
}

// SynthMaxTokens caps the Queen's SYNTHESIS output — the merge of all N workers
// into the graded answer, the call that starves first. <=0 keeps the engine's
// raised default; the engine also never lets it fall below MaxTokens.
func (h *Hive) SynthMaxTokens(n int) *Hive {
	if n > 0 {
		h.opts.SynthMaxTokens = n
	}
	return h
}

// QueenTier sets the Queen's capability tier (the routing key used when no
// explicit Queen model is set). Empty keeps the engine default (default-quality).
func (h *Hive) QueenTier(c Capability) *Hive {
	h.opts.QueenCap = c
	return h
}

// WorkerTier sets the workers' capability tier (default cheap-classification —
// the cheap-bees thesis). Empty keeps the engine default.
func (h *Hive) WorkerTier(c Capability) *Hive {
	h.opts.WorkerCap = c
	return h
}

// VerifierTier sets the verifier's capability tier (default default-quality).
// Empty keeps the engine default.
func (h *Hive) VerifierTier(c Capability) *Hive {
	h.opts.VerifyCap = c
	return h
}

// Ledger attaches the append-only audit ledger the run writes its provenance to
// (model calls, lease claim/release, the ratify verdict). nil disables audit.
func (h *Hive) Ledger(l *ledger.Ledger) *Hive {
	h.opts.Ledger = l
	return h
}

// RunID sets the lease-scope discriminator for reproducible coordination scopes;
// empty lets the engine mint a timestamped id.
func (h *Hive) RunID(id string) *Hive {
	h.opts.RunID = id
	return h
}

// Build returns the swarm.Options this hive will run. It is the pre-defaults
// view (the engine's withDefaults fills any field left at its zero value at Run
// time); Provider and Workers always reflect New()'s explicit defaults. Useful
// for inspection, logging, or handing the config to swarm.Run yourself.
func (h *Hive) Build() swarm.Options {
	return h.opts
}

// QueenActor is the canonical actor reference of this hive's Queen
// ("<hive>/queen/root"), reusing the same wire-string builder the engine uses so
// it can never drift.
func (h *Hive) QueenActor() string {
	return apiary.ActorRef(h.hiveName(), string(caste.Queen), "root")
}

// VerifierActor is the canonical actor reference of this hive's DISTINCT verifier
// bee ("<hive>/worker/verifier-1"). It is the first-class handle on the
// actor≠verifier guarantee: it never equals QueenActor(), and the run's
// Verdict.By always matches it.
func (h *Hive) VerifierActor() string {
	return caste.Actor(h.hiveName(), caste.Worker, "verifier", 1)
}

// Run executes the governed swarm end-to-end: Queen decomposes → N workers
// forage in parallel → Queen synthesizes → the DISTINCT verifier certifies
// through the ratify gate. It returns the frozen Result (partial alongside the
// error on a fatal converge failure, exactly as swarm.Run does).
//
// Run enforces the ADK's two guardrails before dispatching: a non-empty task,
// and the actor≠verifier invariant (a tripwire that can only fire if the caste
// taxonomy is ever changed to collapse the two identities). Neither costs a
// model call.
func (h *Hive) Run(ctx context.Context, task string) (Result, error) {
	if strings.TrimSpace(task) == "" {
		return Result{}, fmt.Errorf("hivekit: Run needs a non-empty task")
	}
	if h.QueenActor() == h.VerifierActor() {
		// Governance tripwire: the swarm's whole contract is actor≠verifier.
		return Result{Task: task}, fmt.Errorf(
			"hivekit: actor≠verifier violated — queen and verifier resolved to the same actor %q", h.QueenActor())
	}

	opts := h.opts
	opts.Task = task
	if len(h.tools) > 0 {
		reg, err := tool.New(h.tools...)
		if err != nil {
			return Result{Task: task}, fmt.Errorf("hivekit: WithTools: %w", err)
		}
		opts.Tools = reg
	}
	return swarm.Run(ctx, opts)
}

// hiveName is the effective hive name, mirroring the engine's default so the
// actor accessors agree with the actors the run actually mints.
func (h *Hive) hiveName() string {
	if strings.TrimSpace(h.opts.Hive) == "" {
		return "agix"
	}
	return h.opts.Hive
}
