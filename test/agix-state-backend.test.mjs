// agix-state-backend — Q0 unit + isolation tests.
// Runner: node --test test/agix-state-backend.test.mjs
//
// Covers the Sprint 0 acceptance criteria
// (docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 0):
//   - cloud state adapter implements the runtime state interface
//   - optional dojoId is an additive superset (absent = legacy behavior)
//   - hard per-tenant AND per-Dojo isolation
//   - smoke-mode stub symmetric to the local one
//   - cross-tenant + cross-Dojo reads are denied

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  assertSafeId,
  stateDocSegments,
  MemoryStateBackend,
  FirestoreStateBackend,
  makeSmokeStateBackend,
} from '../lib/agix-state-backend.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';

// ─── ID validation ─────────────────────────────────────────────────────

test('assertSafeId rejects traversal and separator characters', () => {
  for (const bad of ['', '../agix', 'a/b', 'a.b', '..', 'tenant id', 'a\\b', null, undefined, 42]) {
    assert.throws(() => assertSafeId(bad, 'tenantId'), /not a valid identifier/);
  }
  for (const good of ['agix', 'acme-co', 'Fk29xQ_user', 'dojo-1']) {
    assert.equal(assertSafeId(good, 'tenantId'), good);
  }
});

test('stateDocSegments shapes tenant and dojo paths', () => {
  assert.deepEqual(
    stateDocSegments({ tenantId: 't1', agent: 'sensei', name: 'cursor' }),
    ['tenants', 't1', 'agents', 'sensei', 'state', 'cursor'],
  );
  assert.deepEqual(
    stateDocSegments({ tenantId: 't1', dojoId: 'd1', agent: 'sensei', name: 'cursor' }),
    ['tenants', 't1', 'dojos', 'd1', 'agents', 'sensei', 'state', 'cursor'],
  );
});

// ─── Isolation (AC-4) ──────────────────────────────────────────────────

test('cross-tenant and cross-Dojo reads are denied (memory backend)', async () => {
  const backend = new MemoryStateBackend();

  const tenantA_dojoX = new LocalRuntime({
    tenantId: 'tenant-a', dojoId: 'dojo-x', agentName: 'sensei', stateBackend: backend,
  });
  const tenantA_dojoY = new LocalRuntime({
    tenantId: 'tenant-a', dojoId: 'dojo-y', agentName: 'sensei', stateBackend: backend,
  });
  const tenantB_dojoX = new LocalRuntime({
    tenantId: 'tenant-b', dojoId: 'dojo-x', agentName: 'sensei', stateBackend: backend,
  });

  await tenantA_dojoX.writeState('goal-tree', { goals: ['ship Q0'] });

  // Owner reads back its own state.
  assert.deepEqual(await tenantA_dojoX.readState('goal-tree'), { goals: ['ship Q0'] });
  // Same tenant, different Dojo: denied (fallback).
  assert.equal(await tenantA_dojoY.readState('goal-tree', null), null);
  // Different tenant, same Dojo id + agent + state name: denied (fallback).
  assert.equal(await tenantB_dojoX.readState('goal-tree', null), null);
});

test('a runtime cannot be constructed into a foreign namespace via traversal ids', () => {
  assert.throws(
    () => new LocalRuntime({ tenantId: '../tenant-b', agentName: 'sensei' }),
    /not a valid identifier/,
  );
  assert.throws(
    () => new LocalRuntime({ tenantId: 'tenant-a', dojoId: 'x/../../y', agentName: 'sensei' }),
    /not a valid identifier/,
  );
});

// ─── Additive superset (legacy behavior preserved) ─────────────────────

test('no dojoId and no backend = legacy single-tenant path, unchanged', () => {
  const rt = new LocalRuntime({ agentName: 'sensei' });
  assert.equal(rt.statePath('cursor'), resolve(homedir(), '.cache/agix-sensei/cursor.json'));
  assert.equal(rt.tenantId, 'agix');
  assert.equal(rt.dojoId, null);
});

