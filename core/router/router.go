// Package router is the model-agnostic capability router — the heart of the
// Agix orchestration core. A caller asks for a Capability (or an explicit
// Model); the router resolves it to a provider+model via the RoutingTable,
// dispatches to the registered Provider adapter, fills the cost from the rate
// card, and appends honest Degraded markers when a requested native feature
// (e.g. Anthropic prompt caching) is not supported by the routed provider.
//
// The routing table is the single place to re-route a capability (e.g.
// Sonnet -> GPT) without touching agent code — the model-agnostic contract.
// Being agnostic must NOT collapse to a lowest-common-denominator call: each
// Provider advertises its native efficiency features via Capabilities() and
// the router preserves them on the way through.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Capability is a task-shaped routing key. Agents ask for a capability, not a
// model, so the model choice stays a one-place edit in the RoutingTable.
type Capability string

// The capability set, mirroring lib/model-adapters/routing.mjs.
const (
	CapDefaultQuality      Capability = "default-quality"
	CapCheapClassification Capability = "cheap-classification"
	CapLongContext         Capability = "long-context"
	CapToolUseHeavy        Capability = "tool-use-heavy"
	CapVision              Capability = "vision"
)

// Route is a resolved provider+model for a capability.
type Route struct {
	Provider   string
	Model      string
	Capability Capability
}

// RoutingTable maps each Capability to a Route.
type RoutingTable map[Capability]Route

// DefaultRoutingTable returns a fresh copy of the canonical routing table,
// mirroring lib/model-adapters/routing.mjs. A fresh map each call so callers
// may mutate their router's table (e.g. ForceProvider) without side effects.
func DefaultRoutingTable() RoutingTable {
	return RoutingTable{
		CapDefaultQuality:      {Provider: "anthropic", Model: "claude-sonnet-5"},
		CapCheapClassification: {Provider: "anthropic", Model: "claude-haiku-4-5"},
		CapLongContext:         {Provider: "anthropic", Model: "claude-opus-4-8"},
		CapToolUseHeavy:        {Provider: "anthropic", Model: "claude-sonnet-5"},
		CapVision:              {Provider: "gemini", Model: "gemini-2.5-flash"},
	}
}

// Message is one chat turn. Beyond plain text, a turn can carry the structured
// pieces of a tool-use exchange: an assistant turn may request tool calls, and a
// user turn may feed the results of previously requested calls back to the model.
// Both are omitempty, so a plain text conversation is byte-for-byte unchanged.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// ToolCalls, on an assistant turn, are the tool calls the model requested that
	// turn (mirrors ChatResponse.ToolCalls). The tool-use loop appends this turn
	// to the transcript before it executes the calls.
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	// ToolResults, on a user turn, feed the executed tool outputs back to the
	// model, each matched to its request by ToolCallID.
	ToolResults []ToolResult `json:"tool_results,omitempty"`
}

// ToolSchema is a tool definition offered to the model in a ChatRequest. It is
// the wire shape of a tool.Tool: the model sees the name/description/schema and
// decides whether to call it. (core/tool owns the Tool interface; the loop in
// core/agent maps each registered tool to a ToolSchema.)
type ToolSchema struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema,omitempty"`
}

// ToolCall is the model's request to invoke one tool. ID is the provider's
// correlation handle (echoed back on the matching ToolResult); Args is the raw
// JSON arguments the model produced for the tool.
type ToolCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args,omitempty"`
}

// ToolResult is the outcome of executing a ToolCall, fed back to the model as a
// user turn. IsError marks a failed execution so the model can adapt (the loop
// feeds tool errors back rather than aborting — the heals posture).
type ToolResult struct {
	ToolCallID string `json:"tool_call_id"`
	Name       string `json:"name,omitempty"`
	Content    string `json:"content"`
	IsError    bool   `json:"is_error,omitempty"`
}

