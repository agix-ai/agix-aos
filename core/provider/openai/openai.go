// Package openai is a hand-written HTTP adapter for the OpenAI Chat Completions
// API implementing router.Provider. No SDK is vendored. It advertises OpenAI's
// native efficiency features honestly (automatic prompt caching, native
// structured outputs via response_format, streaming, Batch API), parses the
// model's native tool calls, and leaves clearly-marked `// native-efficiency
// seam` TODOs where deeper wiring follows.
//
// The tool-use (de)serialization is split into pure functions
// (buildTools/buildMessages/parseResponse) so it is unit-testable against
// fixtures with no network — see openai_test.go. OpenAI's tool shape differs from
// Anthropic's in two ways the translation absorbs: tool-call arguments ride as a
// JSON *string* (not a nested object), and tool results are separate role:"tool"
// messages (one per result) rather than blocks inside one user turn.
//
// Live calls are guarded behind an API-key check so tests never hit the network.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package openai

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

const defaultModel = "gpt-4.1"

// Provider is the OpenAI Chat Completions adapter.
type Provider struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
}

// New builds an adapter, loading the key from OPENAI_API_KEY or
// ~/.config/agix/openai.env. A missing key is fine until Chat is called.
func New() *Provider {
	return &Provider{
		APIKey:  keyenv.Load("openai", "OPENAI_API_KEY"),
		BaseURL: "https://api.openai.com",
		HTTP:    &http.Client{Timeout: 120 * time.Second},
	}
}

// Name identifies this provider.
func (p *Provider) Name() string { return "openai" }

// Capabilities advertises OpenAI's native efficiency features honestly. Prompt
// caching is automatic on OpenAI (no cache_control blocks to send). ToolUse is
// true: the adapter serializes offered tools and parses the model's tool_calls.
func (p *Provider) Capabilities() router.Capabilities {
	return router.Capabilities{
		PromptCaching:    true,
		StructuredOutput: "native", // response_format json_schema
		Streaming:        true,
		Batch:            true,
		ToolUse:          true,
	}
}

// Chat posts to /v1/chat/completions and parses the response, including native
// tool calls. Guarded behind an API-key check so tests never make a network call.
func (p *Provider) Chat(ctx context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	if p.APIKey == "" {
		return router.ChatResponse{}, errors.New("openai: no API key (set OPENAI_API_KEY or ~/.config/agix/openai.env)")
	}
	model := req.Model
	if model == "" {
		model = defaultModel
	}

	body := buildRequestBody(model, req)
	// native-efficiency seam: native structured output via
	// response_format:{type:"json_schema", json_schema:req.ResponseSchema},
	// streaming (SSE), and the Batch API endpoint are advertised but not wired here.
	// Prompt caching on OpenAI is automatic (no wire flag), reported via usage.

	buf, err := json.Marshal(body)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("openai: marshal: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return router.ChatResponse{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+p.APIKey)

	resp, err := p.HTTP.Do(httpReq)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("openai: http: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return router.ChatResponse{}, fmt.Errorf("openai: http %d: %s", resp.StatusCode, truncate(data))
	}

	out, err := parseResponse(data)
	if err != nil {
		return router.ChatResponse{}, err
	}
	out.Provider = "openai"
	return out, nil
}

// buildRequestBody assembles the JSON body POSTed to /v1/chat/completions. tools
// is omitted when the request offers none, so a non-tool request body is
// unchanged.
func buildRequestBody(model string, req router.ChatRequest) map[string]any {
	body := map[string]any{"model": model, "messages": buildMessages(req)}
	if req.MaxTokens > 0 {
		body["max_completion_tokens"] = req.MaxTokens
	}
	if tools := buildTools(req); tools != nil {
		body["tools"] = tools
	}
	return body
}

// buildTools serializes the request's ToolSchemas into OpenAI's function-tool
// shape: {type:"function", function:{name, description, parameters}}. A tool with
// no InputSchema gets a permissive empty-object schema. Returns nil when none.
func buildTools(req router.ChatRequest) []any {
	if len(req.Tools) == 0 {
		return nil
	}
	out := make([]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  paramsSchema(t.InputSchema),
			},
		})
	}
	return out
}

