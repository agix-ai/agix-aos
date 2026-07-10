// Package anthropic internal tests: prove the request body the adapter POSTs to
// /v1/messages carries NONE of the parameters the Messages API rejects with a
// 400 on claude-opus-4-8 / claude-sonnet-5 (temperature, top_p, top_k,
// thinking.budget_tokens, assistant prefill). These are the money-savers for a
// real paid run — a stray rejected param 400s the whole call. No network: the
// body-shape test marshals directly, the wire test uses httptest.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

// rejectedParams are the keys that 400 on claude-opus-4-8 / claude-sonnet-5.
// "thinking" covers the {"type":"enabled","budget_tokens":N} shape; "budget_tokens"
// catches it even if nested differently.
var rejectedParams = []string{"temperature", "top_p", "top_k", "budget_tokens", "thinking"}

func TestBuildRequestBodyOmitsRejectedParams(t *testing.T) {
	req := router.ChatRequest{
		System:   "you are a worker bee",
		Messages: []router.Message{{Role: "user", Content: "hello hive"}},
	}
	body := buildRequestBody("claude-opus-4-8", 1024, req)

	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(buf)
	for _, banned := range rejectedParams {
		if strings.Contains(js, banned) {
			t.Errorf("request body must not contain %q (400 on claude-opus-4-8/claude-sonnet-5): %s", banned, js)
		}
	}

	// The required fields ARE present.
	if body["model"] != "claude-opus-4-8" {
		t.Errorf("model = %v, want claude-opus-4-8", body["model"])
	}
	if body["max_tokens"] != 1024 {
		t.Errorf("max_tokens = %v, want 1024", body["max_tokens"])
	}
	if _, ok := body["messages"]; !ok {
		t.Error("body missing required messages field")
	}
	if _, ok := body["system"]; !ok {
		t.Error("body missing system field (System was set)")
	}
}

func TestBuildRequestBodyNoSystemWhenEmpty(t *testing.T) {
	body := buildRequestBody("claude-sonnet-5", 512, router.ChatRequest{
		Messages: []router.Message{{Role: "user", Content: "hi"}},
	})
	if _, ok := body["system"]; ok {
		t.Error("body should omit system when ChatRequest.System is empty")
	}
}

