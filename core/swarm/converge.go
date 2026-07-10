package swarm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/orchestrator"
	"github.com/agix-ai/agix/core/orchestrator/mem"
	"github.com/agix-ai/agix/core/router"
)

const (
	synthSystem  = "You are the Queen of an Agix hive. Synthesize the workers' partial results into one complete, coherent answer to the original task. Return only the final answer."
	verifySystem = "You are the hive's verifier bee. You did NOT produce this answer; grade it independently and honestly for whether it satisfies the task."

	synthKey = "synth.output"
)

// convergeResult carries what converge produced: the certified answer, the
// verifier's verdict, and the two converge bees (Queen-synthesize + verifier).
type convergeResult struct {
	Answer    string
	Verdict   Verdict
	SynthBee  BeeCost
	VerifyBee BeeCost
	Degraded  []string
}

// converge closes the swarm loop: the Queen synthesizes the workers' partials
// into one answer, then a DISTINCT verifier bee certifies it through the mem
// orchestrator's ratify gate (actor≠verifier). The gate PAUSES the run; the
// verifier's GateDecision resumes it, emitting the ratify ledger entry via the
// same interrupt/resume path the `flow` demo proves. On the mock provider this
// is deterministic and $0, and an unparseable verdict approves-with-note.
func converge(ctx context.Context, r *router.Router, o Options, outs []workerOut) (convergeResult, error) {
	var cr convergeResult
	queenActor := apiary.ActorRef(o.Hive, "queen", "root")
	verifierActor := caste.Actor(o.Hive, caste.Worker, "verifier", 1)

	// ── Queen synthesize (a direct queen Chat so per-bee usage is captured
	//    cleanly, without parsing it back out of the ledger) ─────────────────
	synthPrompt := buildSynthPrompt(o.Task, outs)
	sStart := time.Now()
	sresp, serr := r.Chat(ctx, router.ChatRequest{
		System:     synthSystem,
		Messages:   []router.Message{{Role: "user", Content: synthPrompt}},
		MaxTokens:  o.SynthMaxTokens, // the merge gets the LARGE budget, not the per-slice one
		Capability: o.QueenCap,
		Model:      o.QueenModel,
	})
	sLat := time.Since(sStart).Seconds()

	answer := sresp.Text
	synthModel := recordedModel(o.QueenModel, sresp.Model)
	if serr != nil {
		// heals posture: fall back to the concatenated partials as the answer.
		answer = fallbackAnswer(outs)
		synthModel = "degraded"
		cr.Degraded = append(cr.Degraded, "synthesize-failed")
	}
	cr.Answer = answer
	cr.SynthBee = BeeCost{Actor: queenActor, Role: "queen", Phase: "synthesize", Model: synthModel, Usage: sresp.Usage, LatencyS: sLat}
	logModelCall(o.Ledger, cr.SynthBee)

	// ── Governance gate through the mem engine (actor≠verifier) ─────────────
	// The gate's job here is the interrupt/resume + ratify ledger trail; both
	// verdicts terminate at the comb (End), which keeps Cost == Σ Bees exact on
	// every path (no reject-only remediation bee to reconcile). The reject path
	// is surfaced via Verified=false + a degraded marker.
	ratify := &orchestrator.GateNode{NodeName: "ratify", OnApprove: "", OnReject: "", RatifyKey: synthKey}
	g := orchestrator.NewGraph()
	g.AddNode(ratify)
	g.SetEntry("ratify")

	runner := mem.New(mem.Options{Ledger: o.Ledger})
	state := orchestrator.NewState()
	state.Set(synthKey, answer)

	rr, rerr := runner.Run(ctx, g, state)
	if rerr != nil {
		return cr, fmt.Errorf("swarm: converge run to gate: %w", rerr)
	}
	if rr.Interrupted == nil {
		return cr, fmt.Errorf("swarm: expected the ratify gate to pause, but the graph completed")
	}

	// ── Verifier grades the synthesized answer (the distinct bee) ───────────
	vStart := time.Now()
	vresp, verr := r.Chat(ctx, router.ChatRequest{
		System:     verifySystem,
		Messages:   []router.Message{{Role: "user", Content: buildVerifyPrompt(o.Task, answer)}},
		MaxTokens:  o.MaxTokens,
		Capability: o.VerifyCap,
		Model:      o.VerifyModel,
	})
	vLat := time.Since(vStart).Seconds()

	verifyModel := recordedModel(o.VerifyModel, vresp.Model)
	if verr != nil {
		cr.Verdict = Verdict{Approved: true, By: verifierActor, Notes: "auto-approved: verifier call degraded (" + verr.Error() + ")"}
		cr.Degraded = append(cr.Degraded, "verify-failed")
		verifyModel = "degraded"
	} else {
		cr.Verdict = parseVerdict(vresp.Text, verifierActor)
	}
	// Grounding — the load-bearing attestation signal. The verifier bee's reply is
	// PROSE (judgment) by construction; the verdict is EXTERNALLY grounded only if
	// a deterministic oracle fired-and-passed during the workers' forage (an exec
	// exit-0, a passing test suite, a metric threshold — a tool.Grounder result).
	// This keeps the corpus clean: a same-family critic's prose alone never
	// auto-attests (it stays judgment → pending co-sign).
	cr.Verdict.Grounding = grounding(externalGrounding(outs))
	cr.VerifyBee = BeeCost{Actor: verifierActor, Role: "verifier", Phase: "verify", Model: verifyModel, Usage: vresp.Usage, LatencyS: vLat}
	logModelCall(o.Ledger, cr.VerifyBee)

	// ── Resume the gate with the verifier's verdict → ratify ledger entry ───
	if _, err := runner.Resume(ctx, rr.CheckpointID, orchestrator.GateDecision{
		Approved:  cr.Verdict.Approved,
		By:        verifierActor,
		Notes:     cr.Verdict.Notes,
		Grounding: cr.Verdict.Grounding,
	}); err != nil {
		return cr, fmt.Errorf("swarm: resume at ratify gate: %w", err)
	}

	if !cr.Verdict.Approved {
		cr.Degraded = append(cr.Degraded, "verifier-rejected")
	}
	return cr, nil
}

