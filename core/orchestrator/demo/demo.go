// Package demo wires ONE governance gate end-to-end: a forage→ratify→feed graph
// run through the mem engine, bracketed by a coord lease, on the mock provider.
// It is the executable proof of actor≠verifier on interrupt/resume — the point
// of the orchestrator flight — and is shared by both the `flow` CLI subcommand
// and the end-to-end test so there is one assembly, not two.
//
// The graph:
//
//	forage (AgentNode)  → ratify (GateNode) ─approve→ feed (AgentNode)      → END
//	                                        └─reject→ remediate (AgentNode) → END
//
// The gate pauses the run; a verifier's GateDecision resumes it. Approve feeds
// the ratified work into the comb; reject diverts to remediation and the work
// never reaches feed — governance, not decoration.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package demo

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/orchestrator"
	"github.com/agix-ai/agix/core/orchestrator/mem"
	"github.com/agix-ai/agix/core/provider/anthropic"
	"github.com/agix-ai/agix/core/provider/gemini"
	"github.com/agix-ai/agix/core/provider/local"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/provider/openai"
	"github.com/agix-ai/agix/core/router"
)

// Node/role names — the bees in the demo graph.
const (
	NodeForage    = "forage"
	NodeRatify    = "ratify"
	NodeFeed      = "feed"
	NodeRemediate = "remediate"

	forageKey    = "forage.output"
	feedKey      = "feed.output"
	remediateKey = "remediate.output"

	forager  = "forager-1" // the actor bee
	verifier = "curator-1" // the verifier bee (actor≠verifier)
)

// Options configures a demo run.
type Options struct {
	Task     string         // the work to forage
	Approve  bool           // the verifier's verdict at the gate
	Provider string         // "mock" (default); real providers are a TODO for the demo
	Ledger   *ledger.Ledger // audit sink; nil disables audit (a temp/CLI ledger is passed in)
}

// Result is the outcome of a demo run, shaped for display + assertion.
type Result struct {
	Task         string
	Approved     bool
	Interrupted  string // the interrupt Kind at the pause ("ratify")
	CheckpointID string
	Outcome      string // "fed" (approved) | "remediated" (rejected)
	OutputText   string // the final node's reply
	LeaseID      string
	State        *orchestrator.State
}

// BuildGraph assembles the forage→ratify→feed governance graph over router r,
// auditing to led. Exposed so tests can validate the topology directly.
func BuildGraph(r *router.Router, led *ledger.Ledger) *orchestrator.Graph {
	forage := &orchestrator.AgentNode{
		NodeName:   NodeForage,
		AgentName:  forager,
		Capability: router.CapDefaultQuality,
		Router:     r,
		Ledger:     led,
		System:     "You are a forager bee. Forage the task and return a concise draft for ratification.",
		PromptKey:  "task",
		OutputKey:  forageKey,
	}
	ratify := &orchestrator.GateNode{
		NodeName:  NodeRatify,
		OnApprove: NodeFeed,
		OnReject:  NodeRemediate,
		RatifyKey: forageKey,
	}
	feed := &orchestrator.AgentNode{
		NodeName:   NodeFeed,
		AgentName:  forager,
		Capability: router.CapDefaultQuality,
		Router:     r,
		Ledger:     led,
		System:     "You are a nurse bee. Integrate the ratified draft into the comb.",
		PromptKey:  forageKey,
		OutputKey:  feedKey,
	}
	remediate := &orchestrator.AgentNode{
		NodeName:   NodeRemediate,
		AgentName:  forager,
		Capability: router.CapCheapClassification,
		Router:     r,
		Ledger:     led,
		System:     "You are a remediation bee. The draft was rejected; note what to revise. Do not feed the comb.",
		PromptKey:  forageKey,
		OutputKey:  remediateKey,
	}

	g := orchestrator.NewGraph()
	g.AddNode(forage).AddNode(ratify).AddNode(feed).AddNode(remediate)
	g.AddEdge(NodeForage, NodeRatify)
	g.AddEdge(NodeFeed, orchestrator.End)
	g.AddEdge(NodeRemediate, orchestrator.End)
	g.SetEntry(NodeForage)
	return g
}

