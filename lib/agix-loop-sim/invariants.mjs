// agix-loop-sim/invariants — falsifiable safety hypotheses (D-104 idiom).
//
// GUARDS: the three FALSIFIABLE-SAFETY properties of the loop engine. Each
// invariant is a PURE CHECKER + a PROBE that runs the real module over an
// adversarial synthetic stream + a PLANTED-VIOLATION NEGATIVE CONTROL that
// proves the checker can fail. Doctrine: a safety check you have never seen
// fail is not a safety check.
//
//   (a) trust NEVER promotes an entity whose verified signals hadn't earned
//       it, and a catastrophe resets + freezes it. (calibration + freeze)
//   (b) auto-tiering NEVER routes a high-risk task to a tier that has a
//       recorded failure on that task class. (planted-violation control)
//   (c) gateAdjust NEVER returns below the static HITL floor.
//
// Every checker returns { ok, violations, detail }. For each invariant the
// harness asserts check().ok === true AND negativeControl().ok === false.

import { makePrng } from './prng.mjs';
import {
  plantTierSafetyViolation,
  plantTrustCatastropheStream,
  plantTrustPumpingStream,
} from './scenarios.mjs';
import { buildProfile, recommendTier, DEFAULT_HIGH_RISK_FLOOR } from '../agix-efficiency-profile.mjs';
import { replay, gateAdjust, DEFAULT_RULES } from '../agix-trust-ledger.mjs';

export const CANDIDATE_TIERS = ['cheap', 'default-quality', 'premium'];
export const HIGH_RISK_FLOOR = DEFAULT_HIGH_RISK_FLOOR;

// ─── pure checkers ──────────────────────────────────────────────────

/**
 * Freeze checker: for every scope that suffered a catastrophe, every
 * snapshot at or after the first catastrophe must show budget 0, frozen,
 * and not promoted.
 */
export function catastropheFreezeChecker(replayResult) {
  const violations = [];
  const bySc = new Map();
  for (const s of replayResult.snapshots) {
    if (!bySc.has(s.scopeKey)) bySc.set(s.scopeKey, []);
    bySc.get(s.scopeKey).push(s);
  }
  for (const [key, snaps] of bySc) {
    const first = snaps.findIndex((s) => s.catastrophic);
    if (first < 0) continue;
    for (let i = first; i < snaps.length; i++) {
      const s = snaps[i];
      if (s.budget !== 0 || !s.frozen || s.promoted) {
        violations.push({ scopeKey: key, at: i, budget: s.budget, frozen: s.frozen, promoted: s.promoted });
      }
    }
  }
  return { ok: violations.length === 0, violations, detail: violations.length ? `${violations.length} post-catastrophe non-frozen snapshot(s)` : null };
}

/**
 * Calibration checker: no snapshot may be flagged promoted while its gates
 * are unmet, and (for a pumping stream) the scope must not end promoted.
 */
export function promotionCalibrationChecker(replayResult, rules) {
  const R = { ...DEFAULT_RULES, ...rules };
  const violations = [];
  for (const s of replayResult.snapshots) {
    if (s.promoted && (s.budget < R.promotionScore || s.verifiedCount < R.minVerified || s.cleanStreak < R.cleanStreak || s.frozen)) {
      violations.push({ scopeKey: s.scopeKey, reason: 'promoted-with-unmet-gates', budget: s.budget, verifiedCount: s.verifiedCount, cleanStreak: s.cleanStreak });
    }
  }
  for (const key of replayResult.order) {
    if (replayResult.states[key].promoted) {
      violations.push({ scopeKey: key, reason: 'pumping-stream-earned-promotion' });
    }
  }
  return { ok: violations.length === 0, violations, detail: violations.length ? `${violations.length} calibration breach(es)` : null };
}

/**
 * Tier-safety checker: no high-risk planned subtask may be assigned a tier
 * whose learned success rate on that class falls below the high-risk floor —
 * i.e. a tier that has "failed the task" too often to trust with it.
 */
export function tierSafetyChecker(profile, plan, { floor = HIGH_RISK_FLOOR } = {}) {
  const violations = [];
  for (const p of plan) {
    if (p.riskTier !== 'high') continue;
    const stat = profile.taskClasses?.[p.taskClass]?.tiers?.[p.tier];
    // A tier with NO learned data on a high-risk class is also unsafe.
    if (!stat || stat.successRate < floor) {
      violations.push({ id: p.id, taskClass: p.taskClass, tier: p.tier, successRate: stat?.successRate ?? null, floor });
    }
  }
  return { ok: violations.length === 0, violations, detail: violations.length ? `${violations.length} high-risk task(s) routed below the ${floor} floor` : null };
}

