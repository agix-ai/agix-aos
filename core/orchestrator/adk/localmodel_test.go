// Copyright 2026 Agix AI LLC. Apache-2.0.
package adk

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/provider/local"
	"github.com/agix-ai/agix/core/router"
	adkmodel "google.golang.org/adk/model"
	"google.golang.org/genai"
)

// fakeChatter records the request and returns a canned response — no network.
type fakeChatter struct {
	got  router.ChatRequest
	resp router.ChatResponse
}

func (f *fakeChatter) Chat(_ context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	f.got = req
	return f.resp, nil
}

// TestLocalModel_MapsRequestAndResponse proves the ADK↔Agix translation with zero
// network: system instruction → System, genai contents → Messages (model→assistant),
// and the Agix reply text → the ADK LLMResponse content.
func TestLocalModel_MapsRequestAndResponse(t *testing.T) {
	fc := &fakeChatter{resp: router.ChatResponse{Text: "the answer is 4", Model: "qwen3.6:35b-a3b"}}
	lm := NewLocalModel(fc, "qwen3.6:35b-a3b")

	if lm.Name() != "qwen3.6:35b-a3b" {
		t.Fatalf("Name() = %q", lm.Name())
	}

	req := &adkmodel.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("what is 2+2?", genai.RoleUser),
			genai.NewContentFromText("thinking...", genai.RoleModel),
		},
		Config: &genai.GenerateContentConfig{
			SystemInstruction: genai.NewContentFromText("You are terse.", genai.RoleUser),
		},
	}

	var out *adkmodel.LLMResponse
	for resp, err := range lm.GenerateContent(context.Background(), req, false) {
		if err != nil {
			t.Fatalf("GenerateContent: %v", err)
		}
		out = resp
	}

	// request mapping
	if fc.got.System != "You are terse." {
		t.Errorf("System = %q, want %q", fc.got.System, "You are terse.")
	}
	if len(fc.got.Messages) != 2 {
		t.Fatalf("Messages = %d, want 2", len(fc.got.Messages))
	}
	if fc.got.Messages[0].Role != "user" || fc.got.Messages[0].Content != "what is 2+2?" {
		t.Errorf("msg[0] = %+v", fc.got.Messages[0])
	}
	if fc.got.Messages[1].Role != "assistant" { // genai "model" → agix "assistant"
		t.Errorf("msg[1].Role = %q, want assistant", fc.got.Messages[1].Role)
	}
	if fc.got.Model != "qwen3.6:35b-a3b" {
		t.Errorf("Model = %q", fc.got.Model)
	}

	// response mapping
	if out == nil || out.Content == nil {
		t.Fatal("nil response content")
	}
	if !out.TurnComplete {
		t.Error("TurnComplete = false, want true")
	}
	if got := partsText(out.Content.Parts); got != "the answer is 4" {
		t.Errorf("response text = %q", got)
	}
	if out.Content.Role != genai.RoleModel {
		t.Errorf("response role = %q, want model", out.Content.Role)
	}
}

// TestLocalModel_LiveOllama drives the adapter against a real local Ollama daemon.
// Gated: only runs with AGIX_ADK_OLLAMA_TEST=1 and a model pulled locally, so CI (and
// `go test ./...` without a daemon) stays green. This is the durable form of the
// end-to-end proof that a local model answers through the ADK model seam.
func TestLocalModel_LiveOllama(t *testing.T) {
	if os.Getenv("AGIX_ADK_OLLAMA_TEST") == "" {
		t.Skip("set AGIX_ADK_OLLAMA_TEST=1 (and pull the model) to run the live Ollama bridge test")
	}
	model := firstNonEmptyStr(os.Getenv("AGIX_LOCAL_MODEL"), "qwen3.6:35b-a3b")
	lm := NewLocalModel(local.New(), model)

	req := &adkmodel.LLMRequest{
		Config:   &genai.GenerateContentConfig{SystemInstruction: genai.NewContentFromText("Answer with only the final number, nothing else.", genai.RoleUser)},
		Contents: []*genai.Content{genai.NewContentFromText("what is 2+2?", genai.RoleUser)},
	}

	var text string
	for resp, err := range lm.GenerateContent(context.Background(), req, false) {
		if err != nil {
			t.Fatalf("live GenerateContent: %v", err)
		}
		if resp != nil && resp.Content != nil {
			text += partsText(resp.Content.Parts)
		}
	}
	if !strings.Contains(text, "4") {
		t.Fatalf("live model reply %q does not contain 4", text)
	}
	t.Logf("live %s via ADK model seam → %q", model, strings.TrimSpace(text))
}