// Run executes the demo end-to-end: claim a lease, run the graph to the gate,
// resume with the verifier's decision, release the lease. Returns a Result and,
// on a graceful-degrade, a non-nil error alongside the partial Result.
func Run(ctx context.Context, opts Options) (Result, error) {
	provider := opts.Provider
	if provider == "" {
		provider = "mock"
	}
	if provider != "mock" {
		// The demo is a zero-cost governance proof; real providers plug into the
		// same graph via the router but are out of scope for `flow`.
		return Result{}, fmt.Errorf("demo: provider %q not supported here (use mock; real providers route through core/agent)", provider)
	}

	r := router.NewRouter()
	r.Register(mock.New())
	r.ForceProvider("mock")
	// Per-capability routing overlay (~/.agix/routing.json) wins over the forced
	// mock provider: a graduated capability keeps its provider even in the flow
	// demo. Applied AFTER ForceProvider so overlay precedence holds; overlay-target
	// providers are registered so the resolved call can dispatch. A missing/empty
	// file is a no-op — the demo stays deterministic and $0 on mock by default.
	applyDemoOverlay(r)

	led := opts.Ledger
	leases := coord.NewMemLedger()

	// ── forage: claim the scope (reuse the agent loop's lease pattern) ────────
	scope := "hive/flow/" + slug(opts.Task)
	logEntry(led, ledger.Entry{Kind: ledger.KindAgentStart, Agent: forager,
		Data: map[string]any{"task": opts.Task, "graph": "forage-ratify-feed"}})
	lease, err := leases.Claim(ctx, coord.ClaimRequest{
		Agent:  forager,
		Claims: []coord.Claim{{Path: scope, Mode: coord.ModeExclusive}},
		Notes:  opts.Task,
	})
	if err != nil {
		return Result{Task: opts.Task}, fmt.Errorf("demo: claim lease: %w", err)
	}
	logEntry(led, ledger.Entry{Kind: ledger.KindLeaseClaim, Agent: forager,
		Data: map[string]any{"lease": lease.ID, "scope": scope}})

	res := Result{Task: opts.Task, Approved: opts.Approve, LeaseID: lease.ID}

	// ── run the graph to the gate ────────────────────────────────────────────
	g := BuildGraph(r, led)
	runner := mem.New(mem.Options{Ledger: led})
	state := orchestrator.NewState()
	state.Set("task", opts.Task)

	rr, err := runner.Run(ctx, g, state)
	if err != nil {
		releaseAndLog(ctx, leases, led, lease.ID)
		res.State = rr.State
		return res, fmt.Errorf("demo: run to gate: %w", err)
	}
	if rr.Interrupted == nil {
		releaseAndLog(ctx, leases, led, lease.ID)
		res.State = rr.State
		return res, fmt.Errorf("demo: expected the run to pause at the %s gate, but it completed", NodeRatify)
	}
	res.Interrupted = rr.Interrupted.Kind
	res.CheckpointID = rr.CheckpointID

	// ── ratify: a DIFFERENT bee resumes with the verdict (actor≠verifier) ─────
	decision := orchestrator.GateDecision{
		Approved: opts.Approve,
		By:       verifier,
		Notes:    verdictNote(opts.Approve),
	}
	rr2, err := runner.Resume(ctx, rr.CheckpointID, decision)
	if err != nil {
		releaseAndLog(ctx, leases, led, lease.ID)
		res.State = rr2.State
		return res, fmt.Errorf("demo: resume at gate: %w", err)
	}
	res.State = rr2.State

	if opts.Approve {
		res.Outcome = "fed"
		res.OutputText = rr2.State.GetString(feedKey)
	} else {
		res.Outcome = "remediated"
		res.OutputText = rr2.State.GetString(remediateKey)
	}

	// ── feed done: release the lease, close the loop ─────────────────────────
	releaseAndLog(ctx, leases, led, lease.ID)
	logEntry(led, ledger.Entry{Kind: ledger.KindAgentDone, Agent: forager,
		Data: map[string]any{"ok": true, "outcome": res.Outcome, "approved": opts.Approve}})

	return res, nil
}

func releaseAndLog(ctx context.Context, leases coord.LeaseLedger, led *ledger.Ledger, leaseID string) {
	if err := leases.Release(ctx, leaseID, forager); err != nil {
		logEntry(led, ledger.Entry{Kind: ledger.KindLeaseRelease, Agent: forager,
			Data: map[string]any{"lease": leaseID, "error": err.Error()}})
		return
	}
	logEntry(led, ledger.Entry{Kind: ledger.KindLeaseRelease, Agent: forager,
		Data: map[string]any{"lease": leaseID}})
}

func logEntry(led *ledger.Ledger, e ledger.Entry) {
	if led == nil {
		return
	}
	_ = led.Append(e)
}

func verdictNote(approved bool) string {
	if approved {
		return "draft meets the comb's standard; ratified"
	}
	return "draft not ready; sent back for remediation"
}

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_' || r == '/':
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "task"
	}
	return out
}

// applyDemoOverlay loads the persisted per-capability routing overlay and applies
// it to the demo's router AFTER ForceProvider (so overlay precedence holds),
// registering each overlay-target provider so a graduated capability can dispatch.
// A missing/empty file is a no-op; a malformed one is logged and skipped rather
// than aborting the governance proof.
func applyDemoOverlay(r *router.Router) {
	overlay, err := router.LoadOverlay(router.DefaultOverlayPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "demo: routing overlay: %v (continuing without it)\n", err)
		return
	}
	for c, prov := range overlay {
		if err := r.SetCapabilityProvider(c, prov); err != nil {
			fmt.Fprintf(os.Stderr, "demo: routing overlay: %v (skipping)\n", err)
			continue
		}
		switch prov {
		case "mock":
			r.Register(mock.New())
		case "anthropic":
			r.Register(anthropic.New())
		case "openai":
			r.Register(openai.New())
		case "gemini":
			r.Register(gemini.New())
		case "local":
			r.Register(local.New())
		}
	}
}