/** Floor checker: gateAdjust output must never fall below the static floor. */
export function gateFloorChecker(adjustFn, seed = 909, samples = 500) {
  const prng = makePrng(seed);
  const violations = [];
  for (let i = 0; i < samples; i++) {
    const budget = prng.float();
    const floor = prng.float();
    const out = adjustFn(budget, floor);
    if (out < floor - 1e-12) violations.push({ budget, floor, out });
  }
  return { ok: violations.length === 0, violations, detail: violations.length ? `${violations.length} sub-floor result(s)` : null };
}

// Naive (unsafe) recommender used only by the negative control: cheapest
// cost-of-pass, ignoring risk. Proves tierSafetyChecker catches a real
// mis-route, not just a hand-built one.
function naiveCheapestTier(profile, taskClass, candidateTiers) {
  const tc = profile.taskClasses?.[taskClass];
  let best = null;
  for (const tier of candidateTiers) {
    const stat = tc?.tiers?.[tier];
    if (!stat || stat.costOfPass === Infinity) continue;
    if (!best || stat.costOfPass < best.costOfPass) best = { tier, ...stat };
  }
  return best ? best.tier : candidateTiers[0];
}

// ─── invariants (checker + probe + negative control) ────────────────

export const INVARIANTS = [
  {
    id: 'trust-catastrophe-freeze',
    hypothesis: 'A catastrophe resets trust to 0 and freezes the scope; later verified runs never thaw it.',
    check() {
      const { events } = plantTrustCatastropheStream();
      return catastropheFreezeChecker(replay(events, DEFAULT_RULES));
    },
    negativeControl() {
      // Mis-tuned rule-set where catastrophe does NOT reset — must be caught.
      const { events } = plantTrustCatastropheStream();
      return catastropheFreezeChecker(replay(events, { ...DEFAULT_RULES, catastrophicResets: false }));
    },
  },
  {
    id: 'trust-no-premature-promotion',
    hypothesis: 'Alternating verified/overridden "pumping" never earns autonomy under asymmetric penalty + minVerified.',
    check() {
      const { events } = plantTrustPumpingStream();
      return promotionCalibrationChecker(replay(events, DEFAULT_RULES), DEFAULT_RULES);
    },
    negativeControl() {
      // Mis-tuned: symmetric penalty, no verified/streak floor, low bar.
      const badRules = { earnRate: 0.6, penalty: 0.1, promotionScore: 0.4, minVerified: 0, cleanStreak: 0, catastrophicResets: true };
      const { events } = plantTrustPumpingStream();
      return promotionCalibrationChecker(replay(events, badRules), badRules);
    },
  },
  {
    id: 'tier-safety-high-risk',
    hypothesis: 'A high-risk task is never routed to a tier that has a recorded failure on that class.',
    check() {
      const { ledger, outcomes, highRiskClass } = plantTierSafetyViolation();
      const profile = buildProfile(ledger, outcomes);
      const rec = recommendTier(profile, highRiskClass, { candidateTiers: CANDIDATE_TIERS, riskTier: 'high', minQuality: 0.6 });
      const plan = [{ id: 'hr', taskClass: highRiskClass, tier: rec.tier, riskTier: 'high' }];
      return tierSafetyChecker(profile, plan);
    },
    negativeControl() {
      // Route the SAME high-risk task with a naive cheapest recommender.
      const { ledger, outcomes, highRiskClass } = plantTierSafetyViolation();
      const profile = buildProfile(ledger, outcomes);
      const tier = naiveCheapestTier(profile, highRiskClass, CANDIDATE_TIERS);
      const plan = [{ id: 'hr', taskClass: highRiskClass, tier, riskTier: 'high' }];
      return tierSafetyChecker(profile, plan);
    },
  },
  {
    id: 'gate-floor-never-relaxes',
    hypothesis: 'gateAdjust(budget, floor) never returns below the static HITL floor.',
    check() {
      return gateFloorChecker(gateAdjust);
    },
    negativeControl() {
      // A broken adjust that takes the MIN — relaxes the floor.
      const broken = (b, f) => Math.min(b, f);
      return gateFloorChecker(broken);
    },
  },
];

/**
 * Run every invariant. Returns aggregate counts the scorecard/gate consume.
 * @returns {{ safetyViolations, negativeControlsCaught, invariantsTotal, results }}
 */
export function runInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const inv of INVARIANTS) {
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
      negativeControlViolations: neg.violations.length,
      detail: pos.detail,
    });
  }
  return {
    safetyViolations,
    negativeControlsCaught,
    invariantsTotal: INVARIANTS.length,
    results,
  };
}
