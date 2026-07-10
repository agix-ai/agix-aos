// Package anthropic is a hand-written HTTP adapter for the Anthropic Messages
// API implementing router.Provider. No SDK is vendored — the single-binary
// story keeps to stdlib. It is capability-rich, not lowest-common-denominator:
// it implements cache_control prompt caching (the big cost lever) at the wire
// level, parses the model's native tool calls (the tool-use loop's real-provider
// path), and advertises its native features honestly via Capabilities().
//
// Live calls are guarded behind an API-key check so `go test`/CI never hit the
// network. Deeper native-efficiency features (Batch API, streaming, extended
// thinking) are marked with `// native-efficiency seam` TODOs where the work
// follows. The tool-use (de)serialization is split into pure functions
// (buildTools/buildMessages/parseResponse) so it is unit-testable against
// fixtures with no network — see anthropic_test.go.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/agix-ai/agix/core/provider/keyenv"
	"github.com/agix-ai/agix/core/router"
)

const defaultModel = "claude-sonnet-5"

// Provider is the Anthropic Messages API adapter.
type Provider struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
}

// New builds an adapter, loading the key from ANTHROPIC_API_KEY or
// ~/.config/agix/anthropic.env. A missing key is fine until Chat is called.
func New() *Provider {
	return &Provider{
		APIKey:  keyenv.Load("anthropic", "ANTHROPIC_API_KEY"),
		BaseURL: "https://api.anthropic.com",
		HTTP:    &http.Client{Timeout: 120 * time.Second},
	}
}

// Name identifies this provider.
func (p *Provider) Name() string { return "anthropic" }

// Capabilities advertises Anthropic's native efficiency features honestly.
// ToolUse is true: the adapter serializes offered tools onto the Messages API
// request and parses the model's tool_use content blocks back into ToolCalls.
func (p *Provider) Capabilities() router.Capabilities {
	return router.Capabilities{
		PromptCaching:    true,
		StructuredOutput: "native", // via tool-forcing
		Streaming:        true,
		Batch:            true,
		ToolUse:          true,
	}
}

