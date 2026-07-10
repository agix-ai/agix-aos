package swarm

// White-box $0 proof that the output-token budgets are actually THREADED to the
// provider call. The mock provider never truncates (it echoes the prompt), so a
// budget regression is invisible in the answer text — the only way to prove the
// wiring is to CAPTURE the max_tokens each Chat request carries. This is the
// exact seam that starved the Exp #3 synthesis at the 1024 default.

import (
	"context"
	"sync"
	"testing"

	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/router"
)

// captureProvider records every ChatRequest it receives, then answers like the
// mock (deterministic, $0, model="mock" so the rate card charges nothing).
type captureProvider struct {
	mu    sync.Mutex
	calls []router.ChatRequest
}

func (c *captureProvider) Name() string { return "mock" }

func (c *captureProvider) Capabilities() router.Capabilities {
	return router.Capabilities{StructuredOutput: "prompt"}
}

func (c *captureProvider) Chat(_ context.Context, req router.ChatRequest) (router.ChatResponse, error) {
	c.mu.Lock()
	c.calls = append(c.calls, req)
	c.mu.Unlock()
	return router.ChatResponse{
		Text:     "mock reply",
		Usage:    router.Usage{InputTokens: 1, OutputTokens: 1},
		Provider: "mock",
		Model:    "mock",
	}, nil
}

func (c *captureProvider) maxTokensForSystem(system string) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, r := range c.calls {
		if r.System == system {
			return r.MaxTokens, true
		}
	}
	return 0, false
}

func forcedCaptureRouter() (*router.Router, *captureProvider) {
	cp := &captureProvider{}
	r := router.NewRouter()
	r.Register(cp)
	r.ForceProvider("mock")
	return r, cp
}

// TestSynthUsesSynthMaxTokens proves the Queen's merge call carries
// SynthMaxTokens (not the per-slice MaxTokens), and the verifier — whose reply
// is a short verdict — carries the per-slice MaxTokens. This is the fix for the
// starved synthesis.
func TestSynthUsesSynthMaxTokens(t *testing.T) {
	ctx := context.Background()
	r, cp := forcedCaptureRouter()

	o := Options{
		Task:           "compare 6 databases across 5 dims",
		Hive:           "agix",
		QueenCap:       router.CapDefaultQuality,
		VerifyCap:      router.CapDefaultQuality,
		MaxTokens:      1024,
		SynthMaxTokens: 8000,
	}
	outs := []workerOut{
		{Subtask: Subtask{ID: "st-1"}},
		{Subtask: Subtask{ID: "st-2"}},
	}

	if _, err := converge(ctx, r, o, outs); err != nil {
		t.Fatalf("converge: %v", err)
	}

	if got, ok := cp.maxTokensForSystem(synthSystem); !ok {
		t.Fatal("no synthesis Chat call was captured")
	} else if got != 8000 {
		t.Errorf("synthesis max_tokens = %d, want 8000 (SynthMaxTokens, the merge budget)", got)
	}

	if got, ok := cp.maxTokensForSystem(verifySystem); !ok {
		t.Fatal("no verifier Chat call was captured")
	} else if got != 1024 {
		t.Errorf("verifier max_tokens = %d, want 1024 (per-slice MaxTokens)", got)
	}
}

// TestWorkerUsesMaxTokens proves each worker's forage call carries the per-slice
// MaxTokens from Options — previously the worker call hardcoded 1024 and ignored
// Options entirely.
func TestWorkerUsesMaxTokens(t *testing.T) {
	ctx := context.Background()
	r, cp := forcedCaptureRouter()

	o := Options{
		Task:        "compare 6 databases across 5 dims",
		Hive:        "agix",
		Concurrency: 4, // fanOut is called directly here (no withDefaults), so set the semaphore size
		WorkerCap:   router.CapCheapClassification,
		MaxTokens:   4096,
	}
	subs := []Subtask{{ID: "st-1", Prompt: "one cell"}, {ID: "st-2", Prompt: "another cell"}}

	outs := fanOut(ctx, r, coord.NewMemLedger(), o, "agix/swarm/run-x", subs)
	if len(outs) != 2 {
		t.Fatalf("fanOut returned %d outs, want 2", len(outs))
	}

	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.calls) != 2 {
		t.Fatalf("captured %d worker Chat calls, want 2", len(cp.calls))
	}
	for i, c := range cp.calls {
		if c.MaxTokens != 4096 {
			t.Errorf("worker call %d max_tokens = %d, want 4096 (Options.MaxTokens)", i, c.MaxTokens)
		}
	}
}

// TestSynthMaxTokensDefaultRaised proves withDefaults raises the merge budget to
// 4096 (not the 1024 that starved Exp #3) while leaving the per-slice default at
// 1024, and never lets the merge fall below the per-slice budget.
func TestSynthMaxTokensDefaultRaised(t *testing.T) {
	// Unset both → per-slice stays 1024, merge lifts to 4096.
	d := withDefaults(Options{Task: "x"})
	if d.MaxTokens != 1024 {
		t.Errorf("default MaxTokens = %d, want 1024 (unchanged)", d.MaxTokens)
	}
	if d.SynthMaxTokens != 4096 {
		t.Errorf("default SynthMaxTokens = %d, want 4096 (raised so the merge is not starved)", d.SynthMaxTokens)
	}

	// A large per-slice budget must lift the merge to at least match it.
	d2 := withDefaults(Options{Task: "x", MaxTokens: 8000})
	if d2.SynthMaxTokens < 8000 {
		t.Errorf("SynthMaxTokens = %d, want >= MaxTokens (8000); merge must never be smaller than a slice", d2.SynthMaxTokens)
	}
}
