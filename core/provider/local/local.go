// Package local is a hand-written HTTP adapter for a local Ollama daemon
// implementing router.Provider. It is the seam that runs the hive's own
// distilled nuclei (nuc-4b-v1, …) and stock gemma3 models as the worker / T1
// self-healing sidecar tier — the "cheap local model" half of the central
// hypothesis. No SDK is vendored; it POSTs to Ollama's /api/chat.
//
// Honest capability surface (verified against the live daemon 2026-07-07):
// gemma3-family models in Ollama report capabilities ["completion"[,"vision"]]
// and NOT "tools" — the daemon returns {"error":"… does not support tools"} if a
// `tools` field is sent. So this adapter advertises ToolUse:false, NEVER sends a
// tools field, and surfaces an honest "tool-use-unsupported" Degraded marker when
// a call offers tools. The nucleus is used as a structured-text classify/repair
// sidecar (JSON out, parsed by Go), not as a native tool-driver — see
// project-agix-self-healing-loop-doctrine + small-model-sidecar-is-router-not-driver.
//
// Local inference is $0 (Usage.CostUSD stays 0) and requires no API key. num_ctx
// is pinned to the ollama-conventions invariant (≥ 65536), overridable via env.
// The request/response (de)serialization is split into pure functions
// (buildChatBody/buildMessages/parseResponse) so it is unit-testable against
// fixtures and an httptest server with no live daemon — see local_test.go.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/router"
)

const (
	// defaultModel is the worker-tier local model. Per packs/refactor/SPEC.md §4
	// the flywheel migrates workers frontier → gemma3:12b; the trained nucleus
	// (nuc-4b-v1) is selected explicitly for the T1 sidecar via AGIX_LOCAL_MODEL
	// or an explicit local model id on the request.
	defaultModel  = "gemma3:12b"
	defaultBaseURL = "http://localhost:11434"
	// defaultNumCtx honors the hard invariant in docs/operations/ollama-conventions.md
	// (num_ctx ≥ 65536); a short window silently truncates long agent transcripts.
	defaultNumCtx = 65536
)

// Provider is the local Ollama adapter.
type Provider struct {
	Model   string // the Ollama tag to run (e.g. "gemma3:12b", "nuc-4b-v1")
	NumCtx  int    // context window pinned into options.num_ctx
	BaseURL string // Ollama daemon base URL
	HTTP    *http.Client
	// Think toggles the model's chain-of-thought. Default FALSE: this adapter is
	// the structured-text classify/repair sidecar (its closed tasks never need
	// reasoning), and on a reasoning model (gemma4, qwen3.x) leaving it on is a
	// ~15× latency tax — measured 2026-07-09: qwen3.6/gemma4 emit ~450 CoT tokens
	// (10–17s) for a 6-token classification vs <1s with think off, same answer.
	// It is a no-op on non-reasoning models (gemma3), so false is always safe here.
	Think bool
}

// New builds an adapter from env with sane defaults:
//   - model:   AGIX_LOCAL_MODEL   (default "gemma3:12b")
//   - num_ctx: AGIX_LOCAL_NUM_CTX (default 65536, floored at 65536)
//   - host:    OLLAMA_HOST / AGIX_OLLAMA_HOST (default http://localhost:11434)
//
// No key is loaded — local inference needs none. A missing/unreachable daemon is
// fine until Chat is called (then it errors honestly).
func New() *Provider {
	model := firstNonEmpty(os.Getenv("AGIX_LOCAL_MODEL"), defaultModel)
	ctx := defaultNumCtx
	if v := os.Getenv("AGIX_LOCAL_NUM_CTX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= defaultNumCtx {
			ctx = n
		}
	}
	base := firstNonEmpty(os.Getenv("AGIX_OLLAMA_HOST"), os.Getenv("OLLAMA_HOST"), defaultBaseURL)
	base = normalizeHost(base)
	return &Provider{
		Model:   model,
		NumCtx:  ctx,
		BaseURL: base,
		// Chain-of-thought OFF by default (the sidecar's closed tasks don't need it and
		// it's a large latency tax on reasoning models). Set AGIX_LOCAL_THINK=1 to re-enable.
		Think: os.Getenv("AGIX_LOCAL_THINK") == "1",
		// Generous timeout: a cold 9 GB model can take several seconds to load
		// before the first token, and a large num_ctx prefill adds more.
		HTTP: &http.Client{Timeout: 240 * time.Second},
	}
}

// Name identifies this provider.
func (p *Provider) Name() string { return "local" }

// Capabilities is the honest native-feature surface of a local gemma3-family
// Ollama model. ToolUse is false (see the package doc): the adapter never sends a
// tools field and never parses native tool calls. StructuredOutput is "prompt"
// (JSON is coaxed via the prompt and parsed by the caller, not enforced natively).
func (p *Provider) Capabilities() router.Capabilities {
	return router.Capabilities{
		PromptCaching:    false,
		StructuredOutput: "prompt",
		Streaming:        true,
		Batch:            false,
		ToolUse:          false,
	}
}