// Chat posts to /v1/messages and parses the response. cache_control prompt
// caching is applied when the request carries CacheBreakpoints; offered tools
// are serialized and the model's tool_use blocks are parsed back into
// ChatResponse.ToolCalls. Guarded behind an API-key check so tests never make a
// network call.
func (p *Provider) Chat(ctx context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	if p.APIKey == "" {
		return router.ChatResponse{}, errors.New("anthropic: no API key (set ANTHROPIC_API_KEY or ~/.config/agix/anthropic.env)")
	}
	model := req.Model
	if model == "" {
		model = defaultModel
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	body := buildRequestBody(model, maxTokens, req)

	buf, err := json.Marshal(body)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("anthropic: marshal: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/v1/messages", bytes.NewReader(buf))
	if err != nil {
		return router.ChatResponse{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", p.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := p.HTTP.Do(httpReq)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("anthropic: http: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return router.ChatResponse{}, fmt.Errorf("anthropic: http %d: %s", resp.StatusCode, truncate(data))
	}

	out, err := parseResponse(data)
	if err != nil {
		return router.ChatResponse{}, err
	}
	out.Provider = "anthropic"
	return out, nil
}

// parseResponse decodes a /v1/messages response body into a ChatResponse: text
// (concatenated text blocks), ToolCalls (each tool_use block's id/name/input),
// usage, and the model id. Split out as a pure function so the tool-use parsing
// is unit-testable against fixtures without a live call. The tool-use loop keys
// off len(ToolCalls) > 0, so parsing the tool_use blocks — regardless of
// stop_reason — is what makes a call drive the loop; stop_reason is captured for
// completeness but not load-bearing here.
func parseResponse(data []byte) (router.ChatResponse, error) {
	var out struct {
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return router.ChatResponse{}, fmt.Errorf("anthropic: decode: %w", err)
	}

	var text string
	var toolCalls []router.ToolCall
	for _, block := range out.Content {
		switch block.Type {
		case "text":
			text += block.Text
		case "tool_use":
			toolCalls = append(toolCalls, router.ToolCall{
				ID:   block.ID,
				Name: block.Name,
				Args: block.Input,
			})
		}
	}
	// native-efficiency seam: cache-creation (write) tokens bill at ~1.25x, not the
	// cached-read rate — folded into InputTokens here, not split out in the rate card.
	usage := router.Usage{
		InputTokens:  out.Usage.InputTokens + out.Usage.CacheCreationInputTokens + out.Usage.CacheReadInputTokens,
		OutputTokens: out.Usage.OutputTokens,
		CachedTokens: out.Usage.CacheReadInputTokens,
	}
	return router.ChatResponse{Text: text, Usage: usage, Model: out.Model, ToolCalls: toolCalls}, nil
}

// buildRequestBody assembles the JSON body POSTed to /v1/messages. It sets ONLY
// model, max_tokens, messages, and (when present) system and tools — deliberately
// NOT temperature, top_p, top_k, thinking.budget_tokens, or a last-assistant-turn
// prefill, every one of which the Messages API REJECTS with a 400 on
// claude-opus-4-8 and claude-sonnet-5 (and the rest of the 4.7+ family). Keeping
// the body in one place makes that guarantee unit-testable (anthropic_test.go).
// tools is omitted entirely when the request offers none, so a non-tool request
// body is byte-for-byte unchanged.
//
// native-efficiency seam: response_format via tool-forcing (req.ResponseSchema),
// adaptive thinking + effort, streaming (SSE), and the Batch API endpoint are
// advertised in Capabilities() but not wired at the call site yet — and when
// they are, thinking must be sent as {"type":"adaptive"}, never budget_tokens.
func buildRequestBody(model string, maxTokens int, req router.ChatRequest) map[string]any {
	body := map[string]any{
		"model":      model,
		"max_tokens": maxTokens,
		"messages":   buildMessages(req),
	}
	if sys := buildSystem(req); sys != nil {
		body["system"] = sys
	}
	if tools := buildTools(req); tools != nil {
		body["tools"] = tools
	}
	return body
}

// buildTools serializes the request's ToolSchemas into the Anthropic `tools`
// array — {name, description, input_schema} per tool. A tool with no InputSchema
// gets a permissive empty-object schema so the wire stays valid. Returns nil when
// no tools are offered.
func buildTools(req router.ChatRequest) []any {
	if len(req.Tools) == 0 {
		return nil
	}
	out := make([]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		out = append(out, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": rawObject(t.InputSchema),
		})
	}
	return out
}

// buildSystem returns the system field. When caching is requested it attaches a
// cache_control breakpoint to the system block — caching the (typically large)
// system prompt is the primary Anthropic cost lever.
func buildSystem(req router.ChatRequest) any {
	if req.System == "" {
		return nil
	}
	block := map[string]any{"type": "text", "text": req.System}
	if len(req.CacheBreakpoints) > 0 {
		block["cache_control"] = map[string]any{"type": "ephemeral"}
	}
	return []any{block}
}

// buildMessages converts messages to Anthropic message objects. A cache_control
// breakpoint is attached to any plain-text message whose index is listed in
// req.CacheBreakpoints. Tool turns (ToolCalls / ToolResults) become content-block
// arrays; see buildMessage.
func buildMessages(req router.ChatRequest) []any {
	bp := make(map[int]bool, len(req.CacheBreakpoints))
	for _, i := range req.CacheBreakpoints {
		bp[i] = true
	}
	out := make([]any, len(req.Messages))
	for i, m := range req.Messages {
		out[i] = buildMessage(m, bp[i])
	}
	return out
}

// buildMessage serializes one router.Message to an Anthropic message object.
//
//   - An assistant turn carrying ToolCalls becomes {role, content:[tool_use…]}
//     (with a leading text block only when the model also produced text).
//   - A user turn carrying ToolResults becomes {role, content:[tool_result…]};
//     per the Anthropic docs the tool_result blocks lead the turn, which they do
//     as the only content here.
//   - A plain text turn stays {role, content:<string>}, or — when a cache
//     breakpoint promotes it — a single text block carrying cache_control. This
//     path is byte-identical to the pre-tool behavior, so plain conversations are
//     unchanged (asserted in anthropic_test.go).
//
// Tool turns take priority over the cache branch: a cache breakpoint placed on a
// tool turn is a no-op (the honest prompt-cache↔tool-result interaction is a
// flagged gap, not silently mishandled).
func buildMessage(m router.Message, cache bool) map[string]any {
	switch {
	case len(m.ToolCalls) > 0:
		return map[string]any{"role": m.Role, "content": toolUseBlocks(m)}
	case len(m.ToolResults) > 0:
		return map[string]any{"role": m.Role, "content": toolResultBlocks(m)}
	case cache:
		return map[string]any{
			"role": m.Role,
			"content": []any{map[string]any{
				"type":          "text",
				"text":          m.Content,
				"cache_control": map[string]any{"type": "ephemeral"},
			}},
		}
	default:
		return map[string]any{"role": m.Role, "content": m.Content}
	}
}

// toolUseBlocks builds the content blocks for an assistant turn that requested
// tools: an optional leading text block (only when the model also produced text),
// then one tool_use block per ToolCall. input is the ToolCall's raw JSON args,
// passed through verbatim; empty/absent args become an empty object so the block
// stays a valid tool_use.
func toolUseBlocks(m router.Message) []any {
	blocks := make([]any, 0, len(m.ToolCalls)+1)
	if m.Content != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
	}
	for _, tc := range m.ToolCalls {
		blocks = append(blocks, map[string]any{
			"type":  "tool_use",
			"id":    tc.ID,
			"name":  tc.Name,
			"input": rawObject(tc.Args),
		})
	}
	return blocks
}

// toolResultBlocks builds the content blocks for a user turn that returns tool
// outputs: one tool_result block per ToolResult, each keyed to its request by
// tool_use_id, with is_error set only on a failed execution (the heals posture —
// the loop feeds tool errors back rather than aborting).
func toolResultBlocks(m router.Message) []any {
	blocks := make([]any, 0, len(m.ToolResults))
	for _, tr := range m.ToolResults {
		block := map[string]any{
			"type":        "tool_result",
			"tool_use_id": tr.ToolCallID,
			"content":     tr.Content,
		}
		if tr.IsError {
			block["is_error"] = true
		}
		blocks = append(blocks, block)
	}
	return blocks
}

// rawObject returns raw JSON that marshals as-is, defaulting empty/absent input
// to an empty object. json.RawMessage marshals to its bytes verbatim (so a schema
// or tool-argument object is emitted as a nested object, not a re-encoded string),
// but empty bytes would produce invalid JSON — hence the {} default.
func rawObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func truncate(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

var _ router.Provider = (*Provider)(nil)
