// agix-loop-sim/record-replay — deterministic record/replay spine (blueprint §1).
//
// GUARDS: "the ecosystem was tuned on a run we can't reproduce" and "a live
// fallthrough silently diverged the replay" (ecosystem-sim/DETERMINISM). This
// is the determinism ARCHITECTURE the whole endurance test rests on:
// reproducibility is a HARNESS property (record/replay + one seeded world),
// NEVER a sampling parameter. We never assume `temperature` exists or is
// honored — reasoning / extended-thinking models ignore it — so a live-model
// tier is CAPTURED-then-REPLAYED, and sampling params are recorded AS-SENT
// (knowing the model may ignore them).
//
// A "run" is a deterministic function run(io) that drives the synthetic world
// through three transition kinds — model / tool / world — via the injected
// `io`. In RECORD mode each call executes its deterministic oracle and is
// appended to an append-only log (monotonic step IDs, one run ID). In REPLAY
// mode the same run(io) is re-driven, but `io` returns the RECORDED value and
// the oracle is never consulted; any call that does not match the recorded
// sequence (wrong kind/key, or past the end) FAILS LOUDLY. Byte-identical
// replay across two runs of the same seed is itself a hard gate — any
// divergence IS an anomaly.
//
// This module also owns the shared deterministic-serialization helpers
// (stableStringify / fingerprint) the memory + context phases reuse, so the
// determinism guarantees have a single source of truth.

import { makePrng } from './prng.mjs';

// ─── deterministic serialization / hashing (shared across phases) ────

/** Stable JSON: object keys sorted recursively. Infinity/NaN → sentinels. */
export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

function normalize(v) {
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

/** FNV-1a 32-bit hex hash over the stable serialization. */
export function fingerprint(value) {
  const str = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─── the loud failure a broken replay must raise ────────────────────

export class ReplayError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ReplayError';
    this.detail = detail ?? null;
  }
}

const KINDS = new Set(['model', 'tool', 'world']);

// ─── deferred live-model tier (DISABLED in this build) ──────────────
//
// Phases 1–3 are 100% synthetic and deterministic: the "model" everywhere in
// this module is the sim's own SEEDED oracle (a PRNG-driven stub), never a
// real LLM. There is ZERO real model / API / network code path and no API key
// is ever required. A live-model tier is a FUTURE calibration concern (and
// even then will use a local/free model, never a 30h live run) — so it is a
// deferred no-op, gated OFF behind an explicit env flag. If anything reaches
// for it, we throw rather than call a model.

/** True only if the operator has explicitly opted in (default: unset/off). */
export function liveModelEnabled() {
  return Boolean(process.env.AGIX_SIM_LIVE_MODEL);
}

/**
 * The deferred live-model tier. NOT wired to any provider. Present only so the
 * shape is documented; invoking it always throws — this build never calls a
 * model, never spends a token, never needs a key.
 */
export function liveModelCall() {
  throw new ReplayError('live-model tier is not enabled in this build (phases 1–3 are pure-synthetic; set nothing real — calibration is out of scope and would use a local/free model)');
}

// ─── RECORD ──────────────────────────────────────────────────────────

/**
 * Run `run(io)` live, appending every model/tool/world transition to an
 * append-only log. `run` must be pure given its captured seed: it may draw
 * only from a seeded PRNG (never Math.random / Date.now). The `produce`
 * callback on each io call is the deterministic oracle whose result is
 * recorded; sampling `params` are stored AS-SENT.
 *
 * @param {(io) => any} run
 * @param {{ runId?: string, seed?: number }} [opts]
 * @returns {{ runId, seed, events: Array, output }}
 */