// ChatRequest is a provider-agnostic chat request. The native-efficiency seams
// (CacheBreakpoints, ResponseSchema) are honored by adapters that support them
// and surfaced as Degraded markers by those that do not.
type ChatRequest struct {
	System     string
	Messages   []Message
	MaxTokens  int
	Capability Capability
	// Model overrides Capability when set (bypasses the table; provider is
	// inferred from the model id prefix).
	Model string
	// CacheBreakpoints are message indices at which to place an Anthropic
	// cache_control breakpoint (the prompt-caching cost lever).
	CacheBreakpoints []int
	// ResponseSchema is a structured-output JSON schema (native on Anthropic
	// tool-forcing / OpenAI response_format / Gemini responseSchema).
	ResponseSchema json.RawMessage
	// Tools are the tool definitions offered to the model for this call. When the
	// model wants to use one, the ChatResponse carries ToolCalls; the tool-use
	// loop (core/agent) executes them via the registry and re-calls with the
	// results. A provider that does not parse tool calls (Capabilities.ToolUse
	// false) surfaces an honest "tool-use-unsupported" Degraded marker.
	Tools []ToolSchema
}

// Usage is per-call token accounting plus computed cost.
type Usage struct {
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CachedTokens int     `json:"cached_tokens"`
	CostUSD      float64 `json:"cost_usd"`
}

// ChatResponse is a provider-agnostic chat response. Degraded lists native
// features that were requested but not preserved (never silently dropped).
type ChatResponse struct {
	Text     string
	Usage    Usage
	Provider string
	Model    string
	Degraded []string
	// ToolCalls, when non-empty, are the tools the model wants executed before it
	// will produce a final answer. The tool-use loop runs each via the registry,
	// appends the results, and re-calls the model. Empty means Text is the final
	// answer (the ordinary single-shot path).
	ToolCalls []ToolCall
}

// Capabilities is a provider adapter's honest native-feature surface. The
// router routes to the best provider AND preserves these on the way through.
type Capabilities struct {
	PromptCaching bool
	// StructuredOutput is one of "native", "json_mode", "prompt", or "".
	StructuredOutput string
	Streaming        bool
	Batch            bool
	// ToolUse reports whether the adapter parses the model's native tool calls
	// into ChatResponse.ToolCalls. When false and a call offers Tools, the router
	// appends an honest "tool-use-unsupported" Degraded marker rather than
	// silently dropping the tools (the real-provider parsing is a later slice).
	ToolUse bool
}

// Provider is a model provider adapter. Implementations live under
// core/provider/{anthropic,openai,gemini,mock}.
type Provider interface {
	Name() string
	Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
	Capabilities() Capabilities
}

// Router resolves capabilities/models to providers and dispatches chats.
type Router struct {
	providers map[string]Provider
	table     RoutingTable
	// forced is the provider every call is pinned to once ForceProvider is
	// called (the CLI's `--provider X` lane). Empty means "route normally".
	forced string
}

// NewRouter builds a Router with the default routing table.
func NewRouter() *Router {
	return &Router{providers: map[string]Provider{}, table: DefaultRoutingTable()}
}

// NewRouterWithTable builds a Router with a caller-supplied table.
func NewRouterWithTable(table RoutingTable) *Router {
	return &Router{providers: map[string]Provider{}, table: table}
}

// Register adds a provider under its Name().
func (r *Router) Register(p Provider) { r.providers[p.Name()] = p }

// ForceProvider rewrites every route's Provider to name (keeping models) AND
// pins explicit-model calls to the same provider. Used by the CLI's
// `--provider X` lane so the whole run targets one provider; mock is a synthetic
// provider the table never routes to by default. Pinning explicit-model calls
// matters for the mock lane: an explicit model (even a made-up id) must reach
// the forced provider instead of being prefix-inferred to an unregistered one.
func (r *Router) ForceProvider(name string) {
	r.forced = name
	for cap, route := range r.table {
		route.Provider = name
		r.table[cap] = route
	}
}