// TestChatDoesNotPostRejectedParams drives Chat end-to-end against a local
// httptest server (NO real/paid API call), captures the posted body, and asserts
// the rejected params are absent while model + max_tokens are present.
func TestChatDoesNotPostRejectedParams(t *testing.T) {
	var (
		capturedBody []byte
		capturedPath string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedBody, _ = io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		io.WriteString(w, `{"model":"claude-opus-4-8","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":3,"output_tokens":1}}`)
	}))
	defer srv.Close()

	p := &Provider{APIKey: "test-key", BaseURL: srv.URL, HTTP: srv.Client()}
	resp, err := p.Chat(context.Background(), router.ChatRequest{
		Model:     "claude-opus-4-8",
		System:    "sys",
		Messages:  []router.Message{{Role: "user", Content: "hi"}},
		MaxTokens: 512,
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if resp.Text != "ok" {
		t.Errorf("resp.Text = %q, want ok", resp.Text)
	}
	if capturedPath != "/v1/messages" {
		t.Errorf("posted to %q, want /v1/messages", capturedPath)
	}

	js := string(capturedBody)
	for _, banned := range rejectedParams {
		if strings.Contains(js, banned) {
			t.Errorf("posted body must not contain %q: %s", banned, js)
		}
	}
	if !strings.Contains(js, "claude-opus-4-8") {
		t.Errorf("posted body should carry the model id: %s", js)
	}
	if !strings.Contains(js, "max_tokens") {
		t.Errorf("posted body should carry max_tokens: %s", js)
	}
}

// TestBuildRequestBodySerializesToolsAndToolTurns proves the Anthropic tool-use
// wire shape (verified against
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview and
// .../handle-tool-calls): offered tools become {name,description,input_schema};
// an assistant ToolCalls turn becomes tool_use content blocks (id/name/input); a
// user ToolResults turn becomes tool_result content blocks (tool_use_id/content/
// is_error); and a plain text turn stays {role, content:<string>} — no regression.
func TestBuildRequestBodySerializesToolsAndToolTurns(t *testing.T) {
	req := router.ChatRequest{
		Messages: []router.Message{
			{Role: "user", Content: "what is 1 + 2?"},
			{Role: "assistant", Content: "I'll add them.", ToolCalls: []router.ToolCall{
				{ID: "toolu_01", Name: "add", Args: json.RawMessage(`{"a":1,"b":2}`)},
			}},
			{Role: "user", ToolResults: []router.ToolResult{
				{ToolCallID: "toolu_01", Content: "3"},
			}},
		},
		Tools: []router.ToolSchema{
			{Name: "add", Description: "Add a and b.", InputSchema: json.RawMessage(`{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}}}`)},
		},
	}
	buf, err := json.Marshal(buildRequestBody("claude-sonnet-5", 1024, req))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire struct {
		Tools []struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(buf, &wire); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}

	// tools → {name, description, input_schema}
	if len(wire.Tools) != 1 {
		t.Fatalf("tools len = %d, want 1", len(wire.Tools))
	}
	if wire.Tools[0].Name != "add" || wire.Tools[0].Description != "Add a and b." {
		t.Errorf("tool[0] = %+v, want name=add and description set", wire.Tools[0])
	}
	if !json.Valid(wire.Tools[0].InputSchema) || !bytes.Contains(wire.Tools[0].InputSchema, []byte(`"properties"`)) {
		t.Errorf("input_schema not passed through verbatim: %s", wire.Tools[0].InputSchema)
	}

	if len(wire.Messages) != 3 {
		t.Fatalf("messages len = %d, want 3", len(wire.Messages))
	}

	// [0] plain user → {role, content:<string>} (must decode as a bare string).
	var plain struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(wire.Messages[0], &plain); err != nil {
		t.Fatalf("plain user must serialize with a bare-string content (no regression): %v", err)
	}
	if plain.Role != "user" || plain.Content != "what is 1 + 2?" {
		t.Errorf("plain msg = %+v", plain)
	}

	// [1] assistant tool call → content:[{type:text,...},{type:tool_use,...}]
	var asst struct {
		Role    string `json:"role"`
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if err := json.Unmarshal(wire.Messages[1], &asst); err != nil {
		t.Fatalf("assistant decode: %v", err)
	}
	if asst.Role != "assistant" {
		t.Errorf("assistant role = %q", asst.Role)
	}
	var sawText, sawToolUse bool
	for _, b := range asst.Content {
		switch b.Type {
		case "text":
			sawText = b.Text == "I'll add them."
		case "tool_use":
			sawToolUse = b.ID == "toolu_01" && b.Name == "add"
			var in struct{ A, B int }
			if err := json.Unmarshal(b.Input, &in); err != nil || in.A != 1 || in.B != 2 {
				t.Errorf("tool_use input = %s (err %v)", b.Input, err)
			}
		}
	}
	if !sawText || !sawToolUse {
		t.Errorf("assistant blocks missing text=%v tool_use=%v: %s", sawText, sawToolUse, wire.Messages[1])
	}

	// [2] user tool result → content:[{type:tool_result, tool_use_id, content}]
	var ures struct {
		Role    string `json:"role"`
		Content []struct {
			Type      string `json:"type"`
			ToolUseID string `json:"tool_use_id"`
			Content   string `json:"content"`
			IsError   bool   `json:"is_error"`
		} `json:"content"`
	}
	if err := json.Unmarshal(wire.Messages[2], &ures); err != nil {
		t.Fatalf("tool_result decode: %v", err)
	}
	if ures.Role != "user" || len(ures.Content) != 1 {
		t.Fatalf("tool_result msg = %+v", ures)
	}
	tr := ures.Content[0]
	if tr.Type != "tool_result" || tr.ToolUseID != "toolu_01" || tr.Content != "3" || tr.IsError {
		t.Errorf("tool_result block = %+v", tr)
	}
}

// TestToolResultIsErrorSerialized proves a failed tool result carries is_error:true
// (the heals posture — the loop feeds tool errors back to the model, it doesn't drop them).
func TestToolResultIsErrorSerialized(t *testing.T) {
	req := router.ChatRequest{Messages: []router.Message{
		{Role: "user", ToolResults: []router.ToolResult{{ToolCallID: "toolu_x", Content: "boom", IsError: true}}},
	}}
	buf, err := json.Marshal(buildRequestBody("claude-sonnet-5", 256, req))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(buf, []byte(`"is_error":true`)) {
		t.Errorf("failed tool result must serialize is_error:true: %s", buf)
	}
}

// TestParseResponseToolUse parses a fixture Anthropic response whose content has a
// tool_use block (the docs' example shape) plus text, and asserts it yields the
// right ToolCall id/name/input and keeps the text.
func TestParseResponseToolUse(t *testing.T) {
	fixture := `{
	  "id": "msg_01Aq9w938a90dw8q",
	  "model": "claude-opus-4-8",
	  "stop_reason": "tool_use",
	  "role": "assistant",
	  "content": [
	    {"type": "text", "text": "I'll check the weather."},
	    {"type": "tool_use", "id": "toolu_01A09q90qw90lq917835lq9", "name": "get_weather", "input": {"location": "San Francisco, CA", "unit": "celsius"}}
	  ],
	  "usage": {"input_tokens": 42, "output_tokens": 9}
	}`
	resp, err := parseResponse([]byte(fixture))
	if err != nil {
		t.Fatalf("parseResponse: %v", err)
	}
	if resp.Text != "I'll check the weather." {
		t.Errorf("text = %q", resp.Text)
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %d, want 1", len(resp.ToolCalls))
	}
	tc := resp.ToolCalls[0]
	if tc.ID != "toolu_01A09q90qw90lq917835lq9" || tc.Name != "get_weather" {
		t.Errorf("tool call id/name = %q/%q", tc.ID, tc.Name)
	}
	var in struct {
		Location string `json:"location"`
		Unit     string `json:"unit"`
	}
	if err := json.Unmarshal(tc.Args, &in); err != nil {
		t.Fatalf("tool args must be valid JSON: %v (%s)", err, tc.Args)
	}
	if in.Location != "San Francisco, CA" || in.Unit != "celsius" {
		t.Errorf("tool args = %+v", in)
	}
	if resp.Model != "claude-opus-4-8" {
		t.Errorf("model = %q", resp.Model)
	}
	if resp.Usage.InputTokens != 42 || resp.Usage.OutputTokens != 9 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

// TestParseResponsePlainText proves a plain text response still parses to .Text
// with empty ToolCalls (the ordinary single-shot path is unchanged), and that
// cache-read tokens fold into InputTokens while CachedTokens tracks the read.
func TestParseResponsePlainText(t *testing.T) {
	fixture := `{"model":"claude-sonnet-5","stop_reason":"end_turn","content":[{"type":"text","text":"Hello, hive."}],"usage":{"input_tokens":5,"output_tokens":3,"cache_read_input_tokens":2}}`
	resp, err := parseResponse([]byte(fixture))
	if err != nil {
		t.Fatalf("parseResponse: %v", err)
	}
	if resp.Text != "Hello, hive." {
		t.Errorf("text = %q", resp.Text)
	}
	if len(resp.ToolCalls) != 0 {
		t.Errorf("expected no tool calls, got %+v", resp.ToolCalls)
	}
	if resp.Usage.InputTokens != 7 || resp.Usage.CachedTokens != 2 {
		t.Errorf("usage = %+v, want input 7 cached 2", resp.Usage)
	}
}
