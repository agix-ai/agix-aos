// CLI-passthrough adapter + Model routing — unit tests.
// Runner: node --test test/cli-passthrough.test.mjs
//
// Covers AGIX.ONBOARD.1 DL.13: route model calls THROUGH the installed CLI
// agent (Claude Code / Codex) using subscription auth so Agix works with NO
// API key. These tests stub spawn + CLI detection — no real CLI call, no
// API-$ spend, CI-safe.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Model } from '../lib/agix-model.mjs';
import {
  CliPassthroughAdapter,
  detectCliAgent,
  flattenRequestToPrompt,
} from '../lib/model-adapters/cli-passthrough.mjs';
import { resolveModelToProvider, CLI_PROVIDERS } from '../lib/model-adapters/routing.mjs';

// These tests assert the CLI-fallback precedence, which only applies when NO
// local model lane is configured. A configured local lane (AGIX_LOCAL_MODEL_URL
// + AGIX_LOCAL_MODEL) deliberately wins for capability routes, so isolate from
// a developer's local env to keep the suite deterministic.
const _savedLocalEnv = { url: process.env.AGIX_LOCAL_MODEL_URL, model: process.env.AGIX_LOCAL_MODEL };
before(() => {
  delete process.env.AGIX_LOCAL_MODEL_URL;
  delete process.env.AGIX_LOCAL_MODEL;
});
after(() => {
  if (_savedLocalEnv.url === undefined) delete process.env.AGIX_LOCAL_MODEL_URL;
  else process.env.AGIX_LOCAL_MODEL_URL = _savedLocalEnv.url;
  if (_savedLocalEnv.model === undefined) delete process.env.AGIX_LOCAL_MODEL;
  else process.env.AGIX_LOCAL_MODEL = _savedLocalEnv.model;
});

// A spawnSync stub: records the call + returns a canned claude/codex result.
function makeSpawnStub({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  const calls = [];
  const impl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { status, stdout, stderr, error };
  };
  impl.calls = calls;
  return impl;
}

const CLAUDE_JSON = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'pong', stop_reason: 'end_turn', session_id: 'sess-1',
  usage: { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 1 },
  modelUsage: { 'claude-opus-4-8[1m]': { outputTokens: 1 }, 'claude-haiku-4-5-20251001': { outputTokens: 0 } },
});

// ─── routing ─────────────────────────────────────────────────────────

test('resolveModelToProvider maps claude-code + codex to CLI providers', () => {
  assert.equal(resolveModelToProvider('claude-code'), 'claude-code');
  assert.equal(resolveModelToProvider('codex'), 'codex');
  // API-key providers unchanged.
  assert.equal(resolveModelToProvider('claude-sonnet-4-6'), 'anthropic');
  assert.equal(resolveModelToProvider('gpt-4.1'), 'openai');
  assert.equal(resolveModelToProvider('gemini-2.5-flash'), 'gemini');
  assert.ok(CLI_PROVIDERS['claude-code'] && CLI_PROVIDERS['codex']);
});

// ─── prompt flattening ───────────────────────────────────────────────

test('flattenRequestToPrompt renders system + role-tagged turns', () => {
  const prompt = flattenRequestToPrompt({
    system: 'be terse',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'bye' }, { type: 'image', mime: 'image/png', data: 'x' }] },
    ],
  });
  assert.match(prompt, /\[System\]\nbe terse/);
  assert.match(prompt, /\[User\]\nhello/);
  assert.match(prompt, /\[Assistant\]\nhi/);
  assert.match(prompt, /\[User\]\nbye/);
  assert.match(prompt, /image omitted/);
});

// ─── adapter: claude-code happy path ─────────────────────────────────

test('CliPassthroughAdapter (claude-code) parses JSON into the protocol response shape', async () => {
  const spawn = makeSpawnStub({ status: 0, stdout: CLAUDE_JSON });
  const adapter = new CliPassthroughAdapter({ kind: 'claude-code', spawnImpl: spawn });
  const resp = await adapter.chat({ messages: [{ role: 'user', content: 'say pong' }] });

  // Same shape the API adapters return.
  assert.deepEqual(resp.content, [{ type: 'text', text: 'pong' }]);
  assert.equal(resp.stop_reason, 'end_turn');
  assert.equal(resp.provider, 'claude-code');
  assert.equal(resp.via_cli, 'claude-code');
  // model_used picked from modelUsage (highest output tokens), suffix-stripped.
  assert.equal(resp.model_used, 'claude-opus-4-8');
  // usage: input includes cache-creation; cached = cache reads.
  assert.equal(resp.usage.input_tokens, 12 + 3);
  assert.equal(resp.usage.cached_tokens, 5);
  assert.equal(resp.usage.output_tokens, 1);
  assert.ok(typeof resp.latency_ms === 'number');

  // Invocation: args passed as an ARRAY (no shell-string interpolation),
  // print mode + json output, and the prompt is a single argv element.
  const { bin, args, opts } = spawn.calls[0];
  assert.equal(bin, 'claude');
  assert.ok(args.includes('-p') && args.includes('--output-format') && args.includes('json'));
  assert.ok(args.some((a) => /say pong/.test(a)));
  assert.notEqual(opts.shell, true); // never shell:true on the model call
});

test('CliPassthroughAdapter maps a model id to a Claude Code alias', async () => {
  const spawn = makeSpawnStub({ status: 0, stdout: CLAUDE_JSON });
  const adapter = new CliPassthroughAdapter({ kind: 'claude-code', spawnImpl: spawn });
  await adapter.chat({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] });
  const args = spawn.calls[0].args;
  const mi = args.indexOf('--model');
  assert.ok(mi >= 0 && args[mi + 1] === 'opus');
});

