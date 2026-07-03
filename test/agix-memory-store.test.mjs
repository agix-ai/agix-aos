// agix-memory-store + session continuity — Q1 unit tests.
// Runner: node --test test/agix-memory-store.test.mjs
//
// Covers the redirected Sprint 1 acceptance criteria
// (docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 1):
//   - runtime.getMemoryStore() primitive, symmetric to getModel()
//   - smoke-mode stub returns canned shapes, persists nothing
//   - offload() + recall() behind the Agix-owned interface
//   - runtime.resumeRun() / checkpoint() session-continuity hook
//   - memory inherits tenant/dojo isolation from the state contract

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore, makeSmokeMemoryStore, tokenize } from '../lib/agix-memory-store.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';
import { MemoryStateBackend } from '../lib/agix-state-backend.mjs';

function makeRuntime(over = {}) {
  return new LocalRuntime({
    tenantId: 'tenant-a',
    dojoId: 'dojo-x',
    agentName: 'sensei',
    stateBackend: new MemoryStateBackend(),
    ...over,
  });
}

test('offload + recall round-trips and ranks the relevant record first', async () => {
  const store = new MemoryStore({ runtime: makeRuntime() });
  await store.offload({ text: 'Decided to use Firestore for mutable Dojo state', tags: ['architecture'] });
  await store.offload({ text: 'The newsletter audience prefers Tuesday sends', tags: ['marketing'] });
  await store.offload({ text: 'Postgres with pgvector holds the second-brain embeddings', tags: ['architecture'] });

  const hits = await store.recall({ query: 'where does dojo state live firestore', k: 2 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /Firestore for mutable Dojo state/);
  assert.ok(hits[0].score > 0);
});

test('recall filters by tags and returns [] for empty queries', async () => {
  const store = new MemoryStore({ runtime: makeRuntime() });
  await store.offload({ text: 'send the brief on tuesday', tags: ['marketing'] });
  await store.offload({ text: 'tuesday deploy window confirmed', tags: ['ops'] });

  const hits = await store.recall({ query: 'tuesday', tags: ['ops'] });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /deploy window/);

  assert.deepEqual(await store.recall({ query: '' }), []);
  assert.deepEqual(await store.recall({}), []);
});

test('offload rejects empty text', async () => {
  const store = new MemoryStore({ runtime: makeRuntime() });
  await assert.rejects(() => store.offload({ text: '   ' }), /text is required/);
});

test('retention cap evicts oldest records', async () => {
  const runtime = makeRuntime();
  const store = new MemoryStore({ runtime });
  // Write past the cap using the state doc directly (fast), then one offload.
  const records = Array.from({ length: 500 }, (_, i) => ({
    id: `mem-${i}`, ts: new Date().toISOString(), text: `record number ${i}`, tags: [], session_id: null, meta: {},
  }));
  await runtime.writeState('memory-l0', { records });
  await store.offload({ text: 'the newest record' });
  const doc = await runtime.readState('memory-l0');
  assert.equal(doc.records.length, 500);
  assert.equal(doc.records[0].id, 'mem-1', 'oldest record evicted');
  assert.match(doc.records.at(-1).text, /newest record/);
});

test('memory inherits tenant/dojo isolation from the state contract', async () => {
  const backend = new MemoryStateBackend();
  const storeA = new MemoryStore({ runtime: makeRuntime({ stateBackend: backend }) });
  const storeB = new MemoryStore({
    runtime: makeRuntime({ stateBackend: backend, tenantId: 'tenant-b' }),
  });
  await storeA.offload({ text: 'tenant A private decision about pricing' });
  assert.deepEqual(await storeB.recall({ query: 'pricing decision' }), []);
});

test('runtime.getMemoryStore() is cached and smoke-aware', async () => {
  const rt = makeRuntime();
  assert.equal(rt.getMemoryStore(), rt.getMemoryStore(), 'cached per runtime');
  assert.ok(!rt.getMemoryStore().smoke);

  const smokeRt = makeRuntime({ smoke: true });
  const smokeStore = smokeRt.getMemoryStore();
  assert.equal(smokeStore.smoke, true);
  // Smoke offload + recall work in-process…
  await smokeStore.offload({ text: 'smoke decision about deploys', tags: ['ops'] });
  const hits = await smokeStore.recall({ query: 'deploys' });
  assert.equal(hits.length, 1);
  // …and nothing reaches persisted state.
  assert.equal(await smokeRt.readState('memory-l0', null), null);
});

test('checkpoint + resumeRun round-trip; resumeRun null on first run', async () => {
  const rt = makeRuntime();
  assert.equal(await rt.resumeRun(), null);

  const saved = await rt.checkpoint({ step: 'goal-tree-drafted', open_question: 'pricing tier' });
  assert.equal(saved.agent, 'sensei');
  assert.ok(saved.saved_at);

  const resumed = await rt.resumeRun();
  assert.deepEqual(resumed.data, { step: 'goal-tree-drafted', open_question: 'pricing tier' });

  // Latest checkpoint wins.
  await rt.checkpoint({ step: 'plan-ratified' });
  assert.equal((await rt.resumeRun()).data.step, 'plan-ratified');
});

test('checkpoints are tenant/dojo-isolated like all state', async () => {
  const backend = new MemoryStateBackend();
  const a = makeRuntime({ stateBackend: backend });
  const b = makeRuntime({ stateBackend: backend, dojoId: 'dojo-y' });
  await a.checkpoint({ step: 'private-to-dojo-x' });
  assert.equal(await b.resumeRun(), null);
});

test('tokenize lowercases and drops single-char noise', () => {
  assert.deepEqual(tokenize('The Dojo, re-opened: OK?'), ['the', 'dojo', 're', 'opened', 'ok']);
});
