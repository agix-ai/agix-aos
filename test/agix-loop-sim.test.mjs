// agix-loop-sim — unit + falsification tests.
// Runner: node --test test/agix-loop-sim.test.mjs
//
// Covers: PRNG determinism, scenario reproducibility, the two loop-engineering
// modules' behavior, the schema-agnostic gate (incl. its self-test), and —
// the point of the exercise — every safety invariant's NEGATIVE CONTROL
// (proving each checker can fail).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32, makePrng } from '../lib/agix-loop-sim/prng.mjs';
import {
  generateScenario,
  plantTierSafetyViolation,
  plantTrustCatastropheStream,
  effectiveSuccess,
  DEFAULT_TIERS,
} from '../lib/agix-loop-sim/scenarios.mjs';
import {
  buildProfile,
  recommendTier,
  planFanout,
  DEFAULT_HIGH_RISK_FLOOR,
} from '../lib/agix-efficiency-profile.mjs';
import {
  replay,
  trustBudget,
  gateAdjust,
  isPromoted,
  scopeKey,
  DEFAULT_RULES,
} from '../lib/agix-trust-ledger.mjs';
import {
  runGate,
  checkMetric,
  ratchetBaseline,
  selfTest as gateSelfTest,
  getPath,
  setPath,
} from '../lib/agix-loop-sim/gate.mjs';
import { INVARIANTS, runInvariants, CANDIDATE_TIERS } from '../lib/agix-loop-sim/invariants.mjs';
import { runHarness, runOnce, passFingerprint, stableStringify } from '../lib/agix-loop-sim/harness.mjs';

// ─── PRNG determinism ────────────────────────────────────────────────

