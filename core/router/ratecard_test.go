package router_test

import (
	"math"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCostStandard(t *testing.T) {
	// 1M in + 1M out on Sonnet = 3.00 + 15.00 = 18.00.
	got := router.Cost("claude-sonnet-5", 1_000_000, 1_000_000, 0)
	if !approx(got, 18.00) {
		t.Errorf("Cost = %v, want 18.00", got)
	}
}

func TestCostCachedMath(t *testing.T) {
	// 1M input of which 500k cached, 0 output on Sonnet:
	// uncached 500k * 3.00/M = 1.50 ; cached 500k * 0.30/M = 0.15 => 1.65.
	got := router.Cost("claude-sonnet-5", 1_000_000, 0, 500_000)
	if !approx(got, 1.65) {
		t.Errorf("Cost = %v, want 1.65", got)
	}
}

// TestCostCurrentAnthropicModels pins list pricing for the three current models
// a real paid benchmark run may route to (1M in + 1M out at standard rates).
func TestCostCurrentAnthropicModels(t *testing.T) {
	cases := []struct {
		model string
		want  float64 // (In + Out) per 1M tokens
	}{
		{"claude-opus-4-8", 5.00 + 25.00},  // 30.00
		{"claude-sonnet-5", 3.00 + 15.00},  // 18.00
		{"claude-haiku-4-5", 1.00 + 5.00},  // 6.00
	}
	for _, c := range cases {
		if got := router.Cost(c.model, 1_000_000, 1_000_000, 0); !approx(got, c.want) {
			t.Errorf("Cost(%q, 1M, 1M, 0) = %v, want %v", c.model, got, c.want)
		}
	}
}

// TestCostCurrentModelsCached pins the discounted cached-read rate for each.
func TestCostCurrentModelsCached(t *testing.T) {
	cases := []struct {
		model string
		want  float64 // 1M fully-cached input at the cached rate
	}{
		{"claude-opus-4-8", 0.50},
		{"claude-sonnet-5", 0.30},
		{"claude-haiku-4-5", 0.10},
	}
	for _, c := range cases {
		if got := router.Cost(c.model, 1_000_000, 0, 1_000_000); !approx(got, c.want) {
			t.Errorf("Cost(%q cached) = %v, want %v", c.model, got, c.want)
		}
	}
}

func TestCostDatedSuffixCanonicalizes(t *testing.T) {
	// Dated forms must resolve to the same row as the short form.
	cases := []struct {
		model string
		want  float64 // 1M input at standard rate
	}{
		{"claude-haiku-4-5-20251001", 1.00},
		{"claude-opus-4-8-20260101", 5.00},
		{"claude-sonnet-5-20260101", 3.00},
	}
	for _, c := range cases {
		if got := router.Cost(c.model, 1_000_000, 0, 0); !approx(got, c.want) {
			t.Errorf("Cost(%q) = %v, want %v (canonicalized)", c.model, got, c.want)
		}
	}
}

func TestCostUnknownModelIsZero(t *testing.T) {
	if got := router.Cost("mystery-model-9", 1000, 1000, 0); got != 0 {
		t.Errorf("unknown model Cost = %v, want 0", got)
	}
	if got := router.Cost("mock", 999, 999, 0); got != 0 {
		t.Errorf("mock model Cost = %v, want 0", got)
	}
}
