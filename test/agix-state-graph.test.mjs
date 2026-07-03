// agix-state-graph — Q2 unit tests.
// Runner: node --test test/agix-state-graph.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defineGraph } from '../lib/agix-state-graph.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';

function cycleSpec(log = []) {
  return {
    initial: 'pending',
    states: ['pending', 'active', 'paused', 'completed'],
    transitions: [
      { from: 'pending', event: 'start', to: 'active', action: async (p) => { log.push(`action:start:${p.id}`); return 'started'; } },
      { from: 'active', event: 'tick', to: 'active', action: async () => { log.push('action:tick'); } },
      { from: 'active', event: 'pause', to: 'paused' },
      { from: 'paused', event: 'start', to: 'active' },
      { from: '*', event: 'abort', to: 'completed', action: async () => { log.push('action:abort'); } },
    ],
    on_enter: { active: async () => log.push('enter:active'), completed: async () => log.push('enter:completed') },
    on_exit: { pending: async () => log.push('exit:pending'), active: async () => log.push('exit:active') },
  };
}

test('transitions fire with exit → action → enter ordering', async () => {
  const log = [];
  const graph = defineGraph(cycleSpec(log));
  const fired = await graph.fire('start', { id: 'c1' });
  assert.deepEqual(fired, { from: 'pending', to: 'active', event: 'start', result: 'started', smoke: false });
  assert.deepEqual(log, ['exit:pending', 'action:start:c1', 'enter:active']);
  assert.equal(graph.state, 'active');
});

test('self-transitions run the action without exit/enter churn', async () => {
  const log = [];
  const graph = defineGraph(cycleSpec(log));
  await graph.fire('start', { id: 'c1' });
  log.length = 0;
  await graph.fire('tick');
  assert.deepEqual(log, ['action:tick']);
});

test('wildcard transitions fire from any state; exact match wins', async () => {
  const log = [];
  const graph = defineGraph(cycleSpec(log));
  await graph.fire('start', { id: 'c1' });
  await graph.fire('pause');
  const fired = await graph.fire('abort');
  assert.equal(fired.to, 'completed');
  assert.equal(graph.state, 'completed');
});

test('invalid events throw with the allowed-event list', async () => {
  const graph = defineGraph(cycleSpec());
  await assert.rejects(
    () => graph.fire('tick'),
    /event "tick" is not valid from state "pending"\. Allowed: start, abort/,
  );
});

test('definition-time validation: unknown states and missing pieces throw', () => {
  assert.throws(() => defineGraph({ states: ['a'] }), /initial state is required/);
  assert.throws(() => defineGraph({ initial: 'x', states: ['a'] }), /not in states/);
  assert.throws(
    () => defineGraph({ initial: 'a', states: ['a'], transitions: [{ from: 'b', event: 'e', to: 'a' }] }),
    /from unknown state/,
  );
  assert.throws(
    () => defineGraph({ initial: 'a', states: ['a'], transitions: [{ from: 'a', event: 'e', to: 'z' }] }),
    /to unknown state/,
  );
});

test('history records fired transitions; allowedEvents reads current state', async () => {
  const graph = defineGraph(cycleSpec());
  await graph.fire('start', { id: 'c1' });
  await graph.fire('pause');
  assert.deepEqual(graph.history.map((h) => h.event), ['start', 'pause']);
  assert.deepEqual(graph.allowedEvents().sort(), ['abort', 'start']);
});

test('runtime.getStateGraph() in smoke mode skips actions/hooks but transitions hold', async () => {
  const rt = new LocalRuntime({ agentName: 'example-orchestrator', smoke: true });
  const log = [];
  const graph = rt.getStateGraph().defineGraph(cycleSpec(log));
  const fired = await graph.fire('start', { id: 'c1' });
  assert.equal(fired.smoke, true);
  assert.equal(fired.result, null, 'action skipped in smoke');
  assert.deepEqual(log, [], 'no hooks/actions ran');
  assert.equal(graph.state, 'active', 'transition still applied');
});

test('runtime.getStateGraph() non-smoke runs actions', async () => {
  const rt = new LocalRuntime({ agentName: 'example-orchestrator' });
  const log = [];
  const graph = rt.getStateGraph().defineGraph(cycleSpec(log));
  const fired = await graph.fire('start', { id: 'c9' });
  assert.equal(fired.result, 'started');
  assert.ok(log.includes('action:start:c9'));
});