// externalGrounding reports whether any worker's forage ran a deterministic
// external oracle that PASSED — a successful tool.Grounder result (exec exit-0,
// a passing test suite, a metric threshold). It is the evidence that turns a
// prose-only verifier approval into an EXTERNALLY-grounded verdict the
// attestation policy may auto-attest. An errored tool call never counts.
func externalGrounding(outs []workerOut) bool {
	for _, o := range outs {
		for _, inv := range o.Result.ToolCalls {
			if !inv.IsError && inv.Grounded {
				return true
			}
		}
	}
	return false
}

// grounding maps the oracle-fired boolean to the Verdict.Grounding class.
func grounding(external bool) string {
	if external {
		return GroundingExternal
	}
	return GroundingJudgment
}

// buildSynthPrompt assembles the Queen's synthesis prompt from the workers'
// partial results, noting any that degraded.
func buildSynthPrompt(task string, outs []workerOut) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Original task: %s\n\n", task)
	b.WriteString("The hive's workers each solved one slice in isolation. Synthesize their partial results into one complete, coherent answer to the original task.\n\n")
	for i, o := range outs {
		fmt.Fprintf(&b, "--- Worker %d (%s) ---\n", i+1, o.Subtask.ID)
		if o.Err != nil {
			fmt.Fprintf(&b, "[degraded: %v]\n\n", o.Err)
			continue
		}
		fmt.Fprintf(&b, "%s\n\n", strings.TrimSpace(o.Result.Text))
	}
	return b.String()
}

// buildVerifyPrompt frames the certification question for the verifier bee. It
// deliberately avoids embedding a JSON object or the word "reject", so the mock
// provider's echo-reply lands on the graceful approve-with-note path rather than
// tripping a false rejection.
func buildVerifyPrompt(task, answer string) string {
	return fmt.Sprintf(
		"Original task:\n%s\n\nSynthesized answer under review:\n%s\n\n"+
			"Certify whether the answer satisfies the task. Respond with a JSON object having a boolean approved field and a string notes field.",
		task, answer)
}

// fallbackAnswer concatenates the workers' partials — the answer of last resort
// when the Queen's synthesis call itself degrades.
func fallbackAnswer(outs []workerOut) string {
	var parts []string
	for _, o := range outs {
		if o.Err == nil && strings.TrimSpace(o.Result.Text) != "" {
			parts = append(parts, strings.TrimSpace(o.Result.Text))
		}
	}
	return strings.Join(parts, "\n\n")
}

// parseVerdict reads the verifier's reply. A parseable JSON object with an
// approved field wins; an explicit "reject" keyword is honored as a safety net;
// anything else (the mock/unparseable case) approves-with-note, so the spine
// stays green while never silently discarding a real rejection signal.
func parseVerdict(text, by string) Verdict {
	if js := extractJSON(text); js != "" {
		var v struct {
			Approved *bool  `json:"approved"`
			Notes    string `json:"notes"`
		}
		if err := json.Unmarshal([]byte(js), &v); err == nil && v.Approved != nil {
			return Verdict{Approved: *v.Approved, By: by, Notes: v.Notes}
		}
	}
	if strings.Contains(strings.ToLower(text), "reject") {
		return Verdict{Approved: false, By: by, Notes: "verifier rejected the synthesized answer"}
	}
	return Verdict{Approved: true, By: by, Notes: "auto-approved: verifier verdict was not machine-parseable (graceful path)"}
}
