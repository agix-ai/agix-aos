// agix-eval/history — cross-session eval-run history store.
//
// The point-in-time harness (harness.mjs) grades a snapshot. A
// learning-agent harness needs the TIME axis: persist each run's scalar
// gate values so we can compute learning curves and regression gates
// over them (stats.mjs). This generalises the bounded-history pattern
// proven in lib/agix-stv-deploy-health.mjs to a generic eval-run record,
// riding the same tenant-keyed runtime state contract — no new datastore.
//
// Design: wiki/research/2026-06-06-dive-S3-learning-eval-harness.md (piece
// #1, history store). Records are append-only and time-ordered.

import { learningCurve, regressionGate } from './stats.mjs';

const HISTORY_KEY = 'eval-history';
const DEFAULT_MAX = 500;

/**
 * Append one run record to the bounded history (oldest evicted first).
 * Best-effort telemetry — never throw into a caller's eval run.
 * A record is { ts, suite?, agent?, mode?, passed?, promptVersion?,
 * values: { [gateLabel]: number } }.
 */
export async function appendRunRecord(runtime, record, { max = DEFAULT_MAX } = {}) {
  const current = (await runtime.readState(HISTORY_KEY, { records: [] })) || { records: [] };
  const records = Array.isArray(current.records) ? current.records : [];
  records.push({ ts: record.ts || new Date().toISOString(), ...record });
  if (records.length > max) records.splice(0, records.length - max);
  return runtime.writeState(HISTORY_KEY, { records });
}

/** Read the run history (time-ordered as appended), optionally filtered. */
export async function readRunHistory(runtime, { suite, agent } = {}) {
  const current = (await runtime.readState(HISTORY_KEY, { records: [] })) || { records: [] };
  const records = Array.isArray(current.records) ? current.records : [];
  return records.filter((r) => {
    if (suite != null && r.suite !== suite) return false;
    if (agent != null && r.agent !== agent) return false;
    return true;
  });
}

/**
 * Derive run records from an agix-eval fleet result and append one per
 * suite. Scalar series come from the pre-registered gate values (clean,
 * comparable across runs). Pure-ish: only touches the history state doc.
 */
export async function recordFleet(runtime, fleet, { promptVersion, ts, max = DEFAULT_MAX } = {}) {
  const stamp = ts || new Date().toISOString();
  const written = [];
  for (const s of fleet.suites || []) {
    const values = {};
    for (const [label, g] of Object.entries(s.gates || {})) values[label] = g.value;
    const record = {
      ts: stamp,
      suite: s.name,
      agent: s.agent,
      archetype: s.archetype,
      mode: s.mode,
      passed: s.allGatesPassed,
      promptVersion: promptVersion ?? null,
      values,
    };
    await appendRunRecord(runtime, record, { max });
    written.push(record);
  }
  return written;
}

/**
 * Extract a time-ordered series for one gate metric across the history.
 * @returns {Array<{ ts, value, suite, promptVersion }>}
 */
export function metricSeries(records, metricLabel, { suite, agent } = {}) {
  return records
    .filter((r) => {
      if (suite != null && r.suite !== suite) return false;
      if (agent != null && r.agent !== agent) return false;
      return r.values && r.values[metricLabel] != null;
    })
    .map((r) => ({ ts: r.ts, value: r.values[metricLabel], suite: r.suite, promptVersion: r.promptVersion }));
}

/** Convenience: learning curve for one gate metric over the history. */
export function metricTrend(records, metricLabel, opts = {}) {
  return learningCurve(metricSeries(records, metricLabel, opts));
}

/**
 * Convenience: regression check for the latest value of a gate metric
 * against the preceding `window` runs as a moving baseline.
 */
export function metricRegression(records, metricLabel, { window = 10, sigma = 2, suite, agent } = {}) {
  const series = metricSeries(records, metricLabel, { suite, agent }).map((s) => s.value);
  if (series.length < 2) return { regressed: false, n: series.length, reason: 'insufficient-history' };
  const current = series[series.length - 1];
  const baseline = series.slice(Math.max(0, series.length - 1 - window), series.length - 1);
  return regressionGate({ baseline, current, sigma });
}

export const EVAL_HISTORY_KEY = HISTORY_KEY;
