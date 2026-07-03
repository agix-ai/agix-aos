// OpenRouter adapter for the Agix Model protocol. OpenRouter is a hosted
// OpenAI-compatible gateway that fans one API key out across many upstream
// providers/models, so we reuse the OpenAI adapter internals wholesale and
// only pin the base URL, the attribution headers OpenRouter recommends
// (`HTTP-Referer` + `X-Title`, used for its app leaderboard + rate limits),
// and the provider label.
//
// Model ids are OpenRouter's `vendor/model` form (e.g. `anthropic/claude-…`).
// The dispatcher strips the routing `openrouter/` prefix before the id
// reaches this adapter — see routing.mjs::stripRoutingPrefix.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §3.2 (OpenAI-compatible lane).

import { OpenAIAdapter } from './openai.mjs';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Attribution defaults. Overridable per-instance (constructor) or via env
// (AGIX_OPENROUTER_REFERER); kept generic so the open-source distribution
// doesn't hardcode a specific deployment.
const DEFAULT_REFERER = process.env.AGIX_OPENROUTER_REFERER || 'https://github.com/agix-ai/agix-aos';
const DEFAULT_TITLE = 'Agix AOS';

export class OpenRouterAdapter extends OpenAIAdapter {
  constructor({ apiKey, referer, title } = {}) {
    if (!apiKey) {
      throw new Error('OpenRouterAdapter: apiKey is required');
    }
    super({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      provider: 'openrouter',
      local: false, // hosted gateway — a key IS required, not a local server
      headers: {
        'HTTP-Referer': referer || DEFAULT_REFERER,
        'X-Title': title || DEFAULT_TITLE,
      },
    });
  }
}
