package orchestrator

import (
	"context"
	"fmt"

	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/router"
)

// AgentNode is the forage/work bee as a graph node: it reads a prompt from
// State, routes a Capability through the model-agnostic router, appends both
// turns to the Transcript, writes the reply back into State, and records a
// model_call ledger entry. Deterministic + zero-cost under the mock provider.
type AgentNode struct {
	NodeName   string
	AgentName  string // ledger attribution (the bee's identity); defaults to NodeName
	Capability router.Capability
	Router     *router.Router
	Ledger     *ledger.Ledger // optional; nil disables audit
	System     string         // optional system prompt

	// PromptKey is the State.Data key holding this node's user prompt.
	// Defaults to "task".
	PromptKey string
	// OutputKey is the State.Data key the reply is written under.
	// Defaults to NodeName+".output".
	OutputKey string
}

// Name implements Node.
func (a *AgentNode) Name() string { return a.NodeName }

// Run implements Node: forage the prompt from State, route the call, feed the
// result back into State + Transcript, audit the model_call.
func (a *AgentNode) Run(ctx context.Context, s *State) (NodeResult, error) {
	promptKey := a.PromptKey
	if promptKey == "" {
		promptKey = "task"
	}
	outputKey := a.OutputKey
	if outputKey == "" {
		outputKey = a.NodeName + ".output"
	}
	capability := a.Capability
	if capability == "" {
		capability = router.CapDefaultQuality
	}

	prompt := s.GetString(promptKey)
	s.Append(router.Message{Role: "user", Content: prompt})

	messages := make([]router.Message, len(s.Transcript))
	copy(messages, s.Transcript)

	resp, err := a.Router.Chat(ctx, router.ChatRequest{
		System:     a.System,
		Messages:   messages,
		MaxTokens:  1024,
		Capability: capability,
	})
	if err != nil {
		// heals posture: surface the failure, do not retry-loop. The runner
		// decides how to degrade the walk.
		return NodeResult{}, fmt.Errorf("node %s: model call: %w", a.NodeName, err)
	}

	s.Append(router.Message{Role: "assistant", Content: resp.Text})
	s.Set(outputKey, resp.Text)

	a.log(ledger.Entry{Kind: ledger.KindModelCall, Agent: a.agentName(), Data: map[string]any{
		"node":          a.NodeName,
		"provider":      resp.Provider,
		"model":         resp.Model,
		"input_tokens":  resp.Usage.InputTokens,
		"output_tokens": resp.Usage.OutputTokens,
		"cached_tokens": resp.Usage.CachedTokens,
		"cost_usd":      resp.Usage.CostUSD,
	}})

	return NodeResult{}, nil
}

func (a *AgentNode) agentName() string {
	if a.AgentName != "" {
		return a.AgentName
	}
	return a.NodeName
}

func (a *AgentNode) log(e ledger.Entry) {
	if a.Ledger == nil {
		return
	}
	_ = a.Ledger.Append(e)
}

var _ Node = (*AgentNode)(nil)

// GateNode is the governance gate — actor≠verifier made mechanical. It does NOT
// decide: Run builds an Interrupt describing what must be ratified (the actor's
// output, read from RatifyKey) and returns it, pausing the run. On Resume the
// runner calls Resolve with the verifier's GateDecision, routing to OnApprove
// (work enters the comb) or OnReject (divert to remediation).
type GateNode struct {
	NodeName  string
	OnApprove string // next node when ratified
	OnReject  string // next node when rejected
	// RatifyKey is the State.Data key whose value is the subject under review.
	RatifyKey string
}

// Name implements Node.
func (g *GateNode) Name() string { return g.NodeName }

// Run implements Node: raise a "ratify" Interrupt carrying the subject. The gate
// never decides here — it hands off to a different bee/human.
func (g *GateNode) Run(_ context.Context, s *State) (NodeResult, error) {
	payload := map[string]any{
		"gate":      g.NodeName,
		"ratifyKey": g.RatifyKey,
	}
	if v, ok := s.Get(g.RatifyKey); ok {
		payload["subject"] = v
	}
	return NodeResult{Interrupt: &Interrupt{
		ID:       "ratify-" + g.NodeName,
		Kind:     "ratify",
		NodeName: g.NodeName,
		Payload:  payload,
	}}, nil
}

// Resolve implements Gate: map an approval to OnApprove, a rejection to
// OnReject. Empty targets terminate the walk (End).
func (g *GateNode) Resolve(_ *State, d GateDecision) (string, error) {
	if d.Approved {
		if g.OnApprove == "" {
			return End, nil
		}
		return g.OnApprove, nil
	}
	if g.OnReject == "" {
		return End, nil
	}
	return g.OnReject, nil
}

// Targets implements targetLister so Graph.Validate checks the gate's routes.
func (g *GateNode) Targets() []string { return []string{g.OnApprove, g.OnReject} }

var (
	_ Node = (*GateNode)(nil)
	_ Gate = (*GateNode)(nil)
)