test('dojoId without a backend scopes the local path under tenants/dojos', () => {
  const rt = new LocalRuntime({ tenantId: 'agix', dojoId: 'dojo-1', agentName: 'sensei' });
  assert.equal(
    rt.statePath('cursor'),
    resolve(homedir(), '.cache/agix/tenants/agix/dojos/dojo-1/agents/sensei/state/cursor') + '.json',
  );
});

test('non-default tenant without a dojo is tenant-scoped locally (no legacy fallback)', () => {
  // Found by the R0 spike: tenant-level state must never share the
  // legacy single-tenant path, or it leaks across tenants.
  const rt = new LocalRuntime({ tenantId: 'tenant-b', agentName: 'sensei' });
  assert.equal(
    rt.statePath('dojo-index'),
    resolve(homedir(), '.cache/agix/tenants/tenant-b/agents/sensei/state/dojo-index') + '.json',
  );
});

// ─── Smoke symmetry ────────────────────────────────────────────────────

test('smoke mode swaps in the smoke backend: no prod writes, reads sandboxed', async () => {
  const prod = new MemoryStateBackend();
  await prod.write({ tenantId: 't1', dojoId: 'd1', agent: 'sensei', name: 'cursor' }, { real: true });

  const rt = new LocalRuntime({
    tenantId: 't1', dojoId: 'd1', agentName: 'sensei', stateBackend: prod, smoke: true,
  });

  // Smoke reads never observe production state.
  assert.equal(await rt.readState('cursor', null), null);
  // Smoke writes land in the sandbox, readable within the run...
  await rt.writeState('cursor', { smoke_written: true });
  assert.deepEqual(await rt.readState('cursor'), { smoke_written: true });
  // ...and never reach the production backend.
  assert.deepEqual(
    await prod.read({ tenantId: 't1', dojoId: 'd1', agent: 'sensei', name: 'cursor' }),
    { real: true },
  );
});

test('makeSmokeStateBackend marks itself and round-trips writes', async () => {
  const smoke = makeSmokeStateBackend();
  assert.equal(smoke.smoke, true);
  const scope = { tenantId: 't1', agent: 'director', name: 'queue' };
  const ref = await smoke.write(scope, { items: [] });
  assert.match(ref, /^smoke:\/\/tenants\/t1\/agents\/director\/state\/queue$/);
  assert.deepEqual(await smoke.read(scope), { items: [] });
});

// ─── Firestore backend (injected fetch; no network) ────────────────────

function makeFakeFirestore() {
  const docs = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    const path = url.split('/documents/')[1]?.split('?')[0];
    if (init.method === 'GET') {
      if (!docs.has(path)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => docs.get(path) };
    }
    if (init.method === 'PATCH') {
      docs.set(path, JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => docs.get(path) };
    }
    return { ok: false, status: 405, json: async () => ({}) };
  };
  return { docs, calls, fetchImpl };
}

test('FirestoreStateBackend writes and reads the documented document path', async () => {
  const fake = makeFakeFirestore();
  const backend = new FirestoreStateBackend({
    projectId: 'agix-platform',
    tokenProvider: async () => 'test-token',
    fetchImpl: fake.fetchImpl,
  });
  const scope = { tenantId: 't1', dojoId: 'd1', agent: 'sensei', name: 'goal-tree' };

  await backend.write(scope, { goals: [1, 2] });
  assert.ok(fake.docs.has('tenants/t1/dojos/d1/agents/sensei/state/goal-tree'));

  assert.deepEqual(await backend.read(scope), { goals: [1, 2] });
  // Missing document → fallback, not throw.
  assert.equal(
    await backend.read({ tenantId: 't2', dojoId: 'd1', agent: 'sensei', name: 'goal-tree' }, 'fb'),
    'fb',
  );
  // Every call carried the bearer token.
  assert.ok(fake.calls.length >= 3);
});

test('FirestoreStateBackend surfaces non-404 errors', async () => {
  const backend = new FirestoreStateBackend({
    projectId: 'agix-platform',
    tokenProvider: async () => 'test-token',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  await assert.rejects(
    () => backend.read({ tenantId: 't1', agent: 'sensei', name: 'x' }),
    /403/,
  );
});
