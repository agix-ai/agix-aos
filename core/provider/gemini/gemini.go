// Package gemini is a hand-written HTTP adapter for the Google Gemini
// generateContent API implementing router.Provider. No SDK is vendored. It
// advertises Gemini's native efficiency features honestly (context caching,
// native structured output via responseSchema, streaming) and leaves
// clearly-marked `// native-efficiency seam` TODOs where deeper wiring follows.
//
// Live calls are guarded behind an API-key check so tests never hit the network.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/agix-ai/agix/core/provider/keyenv"
	"github.com/agix-ai/agix/core/router"
)

const defaultModel = "gemini-2.5-flash"

// Provider is the Gemini generateContent adapter.
type Provider struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
}

// New builds an adapter, loading the key from GEMINI_API_KEY or
// ~/.config/agix/gemini.env. A missing key is fine until Chat is called.
func New() *Provider {
	return &Provider{
		APIKey:  keyenv.Load("gemini", "GEMINI_API_KEY"),
		BaseURL: "https://generativelanguage.googleapis.com",
		HTTP:    &http.Client{Timeout: 120 * time.Second},
	}
}

// Name identifies this provider.
func (p *Provider) Name() string { return "gemini" }

// Capabilities advertises Gemini's native efficiency features honestly.
func (p *Provider) Capabilities() router.Capabilities {
	return router.Capabilities{
		PromptCaching:    true,     // context caching
		StructuredOutput: "native", // responseSchema
		Streaming:        true,
		Batch:            false,
	}
}

// Chat posts to /v1beta/models/{model}:generateContent and parses usage.
// Guarded behind an API-key check so tests never make a network call.
func (p *Provider) Chat(ctx context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	if p.APIKey == "" {
		return router.ChatResponse{}, errors.New("gemini: no API key (set GEMINI_API_KEY or ~/.config/agix/gemini.env)")
	}
	model := req.Model
	if model == "" {
		model = defaultModel
	}

	contents := make([]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := "user"
		if m.Role == "assistant" || m.Role == "model" {
			role = "model"
		}
		contents = append(contents, map[string]any{
			"role":  role,
			"parts": []any{map[string]any{"text": m.Content}},
		})
	}

	body := map[string]any{"contents": contents}
	if req.System != "" {
		body["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": req.System}}}
	}
	if req.MaxTokens > 0 {
		body["generationConfig"] = map[string]any{"maxOutputTokens": req.MaxTokens}
	}
	// native-efficiency seam: native structured output via
	// generationConfig.responseSchema + responseMimeType, explicit context
	// caching (cachedContent), and streaming (streamGenerateContent) are
	// advertised but not wired here.

	buf, err := json.Marshal(body)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("gemini: marshal: %w", err)
	}
	// SECURITY: the API key rides in the x-goog-api-key HEADER, never the URL
	// query. The Gemini generateContent API accepts the key either way, but a key
	// in the query string leaks: on ANY transport error http.Client.Do returns a
	// *url.Error whose Error() embeds the full URL (key and all), and that string
	// is written to the audit ledger and stderr. With the key in a header there is
	// nothing in the URL to leak. (Header form per Gemini REST docs.)
	endpoint := fmt.Sprintf("%s/v1beta/models/%s:generateContent",
		p.BaseURL, url.PathEscape(model))
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return router.ChatResponse{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-goog-api-key", p.APIKey)

	resp, err := p.HTTP.Do(httpReq)
	if err != nil {
		return router.ChatResponse{}, fmt.Errorf("gemini: http: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return router.ChatResponse{}, fmt.Errorf("gemini: http %d: %s", resp.StatusCode, truncate(data))
	}

	var out struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount        int `json:"promptTokenCount"`
			CandidatesTokenCount    int `json:"candidatesTokenCount"`
			CachedContentTokenCount int `json:"cachedContentTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return router.ChatResponse{}, fmt.Errorf("gemini: decode: %w", err)
	}

	var text string
	if len(out.Candidates) > 0 {
		for _, part := range out.Candidates[0].Content.Parts {
			text += part.Text
		}
	}
	usage := router.Usage{
		InputTokens:  out.UsageMetadata.PromptTokenCount,
		OutputTokens: out.UsageMetadata.CandidatesTokenCount,
		CachedTokens: out.UsageMetadata.CachedContentTokenCount,
	}
	return router.ChatResponse{Text: text, Usage: usage, Provider: "gemini", Model: model}, nil
}

func truncate(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

var _ router.Provider = (*Provider)(nil)
