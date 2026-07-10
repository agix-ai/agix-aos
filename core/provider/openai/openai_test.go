// Package openai internal tests: prove the pure tool-use (de)serialization
// against fixtures with no network. OpenAI's tool shape differs from Anthropic's
// — arguments ride as a JSON string, and tool results are separate role:"tool"
// messages — so these lock the translation both directions. The Chat wire test
// uses httptest (no real/paid API call).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package openai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

// TestBuildRequestBodySerializesToolsAndToolTurns proves the OpenAI Chat
// Completions tool-use wire shape: offered tools become
// {type:"function", function:{name,description,parameters}}; an assistant
// ToolCalls turn becomes one message with a tool_calls array whose arguments are
// a JSON *string*; a user ToolResults turn fans out into role:"tool" messages
// keyed by tool_call_id; a plain turn is unchanged.
func TestBuildRequestBodySerializesToolsAndToolTurns(t *testing.T) {
	req := router.ChatRequest{
		System: "sys",
		Messages: []router.Message{
			{Role: "user", Content: "what is 1 + 2?"},
			{Role: "assistant", Content: "adding", ToolCalls: []router.ToolCall{
				{ID: "call_1", Name: "add", Args: json.RawMessage(`{"a":1,"b":2}`)},
			}},
			{Role: "user", ToolResults: []router.ToolResult{
				{ToolCallID: "call_1", Content: "3"},
			}},
		},
		Tools: []router.ToolSchema{
			{Name: "add", Description: "Add a and b.", InputSchema: json.RawMessage(`{"type":"object","properties":{"a":{"type":"integer"}}}`)},
		},
	}
	buf, err := json.Marshal(buildRequestBody("gpt-4.1", req))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire struct {
		Tools []struct {
			Type     string `json:"type"`
			Function struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			} `json:"function"`
		} `json:"tools"`
		Messages []struct {
			Role       string          `json:"role"`
			Content    *string         `json:"content"`
			ToolCallID string          `json:"tool_call_id"`
			ToolCalls  json.RawMessage `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(buf, &wire); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}

	// tools → {type:function, function:{name,description,parameters}}
	if len(wire.Tools) != 1 || wire.Tools[0].Type != "function" {
		t.Fatalf("tools = %+v, want one function tool", wire.Tools)
	}
	if wire.Tools[0].Function.Name != "add" || wire.Tools[0].Function.Description != "Add a and b." {
		t.Errorf("function = %+v", wire.Tools[0].Function)
	}
	if !json.Valid(wire.Tools[0].Function.Parameters) {
		t.Errorf("parameters not valid JSON schema: %s", wire.Tools[0].Function.Parameters)
	}

	// messages: [system, user, assistant(tool_calls), tool]
	if len(wire.Messages) != 4 {
		t.Fatalf("messages len = %d, want 4 (system+user+assistant+tool)", len(wire.Messages))
	}
	if wire.Messages[0].Role != "system" || wire.Messages[1].Role != "user" {
		t.Errorf("msgs[0..1] roles = %q %q, want system user", wire.Messages[0].Role, wire.Messages[1].Role)
	}

	// [2] assistant with tool_calls; arguments is a JSON STRING.
	asst := wire.Messages[2]
	if asst.Role != "assistant" {
		t.Errorf("assistant role = %q", asst.Role)
	}
	var calls []struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"` // decodes only if arguments is a JSON string
		} `json:"function"`
	}
	if err := json.Unmarshal(asst.ToolCalls, &calls); err != nil {
		t.Fatalf("tool_calls decode (arguments must be a JSON string): %v", err)
	}
	if len(calls) != 1 || calls[0].ID != "call_1" || calls[0].Type != "function" || calls[0].Function.Name != "add" {
		t.Fatalf("tool_calls = %+v", calls)
	}
	var in struct{ A, B int }
	if err := json.Unmarshal([]byte(calls[0].Function.Arguments), &in); err != nil || in.A != 1 || in.B != 2 {
		t.Errorf("arguments string not the tool JSON: %q (err %v)", calls[0].Function.Arguments, err)
	}

	// [3] role:"tool" result keyed by tool_call_id
	tool := wire.Messages[3]
	if tool.Role != "tool" || tool.ToolCallID != "call_1" || tool.Content == nil || *tool.Content != "3" {
		t.Errorf("tool result msg = %+v (content %v)", tool, tool.Content)
	}
}