// Resolve maps a Capability to its Route.
func (r *Router) Resolve(c Capability) (Route, error) {
	route, ok := r.table[c]
	if !ok {
		return Route{}, fmt.Errorf("unknown capability %q; known: %s", c, r.knownCaps())
	}
	route.Capability = c
	return route, nil
}

func (r *Router) knownCaps() string {
	keys := make([]string, 0, len(r.table))
	for k := range r.table {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// ResolveModel infers a Route from an explicit model id via prefix rules,
// mirroring lib/model-adapters/routing.mjs (claude-* -> anthropic,
// gpt-/o1/o3/o4 -> openai, gemini-* -> gemini).
func (r *Router) ResolveModel(model string) (Route, error) {
	provider, err := providerForModel(model)
	if err != nil {
		return Route{}, err
	}
	return Route{Provider: provider, Model: model}, nil
}

func providerForModel(model string) (string, error) {
	id := strings.ToLower(strings.TrimSpace(model))
	if id == "" {
		return "", errors.New("resolveModel: model must be non-empty")
	}
	switch {
	case strings.HasPrefix(id, "claude-"):
		return "anthropic", nil
	case strings.HasPrefix(id, "gpt-"), strings.HasPrefix(id, "o1"),
		strings.HasPrefix(id, "o3"), strings.HasPrefix(id, "o4"):
		return "openai", nil
	case strings.HasPrefix(id, "gemini-"):
		return "gemini", nil
	}
	return "", fmt.Errorf("cannot infer provider for model %q; add a prefix rule", model)
}

// Chat resolves the request (by Model, else Capability) to a provider, calls
// the adapter, fills Usage.CostUSD from the rate card, and appends honest
// Degraded markers for any requested native feature the provider lacks.
func (r *Router) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	var (
		route Route
		err   error
	)
	switch {
	case req.Model != "":
		if r.forced != "" {
			// A forced provider treats the model id as opaque and routes it
			// straight there — no prefix inference (which would reject ids
			// that don't match a known provider prefix, e.g. under mock).
			route = Route{Provider: r.forced, Model: req.Model}
		} else {
			route, err = r.ResolveModel(req.Model)
		}
	case req.Capability != "":
		route, err = r.Resolve(req.Capability)
	default:
		return ChatResponse{}, errors.New("router: ChatRequest needs a Capability or a Model")
	}
	if err != nil {
		return ChatResponse{}, err
	}

	p, ok := r.providers[route.Provider]
	if !ok {
		return ChatResponse{}, fmt.Errorf("no provider registered for %q (route %s/%s)",
			route.Provider, route.Provider, route.Model)
	}

	// Pass the resolved model into the request so the adapter knows what to call.
	call := req
	if call.Model == "" {
		call.Model = route.Model
	}
	resp, err := p.Chat(ctx, call)
	if err != nil {
		return ChatResponse{}, fmt.Errorf("provider %s chat: %w", route.Provider, err)
	}
	if resp.Provider == "" {
		resp.Provider = route.Provider
	}
	if resp.Model == "" {
		resp.Model = route.Model
	}

	// Honest degraded discipline: never silently drop a requested native feature.
	caps := p.Capabilities()
	if len(req.CacheBreakpoints) > 0 && !caps.PromptCaching {
		resp.Degraded = append(resp.Degraded, "prompt-caching-unsupported:"+route.Provider)
	}
	if len(req.ResponseSchema) > 0 && caps.StructuredOutput == "" {
		resp.Degraded = append(resp.Degraded, "structured-output-unsupported:"+route.Provider)
	}
	if len(req.Tools) > 0 && !caps.ToolUse {
		resp.Degraded = append(resp.Degraded, "tool-use-unsupported:"+route.Provider)
	}

	// Fill cost from the rate card on the model actually used.
	resp.Usage.CostUSD = Cost(resp.Model, resp.Usage.InputTokens, resp.Usage.OutputTokens, resp.Usage.CachedTokens)
	return resp, nil
}