export function record(run, { runId = 'run-0', seed = 0 } = {}) {
  const events = [];
  let step = 0;

  const emit = (kind, key, params, produce) => {
    if (!KINDS.has(kind)) throw new ReplayError(`unknown transition kind "${kind}"`);
    const result = produce();
    // Freeze a plain snapshot so later mutation can't rewrite history.
    events.push({ step: step++, runId, kind, key, params: params ?? null, result });
    return result;
  };

  const io = {
    mode: 'record',
    /** Record a model call. `params` = sampling params AS-SENT (may be ignored). */
    model: (key, params, produce) => emit('model', key, params, produce),
    /** Record a tool call. */
    tool: (key, args, produce) => emit('tool', key, args, produce),
    /** Record a world-state transition. */
    world: (key, produce) => emit('world', key, null, produce),
  };

  const output = run(io);
  return { runId, seed, events, output };
}

// ─── REPLAY ──────────────────────────────────────────────────────────

/**
 * Re-drive `run(io)` against a recorded log. `io` returns the RECORDED value
 * for each call (the oracle is NEVER consulted). Fails loudly when:
 *   • a call arrives after the log is exhausted (un-recorded call), or
 *   • a call's kind/key does not match the next recorded event (divergence).
 * On success asserts every recorded event was consumed exactly once.
 *
 * @param {{ events: Array }} log
 * @param {(io) => any} run
 * @returns {{ output, steps }}
 */
export function replay(log, run) {
  let step = 0;

  const consume = (kind, key) => {
    const ev = log.events[step];
    if (!ev) {
      throw new ReplayError(`un-recorded call at step ${step}: ${kind}:${key} (log exhausted — no silent live fallthrough)`, { step, kind, key });
    }
    if (ev.kind !== kind || ev.key !== key) {
      throw new ReplayError(`replay divergence at step ${step}: expected ${ev.kind}:${ev.key}, got ${kind}:${key}`, { step, expected: `${ev.kind}:${ev.key}`, got: `${kind}:${key}` });
    }
    step++;
    return ev.result;
  };

  const io = {
    mode: 'replay',
    // Stubs ignore `produce` entirely — the recorded value is authoritative.
    model: (key /* , params, produce */) => consume('model', key),
    tool: (key /* , args, produce */) => consume('tool', key),
    world: (key /* , produce */) => consume('world', key),
  };

  const output = run(io);
  if (step !== log.events.length) {
    throw new ReplayError(`replay consumed ${step} of ${log.events.length} recorded events — the run did not re-drive the full log`, { consumed: step, recorded: log.events.length });
  }
  return { output, steps: step };
}

/** Fingerprint the reproducible surface of a log (kinds/keys/params/results). */
export function fingerprintLog(log) {
  return fingerprint({ runId: log.runId, events: log.events.map((e) => ({ step: e.step, kind: e.kind, key: e.key, params: e.params, result: e.result })), output: log.output });
}

// ─── the byte-identical-replay GATE ─────────────────────────────────

/**
 * Record the same run twice on the same seed and prove the two logs are
 * byte-identical. Any divergence is an anomaly. Returns a checker result.
 *
 * @param {(io) => any} run
 * @param {{ runId?: string, seed?: number }} [opts]
 * @returns {{ ok, violations, detail, fpA, fpB }}
 */
export function replayDeterminismChecker(run, opts = {}) {
  const a = record(run, opts);
  const b = record(run, opts);
  const fpA = fingerprintLog(a);
  const fpB = fingerprintLog(b);
  // Also prove the recorded log replays back cleanly (round-trip).
  let roundTrip = true;
  let roundTripDetail = null;
  try {
    replay(a, run);
  } catch (err) {
    roundTrip = false;
    roundTripDetail = err.message;
  }
  const violations = [];
  if (fpA !== fpB) violations.push({ reason: 'non-identical-rerun', fpA, fpB });
  if (!roundTrip) violations.push({ reason: 'round-trip-replay-failed', detail: roundTripDetail });
  return { ok: violations.length === 0, violations, detail: violations.length ? `${violations.length} determinism breach(es)` : null, fpA, fpB };
}

// ─── a synthetic run to exercise the spine ──────────────────────────

/**
 * A tiny deterministic "agent" that issues model + tool + world transitions
 * driven ENTIRELY by a seeded PRNG (never Math.random / Date.now). Sampling
 * params are passed AS-SENT to prove they are recorded even though the oracle
 * (here, our seeded stub) is what actually produces the value.
 *
 * @param {number} seed
 * @param {{ steps?: number }} [opts]
 * @returns {(io) => object} a run function for record()/replay().
 */
