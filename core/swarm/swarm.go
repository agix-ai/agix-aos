// Package swarm is the FIRST-LIGHT spine of the governed swarm system-under-test:
// a Queen decomposes a task, N cheap workers forage the subtasks IN PARALLEL, a
// DISTINCT verifier certifies the synthesized answer (actor≠verifier), and the
// run emits a frozen Result contract. It composes the already-tested seams —
// the model-agnostic router, the coord lease ledger (stigmergy), the append-only
// audit ledger, the per-worker agent loop, and the mem orchestrator's
// interrupt/resume governance gate — rather than reinventing any of them.
//
// The whole run is deterministic and $0 under the mock provider (the default),
// so the swarm is a legitimate offline system-under-test the study arm and the
// Comb pieces build on.
//
//	Queen.decompose ─▶ [ worker₁ ‖ worker₂ ‖ … workerₙ ] ─▶ Queen.synthesize
//	                                                             │
//	                                                    ratify gate (pause)
//	                                                             │
//	                                            verifier grades  ▼  (actor≠verifier)
//	                                                    Resume(verdict) ─▶ comb
//
// Lease topology: every worker claims its OWN subtask scope
// ("<hive>/swarm/<runID>/subtask/<id>"); the Queen decompose/synthesize and the
// verifier run UNLEASED. Nothing ever claims the bare parent "<hive>/swarm/<runID>"
// path — coord treats a bare directory as its whole subtree, so a parent claim
// would conflict with every worker child.
//
// Graceful-degrade ("heals" posture) throughout: a worker error is captured and
// shipped partial (siblings are never cancelled); an unparseable Queen reply
// falls back to a deterministic split; an unparseable verdict approves-with-note.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package swarm

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/provider/anthropic"
	"github.com/agix-ai/agix/core/provider/gemini"
	"github.com/agix-ai/agix/core/provider/local"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/provider/openai"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/tool"
)

// Retriever is the knowledge-management (KM) seam. When set on Options, each
// worker's subtask prompt is augmented with retrieved context before it forages;
// nil is the KM-off no-op. hits reports how many knowledge fragments were merged
// (provenance for the study arm's KM-on-vs-off control).
type Retriever interface {
	Augment(ctx context.Context, subtaskPrompt string) (augmented string, hits int, err error)
}

// Options configures one swarm run. Only Task is required; every other field has
// a first-light default (see withDefaults).
type Options struct {
	Task        string
	Provider    string // "mock" (default, $0) | anthropic | openai | gemini | local (Ollama, $0)
	Workers     int    // number of subtasks/worker bees (default 2)
	Concurrency int    // max workers foraging at once (default 4)
	Hive        string // hive name for actor refs + lease scopes (default "agix")
	RunID       string // lease-scope discriminator; a timestamp id when empty

	QueenCap  router.Capability // decompose + synthesize (default default-quality)
	WorkerCap router.Capability // per-worker forage (default cheap-classification)
	VerifyCap router.Capability // verifier grade (default default-quality)

	// Explicit per-role model overrides. Empty falls back to the role's
	// Capability default (behavior unchanged). QueenModel drives both the
	// decompose and synthesize calls; WorkerModels is assigned round-robin
	// across the N workers (e.g. ["claude-sonnet-5","claude-haiku-4-5"] with 4
	// workers → sonnet,haiku,sonnet,haiku); VerifyModel drives the verifier.
	QueenModel   string
	WorkerModels []string
	VerifyModel  string

	Ledger    *ledger.Ledger // audit sink; nil disables audit
	Retriever Retriever      // KM augmentation; nil = KM off

	// Tools, when set, is offered to every WORKER bee's forage (the Queen's
	// decompose/synthesize and the verifier deliberately get no tools). A worker
	// the model drives to call a tool runs the bounded tool-use loop transparently
	// through the same agent path. nil = no tools (the historical single-call
	// forage). The runaway guard is the agent's default max-iterations cap.
	Tools *tool.Registry

	// MaxTokens caps the OUTPUT budget for the per-slice calls: the Queen's
	// decompose, each worker's forage, and the verifier's grade (default 1024 —
	// a terse slice or a short JSON verdict needs no more).
	MaxTokens int
	// SynthMaxTokens caps the Queen's SYNTHESIS output — the single call that
	// merges all N workers' partials into the graded answer. This is the merge
	// that starves first (Exp #3 collapsed matrix coverage to 10 when the merge
	// truncated at the 1024 default), so it gets its OWN, higher budget
	// (defaultSynthMaxTokens) and is never allowed to fall below MaxTokens. Set
	// it explicitly to drive the merge from a flag; 0 takes the raised default.
	SynthMaxTokens int
}

