package mock_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
)

func TestMockDeterministicReplyAndUsage(t *testing.T) {
	p := mock.New()
	req := router.ChatRequest{
		Capability: router.CapDefaultQuality,
		System:     "you are a worker bee",
		Messages:   []router.Message{{Role: "user", Content: "hello hive world"}},
	}
	a, err := p.Chat(context.Background(), req)
	if err != nil {
		t.Fatalf("Chat error: %v", err)
	}
	b, err := p.Chat(context.Background(), req)
	if err != nil {
		t.Fatalf("Chat error: %v", err)
	}
	if a.Text != b.Text || a.Usage != b.Usage {
		t.Fatalf("mock not deterministic:\n a=%+v\n b=%+v", a, b)
	}
	if !strings.Contains(a.Text, "hello hive world") {
		t.Errorf("reply should echo the prompt, got %q", a.Text)
	}
	if a.Usage.InputTokens <= 0 || a.Usage.OutputTokens <= 0 {
		t.Errorf("expected positive synthetic token counts, got %+v", a.Usage)
	}
	if a.Provider != "mock" || a.Model != "mock" {
		t.Errorf("provider/model = %s/%s, want mock/mock", a.Provider, a.Model)
	}
}

func TestMockNameOverride(t *testing.T) {
	p := &mock.MockProvider{Named: "anthropic"}
	if p.Name() != "anthropic" {
		t.Errorf("Name = %q, want anthropic", p.Name())
	}
	if (&mock.MockProvider{}).Name() != "mock" {
		t.Error("empty Named should default to mock")
	}
}