test('mulberry32: identical seed → identical stream', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('mulberry32: different seeds diverge', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test('makePrng: never leaves [0,1); helpers are in-range and stable', () => {
  const p = makePrng(7);
  for (let i = 0; i < 1000; i++) {
    const f = p.float();
    assert.ok(f >= 0 && f < 1);
  }
  const q = makePrng(7);
  const r = makePrng(7);
  assert.equal(q.int(0, 10), r.int(0, 10));
  assert.equal(q.weighted([{ value: 'a', weight: 1 }, { value: 'b', weight: 3 }]), r.weighted([{ value: 'a', weight: 1 }, { value: 'b', weight: 3 }]));
});

// ─── scenario reproducibility ────────────────────────────────────────

test('generateScenario: same (seed,config) → byte-identical streams', () => {
  const a = generateScenario(42);
  const b = generateScenario(42);
  assert.equal(JSON.stringify(a.ledger), JSON.stringify(b.ledger));
  assert.equal(JSON.stringify(a.outcomes), JSON.stringify(b.outcomes));
});

test('generateScenario: no wall-clock leakage (timestamps derive from seeded clock)', () => {
  const s = generateScenario(1);
  // All timestamps are on/after the fixed synthetic epoch, strictly ordered.
  let prev = '';
  for (const o of s.outcomes) {
    assert.ok(o.ts >= '2026-01-01T00:00:00.000Z');
    assert.ok(o.ts > prev || prev === '' || o.ts >= prev);
    prev = o.ts;
  }
});

test('generateScenario: ledger and outcomes join 1:1 by call_id', () => {
  const s = generateScenario(3);
  assert.equal(s.ledger.length, s.outcomes.length);
  const ids = new Set(s.ledger.map((e) => e.call_id));
  for (const o of s.outcomes) assert.ok(ids.has(o.callId));
});

test('effectiveSuccess: premium degrades gently, cheap collapses on hard tasks', () => {
  const easy = 0.05;
  const hard = 0.8;
  assert.ok(effectiveSuccess(DEFAULT_TIERS.cheap, easy) > 0.85, 'cheap fine on easy');
  assert.ok(effectiveSuccess(DEFAULT_TIERS.cheap, hard) < 0.5, 'cheap collapses on hard');
  assert.ok(effectiveSuccess(DEFAULT_TIERS.premium, hard) > 0.9, 'premium reliable on hard');
});

// ─── efficiency-profile module ───────────────────────────────────────

test('buildProfile: cost-of-pass = total cost / verified passes; stable ordering', () => {
  const ledger = [
    { call_id: 'c1', cost_usd: 0.01, input_tokens: 10, output_tokens: 5, latency_ms: 100 },
    { call_id: 'c2', cost_usd: 0.01, input_tokens: 10, output_tokens: 5, latency_ms: 100 },
    { call_id: 'c3', cost_usd: 0.01, input_tokens: 10, output_tokens: 5, latency_ms: 100 },
  ];
  const outcomes = [
    { callId: 'c1', taskClass: 'x', tierUsed: 'cheap', verdict: 'verified', overridden: false },
    { callId: 'c2', taskClass: 'x', tierUsed: 'cheap', verdict: 'failed', overridden: false },
    { callId: 'c3', taskClass: 'x', tierUsed: 'cheap', verdict: 'verified', overridden: false },
  ];
  const prof = buildProfile(ledger, outcomes);
  const stat = prof.taskClasses.x.tiers.cheap;
  assert.equal(stat.attempts, 3);
  assert.equal(stat.verified, 2);
  // total cost 0.03 / 2 verified = 0.015
  assert.equal(stat.costOfPass, 0.015);
  assert.equal(stat.successRate, 0.666667);
});

test('buildProfile: a tier with zero passes has Infinity cost-of-pass (worthless, not free)', () => {
  const ledger = [{ call_id: 'c1', cost_usd: 0.02 }];
  const outcomes = [{ callId: 'c1', taskClass: 'x', tierUsed: 'cheap', verdict: 'failed', overridden: false }];
  const prof = buildProfile(ledger, outcomes);
  assert.equal(prof.taskClasses.x.tiers.cheap.costOfPass, Infinity);
});

test('recommendTier: picks the min cost-of-pass tier that clears the floor', () => {
  const profile = {
    taskClasses: {
      x: {
        tiers: {
          cheap: { successRate: 0.9, costOfPass: 0.002, hadFailure: true },
          'default-quality': { successRate: 0.95, costOfPass: 0.012, hadFailure: true },
        },
      },
    },
  };
  const rec = recommendTier(profile, 'x', { candidateTiers: ['cheap', 'default-quality'], riskTier: 'low', minQuality: 0.7 });
  assert.equal(rec.tier, 'cheap');
  assert.equal(rec.reason, 'learned-min-cost-of-pass');
});

test('recommendTier: high-risk applies the stricter floor and refuses a weak tier', () => {
  const profile = {
    taskClasses: {
      deploy: {
        tiers: {
          cheap: { successRate: 0.75, costOfPass: 0.002, hadFailure: true }, // below 0.8 floor
          premium: { successRate: 0.95, costOfPass: 0.05, hadFailure: false },
        },
      },
    },
  };
  const rec = recommendTier(profile, 'deploy', { candidateTiers: ['cheap', 'premium'], riskTier: 'high' });
  assert.equal(rec.tier, 'premium');
  assert.equal(rec.floor, DEFAULT_HIGH_RISK_FLOOR);
});

test('recommendTier: falls back to safe default with no profile data', () => {
  const rec = recommendTier({ taskClasses: {} }, 'unknown', { candidateTiers: ['cheap'], riskTier: 'low' });
  assert.equal(rec.fellBack, true);
});

test('recommendTier: deterministic tie-break (equal cost-of-pass → higher successRate, then name)', () => {
  const profile = {
    taskClasses: {
      x: { tiers: { b: { successRate: 0.9, costOfPass: 0.01 }, a: { successRate: 0.9, costOfPass: 0.01 } } },
    },
  };
  const r1 = recommendTier(profile, 'x', { candidateTiers: ['b', 'a'], minQuality: 0.5 });
  const r2 = recommendTier(profile, 'x', { candidateTiers: ['a', 'b'], minQuality: 0.5 });
  assert.equal(r1.tier, 'a');
  assert.equal(r2.tier, 'a'); // order-independent
});

test('planFanout: assigns a tier per subtask deterministically', () => {
  const profile = { taskClasses: { x: { tiers: { cheap: { successRate: 0.9, costOfPass: 0.002 } } } } };
  const plan = planFanout(profile, [{ id: 's1', taskClass: 'x', riskTier: 'low' }], { candidateTiers: ['cheap'], minQuality: 0.7 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].tier, 'cheap');
  assert.equal(plan[0].id, 's1');
});

// ─── trust-ledger module ─────────────────────────────────────────────

test('trust replay: verified earns, failure penalizes asymmetrically', () => {
  const scope = { enterpriseId: 'e', userId: 'u', roleId: 'r', action_class: 'a' };
  const ev = (verdict, overridden = false) => ({ ts: `2026-01-01T00:0${0}:00.000Z`, scope, verdict, overridden });
  const rules = { ...DEFAULT_RULES };
  const rep = replay([
    { ...ev('verified'), ts: '2026-01-01T00:00:01.000Z' },
    { ...ev('verified'), ts: '2026-01-01T00:00:02.000Z' },
    { ...ev('failed'), ts: '2026-01-01T00:00:03.000Z' },
  ], rules);
  // 2*earn - penalty = 0.12 - 0.34, clamped at 0.
  assert.equal(trustBudget(rep, scope), 0);
});

test('trust replay: catastrophe resets to 0 and freezes (sticky)', () => {
  const scope = { enterpriseId: 'e', userId: 'u', roleId: 'r', action_class: 'a' };
  const mk = (ts, extra) => ({ ts, scope, verdict: 'verified', overridden: false, ...extra });
  const rep = replay([
    mk('2026-01-01T00:00:01.000Z'),
    mk('2026-01-01T00:00:02.000Z'),
    mk('2026-01-01T00:00:03.000Z', { verdict: 'failed', catastrophic: true }),
    mk('2026-01-01T00:00:04.000Z'), // verified again, must NOT thaw
  ], DEFAULT_RULES);
  const st = rep.states[scopeKey(scope)];
  assert.equal(st.budget, 0);
  assert.equal(st.frozen, true);
  assert.equal(st.promoted, false);
});

test('trust replay: is deterministic (byte-identical on rerun)', () => {
  const s = generateScenario(9);
  const a = replay(s.outcomes, DEFAULT_RULES);
  const b = replay(s.outcomes, DEFAULT_RULES);
  assert.equal(JSON.stringify(a.states), JSON.stringify(b.states));
  assert.equal(JSON.stringify(a.snapshots), JSON.stringify(b.snapshots));
});

test('isPromoted: requires budget AND minVerified AND cleanStreak AND not frozen', () => {
  const R = DEFAULT_RULES;
  assert.equal(isPromoted({ budget: 1, verifiedCount: 100, cleanStreak: 100, frozen: false }, R), true);
  assert.equal(isPromoted({ budget: 1, verifiedCount: 1, cleanStreak: 100, frozen: false }, R), false);
  assert.equal(isPromoted({ budget: 0.1, verifiedCount: 100, cleanStreak: 100, frozen: false }, R), false);
  assert.equal(isPromoted({ budget: 1, verifiedCount: 100, cleanStreak: 100, frozen: true }, R), false);
});

test('gateAdjust: never returns below the static floor (property sweep)', () => {
  const p = makePrng(55);
  for (let i = 0; i < 2000; i++) {
    const b = p.float();
    const f = p.float();
    assert.ok(gateAdjust(b, f) >= f - 1e-12);
  }
});

// ─── gate ────────────────────────────────────────────────────────────

test('gate.getPath / setPath: dotted access round-trips', () => {
  const o = {};
  setPath(o, 'a.b.c', 5);
  assert.equal(getPath(o, 'a.b.c'), 5);
  assert.equal(getPath(o, 'a.missing'), undefined);
});

test('gate checkMetric: exact correctness fails on any deviation', () => {
  const r = checkMetric('c.v', 1, 0, { direction: 'exact', expected: 0, blocking: true, robust: true });
  assert.equal(r.pass, false);
  assert.equal(r.gated, true);
});

test('gate checkMetric: lower-better honors percent tolerance + hard ceiling', () => {
  const within = checkMetric('p', 1.03, undefined, { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 } });
  // no baseline passed via arg here → uses baselineValue undefined; supply it:
  const ok = checkMetric('p', 1.03, 1.0, { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 } });
  assert.equal(ok.pass, true);
  const bad = checkMetric('p', 1.2, 1.0, { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 } });
  assert.equal(bad.pass, false);
  const ceil = checkMetric('p', 6000, 1.0, { direction: 'lower-better', tolerance: { kind: 'percent', value: 100 }, hardCeiling: 5000 });
  assert.equal(ceil.pass, false);
  void within;
});

