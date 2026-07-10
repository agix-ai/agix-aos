// Copyright 2026 Agix AI LLC. Apache-2.0.
package local

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

func TestBuildChatBody_NeverSendsToolsAndPinsNumCtx(t *testing.T) {
	req := router.ChatRequest{
		System:    "you are a refactoring critic",
		Messages:  []router.Message{{Role: "user", Content: "classify this error"}},
		MaxTokens: 256,
		Tools: []router.ToolSchema{
			{Name: "get_weather", Description: "weather", InputSchema: json.RawMessage(`{"type":"object"}`)},
		},
	}
	body := buildChatBody("gemma3:12b", 65536, false, req)

	if body["model"] != "gemma3:12b" {
		t.Fatalf("model = %v, want gemma3:12b", body["model"])
	}
	if _, hasTools := body["tools"]; hasTools {
		t.Fatal("body must NEVER carry a tools field (gemma3 rejects it)")
	}
	// think must be present and false: the sidecar's closed tasks never need
	// chain-of-thought, and leaving it on is a ~15× latency tax on reasoning models.
	if think, ok := body["think"].(bool); !ok || think {
		t.Fatalf("think = %v (ok=%v), want false (CoT disabled for the sidecar)", body["think"], ok)
	}
	if body["stream"] != false {
		t.Fatalf("stream = %v, want false", body["stream"])
	}
	opts, ok := body["options"].(map[string]any)
	if !ok {
		t.Fatalf("options missing or wrong type: %T", body["options"])
	}
	if opts["num_ctx"] != 65536 {
		t.Fatalf("num_ctx = %v, want 65536", opts["num_ctx"])
	}
	if opts["num_predict"] != 256 {
		t.Fatalf("num_predict = %v, want 256", opts["num_predict"])
	}
	msgs, ok := body["messages"].([]any)
	if !ok || len(msgs) != 2 {
		t.Fatalf("messages = %v, want [system,user]", body["messages"])
	}
	first := msgs[0].(map[string]any)
	if first["role"] != "system" {
		t.Fatalf("first message role = %v, want system", first["role"])
	}
}

func TestBuildMessages_ToolResultsRenderAsText(t *testing.T) {
	req := router.ChatRequest{
		Messages: []router.Message{
			{Role: "user", ToolResults: []router.ToolResult{
				{ToolCallID: "c1", Name: "metric", Content: "wmc=42", IsError: false},
				{ToolCallID: "c2", Name: "tester", Content: "3 failed", IsError: true},
			}},
		},
	}
	msgs := buildMessages(req)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d", len(msgs))
	}
	m := msgs[0].(map[string]any)
	if m["role"] != "user" {
		t.Fatalf("role = %v, want user", m["role"])
	}
	content := m["content"].(string)
	if !strings.Contains(content, "[tool metric result] wmc=42") {
		t.Fatalf("missing metric result in %q", content)
	}
	if !strings.Contains(content, "[tool tester error] 3 failed") {
		t.Fatalf("missing tester error in %q", content)
	}
}

func TestParseResponse_Basic(t *testing.T) {
	data := []byte(`{"model":"nuc-4b-v1","message":{"role":"assistant","content":"extract subclass"},"prompt_eval_count":128,"eval_count":9,"done":true}`)
	out, err := parseResponse(data)
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "extract subclass" {
		t.Fatalf("text = %q", out.Text)
	}
	if out.Model != "nuc-4b-v1" {
		t.Fatalf("model = %q", out.Model)
	}
	if out.Usage.InputTokens != 128 || out.Usage.OutputTokens != 9 {
		t.Fatalf("usage = %+v", out.Usage)
	}
	if out.Usage.CostUSD != 0 {
		t.Fatalf("local cost must be 0, got %v", out.Usage.CostUSD)
	}
}

func TestParseResponse_Error(t *testing.T) {
	data := []byte(`{"error":"registry.ollama.ai/library/gemma3:4b does not support tools"}`)
	_, err := parseResponse(data)
	if err == nil {
		t.Fatal("expected an error for an ollama error body")
	}
	if !strings.Contains(err.Error(), "does not support tools") {
		t.Fatalf("error should surface the ollama message, got %v", err)
	}
}