// TestParseResponseToolCalls parses a fixture OpenAI response with a tool_calls
// message + finish_reason "tool_calls" into ChatResponse.ToolCalls with the right
// id/name and JSON-object args (converted from the arguments string).
func TestParseResponseToolCalls(t *testing.T) {
	fixture := `{
	  "model": "gpt-4.1",
	  "choices": [{
	    "finish_reason": "tool_calls",
	    "message": {
	      "role": "assistant",
	      "content": null,
	      "tool_calls": [{
	        "id": "call_abc",
	        "type": "function",
	        "function": {"name": "get_weather", "arguments": "{\"location\":\"Paris\"}"}
	      }]
	    }
	  }],
	  "usage": {"prompt_tokens": 30, "completion_tokens": 12}
	}`
	resp, err := parseResponse([]byte(fixture))
	if err != nil {
		t.Fatalf("parseResponse: %v", err)
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %d, want 1", len(resp.ToolCalls))
	}
	tc := resp.ToolCalls[0]
	if tc.ID != "call_abc" || tc.Name != "get_weather" {
		t.Errorf("tool call id/name = %q/%q", tc.ID, tc.Name)
	}
	var in struct {
		Location string `json:"location"`
	}
	if err := json.Unmarshal(tc.Args, &in); err != nil || in.Location != "Paris" {
		t.Errorf("args = %s (err %v)", tc.Args, err)
	}
	if resp.Usage.InputTokens != 30 || resp.Usage.OutputTokens != 12 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

// TestParseResponsePlainText proves a plain text response parses to .Text with
// empty ToolCalls (single-shot path unchanged), including cached-token accounting.
func TestParseResponsePlainText(t *testing.T) {
	fixture := `{"model":"gpt-4.1","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Hello, hive."}}],"usage":{"prompt_tokens":9,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}`
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
	if resp.Usage.CachedTokens != 4 {
		t.Errorf("cached tokens = %d, want 4", resp.Usage.CachedTokens)
	}
}

// TestChatToolRoundTripOffline drives Chat against an httptest server (NO paid
// call): first turn returns a tool_calls response, the returned ToolCall is fed
// back as a ToolResults turn, and the server echoes it as a final answer —
// exercising the adapter's serialize AND parse across a full turn offline.
func TestChatToolRoundTripOffline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		if strings.Contains(string(raw), `"role":"tool"`) {
			io.WriteString(w, `{"model":"gpt-4.1","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
			return
		}
		io.WriteString(w, `{"model":"gpt-4.1","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"add","arguments":"{\"a\":1,\"b\":2}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}))
	defer srv.Close()

	p := &Provider{APIKey: "test-key", BaseURL: srv.URL, HTTP: srv.Client()}
	tools := []router.ToolSchema{{Name: "add", Description: "add", InputSchema: json.RawMessage(`{"type":"object"}`)}}

	first, err := p.Chat(context.Background(), router.ChatRequest{
		Model:    "gpt-4.1",
		Messages: []router.Message{{Role: "user", Content: "1+2?"}},
		Tools:    tools,
	})
	if err != nil {
		t.Fatalf("first Chat: %v", err)
	}
	if len(first.ToolCalls) != 1 || first.ToolCalls[0].Name != "add" {
		t.Fatalf("first turn tool calls = %+v", first.ToolCalls)
	}

	second, err := p.Chat(context.Background(), router.ChatRequest{
		Model: "gpt-4.1",
		Messages: []router.Message{
			{Role: "user", Content: "1+2?"},
			{Role: "assistant", ToolCalls: first.ToolCalls},
			{Role: "user", ToolResults: []router.ToolResult{{ToolCallID: first.ToolCalls[0].ID, Content: "3"}}},
		},
		Tools: tools,
	})
	if err != nil {
		t.Fatalf("second Chat: %v", err)
	}
	if second.Text != "done" || len(second.ToolCalls) != 0 {
		t.Errorf("final turn = %q / %+v, want text=done and no tool calls", second.Text, second.ToolCalls)
	}
	if second.Provider != "openai" {
		t.Errorf("provider = %q, want openai", second.Provider)
	}
}