// Chat posts to /api/chat (stream:false) and parses the response. It resolves the
// model to run (an explicit local tag on the request wins, otherwise the
// provider's configured Model — a frontier model id left in a force-routed table
// is ignored, since it is not an Ollama tag). When the call offers tools, they are
// NOT sent (the model can't parse them) and an honest Degraded marker is attached.
func (p *Provider) Chat(ctx context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	model := p.Model
	if looksLocal(req.Model) {
		model = req.Model
	}
	numCtx := p.NumCtx
	if numCtx < defaultNumCtx {
		numCtx = defaultNumCtx
	}

	body := buildChatBody(model, numCtx, p.Think, req)
	buf, err := json.Marshal(body)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("local: marshal: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/api/chat", bytes.NewReader(buf))
	if err != nil {
		return router.ChatResponse{}, err
	}
	httpReq.Header.Set("content-type", "application/json")

	resp, err := p.HTTP.Do(httpReq)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("local: http (is `ollama serve` running at %s?): %w", p.BaseURL, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return router.ChatResponse{}, fmt.Errorf("local: http %d: %s", resp.StatusCode, truncate(data))
	}

	out, err := parseResponse(data)
	if err != nil {
		return router.ChatResponse{}, err
	}
	out.Provider = "local"
	if out.Model == "" {
		out.Model = model
	}
	if len(req.Tools) > 0 {
		// Honest: the model cannot parse tools; say so rather than silently drop.
		out.Degraded = append(out.Degraded, "tool-use-unsupported")
	}
	return out, nil
}

// buildChatBody assembles the JSON body POSTed to /api/chat. It NEVER includes a
// tools field (gemma3 in Ollama rejects it). options.num_ctx is always pinned;
// max tokens map to options.num_predict when set.
func buildChatBody(model string, numCtx int, think bool, req router.ChatRequest) map[string]any {
	opts := map[string]any{"num_ctx": numCtx}
	if req.MaxTokens > 0 {
		opts["num_predict"] = req.MaxTokens
	}
	return map[string]any{
		"model":    model,
		"messages": buildMessages(req),
		"stream":   false,
		// think gates chain-of-thought on reasoning models; false (the default) keeps
		// the sidecar fast on its closed classify/repair tasks. No-op on gemma3.
		"think":   think,
		"options": opts,
	}
}

// buildMessages converts router messages to Ollama chat messages, prepending the
// system turn. Because tool-use is unsupported, tool-carrying turns are rendered
// as plain text rather than the native tool/tool_calls shapes:
//   - an assistant turn carrying ToolCalls collapses to its text content;
//   - a user turn carrying ToolResults renders each result as readable text in a
//     single user message (so a tool-loop transcript degrades gracefully).
func buildMessages(req router.ChatRequest) []any {
	msgs := make([]any, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		switch {
		case len(m.ToolResults) > 0:
			var b strings.Builder
			if m.Content != "" {
				b.WriteString(m.Content)
				b.WriteString("\n")
			}
			for _, tr := range m.ToolResults {
				name := tr.Name
				if name == "" {
					name = tr.ToolCallID
				}
				if tr.IsError {
					b.WriteString(fmt.Sprintf("[tool %s error] %s\n", name, tr.Content))
				} else {
					b.WriteString(fmt.Sprintf("[tool %s result] %s\n", name, tr.Content))
				}
			}
			msgs = append(msgs, map[string]any{"role": "user", "content": strings.TrimRight(b.String(), "\n")})
		case len(m.ToolCalls) > 0:
			content := m.Content
			if content == "" {
				content = "(requested a tool the local model cannot invoke)"
			}
			msgs = append(msgs, map[string]any{"role": "assistant", "content": content})
		default:
			msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
		}
	}
	return msgs
}

// parseResponse decodes an /api/chat (stream:false) response into a ChatResponse.
// A non-empty top-level "error" is surfaced (Ollama can 200 with an error body on
// some daemon states). Usage maps prompt_eval_count → InputTokens and eval_count →
// OutputTokens; cost stays 0 (local is free).
func parseResponse(data []byte) (router.ChatResponse, error) {
	var out struct {
		Model   string `json:"model"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		PromptEvalCount int    `json:"prompt_eval_count"`
		EvalCount       int    `json:"eval_count"`
		Done            bool   `json:"done"`
		Error           string `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return router.ChatResponse{}, fmt.Errorf("local: decode: %w", err)
	}
	if strings.TrimSpace(out.Error) != "" {
		return router.ChatResponse{}, fmt.Errorf("local: ollama error: %s", out.Error)
	}
	return router.ChatResponse{
		Text:  out.Message.Content,
		Model: out.Model,
		Usage: router.Usage{
			InputTokens:  out.PromptEvalCount,
			OutputTokens: out.EvalCount,
		},
	}, nil
}

// looksLocal reports whether a model id is a plausible Ollama tag rather than a
// frontier id left in a force-routed table. Frontier prefixes fall back to the
// provider's configured Model; anything else (gemma3:12b, nuc-4b-v1, …) is honored.
func looksLocal(model string) bool {
	if strings.TrimSpace(model) == "" {
		return false
	}
	frontier := []string{"gpt", "claude", "gemini", "o1", "o3", "o4", "text-", "dall"}
	lower := strings.ToLower(model)
	for _, pfx := range frontier {
		if strings.HasPrefix(lower, pfx) {
			return false
		}
	}
	return true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// normalizeHost accepts a bare host:port (Ollama's OLLAMA_HOST convention) or a
// full URL and returns a scheme-qualified base URL with no trailing slash.
func normalizeHost(h string) string {
	h = strings.TrimRight(strings.TrimSpace(h), "/")
	if h == "" {
		return defaultBaseURL
	}
	if !strings.HasPrefix(h, "http://") && !strings.HasPrefix(h, "https://") {
		h = "http://" + h
	}
	return h
}

func truncate(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

var _ router.Provider = (*Provider)(nil)
