// Package agent is ONE end-to-end beehive loop in miniature:
// forage → work → return/feed. It ties the router, the audit ledger, and the
// coordination lease seam into a single working path:
//
//  1. forage: claim a lease over the task's scope (stigmergy) + ledger agent_start.
//  2. work:   route a Capability through the model-agnostic router (ledger model_call).
//  3. return/feed: write the result + agent_done to the ledger, release the lease.
//
// Deterministic and zero-cost with the mock provider (default); real with a
// live provider. Graceful-degrade ("heals" posture): on a provider/budget
// error it ships what landed and releases the lease — never a retry loop.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/secrets"
	"github.com/agix-ai/agix/core/tool"
)

// defaultMaxToolIters bounds the tool-use loop's model calls when a task does not
// set MaxToolIters. It is the runaway guard: a model that keeps calling tools
// without ever answering is stopped here rather than looping forever. 8 was too
// tight for a real read-plan-write cycle — a refactoring worker spends several
// iterations reading the target file and its neighbors before it can write, and
// hit the cap mid-exploration (never reaching the write) on any non-trivial file.
// 20 leaves room for the read/grep/write cycle while still catching a runaway.
const defaultMaxToolIters = 20

// egress redacts a provider error before it becomes res.Err, a ledger entry, or
// (via the caller) a stderr line. Defense in depth: even though gemini no longer
// puts its key in the URL, a raw provider/transport error must never carry a
// credential out of the process. The ledger redacts too; this closes the return
// value + stderr path.
var egress = secrets.NewEgressScanner()

const systemPrompt = "You are a worker bee in an Agix hive. Forage the task, return a concise result, and feed the hive."

// Task is one unit of work for an agent.
type Task struct {
	Name       string
	Prompt     string
	Scope      []string // path globs to claim; defaults to a synthetic task path
	Branch     string
	Capability router.Capability // defaults to default-quality
	// Model, when set, overrides Capability for this task's model call (the
	// router routes to the explicit model instead of resolving the capability).
	Model string
	// MaxTokens caps the model call's output budget. <=0 keeps the historical
	// 1024 default, so existing callers that don't set it are unchanged.
	MaxTokens int
	// Tools, when non-empty, turns the work phase into a bounded tool-use loop:
	// the model is offered the registry's tools, and when it calls one the loop
	// executes it, appends the result, and re-calls — up to MaxToolIters. Nil (the
	// default) keeps the historical single-call path unchanged.
	Tools *tool.Registry
	// MaxToolIters caps the tool-use loop's model calls (the runaway guard). <=0
	// uses defaultMaxToolIters. Ignored when Tools is empty.
	MaxToolIters int
}

// ToolInvocation records one tool the tool-use loop executed — provenance beyond
// the ledger so a caller can inspect the tool trace on the Result directly.
// Grounded is true when the tool implements tool.Grounder and classified its own
// (successful) result as a PASSING external oracle — the signal the swarm folds
// into the verdict's grounding (external vs judgment).
type ToolInvocation struct {
	Name     string
	Args     string
	Result   string
	IsError  bool
	Grounded bool
}

// Result is the outcome of a run.
type Result struct {
	Text     string
	Usage    router.Usage
	Provider string
	Model    string
	LeaseID  string
	Degraded []string
	// ToolCalls records each tool the tool-use loop executed, in order. Empty on
	// the single-call path.
	ToolCalls []ToolInvocation
	// Err is set (and Run also returns the error) when the run graceful-degraded.
	Err string
}

// Agent runs the forage→work→return/feed loop.
type Agent struct {
	Name   string
	Router *router.Router
	Ledger *ledger.Ledger
	Leases coord.LeaseLedger
}