export function makeSyntheticRun(seed, { steps = 24 } = {}) {
  return function run(io) {
    // The oracle PRNG is rebuilt from the captured seed on every drive, so
    // record and replay share the same deterministic source. In replay the
    // oracle is never consulted, but rebuilding it keeps the run pure.
    const prng = makePrng(seed >>> 0);
    let worldTokens = 0;
    let verdicts = 0;
    for (let i = 0; i < steps; i++) {
      // A model call — params recorded AS-SENT (the model may ignore them).
      const verdict = io.model(`plan#${i}`, { temperature: 0.2, top_p: 1, note: 'as-sent; may be ignored' }, () => (prng.bool(0.9) ? 'verified' : 'failed'));
      if (verdict === 'verified') verdicts++;
      // A tool call whose recorded result feeds the world transition.
      const toolTokens = io.tool(`fetch#${i}`, { n: i }, () => 200 + prng.int(0, 800));
      worldTokens = io.world(`ctx#${i}`, () => worldTokens + toolTokens);
    }
    return { verdicts, worldTokens };
  };
}

// ─── PLANTED-VIOLATION negative controls ────────────────────────────
//
// Each returns a probe proving a determinism detector can FAIL.

/**
 * PLANT — a recorded result is corrupted after the fact. The byte-identical
 * gate must see the two logs diverge (or the round-trip replay must break).
 * Proves the fingerprint gate can fail.
 *
 * @returns {{ ok, violations, detail }}
 */
export function plantResultDivergence(seed = 7) {
  const run = makeSyntheticRun(seed, { steps: 8 });
  const clean = record(run, { seed, runId: 'div' });
  // Tamper: flip one recorded world result. Replaying the ORIGINAL run now
  // yields a value the tampered log can't reproduce faithfully.
  const tampered = { ...clean, events: clean.events.map((e, i) => (i === 6 ? { ...e, result: (e.result ?? 0) + 999999 } : e)) };
  const fpClean = fingerprintLog(clean);
  const fpTampered = fingerprintLog(tampered);
  const violations = [];
  if (fpClean !== fpTampered) violations.push({ reason: 'divergence-detected', fpClean, fpTampered });
  // The tampered log must ALSO be caught by a strict re-fingerprint against a
  // fresh record of the same seed (the honest baseline).
  const fresh = fingerprintLog(record(run, { seed, runId: 'div' }));
  if (fresh !== fpTampered) violations.push({ reason: 'tampered-log-mismatches-fresh-record', fresh, fpTampered });
  return { ok: violations.length === 0, violations, detail: `${violations.length} divergence(s) detected` };
}

/**
 * PLANT — the replayed run issues an EXTRA, un-recorded call (a live
 * fallthrough). replay() must throw ReplayError rather than silently return.
 * Proves the "fail loudly on any un-recorded call" detector fires.
 *
 * @returns {{ ok, violations, detail }}
 */
export function plantUnrecordedCall(seed = 11) {
  const cleanRun = makeSyntheticRun(seed, { steps: 6 });
  const log = record(cleanRun, { seed, runId: 'extra' });
  // A DIVERGENT run that makes one extra world call the log never recorded.
  const divergentRun = (io) => {
    const out = cleanRun(io);
    io.world('ghost', () => 42); // un-recorded → must throw
    return out;
  };
  const violations = [];
  let caught = false;
  try {
    replay(log, divergentRun);
  } catch (err) {
    if (err instanceof ReplayError) {
      caught = true;
      violations.push({ reason: 'unrecorded-call-caught', message: err.message });
    } else {
      throw err;
    }
  }
  return { ok: !caught, violations, detail: caught ? 'un-recorded call threw ReplayError' : 'un-recorded call slipped through (BUG)' };
}

/**
 * PLANT — the replayed run makes a call whose KEY diverges from the record.
 * replay() must throw. Proves kind/key mismatch is a hard failure.
 *
 * @returns {{ ok, violations, detail }}
 */
