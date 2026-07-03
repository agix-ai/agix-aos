// agix-model-local-lane — unit tests for the local (ollama / OpenAI-compatible)
// model lane wiring. No network: asserts routing + adapter construction only.
// Runner: node --test test/agix-model-local-lane.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelToProvider } from '../lib/model-adapters/routing.mjs';
import { OpenAIAdapter } from '../lib/model-adapters/openai.mjs';

test('resolveModelToProvider: non-frontier id routes to local only when AGIX_LOCAL_MODEL_URL is set', () => {
  const saved = process.env.AGIX_LOCAL_MODEL_URL;
  delete process.env.AGIX_LOCAL_MODEL_URL;
  try {
    // No local endpoint configured → unknown model is rejected (unchanged behavior).
    assert.throws(() => resolveModelToProvider('gemma3:4b'), /Cannot infer provider/);

    process.env.AGIX_LOCAL_MODEL_URL = 'http://127.0.0.1:11434/v1';
    assert.equal(resolveModelToProvider('gemma3:4b'), 'local');
    // Frontier ids still resolve to their own provider even with local set.
    assert.equal(resolveModelToProvider('claude-sonnet-4-6'), 'anthropic');
    assert.equal(resolveModelToProvider('gpt-4.1-mini'), 'openai');
    assert.equal(resolveModelToProvider('gemini-2.5-flash'), 'gemini');
  } finally {
    if (saved === undefined) delete process.env.AGIX_LOCAL_MODEL_URL;
    else process.env.AGIX_LOCAL_MODEL_URL = saved;
  }
});

test('OpenAIAdapter: baseURL targets a local endpoint without an apiKey', () => {
  const a = new OpenAIAdapter({ baseURL: 'http://127.0.0.1:11434/v1' });
  assert.equal(a.endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(a.local, true);

  // Trailing slash on the base URL is tolerated.
  const b = new OpenAIAdapter({ baseURL: 'http://127.0.0.1:11434/v1/' });
  assert.equal(b.endpoint, 'http://127.0.0.1:11434/v1/chat/completions');

  // Default (no baseURL) still requires an apiKey — unchanged frontier behavior.
  assert.throws(() => new OpenAIAdapter({}), /apiKey is required/);

  const c = new OpenAIAdapter({ apiKey: 'sk-test' });
  assert.equal(c.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.local, false);
});