// Run executes the loop for one task.
func (a *Agent) Run(ctx context.Context, task Task) (Result, error) {
	capability := task.Capability
	if capability == "" {
		capability = router.CapDefaultQuality
	}

	scope := task.Scope
	if len(scope) == 0 {
		scope = []string{"hive/task/" + slug(task.Name)}
	}

	maxTokens := task.MaxTokens
	if maxTokens <= 0 {
		// A single-call node (decompose, narrate, certify) needs little output, so
		// keep the historical 1024. A tool-use WORKER, though, emits whole files back
		// through the write tool's arguments — a real refactoring of a ~250-line file
		// exceeds 1024 and the write truncates, so the loop never completes (the
		// refactor pack failed on every non-trivial file for exactly this reason).
		// Give the tool-use loop a code-sized output budget.
		maxTokens = 1024
		if task.Tools != nil {
			maxTokens = 8192
		}
	}

	// ── forage: claim the scope ───────────────────────────────────────────
	claims := make([]coord.Claim, len(scope))
	for i, s := range scope {
		claims[i] = coord.Claim{Path: s, Mode: coord.ModeExclusive}
	}
	var branches []string
	if task.Branch != "" {
		branches = []string{task.Branch}
	}
	lease, err := a.Leases.Claim(ctx, coord.ClaimRequest{
		Agent:    a.Name,
		Branches: branches,
		Claims:   claims,
		Notes:    task.Name,
	})
	if err != nil {
		return Result{}, fmt.Errorf("forage: claim lease: %w", err)
	}
	res := Result{LeaseID: lease.ID}
	a.log(ledger.Entry{Kind: ledger.KindAgentStart, Agent: a.Name,
		Data: map[string]any{"task": task.Name, "capability": string(capability)}})
	a.log(ledger.Entry{Kind: ledger.KindLeaseClaim, Agent: a.Name,
		Data: map[string]any{"lease": lease.ID, "scope": scope}})

	// ── work: a single model call, or a bounded tool-use loop when the task
	//    carries a non-empty tool registry ─────────────────────────────────
	var wr workResult
	var chatErr error
	if task.Tools != nil && task.Tools.Len() > 0 {
		wr, chatErr = a.toolLoop(ctx, task, capability, maxTokens)
	} else {
		wr, chatErr = a.singleCall(ctx, task, capability, maxTokens)
	}

	// Copy whatever landed onto the result — partial included: the tool loop can
	// execute real tools and accumulate usage even on its failure paths.
	res.Text = wr.Text
	res.Usage = wr.Usage
	res.Provider = wr.Provider
	res.Model = wr.Model
	res.ToolCalls = wr.ToolCalls
	res.Degraded = append(res.Degraded, wr.Degraded...)

	if chatErr != nil {
		// heals posture: ship what landed, release the lease, no retry loop.
		// Redact any credential the transport/provider error may embed (e.g. a
		// URL query) before it reaches res.Err, the ledger, or the caller's stderr.
		safeErr := egress.RedactKnown(chatErr.Error())
		res.Err = safeErr
		a.log(ledger.Entry{Kind: ledger.KindAgentDone, Agent: a.Name,
			Data: map[string]any{"ok": false, "error": safeErr}})
		a.releaseAndLog(ctx, lease.ID)
		return res, errors.New(safeErr)
	}

	// ── return/feed: record the result, release the lease ─────────────────
	a.log(ledger.Entry{Kind: ledger.KindAgentDone, Agent: a.Name, Data: map[string]any{
		"ok": true, "chars": len(res.Text), "cost_usd": res.Usage.CostUSD,
	}})
	a.releaseAndLog(ctx, lease.ID)
	return res, nil
}

// workResult is the outcome of the work phase (a single call or the tool loop),
// accumulated so Run can copy it onto the Result uniformly on either path.
type workResult struct {
	Text      string
	Usage     router.Usage
	Provider  string
	Model     string
	Degraded  []string
	ToolCalls []ToolInvocation
}