func TestChat_RoundTrip(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Errorf("path = %s, want /api/chat", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"model":"gemma3:12b","message":{"role":"assistant","content":"hive online"},"prompt_eval_count":10,"eval_count":3,"done":true}`)
	}))
	defer srv.Close()

	p := &Provider{Model: "gemma3:12b", NumCtx: 65536, BaseURL: srv.URL, HTTP: srv.Client()}
	out, err := p.Chat(context.Background(), router.ChatRequest{
		Messages: []router.Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "hive online" {
		t.Fatalf("text = %q", out.Text)
	}
	if out.Provider != "local" {
		t.Fatalf("provider = %q, want local", out.Provider)
	}
	if out.Usage.InputTokens != 10 || out.Usage.OutputTokens != 3 {
		t.Fatalf("usage = %+v", out.Usage)
	}
	if _, hasTools := gotBody["tools"]; hasTools {
		t.Fatal("request must not carry a tools field")
	}
	if gotBody["model"] != "gemma3:12b" {
		t.Fatalf("model sent = %v", gotBody["model"])
	}
}

func TestChat_ToolsOfferedYieldsDegradedMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		if _, hasTools := body["tools"]; hasTools {
			t.Error("tools field leaked to the daemon")
		}
		_, _ = io.WriteString(w, `{"model":"nuc-4b-v1","message":{"role":"assistant","content":"{\"class\":\"syntactic\"}"},"prompt_eval_count":5,"eval_count":6,"done":true}`)
	}))
	defer srv.Close()

	p := &Provider{Model: "nuc-4b-v1", NumCtx: 65536, BaseURL: srv.URL, HTTP: srv.Client()}
	out, err := p.Chat(context.Background(), router.ChatRequest{
		Messages: []router.Message{{Role: "user", Content: "classify"}},
		Tools:    []router.ToolSchema{{Name: "get_weather", Description: "x"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range out.Degraded {
		if d == "tool-use-unsupported" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected tool-use-unsupported degraded marker, got %v", out.Degraded)
	}
}

func TestLooksLocal(t *testing.T) {
	cases := map[string]bool{
		"gemma3:12b":            true,
		"nuc-4b-v1":             true,
		"nuc-traversal-v1":      true,
		"qwen2.5-coder:7b":      true,
		"":                      false,
		"gpt-4.1":               false,
		"claude-opus-4-8":       false,
		"gemini-2.5-pro":        false,
		"o3-mini":               false,
	}
	for model, want := range cases {
		if got := looksLocal(model); got != want {
			t.Errorf("looksLocal(%q) = %v, want %v", model, got, want)
		}
	}
}

func TestCapabilities_ToolUseFalse(t *testing.T) {
	c := New().Capabilities()
	if c.ToolUse {
		t.Fatal("local gemma3 does not support tools; ToolUse must be false")
	}
	if c.StructuredOutput != "prompt" {
		t.Fatalf("StructuredOutput = %q, want prompt", c.StructuredOutput)
	}
}

func TestNew_Defaults(t *testing.T) {
	t.Setenv("AGIX_LOCAL_MODEL", "")
	t.Setenv("AGIX_OLLAMA_HOST", "")
	t.Setenv("OLLAMA_HOST", "")
	t.Setenv("AGIX_LOCAL_NUM_CTX", "")
	p := New()
	if p.Model != defaultModel {
		t.Fatalf("model = %q, want %q", p.Model, defaultModel)
	}
	if p.NumCtx < defaultNumCtx {
		t.Fatalf("num_ctx = %d, must be >= %d", p.NumCtx, defaultNumCtx)
	}
	if p.Name() != "local" {
		t.Fatalf("name = %q", p.Name())
	}
	if p.BaseURL != defaultBaseURL {
		t.Fatalf("base = %q, want %q", p.BaseURL, defaultBaseURL)
	}
}

// TestLive_Ollama is a real round-trip against a running Ollama daemon — the
// in-situ proof that the hive's own nucleus runs through this provider and that
// parseResponse matches Ollama's real wire shape. Skipped by default; opt in with
// AGIX_LOCAL_LIVE=1 (optionally AGIX_LOCAL_MODEL, e.g. nuc-4b-v1). Not run in CI.
func TestLive_Ollama(t *testing.T) {
	if os.Getenv("AGIX_LOCAL_LIVE") != "1" {
		t.Skip("set AGIX_LOCAL_LIVE=1 (and ensure `ollama serve` is up) to run the live smoke")
	}
	p := New()
	out, err := p.Chat(context.Background(), router.ChatRequest{
		Messages:  []router.Message{{Role: "user", Content: "Reply with exactly: hive online"}},
		MaxTokens: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("live: model=%s provider=%s in=%d out=%d text=%q",
		out.Model, out.Provider, out.Usage.InputTokens, out.Usage.OutputTokens, out.Text)
	if out.Provider != "local" {
		t.Fatalf("provider = %q, want local", out.Provider)
	}
	if strings.TrimSpace(out.Text) == "" {
		t.Fatal("live model returned empty text")
	}
	if out.Usage.OutputTokens <= 0 {
		t.Fatalf("expected output tokens > 0, got %d", out.Usage.OutputTokens)
	}
}