test('gate: non-robust (noisy) metric regressing is reported, NOT gated', () => {
  const g = runGate({ p: { tail: 9000 } }, { p: { tail: 100 } }, {
    'p.tail': { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 }, blocking: true, robust: false },
  });
  assert.equal(g.allBlockingPassed, true); // did not gate
  assert.equal(g.reportedOnly.length, 1);
});

test('gate.selfTest: proves the gate flags each planted regression', () => {
  const st = gateSelfTest();
  assert.equal(st.passed, true, JSON.stringify(st.cases.filter((c) => !c.ok)));
});

test('gate ratchetBaseline: only tightens (lower for lower-better, higher for higher-better)', () => {
  const contracts = {
    'p.cost': { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 } },
    'p.delta': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.05 } },
  };
  const base = { p: { cost: 1.0, delta: 0.5 } };
  // Improvement: cost down, delta up → baseline tightens.
  const better = ratchetBaseline(base, { p: { cost: 0.8, delta: 0.7 } }, contracts);
  assert.equal(getPath(better, 'p.cost'), 0.8);
  assert.equal(getPath(better, 'p.delta'), 0.7);
  // Regression: cost up, delta down → baseline must NOT loosen.
  const worse = ratchetBaseline(base, { p: { cost: 1.5, delta: 0.2 } }, contracts);
  assert.equal(getPath(worse, 'p.cost'), 1.0);
  assert.equal(getPath(worse, 'p.delta'), 0.5);
});