// singleCall is the historical one-shot work phase: one model call, no tools.
func (a *Agent) singleCall(ctx context.Context, task Task, capability router.Capability, maxTokens int) (workResult, error) {
	resp, err := a.Router.Chat(ctx, router.ChatRequest{
		System:     systemPrompt,
		Messages:   []router.Message{{Role: "user", Content: task.Prompt}},
		MaxTokens:  maxTokens,
		Capability: capability,
		Model:      task.Model,
	})
	if err != nil {
		return workResult{Degraded: []string{"model-call-failed"}}, err
	}
	a.logModelCall(resp)
	return workResult{
		Text:     resp.Text,
		Usage:    resp.Usage,
		Provider: resp.Provider,
		Model:    resp.Model,
		Degraded: resp.Degraded,
	}, nil
}

// toolLoop is the bounded tool-use loop: offer the registry's tools, and each
// time the model requests tool calls, execute them via the registry, append the
// results to the transcript, and re-call — until the model returns a final answer
// (no tool calls) or the max-iterations cap trips (the runaway guard). Usage is
// accumulated across every model call in the loop; each tool run is logged to the
// ledger. A tool error is fed back to the model as an error result (heals
// posture) rather than aborting, so the cap is what ultimately bounds a
// misbehaving model.
func (a *Agent) toolLoop(ctx context.Context, task Task, capability router.Capability, maxTokens int) (workResult, error) {
	var wr workResult
	reg := task.Tools
	maxIters := task.MaxToolIters
	if maxIters <= 0 {
		maxIters = defaultMaxToolIters
	}
	schemas := toolSchemas(reg)
	messages := []router.Message{{Role: "user", Content: task.Prompt}}

	for iter := 0; iter < maxIters; iter++ {
		resp, err := a.Router.Chat(ctx, router.ChatRequest{
			System:     systemPrompt,
			Messages:   messages,
			MaxTokens:  maxTokens,
			Capability: capability,
			Model:      task.Model,
			Tools:      schemas,
		})
		if err != nil {
			wr.Degraded = append(wr.Degraded, "model-call-failed")
			return wr, err
		}
		// Accumulate usage/cost over the whole loop; keep the latest provider/model.
		wr.Usage.InputTokens += resp.Usage.InputTokens
		wr.Usage.OutputTokens += resp.Usage.OutputTokens
		wr.Usage.CachedTokens += resp.Usage.CachedTokens
		wr.Usage.CostUSD += resp.Usage.CostUSD
		if wr.Provider == "" {
			wr.Provider = resp.Provider
		}
		if resp.Model != "" {
			wr.Model = resp.Model
		}
		wr.Degraded = append(wr.Degraded, resp.Degraded...)
		a.logModelCall(resp)

		if len(resp.ToolCalls) == 0 {
			// Final answer — the model is done calling tools.
			wr.Text = resp.Text
			return wr, nil
		}

		// Record the assistant's tool-call turn, execute each requested tool, then
		// append the results as a user turn for the next model call.
		messages = append(messages, router.Message{
			Role:      "assistant",
			Content:   resp.Text,
			ToolCalls: resp.ToolCalls,
		})
		results := make([]router.ToolResult, 0, len(resp.ToolCalls))
		for _, tc := range resp.ToolCalls {
			tr, inv := a.execTool(ctx, reg, tc)
			results = append(results, tr)
			wr.ToolCalls = append(wr.ToolCalls, inv)
		}
		messages = append(messages, router.Message{Role: "user", ToolResults: results})
	}

	// Runaway guard tripped: the model kept calling tools past the cap. Heals
	// posture — ship what landed with a marker and a clear error so the caller
	// knows the loop did not converge.
	wr.Degraded = append(wr.Degraded, "tool-loop-max-iterations")
	return wr, fmt.Errorf("tool loop hit max iterations (%d) without a final answer", maxIters)
}