// defaultSynthMaxTokens is the synthesis-call output budget when SynthMaxTokens
// is unset. It is deliberately higher than the per-slice MaxTokens default: the
// Queen's merge of N workers is the one call that must not be starved, so the
// out-of-the-box behavior no longer silently truncates the graded artifact.
const defaultSynthMaxTokens = 4096

// Subtask is one independent slice of the task, as decomposed by the Queen.
type Subtask struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Prompt string `json:"prompt"`
}

// Grounding classifies WHAT backed the verifier's approval — the load-bearing
// signal the attestation policy keys on:
//
//   - GroundingExternal: a deterministic/external ORACLE backed the verdict
//     during the run (a test suite passed, code executed to exit 0, a
//     deterministic gate fired). This is the only class that AUTO-ATTESTS into
//     the certified corpus, because the approval rests on something other than a
//     same-family LLM's prose judgment.
//   - GroundingJudgment: the verdict is the verifier bee's PROSE judgment only,
//     with no external oracle behind it. Same-family critics grade style, not
//     correctness, so a judgment-only leaf is held out of the corpus pending a
//     human co-sign (attested=false, pending_cosign=true).
const (
	GroundingExternal = "external"
	GroundingJudgment = "judgment"
)

// Verdict is the verifier's certification of the synthesized answer. Grounding
// records whether that certification was backed by an external oracle
// (GroundingExternal) or is LLM-judgment-only (GroundingJudgment) — the
// distinction the Comb attestation policy uses to decide auto-attest vs. hold
// for human co-sign.
type Verdict struct {
	Approved  bool   `json:"approved"`
	By        string `json:"by"`
	Notes     string `json:"notes"`
	Grounding string `json:"grounding,omitempty"`
}

// Result is the frozen outcome contract of a swarm run.
type Result struct {
	Task     string    `json:"task"`
	Answer   string    `json:"answer"`
	Verified bool      `json:"verified"`
	Verdict  Verdict   `json:"verdict"`
	Subtasks []Subtask `json:"subtasks"`
	Cost     Cost      `json:"cost"`
	Degraded []string  `json:"degraded"`
}

