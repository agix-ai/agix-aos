// Capability → provider+model routing table. One-place edit per the
// model-agnostic protocol; operator can re-route Sonnet→GPT in one PR
// without touching agent code.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §4.

export const ROUTING_TABLE = Object.freeze({
  'default-quality':      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'cheap-classification': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'long-context':         { provider: 'anthropic', model: 'claude-opus-4-7'  },
  'tool-use-heavy':       { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'vision':               { provider: 'gemini',    model: 'gemini-2.5-flash' },
});

export function resolveCapability(capability) {
  const row = ROUTING_TABLE[capability];
  if (!row) {
    throw new Error(
      `Unknown capability "${capability}". Known: ${Object.keys(ROUTING_TABLE).join(', ')}.`,
    );
  }
  return row;
}

// Map an explicit model ID to its provider. Used when the caller bypasses
// the capability table by passing `model: '...'` directly.
//
// Matching is prefix-based on the canonical family stem so dated suffixes
// (e.g. `claude-haiku-4-5-20251001`) still resolve.
export function resolveModelToProvider(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('resolveModelToProvider: modelId must be a string');
  }
  const id = modelId.toLowerCase();
  // CLI-passthrough providers: explicit opt-in via model id. `claude-code`
  // and `codex` route through the locally-installed CLI agent (subscription
  // auth) instead of an API key. See lib/model-adapters/cli-passthrough.mjs.
  if (id === 'claude-code') return 'claude-code';
  if (id === 'codex') return 'codex';
  // OpenAI-compatible hosted gateways (all reuse the OpenAI adapter path).
  // Explicit `openrouter/…` / `groq/…` / `mistral/…` prefixes win before
  // the family stems below. Groq routes on the `groq/` prefix ONLY (never
  // bare `llama-`/`mixtral-`/`gemma-`) to avoid clashing with local models.
  if (id.startsWith('openrouter/')) return 'openrouter';
  if (id.startsWith('groq/')) return 'groq';
  if (id.startsWith('mistral/') || id.startsWith('mistral-')) return 'mistral';
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  if (id.startsWith('gemini-')) return 'gemini';
  // Local OpenAI-compatible lane (ollama et al). When AGIX_LOCAL_MODEL_URL is
  // configured, any non-frontier model id (e.g. 'gemma3:4b') routes to the
  // local endpoint rather than being rejected.
  if ((process.env.AGIX_LOCAL_MODEL_URL || '').trim()) return 'local';
  throw new Error(`Cannot infer provider for model "${modelId}". Add a prefix rule in lib/model-adapters/routing.mjs.`);
}

// Strip the routing prefix from a model id before it reaches the adapter.
// `openrouter/anthropic/claude-…` → `anthropic/claude-…` (OpenRouter's own
// vendor/model form); `groq/llama-…` → `llama-…`; `mistral/…` → `…`. A bare
// `mistral-large-latest` (no slash) is passed through unchanged.
export function stripRoutingPrefix(modelId, provider) {
  const id = String(modelId ?? '');
  if (provider === 'openrouter' && /^openrouter\//i.test(id)) return id.slice('openrouter/'.length);
  if (provider === 'groq' && /^groq\//i.test(id)) return id.slice('groq/'.length);
  if (provider === 'mistral' && /^mistral\//i.test(id)) return id.slice('mistral/'.length);
  return id;
}

// Providers backed by the CLI-passthrough adapter (subscription auth, no
// API key). The Model dispatcher maps these to the kind the adapter needs.
export const CLI_PROVIDERS = Object.freeze({
  'claude-code': 'claude-code',
  'codex':       'codex',
});
