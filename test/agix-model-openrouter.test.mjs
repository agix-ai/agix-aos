// agix-model OpenRouter + Groq + Mistral gateways — Chunk 3 of the model
// spine. All three are OpenAI-compatible hosted gateways reusing the OpenAI
// adapter path. Asserts prefix routing, model-id prefix stripping, and
// adapter construction. No network — construction + routing only.
// Runner: node --test test/agix-model-openrouter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Model } from '../lib/agix-model.mjs';
import { OpenRouterAdapter } from '../lib/model-adapters/openrouter.mjs';
import { OpenAIAdapter } from '../lib/model-adapters/openai.mjs';
import { resolveModelToProvider, stripRoutingPrefix } from '../lib/model-adapters/routing.mjs';

// Isolate from a developer's local-model env so unknown ids don't route local.
const _savedLocal = process.env.AGIX_LOCAL_MODEL_URL;
delete process.env.AGIX_LOCAL_MODEL_URL;
process.on('exit', () => { if (_savedLocal !== undefined) process.env.AGIX_LOCAL_MODEL_URL = _savedLocal; });

// ─── prefix routing ──────────────────────────────────────────────────

test('resolveModelToProvider: gateway prefixes route to the right provider', () => {
  assert.equal(resolveModelToProvider('openrouter/anthropic/claude-3.7-sonnet'), 'openrouter');
  assert.equal(resolveModelToProvider('groq/llama-3.3-70b-versatile'), 'groq');
  assert.equal(resolveModelToProvider('mistral/mistral-large-latest'), 'mistral');
  assert.equal(resolveModelToProvider('mistral-large-latest'), 'mistral');
  // Bare Groq stems do NOT clash — they are not routed to groq without the prefix.
  assert.throws(() => resolveModelToProvider('llama-3.3-70b'), /Cannot infer provider/);
  assert.throws(() => resolveModelToProvider('mixtral-8x7b'), /Cannot infer provider/);
  // Existing providers unchanged.
  assert.equal(resolveModelToProvider('claude-sonnet-4-6'), 'anthropic');
  assert.equal(resolveModelToProvider('gpt-4.1-mini'), 'openai');
});

test('stripRoutingPrefix: strips the gateway prefix, leaves bare ids alone', () => {
  assert.equal(stripRoutingPrefix('openrouter/anthropic/claude-3.7-sonnet', 'openrouter'), 'anthropic/claude-3.7-sonnet');
  assert.equal(stripRoutingPrefix('groq/llama-3.3-70b-versatile', 'groq'), 'llama-3.3-70b-versatile');
  assert.equal(stripRoutingPrefix('mistral/mistral-large-latest', 'mistral'), 'mistral-large-latest');
  assert.equal(stripRoutingPrefix('mistral-large-latest', 'mistral'), 'mistral-large-latest');
});

test('Model._route strips the gateway prefix for the adapter', () => {
  const model = new Model({ keys: { openrouter: 'k' } });
  const route = model._route({ model: 'openrouter/anthropic/claude-3.7-sonnet' });
  assert.equal(route.provider, 'openrouter');
  assert.equal(route.model, 'anthropic/claude-3.7-sonnet');
});

// ─── OpenRouter adapter construction ─────────────────────────────────

test('OpenRouterAdapter: base URL, label, attribution headers, key required', () => {
  const a = new OpenRouterAdapter({ apiKey: 'or-key' });
  assert.equal(a.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(a.providerLabel, 'openrouter');
  assert.equal(a.local, false); // hosted gateway, not a local server
  assert.equal(a.extraHeaders['HTTP-Referer'], 'https://github.com/agix-ai/agix-aos');
  assert.equal(a.extraHeaders['X-Title'], 'Agix AOS');
  // Hosted capabilities (native structured output), NOT the local profile.
  assert.equal(a.capabilities.structuredOutput, 'native');
  assert.equal(a.capabilities.vision, true);
  assert.throws(() => new OpenRouterAdapter({}), /apiKey is required/);
  // Custom attribution overrides.
  const b = new OpenRouterAdapter({ apiKey: 'or-key', referer: 'https://example.test', title: 'MyApp' });
  assert.equal(b.extraHeaders['HTTP-Referer'], 'https://example.test');
  assert.equal(b.extraHeaders['X-Title'], 'MyApp');
});

// ─── _getAdapter wiring ──────────────────────────────────────────────

test('_getAdapter(openrouter): constructs the OpenRouter adapter when the key is set', () => {
  const model = new Model({ keys: { openrouter: 'or-key' } });
  const a = model._getAdapter('openrouter');
  assert.ok(a instanceof OpenRouterAdapter);
  assert.equal(a.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
});

test('_getAdapter(groq): OpenAI-compatible adapter against Groq, key required', () => {
  const model = new Model({ keys: { groq: 'gk' } });
  const a = model._getAdapter('groq');
  assert.ok(a instanceof OpenAIAdapter);
  assert.equal(a.endpoint, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(a.providerLabel, 'groq');
  assert.equal(a.local, false);
  assert.equal(a.capabilities.structuredOutput, 'native');
});

test('_getAdapter(mistral): OpenAI-compatible adapter against Mistral, key required', () => {
  const model = new Model({ keys: { mistral: 'mk' } });
  const a = model._getAdapter('mistral');
  assert.ok(a instanceof OpenAIAdapter);
  assert.equal(a.endpoint, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(a.providerLabel, 'mistral');
});

test('_getAdapter: each gateway throws a clear KEY-missing error when unconfigured', () => {
  const model = new Model({ keys: {} });
  assert.throws(() => model._getAdapter('openrouter'), /OPENROUTER_API_KEY missing/);
  assert.throws(() => model._getAdapter('groq'), /GROQ_API_KEY missing/);
  assert.throws(() => model._getAdapter('mistral'), /MISTRAL_API_KEY missing/);
});