// Run executes one governed swarm end-to-end and returns its Result. It never
// retries; on a fatal converge error it returns the partial Result alongside the
// error.
func Run(ctx context.Context, o Options) (Result, error) {
	o = withDefaults(o)
	runID := o.RunID
	if runID == "" {
		runID = fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	runScope := fmt.Sprintf("%s/swarm/%s", o.Hive, runID)

	r := router.NewRouter()
	switch o.Provider {
	case "mock":
		r.Register(mock.New())
		r.ForceProvider("mock") // synthetic provider; the default table never routes to it
	case "anthropic":
		r.Register(anthropic.New())
		r.ForceProvider("anthropic")
	case "openai":
		r.Register(openai.New())
		r.ForceProvider("openai")
	case "gemini":
		r.Register(gemini.New())
		r.ForceProvider("gemini")
	case "local":
		// Local Ollama lane ($0): runs the hive's own distilled nuclei / gemma3
		// worker tier. ToolUse is unsupported (gemma3 has no Ollama tool capability)
		// so tool-offering calls surface a tool-use-unsupported Degraded marker.
		r.Register(local.New())
		r.ForceProvider("local")
	default:
		return Result{Task: o.Task}, fmt.Errorf("swarm: unknown provider %q (mock|anthropic|openai|gemini|local)", o.Provider)
	}

	result := Result{Task: o.Task}

	// ── Queen decompose ────────────────────────────────────────────────────
	subtasks, queenBee, decompDegraded := decompose(ctx, r, o)
	result.Subtasks = subtasks
	result.Cost.add(queenBee)
	logModelCall(o.Ledger, queenBee)
	if decompDegraded != "" {
		result.Degraded = append(result.Degraded, decompDegraded)
	}

	// ── Fan-out: N workers forage the subtasks in parallel ─────────────────
	leases := coord.NewMemLedger()
	outs := fanOut(ctx, r, leases, o, runScope, subtasks)
	for _, out := range outs {
		result.Cost.add(out.Bee)
		if out.Err != nil {
			result.Degraded = append(result.Degraded, "worker-"+out.Subtask.ID+"-failed")
		}
	}

	// ── Converge: Queen synthesizes, a DISTINCT verifier certifies ─────────
	conv, err := converge(ctx, r, o, outs)
	result.Answer = conv.Answer
	result.Verdict = conv.Verdict
	result.Verified = conv.Verdict.Approved
	result.Cost.add(conv.SynthBee)
	result.Cost.add(conv.VerifyBee)
	result.Degraded = append(result.Degraded, conv.Degraded...)
	if err != nil {
		return result, err
	}

	if result.Degraded == nil {
		result.Degraded = []string{}
	}
	return result, nil
}

func withDefaults(o Options) Options {
	if o.Workers <= 0 {
		o.Workers = 2
	}
	if o.Concurrency <= 0 {
		o.Concurrency = 4
	}
	if strings.TrimSpace(o.Hive) == "" {
		o.Hive = "agix"
	}
	if strings.TrimSpace(o.Provider) == "" {
		o.Provider = "mock"
	}
	if o.QueenCap == "" {
		o.QueenCap = router.CapDefaultQuality
	}
	if o.WorkerCap == "" {
		o.WorkerCap = router.CapCheapClassification
	}
	if o.VerifyCap == "" {
		o.VerifyCap = router.CapDefaultQuality
	}
	if o.MaxTokens <= 0 {
		o.MaxTokens = 1024
	}
	if o.SynthMaxTokens <= 0 {
		o.SynthMaxTokens = defaultSynthMaxTokens
	}
	// The merge must never be given LESS room than a single slice; if an
	// operator raises MaxTokens above the synth budget, lift synth to match.
	if o.SynthMaxTokens < o.MaxTokens {
		o.SynthMaxTokens = o.MaxTokens
	}
	return o
}

// recordedModel is the model to stamp on a bee's provenance: the explicit
// override when set (so bees[].model reflects the routing decision even under
// the mock provider, which always echoes "mock"), else the model the provider
// actually reported. The error paths still override this with "degraded".
func recordedModel(override, reported string) string {
	if override != "" {
		return override
	}
	return reported
}

// logModelCall records a bee's model call in the audit ledger, attributed to the
// bee's actor ref — the trail that proves who did what (and that the verifier is
// a distinct actor from every forager). A nil ledger disables audit.
func logModelCall(led *ledger.Ledger, b BeeCost) {
	if led == nil {
		return
	}
	_ = led.Append(ledger.Entry{Kind: ledger.KindModelCall, Agent: b.Actor, Data: map[string]any{
		"role":          b.Role,
		"phase":         b.Phase,
		"model":         b.Model,
		"subtask":       b.Subtask,
		"input_tokens":  b.Usage.InputTokens,
		"output_tokens": b.Usage.OutputTokens,
		"cached_tokens": b.Usage.CachedTokens,
		"cost_usd":      b.Usage.CostUSD,
	}})
}
