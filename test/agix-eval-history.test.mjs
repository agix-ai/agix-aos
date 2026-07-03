// agix-eval history + learning-over-time metrics — unit tests.
// Runner: node --test test/agix-eval-history.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { learningCurve, regressionGate, skillRetention } from '../lib/agix-eval/stats.mjs';
import {
  appendRunRecord,
  readRunHistory,
  recordFleet,
  metricSeries,
  metricTrend,
  metricRegression,
  EVAL_HISTORY_KEY,
} from '../lib/agix-eval/history.mjs';

function makeRuntime() {
  const store = new Map();
  return {
    tenantId: 'agix',
    agentName: 'eval',
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

// ─── learningCurve ───────────────────────────────────────────────────

test('learningCurve detects a clear upward trend', () => {
  const lc = learningCurve([0.5, 0.6, 0.7, 0.8, 0.9]);
  assert.ok(lc.slope > 0.09 && lc.slope < 0.11, `slope ${lc.slope}`);
  assert.equal(lc.direction, 'improving');
  assert.ok(lc.ci95[0] > 0, 'CI excludes zero on the low side');
});

test('learningCurve calls a flat-but-noisy series a plateau', () => {
  const lc = learningCurve([0.80, 0.78, 0.82, 0.79, 0.81, 0.80]);
  assert.equal(lc.direction, 'plateau');
});

test('learningCurve detects regression and handles short series', () => {
  assert.equal(learningCurve([0.9, 0.8, 0.7, 0.6, 0.5]).direction, 'regressing');
  assert.equal(learningCurve([0.5]).direction, 'insufficient');
  const two = learningCurve([0.5, 0.7]);
  assert.equal(two.direction, 'improving');
  assert.equal(two.lowConfidence, true);
});

test('learningCurve accepts {value} objects', () => {
  const lc = learningCurve([{ value: 1 }, { value: 2 }, { value: 3 }]);
  assert.ok(Math.abs(lc.slope - 1) < 1e-9);
});

// ─── regressionGate ──────────────────────────────────────────────────

test('regressionGate flags a drop beyond sigma and passes normal variance', () => {
  const baseline = [0.90, 0.91, 0.89, 0.90, 0.92];
  assert.equal(regressionGate({ baseline, current: 0.905 }).regressed, false);
  const r = regressionGate({ baseline, current: 0.40 });
  assert.equal(r.regressed, true);
  assert.ok(r.z < -2);
});

test('regressionGate handles zero-variance baseline and empty baseline', () => {
  assert.equal(regressionGate({ baseline: [0.8, 0.8, 0.8], current: 0.79 }).regressed, true);
  assert.equal(regressionGate({ baseline: [0.8, 0.8, 0.8], current: 0.8 }).regressed, false);
  assert.equal(regressionGate({ baseline: [], current: 0.5 }).regressed, false);
});

// ─── skillRetention ──────────────────────────────────────────────────

test('skillRetention measures persistence within tolerance', () => {
  assert.equal(skillRetention({ before: 0.8, after: 0.82 }).retained, true);
  assert.equal(skillRetention({ before: 0.8, after: 0.6 }).retained, false);
  assert.equal(skillRetention({ before: 0.8, after: 0.78, tolerance: 0.05 }).retained, true);
});

// ─── history store ───────────────────────────────────────────────────

test('appendRunRecord persists and readRunHistory filters; bound respected', async () => {
  const rt = makeRuntime();
  await appendRunRecord(rt, { suite: 'a', agent: 'director', values: { f1: 0.8 } });
  await appendRunRecord(rt, { suite: 'b', agent: 'curator', values: { f1: 0.7 } });
  assert.equal((await readRunHistory(rt)).length, 2);
  assert.equal((await readRunHistory(rt, { agent: 'director' })).length, 1);

  const rt2 = makeRuntime();
  for (let i = 0; i < 5; i++) await appendRunRecord(rt2, { suite: 's', values: { f1: i } }, { max: 3 });
  const recs = await readRunHistory(rt2);
  assert.equal(recs.length, 3, 'bounded to max');
  assert.deepEqual(recs.map((r) => r.values.f1), [2, 3, 4], 'oldest evicted');
  assert.equal(EVAL_HISTORY_KEY, 'eval-history');
});

test('recordFleet writes one record per suite from gate values', async () => {
  const rt = makeRuntime();
  const fleet = {
    mode: 'replay',
    suites: [
      {
        name: 'classify-reply', agent: 'director', archetype: 'classifier', mode: 'replay',
        allGatesPassed: true,
        gates: { 'Macro-F1': { value: 0.92, passed: true }, 'Label accuracy': { value: 0.88, passed: true } },
      },
    ],
  };
  const written = await recordFleet(rt, fleet, { promptVersion: 'v3' });
  assert.equal(written.length, 1);
  const recs = await readRunHistory(rt);
  assert.equal(recs[0].suite, 'classify-reply');
  assert.equal(recs[0].promptVersion, 'v3');
  assert.equal(recs[0].values['Macro-F1'], 0.92);
});

test('metricSeries + metricTrend + metricRegression over recorded runs', async () => {
  const rt = makeRuntime();
  const f1s = [0.70, 0.74, 0.78, 0.82, 0.86];
  for (const f1 of f1s) {
    await recordFleet(rt, {
      suites: [{ name: 'classify-reply', agent: 'director', mode: 'replay', allGatesPassed: true, gates: { 'Macro-F1': { value: f1, passed: true } } }],
    });
  }
  const recs = await readRunHistory(rt);
  const series = metricSeries(recs, 'Macro-F1');
  assert.deepEqual(series.map((s) => s.value), f1s);

  const trend = metricTrend(recs, 'Macro-F1');
  assert.equal(trend.direction, 'improving');

  // Latest value (0.86) is consistent with the rising baseline → no regression.
  assert.equal(metricRegression(recs, 'Macro-F1').regressed, false);

  // Now append a collapse and confirm the gate trips.
  await recordFleet(rt, { suites: [{ name: 'classify-reply', agent: 'director', mode: 'replay', allGatesPassed: false, gates: { 'Macro-F1': { value: 0.30, passed: false } } }] });
  const recs2 = await readRunHistory(rt);
  assert.equal(metricRegression(recs2, 'Macro-F1').regressed, true);
});