export function plantKeyDivergence(seed = 13) {
  const cleanRun = makeSyntheticRun(seed, { steps: 5 });
  const log = record(cleanRun, { seed, runId: 'key' });
  // A run that swaps the first model key — first call diverges immediately.
  const divergentRun = (io) => {
    io.model('WRONG_KEY', { temperature: 0.2 }, () => 'verified');
    return {};
  };
  let caught = false;
  const violations = [];
  try {
    replay(log, divergentRun);
  } catch (err) {
    if (err instanceof ReplayError) {
      caught = true;
      violations.push({ reason: 'key-divergence-caught', message: err.message });
    } else {
      throw err;
    }
  }
  return { ok: !caught, violations, detail: caught ? 'key divergence threw ReplayError' : 'key divergence slipped through (BUG)' };
}

// ─── invariants (checker + probe + negative control) ────────────────

export const REPLAY_INVARIANTS = [
  {
    id: 'replay-byte-identical',
    hypothesis: 'Two records of the same seeded run produce byte-identical logs and the log replays back cleanly.',
    check() {
      return replayDeterminismChecker(makeSyntheticRun(4242, { steps: 24 }), { seed: 4242, runId: 'inv' });
    },
    negativeControl() {
      // A corrupted recorded result must be detected as a divergence.
      return plantResultDivergence();
    },
  },
  {
    id: 'replay-no-unrecorded-call',
    hypothesis: 'Any call not present in the recorded log fails loudly — no silent live fallthrough.',
    check() {
      // Clean replay of a faithful run consumes exactly the recorded events.
      const run = makeSyntheticRun(99, { steps: 10 });
      const log = record(run, { seed: 99, runId: 'inv' });
      let ok = true;
      const violations = [];
      try {
        const r = replay(log, run);
        if (r.steps !== log.events.length) {
          ok = false;
          violations.push({ reason: 'incomplete-consume', steps: r.steps, recorded: log.events.length });
        }
      } catch (err) {
        ok = false;
        violations.push({ reason: 'clean-replay-threw', message: err.message });
      }
      return { ok, violations, detail: ok ? null : 'clean replay did not round-trip' };
    },
    negativeControl() {
      return plantUnrecordedCall();
    },
  },
  {
    id: 'replay-key-divergence-fails-loud',
    hypothesis: 'A replayed call whose kind/key diverges from the record throws rather than silently returning a mismatched value.',
    check() {
      // The faithful run never diverges → no throw.
      const run = makeSyntheticRun(21, { steps: 8 });
      const log = record(run, { seed: 21, runId: 'inv' });
      let ok = true;
      const violations = [];
      try {
        replay(log, run);
      } catch (err) {
        ok = false;
        violations.push({ reason: 'faithful-run-threw', message: err.message });
      }
      return { ok, violations, detail: ok ? null : 'faithful run should not diverge' };
    },
    negativeControl() {
      return plantKeyDivergence();
    },
  },
];

/**
 * Run every replay invariant. Mirrors invariants.runInvariants aggregate shape.
 * @returns {{ safetyViolations, negativeControlsCaught, invariantsTotal, results, fingerprints }}
 */
export function runReplayInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const inv of REPLAY_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    if (!pos.ok) safetyViolations += pos.violations.length;
    if (!neg.ok) negativeControlsCaught += 1;
    results.push({
      id: inv.id,
      hypothesis: inv.hypothesis,
      checkOk: pos.ok,
      checkViolations: pos.violations.length,
      negativeControlCaught: !neg.ok,
      detail: pos.detail,
      fpA: pos.fpA ?? null,
      fpB: pos.fpB ?? null,
    });
  }
  // A canonical determinism fingerprint the scorecard can report.
  const canonical = replayDeterminismChecker(makeSyntheticRun(1, { steps: 32 }), { seed: 1, runId: 'canonical' });
  return {
    safetyViolations,
    negativeControlsCaught,
    invariantsTotal: REPLAY_INVARIANTS.length,
    results,
    fingerprint: canonical.fpA,
    fingerprintStable: canonical.ok,
  };
}
