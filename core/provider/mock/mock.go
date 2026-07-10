// Package mock is a deterministic, zero-cost Provider adapter. It never touches
// the network: it templates a reply from the request and reports synthetic
// token counts. This is what the end-to-end agent path and `go test` use, so
// the seed runs and tests green with zero API cost — and it doubles as a
// legitimate offline system-under-test.
//
// It also faithfully exercises tool use: when a call offers Tools, MockProvider
// drives a one-step tool-use loop (request the first tool, then answer with the
// tool's result). Scripted is a programmable sibling for multi-call loop tests
// that need precise control the templated MockProvider can't give.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/agix-ai/agix/core/router"
)

// MockProvider is a deterministic offline provider. Named and Caps are
// exported so tests can register it under an arbitrary provider name with
// arbitrary advertised capabilities; Fail, when set, makes Chat return that
// error (to exercise the agent's graceful-degrade path).
type MockProvider struct {
	Named string
	Caps  router.Capabilities
	Fail  error
}

// New returns a MockProvider named "mock" advertising prompt-based structured
// output and native tool use (it faithfully emits tool calls when tools are
// offered, so the offline SUT exercises the whole tool-use loop at $0).
func New() *MockProvider {
	return &MockProvider{Named: "mock", Caps: router.Capabilities{StructuredOutput: "prompt", ToolUse: true}}
}

// Name returns the provider name ("mock" by default).
func (m *MockProvider) Name() string {
	if m.Named == "" {
		return "mock"
	}
	return m.Named
}

// Capabilities returns the advertised native-feature surface.
func (m *MockProvider) Capabilities() router.Capabilities { return m.Caps }

// Chat returns a deterministic templated reply with synthetic usage. Model is
// reported as "mock" so the rate card charges 0 (the zero-cost guarantee).
//
// Tool-aware branch (gated on len(req.Tools) > 0, so non-tool callers are
// unchanged): the behavior is a PURE function of the transcript — no internal
// state — so it stays deterministic and race-free even when ONE MockProvider is
// shared across parallel worker bees. If the transcript already carries a tool
// result, it answers, threading that result back in; otherwise it requests the
// first offered tool with empty ({}) args. Any tool that tolerates {} args thus
// drives a full call→execute→answer loop offline.
func (m *MockProvider) Chat(_ context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	if m.Fail != nil {
		return router.ChatResponse{}, m.Fail
	}
	label := string(req.Capability)
	if req.Model != "" {
		label = req.Model
	}

	if len(req.Tools) > 0 {
		if result, ok := lastToolResult(req.Messages); ok {
			text := fmt.Sprintf("mock reply [%s]: used tool result: %s", label, result)
			return m.respond(req, text), nil
		}
		resp := m.respond(req, "")
		resp.ToolCalls = []router.ToolCall{{
			ID:   "mock-tool-1",
			Name: req.Tools[0].Name,
			Args: json.RawMessage(`{}`),
		}}
		return resp, nil
	}

	last := lastUserContent(req.Messages)
	text := fmt.Sprintf("mock reply [%s]: %s", label, last)
	return m.respond(req, text), nil
}

// respond wraps text in a ChatResponse with synthetic usage over the request.
func (m *MockProvider) respond(req router.ChatRequest, text string) router.ChatResponse {
	in := countTokens(req.System)
	for _, msg := range req.Messages {
		in += countTokens(msg.Content)
	}
	out := countTokens(text)
	return router.ChatResponse{
		Text:     text,
		Usage:    router.Usage{InputTokens: in, OutputTokens: out},
		Provider: m.Name(),
		Model:    "mock",
	}
}

// Scripted is a programmable offline Provider for exercising MULTI-CALL loops —
// the tool-use loop especially — with control the templated MockProvider can't
// give (specific tool args, a forced runaway, an error mid-loop). Reply is
// invoked once per Chat with the request and a 0-based call index and returns
// exactly the response the loop should see next: e.g. a ToolCall on call 0, then
// a final answer on call 1. This is legitimate offline TEST/DEV infrastructure —
// a programmable stand-in for a real provider's tool-calling behavior — not a
// production shortcut. One Scripted drives ONE sequential conversation; the call
// counter is mutex-guarded for safety but Scripted is not meant to be shared
// across concurrent conversations.
type Scripted struct {
	Named string
	Caps  router.Capabilities
	Reply func(req router.ChatRequest, call int) (router.ChatResponse, error)

	mu    sync.Mutex
	calls int
}

// Name returns the provider name ("mock" by default).
func (s *Scripted) Name() string {
	if s.Named == "" {
		return "mock"
	}
	return s.Named
}

// Capabilities returns the advertised native-feature surface.
func (s *Scripted) Capabilities() router.Capabilities { return s.Caps }

// Calls reports how many times Chat has been invoked (loop-iteration count).
func (s *Scripted) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// Chat advances the script by one and returns Reply's response, filling in the
// provider/model defaults so cost accounting stays $0.
func (s *Scripted) Chat(_ context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	s.mu.Lock()
	n := s.calls
	s.calls++
	s.mu.Unlock()

	if s.Reply == nil {
		return router.ChatResponse{}, fmt.Errorf("mock.Scripted: no Reply func set")
	}
	resp, err := s.Reply(req, n)
	if err != nil {
		return resp, err
	}
	if resp.Provider == "" {
		resp.Provider = s.Name()
	}
	if resp.Model == "" {
		resp.Model = "mock"
	}
	return resp, nil
}

func lastUserContent(msgs []router.Message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return msgs[i].Content
		}
	}
	if len(msgs) > 0 {
		return msgs[len(msgs)-1].Content
	}
	return ""
}

// lastToolResult returns the content of the most recent tool result in the
// transcript, and whether one was present.
func lastToolResult(msgs []router.Message) (string, bool) {
	for i := len(msgs) - 1; i >= 0; i-- {
		if n := len(msgs[i].ToolResults); n > 0 {
			return msgs[i].ToolResults[n-1].Content, true
		}
	}
	return "", false
}

// countTokens is a deterministic whitespace-field count — a stand-in token
// meter, not a real tokenizer.
func countTokens(s string) int { return len(strings.Fields(s)) }

var (
	_ router.Provider = (*MockProvider)(nil)
	_ router.Provider = (*Scripted)(nil)
)
