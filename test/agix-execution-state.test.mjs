// agix-execution-state — P1 unit tests (schema + accessors).
// Runner: node --test test/agix-execution-state.test.mjs
//
// Uses an in-memory fake runtime implementing the readState/writeState
// contract (lib/agix-runtime.mjs) so the read-modify-write logic is
// exercised deterministically without touching the filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getTask,
  listTasks,
  putTask,
  appendStep,
  setStatus,
  addBranch,
  addPending,
  resolvePending,
  STATUSES,
  STEP_OUTCOMES,
  EXECUTION_STATE_KEY,
} from '../lib/agix-execution-state.mjs';

// Minimal runtime double: per-name JSON store, mirrors readState/writeState.
function makeRuntime({ tenantId = 'agix', agentName = 'director' } = {}) {
  const store = new Map();
  return {
    tenantId,
    agentName,
    async readState(name, fallback = null) {
      return store.has(name) ? JSON.parse(store.get(name)) : fallback;
    },
    async writeState(name, data) {
      store.set(name, JSON.stringify(data));
      return `mem://${name}`;
    },
    _raw: store,
  };
}

test('putTask creates a record with schema defaults stamped', async () => {
  const rt = makeRuntime();
  const rec = await putTask(rt, 'director:2026-06-06.A1:spec', { goal: 'file A1 spec' });

  assert.equal(rec.task_id, 'director:2026-06-06.A1:spec');
  assert.equal(rec.tenant_id, 'agix');
  assert.equal(rec.agent, 'director');
  assert.equal(rec.goal, 'file A1 spec');
  assert.equal(rec.status, 'pending', 'defaults to pending');
  assert.deepEqual(rec.steps, []);
  assert.deepEqual(rec.branches, []);
  assert.deepEqual(rec.pending, []);
  assert.match(rec.created_at, /\dT\d/);
  assert.match(rec.updated_at, /\dT\d/);

  // Persisted under the execution-state doc as { tasks: [...] }.
  const doc = JSON.parse(rt._raw.get(EXECUTION_STATE_KEY));
  assert.equal(doc.tasks.length, 1);
});

test('getTask returns the record or null; deterministic lookup', async () => {
  const rt = makeRuntime();
  assert.equal(await getTask(rt, 'missing'), null);
  await putTask(rt, 't1', { goal: 'g' });
  const got = await getTask(rt, 't1');
  assert.equal(got.task_id, 't1');
  await assert.rejects(() => getTask(rt, ''), /task_id required/);
});

test('putTask patches existing record without clobbering substrate or created_at', async () => {
  const rt = makeRuntime();
  const a = await putTask(rt, 't1', { goal: 'first' });
  await appendStep(rt, 't1', { intent: 'do thing', outcome: 'success' });

  const b = await putTask(rt, 't1', { goal: 'updated', status: 'active' });
  assert.equal(b.goal, 'updated');
  assert.equal(b.status, 'active');
  assert.equal(b.created_at, a.created_at, 'created_at preserved across upsert');
  assert.equal(b.steps.length, 1, 'existing steps not clobbered by a goal patch');
  assert.equal(b.task_id, 't1');
  assert.equal(b.tenant_id, 'agix');

  // Still a single record (upsert, not insert).
  assert.equal((await listTasks(rt)).length, 1);
});

test('listTasks filters by status and agent', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', { status: 'pending' });
  await putTask(rt, 't2', { status: 'active' });
  await putTask(rt, 't3', { status: 'active', agent: 'research' });

  assert.equal((await listTasks(rt)).length, 3);
  assert.equal((await listTasks(rt, { status: 'active' })).length, 2);
  assert.equal((await listTasks(rt, { status: 'pending' })).length, 1);
  assert.equal((await listTasks(rt, { agent: 'research' })).length, 1);
  assert.equal((await listTasks(rt, { status: 'active', agent: 'director' })).length, 1);
  await assert.rejects(() => listTasks(rt, { status: 'bogus' }), /invalid status/);
});

test('appendStep stamps step_id + ts, preserves order, and grows the trace', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', { goal: 'g' });
  await appendStep(rt, 't1', { intent: 'retrieve', outcome: 'partial', result_ref: 'wiki/x.md' });
  const task = await appendStep(rt, 't1', { intent: 'draft', outcome: 'success' });

  assert.equal(task.steps.length, 2);
  assert.deepEqual(task.steps.map((s) => s.step_id), ['s1', 's2']);
  assert.equal(task.steps[0].result_ref, 'wiki/x.md', 'result_ref kept as a pointer');
  assert.equal(task.steps[1].intent, 'draft');
  assert.match(task.steps[0].ts, /\dT\d/);
});

test('appendStep rejects an invalid outcome and a missing task', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', {});
  await assert.rejects(() => appendStep(rt, 't1', { outcome: 'great' }), /invalid step outcome/);
  await assert.rejects(() => appendStep(rt, 'nope', { intent: 'x' }), /not found/);
});

test('setStatus validates and transitions', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', {});
  const done = await setStatus(rt, 't1', 'done');
  assert.equal(done.status, 'done');
  await assert.rejects(() => setStatus(rt, 't1', 'finished'), /invalid status/);
  await assert.rejects(() => setStatus(rt, 'ghost', 'done'), /not found/);
});

test('addBranch records branching history', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', {});
  const task = await addBranch(rt, 't1', { from_step: 's2', reason: 'tried PRM path', chosen: true });
  assert.equal(task.branches.length, 1);
  assert.deepEqual(task.branches[0], { from_step: 's2', reason: 'tried PRM path', chosen: true });
});

test('addPending dedupes and resolvePending removes', async () => {
  const rt = makeRuntime();
  await putTask(rt, 't1', {});
  await addPending(rt, 't1', 'write tests');
  await addPending(rt, 't1', 'write tests'); // dedup
  await addPending(rt, 't1', 'wire executor');
  let task = await getTask(rt, 't1');
  assert.deepEqual(task.pending, ['write tests', 'wire executor']);

  task = await resolvePending(rt, 't1', 'write tests');
  assert.deepEqual(task.pending, ['wire executor']);
  // Resolving an absent item is a no-op.
  task = await resolvePending(rt, 't1', 'nonexistent');
  assert.deepEqual(task.pending, ['wire executor']);
});

test('exported vocabularies match the §2.1 schema', () => {
  assert.deepEqual(STATUSES, ['pending', 'active', 'blocked', 'done', 'abandoned']);
  assert.deepEqual(STEP_OUTCOMES, ['success', 'failure', 'partial', 'skipped']);
  assert.equal(EXECUTION_STATE_KEY, 'execution-state');
});
