// localmodel.go — bridge an Agix chat seam (the router, or a local Ollama provider)
// onto ADK-Go's model.LLM, so an ADK llmagent runs on the LOCAL sidecar with NO
// Gemini/Google credentials. This is the production form of the throwaway proof that
// qwen3.6 drives a real ADK runner.Run end-to-end (research/results/2026-07-10-adk-
// ollama-sidecar-compat.md, next-action #1).
//
// ADK's model.LLM has only EXPORTED methods (unlike agent.Agent), so a local impl slots
// straight into llmagent.Config.Model → runner.New. Everything else in the ADK runner /
// session stack is unchanged. The llmagent path then inherits Agix cost-routing + honest
// degraded markers (when driven through *router.Router).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package adk

import (
	"context"
	"iter"
	"strings"

	"github.com/agix-ai/agix/core/router"
	adkmodel "google.golang.org/adk/model"
	"google.golang.org/genai"
)

// Chatter is the single Agix seam this adapter drives: provider-agnostic chat. It is
// satisfied by *router.Router (cost-routed, multi-provider) AND by every core/provider
// adapter directly (e.g. *local.Provider, the $0 Ollama sidecar) — both expose exactly
// this method. Keeping the dependency at this interface means the ADK binding never
// imports a concrete provider, so core stays born-clean.
type Chatter interface {
	Chat(ctx context.Context, req router.ChatRequest) (router.ChatResponse, error)
}

// LocalModel adapts a Chatter to ADK's model.LLM. Construct it over a local Ollama
// provider for the credential-free sidecar lane, or over the router for cost-routed
// calls, then pass it as llmagent.Config.Model.
type LocalModel struct {
	chatter Chatter
	name    string // ADK-visible model id; also used as the Agix Model override
}

// compile-time proof the adapter satisfies the ADK model seam.
var _ adkmodel.LLM = (*LocalModel)(nil)

// NewLocalModel wires a Chatter (e.g. local.New() or a *router.Router) as an ADK model.
// name is the model id ADK reports and the id Agix routes on (e.g. "qwen3.6:35b-a3b").
func NewLocalModel(chatter Chatter, name string) *LocalModel {
	return &LocalModel{chatter: chatter, name: name}
}

// Name reports the model id to ADK.
func (m *LocalModel) Name() string { return m.name }

// GenerateContent maps one ADK request onto one Agix Chat call and yields a single
// non-partial response. Non-streaming (the sidecar's closed tasks don't need token
// streaming); the ADK Runner fully processes the final non-partial event.
func (m *LocalModel) GenerateContent(ctx context.Context, req *adkmodel.LLMRequest, _ bool) iter.Seq2[*adkmodel.LLMResponse, error] {
	return func(yield func(*adkmodel.LLMResponse, error) bool) {
		resp, err := m.chatter.Chat(ctx, m.toChatRequest(req))
		if err != nil {
			yield(nil, err)
			return
		}
		yield(&adkmodel.LLMResponse{
			Content:      genai.NewContentFromText(resp.Text, genai.RoleModel),
			ModelVersion: resp.Model,
			TurnComplete: true,
		}, nil)
	}
}

// toChatRequest translates an ADK LLMRequest into an Agix ChatRequest: the system
// instruction (from Config) becomes System; each genai.Content becomes a Message with
// its text parts joined; ADK's "model" role maps to Agix "assistant".
func (m *LocalModel) toChatRequest(req *adkmodel.LLMRequest) router.ChatRequest {
	out := router.ChatRequest{Model: firstNonEmptyStr(req.Model, m.name)}
	if req.Config != nil && req.Config.SystemInstruction != nil {
		out.System = partsText(req.Config.SystemInstruction.Parts)
	}
	for _, c := range req.Contents {
		if c == nil {
			continue
		}
		out.Messages = append(out.Messages, router.Message{
			Role:    agixRole(c.Role),
			Content: partsText(c.Parts),
		})
	}
	return out
}

// agixRole maps a genai role onto the Agix message-role convention.
func agixRole(role string) string {
	switch role {
	case genai.RoleModel:
		return "assistant"
	case "":
		return "user" // genai defaults an empty role to user
	default:
		return role // "user" (and any future roles) pass through
	}
}

// partsText concatenates the Text of a content's parts (non-text parts are ignored —
// the sidecar lane is text-in/text-out).
func partsText(parts []*genai.Part) string {
	var b strings.Builder
	for _, p := range parts {
		if p != nil && p.Text != "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func firstNonEmptyStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
