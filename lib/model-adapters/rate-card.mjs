// Per-model rate card in USD per million tokens. Numbers reflect
// published rates as of 2026-05; verify before relying on totals for
// invoicing. `cached_input_per_mtok` is the discounted prompt-cache read
// rate (Anthropic surfaces this directly; OpenAI/Gemini surface 0 today).
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §5.

export const RATE_CARD = Object.freeze({
  // Anthropic — published rates at console.anthropic.com/pricing.
  'claude-opus-4-7':    { input_per_mtok: 15.00, output_per_mtok: 75.00, cached_input_per_mtok: 1.50  }, // TODO(rate-card): verify Opus 4.7 1M-context tier; published Opus 4.x rates as of 2026-05
  'claude-sonnet-4-6':  { input_per_mtok: 3.00,  output_per_mtok: 15.00, cached_input_per_mtok: 0.30  }, // TODO(rate-card): verify Sonnet 4.6 published rate
  'claude-haiku-4-5':   { input_per_mtok: 1.00,  output_per_mtok: 5.00,  cached_input_per_mtok: 0.10  }, // TODO(rate-card): verify Haiku 4.5

  // OpenAI — published rates at openai.com/api/pricing.
  'gpt-4.1':            { input_per_mtok: 2.00,  output_per_mtok: 8.00,  cached_input_per_mtok: 0.50  }, // TODO(rate-card): verify gpt-4.1 standard rate
  'gpt-4.1-mini':       { input_per_mtok: 0.40,  output_per_mtok: 1.60,  cached_input_per_mtok: 0.10  }, // TODO(rate-card): verify gpt-4.1-mini

  // Gemini — AI Studio rates at ai.google.dev/pricing.
  'gemini-2.5-flash':   { input_per_mtok: 0.30,  output_per_mtok: 2.50,  cached_input_per_mtok: 0     }, // TODO(rate-card): verify 2.5 Flash; tiered pricing >200K may change
  'gemini-2.5-pro':     { input_per_mtok: 1.25,  output_per_mtok: 10.00, cached_input_per_mtok: 0     }, // TODO(rate-card): verify 2.5 Pro
});

// Normalize a model ID for rate-card lookup. The protocol's short forms
// (`claude-haiku-4-5`) and the adapter's dated forms
// (`claude-haiku-4-5-20251001`) both must resolve to the same row.
function canonicalize(modelId) {
  if (!modelId) return modelId;
  // Strip Anthropic date suffix: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`.
  return String(modelId).replace(/-\d{8}$/, '');
}

export function computeCost({ provider, model, input_tokens = 0, output_tokens = 0, cached_tokens = 0 } = {}) {
  const key = canonicalize(model);
  const card = RATE_CARD[key];
  if (!card) {
    // Unknown model — return 0 rather than throw so a missing rate-card
    // row never blocks a real call. The ledger will still record the
    // tokens; cost analysis surfaces the gap.
    return 0;
  }
  // Anthropic cached_tokens are billed at the cached rate; the remaining
  // input_tokens are billed at standard. OpenAI/Gemini report 0 cached
  // today so the math collapses to standard-only.
  const uncachedInput = Math.max(0, input_tokens - cached_tokens);
  const inputCost  = (uncachedInput / 1_000_000) * card.input_per_mtok;
  const cachedCost = (cached_tokens / 1_000_000) * card.cached_input_per_mtok;
  const outputCost = (output_tokens / 1_000_000) * card.output_per_mtok;
  return inputCost + cachedCost + outputCost;
}
