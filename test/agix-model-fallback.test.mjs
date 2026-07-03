// agix-model fallback chain + ledger degraded[] — Chunk 4 of the model
// spine. Covers the opt-in single fallback on a retryable provider error and
// the honest degraded[] markers (prompt_cache / structured:prompt /
// fallback:<from>) that ride onto the ledger. Adapters stubbed — no network.
// Runner: node --test test/agix-model-fallback.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Model } from '../lib/agix-model.mjs';
import { buildLedgerEntry } from '../lib/model-adapters/ledger.mjs';
import { ModelProviderError, StructuredOutputError } from '../lib/model-adapters/errors.mjs';

const HOSTED_CAPS = { toolUse: true, streamingToolUse: true, structuredOutput: 'native', vision: true, promptCaching: false, reasoning: true };

function okResponse(model) {
  return {
    model_used: model,
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 5, output_tokens: 5, cached_tokens: 0 },
    stop_reason: 'end_turn',
    latency_ms: 1,
  };
}

// Model with captured ledger writes (no disk) + stubbable adapters.
function makeModel(keys = { anthropic: 'a', openai: 'o' }) {
  const model = new Model({ keys });
  const ledger = [];
  // Snapshot degraded[] at write time — the dispatcher shares one live array
  // across attempts, and the real ledger serializes (JSON) at each write.
  model._writeLedger = async (args) => { ledger.push({ ...args, degraded: [...(args.degraded || [])] }); };
  model._ledger = ledger;
  return model;
}

function setAdapter(model, provider, impl, caps = HOSTED_CAPS) {
  model._adapters.set(provider, { capabilities: caps, chat: impl });
}

// ─── ledger schema ───────────────────────────────────────────────────

test('buildLedgerEntry: carries a degraded[] field (defaults to [])', () => {
  assert.deepEqual(buildLedgerEntry({ callId: 'c', provider: 'anthropic', model: 'm' }).degraded, []);
  assert.deepEqual(
    buildLedgerEntry({ callId: 'c', provider: 'anthropic', model: 'm', degraded: ['fallback:anthropic'] }).degraded,
    ['fallback:anthropic'],
  );
});

// ─── fallback firing ─────────────────────────────────────────────────

test('retryable 5xx on primary → fallback fires once, returns fallback response', async () => {
  const model = makeModel();
  let anthropicCalls = 0;
  let openaiCalls = 0;
  setAdapter(model, 'anthropic', async () => {
    anthropicCalls += 1;
    throw new ModelProviderError({ provider: 'anthropic', model: 'claude-haiku-4-5', status: 503, message: 'overloaded' });
  });
  setAdapter(model, 'openai', async () => { openaiCalls += 1; return okResponse('gpt-4.1-mini'); });

  const resp = await model.chat({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    fallbackModel: 'gpt-4.1-mini',
  });

  assert.equal(resp.model_used, 'gpt-4.1-mini');
  assert.equal(anthropicCalls, 1);
  assert.equal(openaiCalls, 1);
  // Two ledger writes: the failed primary + the successful fallback.
  assert.equal(model._ledger.length, 2);
  const success = model._ledger.find((e) => e.provider === 'openai');
  assert.ok(success.degraded.includes('fallback:anthropic'));
  // The failed primary entry recorded the error and did NOT claim a fallback.
  const failed = model._ledger.find((e) => e.provider === 'anthropic');
  assert.ok(failed.error);
  assert.ok(!(failed.degraded || []).includes('fallback:anthropic'));
});

test('network error (no status) is retryable → fallback fires', async () => {
  const model = makeModel();
  setAdapter(model, 'anthropic', async () => {
    throw new ModelProviderError({ provider: 'anthropic', model: 'x', status: null, message: 'ECONNRESET' });
  });
  let hit = false;
  setAdapter(model, 'openai', async () => { hit = true; return okResponse('gpt-4.1-mini'); });
  const resp = await model.chat({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], fallbackModel: 'gpt-4.1-mini' });
  assert.ok(hit);
  assert.equal(resp.model_used, 'gpt-4.1-mini');
});

// ─── fallback NOT firing ─────────────────────────────────────────────

test('4xx auth error is NOT retryable → original error thrown, no fallback', async () => {
  const model = makeModel();
  let openaiCalls = 0;
  setAdapter(model, 'anthropic', async () => {
    throw new ModelProviderError({ provider: 'anthropic', model: 'x', status: 401, message: 'unauthorized' });
  });
  setAdapter(model, 'openai', async () => { openaiCalls += 1; return okResponse('gpt-4.1-mini'); });
  await assert.rejects(
    () => model.chat({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], fallbackModel: 'gpt-4.1-mini' }),
    (err) => err instanceof ModelProviderError && err.status === 401,
  );
  assert.equal(openaiCalls, 0, 'fallback must not fire on a 4xx');
});

test('no fallbackModel declared → retryable error surfaces unchanged', async () => {
  const model = makeModel();
  setAdapter(model, 'anthropic', async () => {
    throw new ModelProviderError({ provider: 'anthropic', model: 'x', status: 503, message: 'overloaded' });
  });
  await assert.rejects(
    () => model.chat({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof ModelProviderError && err.status === 503,
  );
});

test('StructuredOutputError does NOT trigger a fallback', async () => {
  const model = makeModel();
  let openaiCalls = 0;
  // Prompt-rung provider that never returns JSON → StructuredOutputError.
  setAdapter(model, 'anthropic',
    async () => okResponse('claude-haiku-4-5'), // text 'ok' is not JSON
    { ...HOSTED_CAPS, structuredOutput: 'prompt' });
  setAdapter(model, 'openai', async () => { openaiCalls += 1; return okResponse('gpt-4.1-mini'); });
  await assert.rejects(
    () => model.chat({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'json' }],
      responseSchema: { type: 'object' },
      fallbackModel: 'gpt-4.1-mini',
    }),
    StructuredOutputError,
  );
  assert.equal(openaiCalls, 0);
});

// ─── other degraded markers ──────────────────────────────────────────

test('prompt_cache marker recorded when routed provider lacks caching', async () => {
  const model = makeModel();
  setAdapter(model, 'anthropic', async () => okResponse('claude-haiku-4-5'),
    { ...HOSTED_CAPS, promptCaching: false });
  await model.chat({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    cache_breakpoints: [{ scope: 'messages' }],
  });
  assert.ok(model._ledger[0].degraded.includes('prompt_cache'));
});

test('structured:prompt marker recorded when the prompt rung is used', async () => {
  const model = makeModel();
  setAdapter(model, 'anthropic', async () => ({ ...okResponse('claude-haiku-4-5'), content: [{ type: 'text', text: '{"a":1}' }] }),
    { ...HOSTED_CAPS, structuredOutput: 'prompt' });
  const resp = await model.chat({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'json' }],
    responseSchema: { type: 'object', properties: { a: { type: 'number' } } },
  });
  assert.deepEqual(resp.structured, { a: 1 });
  assert.ok(model._ledger[0].degraded.includes('structured:prompt'));
});
