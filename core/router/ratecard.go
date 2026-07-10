package router

import "regexp"

// Rate is a per-model price in USD per million tokens. CachedInputPerMtok is
// the discounted prompt-cache read rate (Anthropic surfaces this directly;
// OpenAI/Gemini surface 0 today).
type Rate struct {
	InputPerMtok       float64
	OutputPerMtok      float64
	CachedInputPerMtok float64
}

// RateCard mirrors lib/model-adapters/rate-card.mjs. Numbers reflect published
// rates as of 2026-07; verify before relying on totals for invoicing.
var RateCard = map[string]Rate{
	// Anthropic — current models + list pricing at console.anthropic.com/pricing.
	"claude-opus-4-8":  {InputPerMtok: 5.00, OutputPerMtok: 25.00, CachedInputPerMtok: 0.50},
	"claude-sonnet-5":  {InputPerMtok: 3.00, OutputPerMtok: 15.00, CachedInputPerMtok: 0.30},
	"claude-haiku-4-5": {InputPerMtok: 1.00, OutputPerMtok: 5.00, CachedInputPerMtok: 0.10},

	// OpenAI — published rates at openai.com/api/pricing.
	"gpt-4.1":      {InputPerMtok: 2.00, OutputPerMtok: 8.00, CachedInputPerMtok: 0.50},
	"gpt-4.1-mini": {InputPerMtok: 0.40, OutputPerMtok: 1.60, CachedInputPerMtok: 0.10},

	// Gemini — AI Studio rates at ai.google.dev/pricing.
	"gemini-2.5-flash": {InputPerMtok: 0.30, OutputPerMtok: 2.50, CachedInputPerMtok: 0},
	"gemini-2.5-pro":   {InputPerMtok: 1.25, OutputPerMtok: 10.00, CachedInputPerMtok: 0},
}

var dateSuffix = regexp.MustCompile(`-\d{8}$`)

// canonicalize normalizes a model id for rate-card lookup: the protocol's short
// forms (claude-haiku-4-5) and the adapter's dated forms
// (claude-haiku-4-5-20251001) both resolve to the same row.
func canonicalize(model string) string {
	if model == "" {
		return model
	}
	return dateSuffix.ReplaceAllString(model, "")
}

// Cost returns the USD cost of a call. Anthropic cached tokens bill at the
// cached rate; the remaining input tokens bill at standard. An unknown model
// returns 0 (never block a real call), mirroring the reference — the ledger
// still records the tokens so cost analysis surfaces the gap.
func Cost(model string, inputTokens, outputTokens, cachedTokens int) float64 {
	card, ok := RateCard[canonicalize(model)]
	if !ok {
		return 0
	}
	uncached := inputTokens - cachedTokens
	if uncached < 0 {
		uncached = 0
	}
	inputCost := float64(uncached) / 1_000_000 * card.InputPerMtok
	cachedCost := float64(cachedTokens) / 1_000_000 * card.CachedInputPerMtok
	outputCost := float64(outputTokens) / 1_000_000 * card.OutputPerMtok
	return inputCost + cachedCost + outputCost
}