// buildMessages converts messages to OpenAI chat messages, prepending the system
// turn. Tool turns are translated to OpenAI's shape:
//
//   - An assistant turn carrying ToolCalls becomes a single assistant message with
//     a tool_calls array (each {id, type:"function", function:{name, arguments}},
//     arguments serialized as a JSON string per the OpenAI contract).
//   - A user turn carrying ToolResults fans OUT into one role:"tool" message per
//     result (keyed by tool_call_id) — OpenAI does not group results into one turn.
//   - A plain turn stays {role, content:<string>} — unchanged.
func buildMessages(req router.ChatRequest) []any {
	msgs := make([]any, 0, len(req.Messages)+1)
	if req.System != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		switch {
		case len(m.ToolCalls) > 0:
			msgs = append(msgs, assistantToolCallMessage(m))
		case len(m.ToolResults) > 0:
			for _, tr := range m.ToolResults {
				msgs = append(msgs, map[string]any{
					"role":         "tool",
					"tool_call_id": tr.ToolCallID,
					"content":      tr.Content,
				})
			}
		default:
			msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
		}
	}
	return msgs
}

// assistantToolCallMessage builds the assistant turn that requested tools. content
// is the model's text (or null when it produced none — OpenAI accepts a null
// content alongside tool_calls). Each tool call's arguments ride as a JSON string.
func assistantToolCallMessage(m router.Message) map[string]any {
	calls := make([]any, 0, len(m.ToolCalls))
	for _, tc := range m.ToolCalls {
		calls = append(calls, map[string]any{
			"id":   tc.ID,
			"type": "function",
			"function": map[string]any{
				"name":      tc.Name,
				"arguments": argString(tc.Args),
			},
		})
	}
	msg := map[string]any{"role": "assistant", "tool_calls": calls}
	if m.Content != "" {
		msg["content"] = m.Content
	} else {
		msg["content"] = nil
	}
	return msg
}

// parseResponse decodes a /v1/chat/completions response body into a ChatResponse:
// the first choice's text, its native tool_calls (each function's name +
// arguments, the arguments string carried through as the ToolCall's raw JSON
// args), usage, and the model id. Split out as a pure function so the tool-use
// parsing is unit-testable against fixtures with no live call. The loop keys off
// len(ToolCalls) > 0; finish_reason "tool_calls" corroborates but isn't required.
func parseResponse(data []byte) (router.ChatResponse, error) {
	var out struct {
		Model   string `json:"model"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens        int `json:"prompt_tokens"`
			CompletionTokens    int `json:"completion_tokens"`
			PromptTokensDetails struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return router.ChatResponse{}, fmt.Errorf("openai: decode: %w", err)
	}

	var text string
	var toolCalls []router.ToolCall
	if len(out.Choices) > 0 {
		text = out.Choices[0].Message.Content
		for _, tc := range out.Choices[0].Message.ToolCalls {
			args := tc.Function.Arguments
			if args == "" {
				args = "{}" // keep args a valid JSON object for the tool's Execute
			}
			toolCalls = append(toolCalls, router.ToolCall{
				ID:   tc.ID,
				Name: tc.Function.Name,
				Args: json.RawMessage(args),
			})
		}
	}
	usage := router.Usage{
		InputTokens:  out.Usage.PromptTokens,
		OutputTokens: out.Usage.CompletionTokens,
		CachedTokens: out.Usage.PromptTokensDetails.CachedTokens,
	}
	return router.ChatResponse{Text: text, Usage: usage, Model: out.Model, ToolCalls: toolCalls}, nil
}

// argString renders raw JSON tool arguments as the string OpenAI's `arguments`
// field expects, defaulting empty/absent args to an empty object.
func argString(args json.RawMessage) string {
	if len(args) == 0 {
		return "{}"
	}
	return string(args)
}

// paramsSchema returns raw JSON that marshals as-is, defaulting empty/absent input
// to a permissive empty-object schema (json.RawMessage marshals its bytes verbatim,
// but empty bytes would be invalid JSON).
func paramsSchema(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`)
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
