package router_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
)

func TestResolveAllCapabilities(t *testing.T) {
	r := router.NewRouter()
	cases := []struct {
		cap      router.Capability
		provider string
		model    string
	}{
		{router.CapDefaultQuality, "anthropic", "claude-sonnet-5"},
		{router.CapCheapClassification, "anthropic", "claude-haiku-4-5"},
		{router.CapLongContext, "anthropic", "claude-opus-4-8"},
		{router.CapToolUseHeavy, "anthropic", "claude-sonnet-5"},
		{router.CapVision, "gemini", "gemini-2.5-flash"},
	}
	for _, c := range cases {
		got, err := r.Resolve(c.cap)
		if err != nil {
			t.Fatalf("Resolve(%q) error: %v", c.cap, err)
		}
		if got.Provider != c.provider || got.Model != c.model {
			t.Errorf("Resolve(%q) = %s/%s, want %s/%s", c.cap, got.Provider, got.Model, c.provider, c.model)
		}
		if got.Capability != c.cap {
			t.Errorf("Resolve(%q) capability = %q", c.cap, got.Capability)
		}
	}
}

func TestResolveUnknownCapability(t *testing.T) {
	r := router.NewRouter()
	if _, err := r.Resolve("nonsense"); err == nil {
		t.Fatal("expected error for unknown capability, got nil")
	}
}

func TestResolveModelPrefixes(t *testing.T) {
	r := router.NewRouter()
	cases := []struct {
		model    string
		provider string
		wantErr  bool
	}{
		{"claude-sonnet-5", "anthropic", false},
		{"claude-haiku-4-5-20251001", "anthropic", false},
		{"gpt-4.1", "openai", false},
		{"o1", "openai", false},
		{"o3-mini", "openai", false},
		{"o4-preview", "openai", false},
		{"gemini-2.5-flash", "gemini", false},
		{"llama-3-70b", "", true},
		{"", "", true},
	}
	for _, c := range cases {
		got, err := r.ResolveModel(c.model)
		if c.wantErr {
			if err == nil {
				t.Errorf("ResolveModel(%q) expected error", c.model)
			}
			continue
		}
		if err != nil {
			t.Errorf("ResolveModel(%q) error: %v", c.model, err)
			continue
		}
		if got.Provider != c.provider {
			t.Errorf("ResolveModel(%q) = %s, want %s", c.model, got.Provider, c.provider)
		}
	}
}

func TestChatFillsCostAndNoDegradedWhenSupported(t *testing.T) {
	r := router.NewRouter()
	// Register a mock UNDER the routed provider name with caching supported.
	r.Register(&mock.MockProvider{Named: "anthropic", Caps: router.Capabilities{PromptCaching: true, StructuredOutput: "native"}})
	resp, err := r.Chat(context.Background(), router.ChatRequest{
		Capability:       router.CapDefaultQuality,
		Messages:         []router.Message{{Role: "user", Content: "hi"}},
		CacheBreakpoints: []int{0},
	})
	if err != nil {
		t.Fatalf("Chat error: %v", err)
	}
	if len(resp.Degraded) != 0 {
		t.Errorf("expected no degraded markers, got %v", resp.Degraded)
	}
	if resp.Usage.CostUSD != 0 {
		t.Errorf("mock model cost should be 0, got %v", resp.Usage.CostUSD)
	}
	if resp.Provider != "anthropic" {
		t.Errorf("provider = %q, want anthropic", resp.Provider)
	}
}

func TestChatDegradedWhenCachingUnsupported(t *testing.T) {
	r := router.NewRouter()
	// Provider lacks prompt caching, but the caller asked for it.
	r.Register(&mock.MockProvider{Named: "anthropic", Caps: router.Capabilities{PromptCaching: false}})
	resp, err := r.Chat(context.Background(), router.ChatRequest{
		Capability:       router.CapDefaultQuality,
		Messages:         []router.Message{{Role: "user", Content: "hi"}},
		CacheBreakpoints: []int{0},
		ResponseSchema:   json.RawMessage(`{"type":"object"}`),
	})
	if err != nil {
		t.Fatalf("Chat error: %v", err)
	}
	if len(resp.Degraded) != 2 {
		t.Fatalf("expected 2 degraded markers (caching + structured-output), got %v", resp.Degraded)
	}
}

func TestChatUnregisteredProviderErrors(t *testing.T) {
	r := router.NewRouter()
	// Nothing registered → default-quality routes to anthropic → error.
	if _, err := r.Chat(context.Background(), router.ChatRequest{Capability: router.CapDefaultQuality}); err == nil {
		t.Fatal("expected error for unregistered provider")
	}
}

func TestChatNeedsCapabilityOrModel(t *testing.T) {
	r := router.NewRouter()
	if _, err := r.Chat(context.Background(), router.ChatRequest{}); err == nil {
		t.Fatal("expected error when neither capability nor model set")
	}
}

// TestChatForcedProviderRoutesExplicitModel proves the per-role model override
// path used by the swarm: under a forced provider, an explicit model — even a
// prefix-unknown id like "m-a" — routes to that provider instead of erroring on
// provider inference, and stays $0 on the mock.
func TestChatForcedProviderRoutesExplicitModel(t *testing.T) {
	r := router.NewRouter()
	r.Register(mock.New())
	r.ForceProvider("mock")
	resp, err := r.Chat(context.Background(), router.ChatRequest{
		Model:    "m-a",
		Messages: []router.Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("forced provider should route an opaque explicit model, got: %v", err)
	}
	if resp.Provider != "mock" {
		t.Errorf("provider = %q, want mock", resp.Provider)
	}
	if resp.Usage.CostUSD != 0 {
		t.Errorf("mock cost should be 0, got %v", resp.Usage.CostUSD)
	}
}
