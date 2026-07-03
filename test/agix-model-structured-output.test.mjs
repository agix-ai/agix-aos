// agix-model structured-output ladder — Chunk 2 of the model spine.
// Exercises the dispatcher's degradation ladder: native pass-through,
// the prompt-rung parse (fences + balanced extraction), the single re-ask,
// and the terminal StructuredOutputError. Adapters are stubbed — no network.
// Runner: node --test test/agix-model-structured-output.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Model } from '../lib/agix-model.mjs';
import { StructuredOutputError } from '../lib/model-adapters/errors.mjs';

// Build a Model with a stubbed adapter of a given structuredOutput capability.
// `replies` is an array of assistant text strings, one per adapter.chat call.
function modelWith({ structuredOutput, replies }) {
  const model = new Model({ keys: { anthropic: 'test' } });
  const calls = [];
  let i = 0;
  model._adapters.set('anthropic', {
    capabilities: { toolUse: true, streamingToolUse: true, structuredOutput, vision: true, promptCaching: true, reasoning: true },
    chat: async (adapterReq) => {
      calls.push(adapterReq);
      const text = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return {
        model_used: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 10, cached_tokens: 0 },
        stop_reason: 'end_turn',
        latency_ms: 1,
      };
    },
  });
  model._calls = calls;
  return model;
}

const BASE = {
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'give me an object' }],
  responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
};

test('native rung: schema passes through to the adapter, reply parsed onto .structured', async () => {
  const model = modelWith({ structuredOutput: 'native', replies: ['{"answer":"hi"}'] });
  const resp = await model.chat(BASE);
  assert.deepEqual(resp.structured, { answer: 'hi' });
  // The adapter saw the native schema field, and no prompt instruction was injected.
  const req = model._calls[0];
  assert.deepEqual(req.responseSchema, BASE.responseSchema);
  assert.equal(model._calls.length, 1);
});

test('prompt rung: injects instruction, strips code fences, extracts balanced JSON', async () => {
  const fenced = 'Sure! Here you go:\n```json\n{ "answer": "wrapped in prose" }\n```\nHope that helps.';
  const model = modelWith({ structuredOutput: 'prompt', replies: [fenced] });
  const resp = await model.chat(BASE);
  assert.deepEqual(resp.structured, { answer: 'wrapped in prose' });
  // Instruction injected into the system prompt; no native schema field.
  const req = model._calls[0];
  assert.ok(/exactly one JSON value/.test(req.system));
  assert.equal(req.responseSchema, undefined);
  assert.equal(model._calls.length, 1);
});

test('prompt rung: bad first reply triggers a single re-ask, then parses', async () => {
  const model = modelWith({
    structuredOutput: 'prompt',
    replies: ['I cannot do that as JSON, sorry.', '{"answer":"second try"}'],
  });
  const resp = await model.chat(BASE);
  assert.deepEqual(resp.structured, { answer: 'second try' });
  // Exactly two adapter calls; the repair turn shows the model its bad output.
  assert.equal(model._calls.length, 2);
  const repair = model._calls[1];
  const roles = repair.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ['assistant', 'user']);
  assert.ok(/not valid JSON/.test(repair.messages.at(-1).content));
});

test('prompt rung: still-unparseable after re-ask throws StructuredOutputError', async () => {
  const model = modelWith({
    structuredOutput: 'prompt',
    replies: ['nope, prose only', 'still just prose, no json here'],
  });
  await assert.rejects(() => model.chat(BASE), (err) => {
    assert.ok(err instanceof StructuredOutputError);
    assert.equal(err.provider, 'anthropic');
    assert.ok(typeof err.raw_text === 'string');
    return true;
  });
  assert.equal(model._calls.length, 2); // one re-ask, no infinite loop
});

test('native rung: unparseable native reply throws immediately (no re-ask)', async () => {
  const model = modelWith({ structuredOutput: 'native', replies: ['not json at all'] });
  await assert.rejects(() => model.chat(BASE), StructuredOutputError);
  assert.equal(model._calls.length, 1);
});

test('structuredOutput:true (no schema) still coerces via the ladder', async () => {
  const model = modelWith({ structuredOutput: 'prompt', replies: ['{"ok":true}'] });
  const resp = await model.chat({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'json please' }],
    structuredOutput: true,
  });
  assert.deepEqual(resp.structured, { ok: true });
});

test('non-structured calls are unchanged (no .structured, single call)', async () => {
  const model = modelWith({ structuredOutput: 'native', replies: ['just a normal answer'] });
  const resp = await model.chat({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(resp.structured, undefined);
  assert.equal(model._calls.length, 1);
  assert.equal(model._calls[0].responseSchema, undefined);
});