// ─── adapter: codex happy path ───────────────────────────────────────

test('CliPassthroughAdapter (codex) extracts the plain-text answer', async () => {
  const stdout = [
    '[2026-06-19T00:00:00] session start',
    'model: gpt-5',
    '----',
    'pong',
  ].join('\n');
  const spawn = makeSpawnStub({ status: 0, stdout });
  const adapter = new CliPassthroughAdapter({ kind: 'codex', spawnImpl: spawn });
  const resp = await adapter.chat({ messages: [{ role: 'user', content: 'say pong' }] });
  assert.equal(resp.content[0].text, 'pong');
  assert.equal(resp.provider, 'codex');
  const args = spawn.calls[0].args;
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--skip-git-repo-check'));
});

// ─── adapter: error surfaces ─────────────────────────────────────────

test('CLI not found (ENOENT) throws a clear install/sign-in error', async () => {
  const spawn = makeSpawnStub({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
  const adapter = new CliPassthroughAdapter({ kind: 'claude-code', spawnImpl: spawn });
  await assert.rejects(
    () => adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    /not found.*Install.*sign in.*ANTHROPIC_API_KEY/s,
  );
});

test('CLI auth failure (non-zero exit with auth stderr) throws a clear error', async () => {
  const spawn = makeSpawnStub({ status: 1, stderr: 'Error: not logged in. Run claude login.' });
  const adapter = new CliPassthroughAdapter({ kind: 'claude-code', spawnImpl: spawn });
  await assert.rejects(
    () => adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    /not authenticated/,
  );
});

// ─── THE structural test: no key + CLI detected → passthrough route ──

test('no API key but claude on PATH → Model routes to claude-code passthrough', async () => {
  // No AGIX_PROVIDER pin, no keys, stub detection to "claude-code".
  const prevPin = process.env.AGIX_PROVIDER;
  delete process.env.AGIX_PROVIDER;
  try {
    const model = new Model({ keys: {}, detectCli: () => 'claude-code' });
    const route = model._route({ capability: 'default-quality' });
    assert.equal(route.provider, 'claude-code', 'must rewrite anthropic→claude-code when no key + CLI present');
    assert.equal(route.via_cli_fallback, true);
    assert.equal(route.fallback_from, 'anthropic');

    // And the adapter selected for that provider is the CLI-passthrough one
    // (constructed without any API key).
    const adapter = model._getAdapter(route.provider);
    assert.ok(adapter instanceof CliPassthroughAdapter);
    assert.equal(adapter.kind, 'claude-code');

    // End-to-end through Model.chat with a stubbed adapter (no real spawn):
    // confirms the dispatcher accepts the passthrough response shape.
    model._adapters.set('claude-code', {
      chat: async () => ({
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        model_used: 'claude-opus-4-8',
        provider: 'claude-code',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
        latency_ms: 1,
      }),
    });
    const resp = await model.chat({ messages: [{ role: 'user', content: 'say pong' }] });
    assert.equal(resp.content[0].text, 'pong');
    assert.equal(resp.provider, 'claude-code');
    assert.equal(resp.cost_usd, 0); // subscription call → unknown model → 0 via rate card
  } finally {
    if (prevPin === undefined) delete process.env.AGIX_PROVIDER;
    else process.env.AGIX_PROVIDER = prevPin;
  }
});

test('precedence: explicit AGIX_PROVIDER is NOT rewritten even with no key + CLI present', () => {
  const prevPin = process.env.AGIX_PROVIDER;
  process.env.AGIX_PROVIDER = 'anthropic';
  try {
    const model = new Model({ keys: {}, detectCli: () => 'claude-code' });
    const route = model._route({ capability: 'default-quality' });
    assert.equal(route.provider, 'anthropic', 'explicit pin wins over CLI fallback');
    assert.ok(!route.via_cli_fallback);
  } finally {
    if (prevPin === undefined) delete process.env.AGIX_PROVIDER;
    else process.env.AGIX_PROVIDER = prevPin;
  }
});

test('precedence: a configured API key keeps the API-key path (no CLI rewrite)', () => {
  const prevPin = process.env.AGIX_PROVIDER;
  delete process.env.AGIX_PROVIDER;
  try {
    const model = new Model({ keys: { anthropic: 'sk-test' }, detectCli: () => 'claude-code' });
    const route = model._route({ capability: 'default-quality' });
    assert.equal(route.provider, 'anthropic', 'key present → API path');
    assert.ok(!route.via_cli_fallback);
  } finally {
    if (prevPin === undefined) delete process.env.AGIX_PROVIDER;
    else process.env.AGIX_PROVIDER = prevPin;
  }
});

test('precedence: no key + no CLI → route unchanged so _getAdapter throws the clear key-missing error', () => {
  const prevPin = process.env.AGIX_PROVIDER;
  delete process.env.AGIX_PROVIDER;
  try {
    const model = new Model({ keys: {}, detectCli: () => null });
    const route = model._route({ capability: 'default-quality' });
    assert.equal(route.provider, 'anthropic');
    assert.throws(() => model._getAdapter('anthropic'), /ANTHROPIC_API_KEY missing/);
  } finally {
    if (prevPin === undefined) delete process.env.AGIX_PROVIDER;
    else process.env.AGIX_PROVIDER = prevPin;
  }
});

// ─── detection helper sanity (no spawn stub — just exercises the path) ─

test('detectCliAgent returns a known kind or null', () => {
  const r = detectCliAgent();
  assert.ok(r === null || r === 'claude-code' || r === 'codex');
});
