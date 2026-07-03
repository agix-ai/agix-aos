// agix-model capability descriptors — Chunk 1 of the model spine.
// Each adapter declares what its models support so the dispatcher can pick
// the right structured-output rung + record honest degraded[] markers.
// No network: constructs adapters + reads the static descriptor only.
// Runner: node --test test/agix-model-capabilities.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicAdapter } from '../lib/model-adapters/anthropic.mjs';
import { OpenAIAdapter } from '../lib/model-adapters/openai.mjs';
import { GeminiAdapter } from '../lib/model-adapters/gemini.mjs';
import { CliPassthroughAdapter } from '../lib/model-adapters/cli-passthrough.mjs';
import { Model, DEFAULT_CAPABILITIES } from '../lib/agix-model.mjs';

const CAP_KEYS = ['toolUse', 'streamingToolUse', 'structuredOutput', 'vision', 'promptCaching', 'reasoning'];

function assertShape(caps) {
  for (const k of CAP_KEYS) assert.ok(k in caps, `missing capability key: ${k}`);
  assert.ok(['native', 'json_mode', 'prompt'].includes(caps.structuredOutput), `bad structuredOutput: ${caps.structuredOutput}`);
}

test('AnthropicAdapter.capabilities: native structured output, caching, streaming tool-use', () => {
  const caps = new AnthropicAdapter({ apiKey: 'sk-test' }).capabilities;
  assertShape(caps);
  assert.equal(caps.toolUse, true);
  assert.equal(caps.streamingToolUse, true);
  assert.equal(caps.structuredOutput, 'native');
  assert.equal(caps.vision, true);
  assert.equal(caps.promptCaching, true);
  assert.equal(caps.reasoning, true);
});

test('OpenAIAdapter.capabilities: hosted = native + streaming, no caching', () => {
  const caps = new OpenAIAdapter({ apiKey: 'sk-test' }).capabilities;
  assertShape(caps);
  assert.equal(caps.toolUse, true);
  assert.equal(caps.streamingToolUse, true);
  assert.equal(caps.structuredOutput, 'native');
  assert.equal(caps.vision, true);
  assert.equal(caps.promptCaching, false);
});

test('OpenAIAdapter.capabilities: local (baseURL) lane degrades conservatively', () => {
  const caps = new OpenAIAdapter({ baseURL: 'http://127.0.0.1:11434/v1' }).capabilities;
  assertShape(caps);
  assert.equal(caps.streamingToolUse, false);
  assert.equal(caps.structuredOutput, 'prompt');
  assert.equal(caps.vision, false);
  assert.equal(caps.promptCaching, false);
});

test('GeminiAdapter.capabilities: native structured output, vision', () => {
  const caps = new GeminiAdapter({ apiKey: 'sk-test' }).capabilities;
  assertShape(caps);
  assert.equal(caps.toolUse, true);
  assert.equal(caps.structuredOutput, 'native');
  assert.equal(caps.vision, true);
  assert.equal(caps.promptCaching, false);
});

test('CliPassthroughAdapter.capabilities: conservative — no tools, prompt-only structured', () => {
  const caps = new CliPassthroughAdapter({ kind: 'claude-code' }).capabilities;
  assertShape(caps);
  assert.equal(caps.toolUse, false);
  assert.equal(caps.streamingToolUse, false);
  assert.equal(caps.structuredOutput, 'prompt');
  assert.equal(caps.promptCaching, false);
});

test('Model._capabilities: reads the routed adapter descriptor, defaults when absent', () => {
  const model = new Model({ keys: { anthropic: 'sk-test' } });
  const anthropic = model._getAdapter('anthropic');
  assert.equal(model._capabilities(anthropic).structuredOutput, 'native');
  // A test stub without a descriptor falls back to the conservative default.
  assert.deepEqual(model._capabilities({ chat: async () => ({}) }), DEFAULT_CAPABILITIES);
});