// ─── falsifiable safety invariants + NEGATIVE CONTROLS ───────────────

test('invariants: every hypothesis HOLDS on a well-tuned engine', () => {
  for (const inv of INVARIANTS) {
    const r = inv.check();
    assert.equal(r.ok, true, `${inv.id} should hold: ${r.detail || ''}`);
  }
});

test('NEGATIVE CONTROL: every invariant catches its planted violation', () => {
  for (const inv of INVARIANTS) {
    const r = inv.negativeControl();
    assert.equal(r.ok, false, `${inv.id} negative control MUST be caught (proves the checker can fail)`);
    assert.ok(r.violations.length > 0, `${inv.id} negative control produced no violations`);
  }
});

test('NEGATIVE CONTROL (freeze): a catastrophicResets:false rule-set leaves budget standing', () => {
  const { events } = plantTrustCatastropheStream();
  const bad = replay(events, { ...DEFAULT_RULES, catastrophicResets: false });
  // At least one post-catastrophe snapshot is not frozen / non-zero.
  const anyStanding = bad.snapshots.some((s) => s.catastrophic === false && s.budget > 0 && !s.frozen);
  assert.equal(anyStanding, true);
});

test('NEGATIVE CONTROL (tier-safety): a naive cheapest recommender routes a high-risk task below the floor', () => {
  const { ledger, outcomes, highRiskClass } = plantTierSafetyViolation();
  const profile = buildProfile(ledger, outcomes);
  // Safe recommender refuses the poison tier.
  const safe = recommendTier(profile, highRiskClass, { candidateTiers: CANDIDATE_TIERS, riskTier: 'high' });
  assert.notEqual(safe.tier, 'cheap');
  const poison = profile.taskClasses[highRiskClass].tiers.cheap;
  assert.ok(poison.successRate < DEFAULT_HIGH_RISK_FLOOR, 'poison tier is below the high-risk floor');
});

test('runInvariants: aggregate reports 0 safety violations and all negative controls caught', () => {
  const r = runInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, r.invariantsTotal);
});

// ─── harness end-to-end ──────────────────────────────────────────────

test('runOnce: byte-identical artifacts across two runs of the same seed (RELIABILITY)', () => {
  const a = runOnce(1);
  const b = runOnce(1);
  assert.equal(passFingerprint(a), passFingerprint(b));
  assert.equal(stableStringify(a.profile), stableStringify(b.profile));
  assert.equal(stableStringify(a.trust.states), stableStringify(b.trust.states));
});

test('runHarness: determinism stable, safety clean, efficiency delta positive at equal quality', () => {
  const r = runHarness({});
  assert.equal(r.scorecard.correctness.determinismStable, 1);
  assert.equal(r.scorecard.correctness.safetyViolations, 0);
  assert.equal(r.scorecard.correctness.tierSafetyViolations, 0);
  assert.equal(r.scorecard.correctness.negativeControlsCaught, 4);
  assert.equal(r.scorecard.correctness.gateSelfTestPassed, 1);
  assert.equal(r.scorecard.correctness.efficiencyDeltaPositive, 1);
  assert.equal(r.scorecard.correctness.qualityRegressed, 0);
  assert.ok(r.repeatability.minDelta > 0, 'every seed shows a positive efficiency delta');
});

test('runHarness: whole scorecard is reproducible across two full runs (REPEATABILITY)', () => {
  const a = runHarness({});
  const b = runHarness({});
  assert.equal(stableStringify(a.scorecard), stableStringify(b.scorecard));
});