// execTool runs one requested tool call via the registry and returns both the
// wire ToolResult (fed back to the model) and the ToolInvocation (Result-level
// provenance). An unknown tool or an Execute error is turned into an error result
// — never a panic or a loop abort — so the model can recover.
func (a *Agent) execTool(ctx context.Context, reg *tool.Registry, tc router.ToolCall) (router.ToolResult, ToolInvocation) {
	inv := ToolInvocation{Name: tc.Name, Args: string(tc.Args)}
	t, ok := reg.Lookup(tc.Name)
	if !ok {
		msg := "unknown tool: " + tc.Name
		inv.Result, inv.IsError = msg, true
		a.logToolCall(tc.Name, string(tc.Args), false, msg)
		return router.ToolResult{ToolCallID: tc.ID, Name: tc.Name, Content: msg, IsError: true}, inv
	}
	out, err := t.Execute(ctx, tc.Args)
	if err != nil {
		safe := egress.RedactKnown(err.Error())
		inv.Result, inv.IsError = safe, true
		a.logToolCall(tc.Name, string(tc.Args), false, safe)
		return router.ToolResult{ToolCallID: tc.ID, Name: tc.Name, Content: safe, IsError: true}, inv
	}
	inv.Result = out
	// External-grounding classification: a tool that implements tool.Grounder
	// reports whether this (successful) result is a PASSING external oracle — the
	// provenance the swarm folds into the verdict's grounding. Non-Grounder tools
	// leave it false (judgment-only), so this never changes existing behavior.
	if g, ok := t.(tool.Grounder); ok {
		inv.Grounded = g.Grounds(out)
	}
	a.logToolCall(tc.Name, string(tc.Args), true, "")
	return router.ToolResult{ToolCallID: tc.ID, Name: tc.Name, Content: out}, inv
}

// toolSchemas maps a registry's tools to the wire schemas offered to the model,
// in the registry's deterministic order.
func toolSchemas(reg *tool.Registry) []router.ToolSchema {
	tools := reg.List()
	out := make([]router.ToolSchema, 0, len(tools))
	for _, t := range tools {
		out = append(out, router.ToolSchema{
			Name:        t.Name(),
			Description: t.Description(),
			InputSchema: t.InputSchema(),
		})
	}
	return out
}

// logModelCall records one model call in the audit ledger (per loop iteration).
func (a *Agent) logModelCall(resp router.ChatResponse) {
	a.log(ledger.Entry{Kind: ledger.KindModelCall, Agent: a.Name, Data: map[string]any{
		"provider":      resp.Provider,
		"model":         resp.Model,
		"input_tokens":  resp.Usage.InputTokens,
		"output_tokens": resp.Usage.OutputTokens,
		"cached_tokens": resp.Usage.CachedTokens,
		"cost_usd":      resp.Usage.CostUSD,
	}})
}

// logToolCall records one tool execution in the audit ledger — the provenance
// trail that proves which tool a bee invoked with what arguments and whether it
// succeeded. The ledger's egress redaction covers the whole line, so an argument
// or error carrying a credential shape never persists.
func (a *Agent) logToolCall(name, args string, ok bool, errMsg string) {
	data := map[string]any{"tool": name, "args": args, "ok": ok}
	if errMsg != "" {
		data["error"] = errMsg
	}
	a.log(ledger.Entry{Kind: ledger.KindToolCall, Agent: a.Name, Data: data})
}

func (a *Agent) releaseAndLog(ctx context.Context, leaseID string) {
	if err := a.Leases.Release(ctx, leaseID, a.Name); err != nil {
		a.log(ledger.Entry{Kind: ledger.KindLeaseRelease, Agent: a.Name,
			Data: map[string]any{"lease": leaseID, "error": err.Error()}})
		return
	}
	a.log(ledger.Entry{Kind: ledger.KindLeaseRelease, Agent: a.Name,
		Data: map[string]any{"lease": leaseID}})
}

func (a *Agent) log(e ledger.Entry) {
	if a.Ledger == nil {
		return
	}
	_ = a.Ledger.Append(e)
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
