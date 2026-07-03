// agix-loop-sim/harness — run synthetic scenarios through the loop engine
// and emit a scorecard the gate can judge.
//
// GUARDS: "the loop was tuned on a run we can't reproduce" (loop-sim). This
// harness is the reproducibility spine: it runs the two pure modules
// (efficiency-profile, trust-ledger) over deterministic synthetic streams
// and proves RELIABILITY (byte-identical reruns), REPEATABILITY (metrics
// converge across seeds), EFFICIENCY (learned auto-tiering beats an
// always-default baseline at equal quality), and FALSIFIABLE SAFETY (the
// invariants + their negative controls).
//
// Everything here is deterministic: no clock, no Math.random, stable key
// ordering, 6-decimal rounding in the modules — so two runs of the same
// seed serialize byte-for-byte.

import { generateScenario, DEFAULT_CONFIG } from './scenarios.mjs';
import { buildProfile, recommendTier, planFanout, DEFAULT_HIGH_RISK_FLOOR } from '../agix-efficiency-profile.mjs';
import { replay, DEFAULT_RULES } from '../agix-trust-ledger.mjs';
import { runInvariants, tierSafetyChecker, CANDIDATE_TIERS } from './invariants.mjs';
import { runGate, selfTest as gateSelfTest } from './gate.mjs';

export const DEFAULT_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
export const DEFAULT_MIN_QUALITY = 0.7;

// ─── deterministic serialization / hashing ──────────────────────────

/** Stable JSON: object keys sorted recursively. Infinity → "Infinity". */
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

// ─── one deterministic pass ──────────────────────────────────────────

/**
 * Run the two modules once over a scenario. Pure given (seed, config):
 * returns the profile, the fan-out plan, and the trust replay — the exact
 * artifacts the RELIABILITY suite byte-compares.
 */
export function runOnce(seed, config = DEFAULT_CONFIG, opts = {}) {
  const minQuality = opts.minQuality ?? DEFAULT_MIN_QUALITY;
  const scenario = generateScenario(seed, config);
  const profile = buildProfile(scenario.ledger, scenario.outcomes);

  // One subtask per task class — a canonical fan-out for the plan artifact.
  const subtasks = config.taskClasses.map((tc) => ({ id: tc.name, taskClass: tc.name, riskTier: tc.riskTier }));
  const plan = planFanout(profile, subtasks, { candidateTiers: CANDIDATE_TIERS, minQuality });

  const trust = replay(scenario.outcomes, DEFAULT_RULES);

  return { scenario, profile, plan, trust, minQuality };
}

/** Fingerprint the reproducible artifacts of one pass. */
export function passFingerprint(pass) {
  return fingerprint({ profile: pass.profile, plan: pass.plan, trust: { states: pass.trust.states, snapshots: pass.trust.snapshots } });
}

// ─── efficiency comparison (learned vs always-default) ───────────────

/**
 * Compare learned auto-tiering against an always-`default-quality` policy,
 * weighting each task class by its frequency in the scenario. cost-of-pass
 * is the metric; quality is the guardrail (learned must not trade quality
 * for cost).
 */
export function efficiencyComparison(pass) {
  const { scenario, profile, minQuality } = pass;
  const counts = new Map();
  const risk = new Map();
  for (const o of scenario.outcomes) {
    counts.set(o.taskClass, (counts.get(o.taskClass) || 0) + 1);
    risk.set(o.taskClass, o.riskTier);
  }
  const classes = [...counts.keys()].sort();
  const BASELINE_TIER = 'default-quality';

  let wBaseCost = 0;
  let wLearnCost = 0;
  let wBaseQual = 0;
  let wLearnQual = 0;
  let wsum = 0;
  let floorBreached = false;
  const perClass = [];

  for (const c of classes) {
    const f = counts.get(c);
    const baseStat = profile.taskClasses?.[c]?.tiers?.[BASELINE_TIER];
    if (!baseStat || baseStat.costOfPass === Infinity) continue; // no baseline pass → skip
    // Effective quality floor for this class (stricter when high-risk).
    const floor = risk.get(c) === 'high' ? Math.max(minQuality, DEFAULT_HIGH_RISK_FLOOR) : minQuality;
    // EQUAL-QUALITY comparison: only count a class where the always-default
    // baseline itself clears the floor. Where default is below the floor,
    // the baseline is unsafe there and a cost comparison is apples-to-oranges
    // (learned routes UP for quality, a safety upgrade, not a cost win).
    if (baseStat.successRate < floor) continue;
    const rec = recommendTier(profile, c, { candidateTiers: CANDIDATE_TIERS, riskTier: risk.get(c), minQuality });
    // recommendTier picks argmin cost-of-pass among floor-clearers, and
    // default is itself a candidate → learnedCost <= baselineCost, always.
    const learnCost = rec.costOfPass === Infinity ? baseStat.costOfPass : rec.costOfPass;
    const learnQual = rec.successRate;
    // Equal-quality guard: the learned tier must still clear the floor.
    if (learnQual < floor - 1e-9) floorBreached = true;

    wsum += f;
    wBaseCost += f * baseStat.costOfPass;
    wLearnCost += f * learnCost;
    wBaseQual += f * baseStat.successRate;
    wLearnQual += f * learnQual;
    perClass.push({ taskClass: c, freq: f, baselineTier: BASELINE_TIER, learnedTier: rec.tier, baseCostOfPass: baseStat.costOfPass, learnedCostOfPass: learnCost, floor });
  }

  const baselineCostOfPass = wsum ? wBaseCost / wsum : 0;
  const learnedCostOfPass = wsum ? wLearnCost / wsum : 0;
  const baselineQuality = wsum ? wBaseQual / wsum : 0;
  const learnedQuality = wsum ? wLearnQual / wsum : 0;
  const deltaPct = baselineCostOfPass > 0 ? (baselineCostOfPass - learnedCostOfPass) / baselineCostOfPass : 0;

  return {
    baselineCostOfPass: round6(baselineCostOfPass),
    learnedCostOfPass: round6(learnedCostOfPass),
    baselineQuality: round6(baselineQuality),
    learnedQuality: round6(learnedQuality),
    efficiencyDeltaPct: round6(deltaPct),
    // "Regressed" = the learned routing dropped a counted class BELOW its
    // quality floor. Routing DOWN to a cheaper floor-clearing tier is not a
    // regression — both baseline and learned clear the floor (equal quality).
    qualityRegressed: floorBreached,
    perClass,
  };
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// ─── full harness run → scorecard ────────────────────────────────────

/**
 * Run the whole harness. Deterministic given (seeds, config).
 * @returns {{ scorecard, primary, efficiency, repeatability, safety, gateSelfTest }}
 */
export function runHarness({ seeds = DEFAULT_SEEDS, config = DEFAULT_CONFIG, minQuality = DEFAULT_MIN_QUALITY } = {}) {
  const primarySeed = seeds[0];

  // RELIABILITY — every seed must produce a byte-identical rerun.
  const deltas = [];
  const fingerprints = [];
  let allDeterministic = true;
  let primary = null;
  let primaryEff = null;

  for (const seed of seeds) {
    const passA = runOnce(seed, config, { minQuality });
    const passB = runOnce(seed, config, { minQuality });
    const fpA = passFingerprint(passA);
    const fpB = passFingerprint(passB);
    if (fpA !== fpB) allDeterministic = false;
    fingerprints.push({ seed, fingerprint: fpA, stable: fpA === fpB });
    const eff = efficiencyComparison(passA);
    deltas.push({ seed, efficiencyDeltaPct: eff.efficiencyDeltaPct, learnedCostOfPass: eff.learnedCostOfPass, qualityRegressed: eff.qualityRegressed });
    if (seed === primarySeed) {
      primary = passA;
      primaryEff = eff;
    }
  }

  // REPEATABILITY — convergence across seeds.
  const deltaVals = deltas.map((d) => d.efficiencyDeltaPct);
  const minDelta = Math.min(...deltaVals);
  const maxDelta = Math.max(...deltaVals);
  const meanDelta = deltaVals.reduce((s, v) => s + v, 0) / deltaVals.length;
  const spread = round6(maxDelta - minDelta);
  const anyQualityRegressed = deltas.some((d) => d.qualityRegressed);
  const meanLatencyLearned = round6(meanLearnedLatency(primary));

  // FALSIFIABLE SAFETY — invariants + negative controls + gate self-test.
  const safety = runInvariants();
  const gateSelf = gateSelfTest();

  // Tier-safety over the PRIMARY scenario's high-risk plan (aggregate).
  const highRiskPlan = primary.plan
    .filter((p) => primary.scenario.config.taskClasses.find((t) => t.name === p.taskClass)?.riskTier === 'high')
    .map((p) => ({ ...p, riskTier: 'high' }));
  const tierSafety = tierSafetyChecker(primary.profile, highRiskPlan);

  const scorecard = {
    correctness: {
      determinismStable: allDeterministic ? 1 : 0,
      safetyViolations: safety.safetyViolations,
      negativeControlsCaught: safety.negativeControlsCaught,
      negativeControlsExpected: safety.invariantsTotal,
      gateSelfTestPassed: gateSelf.passed ? 1 : 0,
      tierSafetyViolations: tierSafety.violations.length,
      efficiencyDeltaPositive: minDelta > 0 ? 1 : 0,
      qualityRegressed: anyQualityRegressed ? 1 : 0,
    },
    performance: {
      costOfPassLearned: primaryEff.learnedCostOfPass,
      efficiencyDeltaPct: round6(meanDelta),
      minEfficiencyDeltaPct: round6(minDelta),
      repeatabilitySpread: spread,
      meanLatencyLearned,
    },
    observed: {
      seeds,
      primarySeed,
      fingerprints,
      deltas,
      efficiency: primaryEff,
    },
  };

  return {
    scorecard,
    primary,
    efficiency: primaryEff,
    repeatability: { minDelta: round6(minDelta), maxDelta: round6(maxDelta), meanDelta: round6(meanDelta), spread, seeds: seeds.length },
    safety,
    gateSelfTest: gateSelf,
    fingerprints,
  };
}

function meanLearnedLatency(pass) {
  // Mean learned-tier latency across the plan (a noisy, reported-only signal).
  let sum = 0;
  let n = 0;
  for (const p of pass.plan) {
    const stat = pass.profile.taskClasses?.[p.taskClass]?.tiers?.[p.tier];
    if (stat) {
      sum += stat.meanLatency;
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

// ─── metric contracts (the gate's rulebook) ─────────────────────────
//
// Correctness = absolute / zero-tolerance / blocking. Performance =
// relative to the committed baseline. Robustness split: noisy CI signals
// (latency spread) are robust:false → reported, never gating.

export const CONTRACTS = {
  // Correctness — absolute, blocking.
  'correctness.determinismStable': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.safetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.gateSelfTestPassed': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.tierSafetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.efficiencyDeltaPositive': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.qualityRegressed': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.negativeControlsCaught': { direction: 'exact', expected: 4, blocking: true, robust: true },
  // Performance — relative to committed baseline (ratchet).
  'performance.costOfPassLearned': { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.1 }, blocking: true, robust: true, hardCeiling: 1.0 },
  'performance.efficiencyDeltaPct': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.05 }, blocking: true, robust: true },
  // Reported-only (noisy / runner-variant) — NOT gating.
  'performance.repeatabilitySpread': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 0.05 }, blocking: false, robust: false },
  'performance.meanLatencyLearned': { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.25 }, blocking: false, robust: false },
};

/** Run the gate over a harness scorecard + committed baseline. */
export function judge(scorecard, baseline) {
  return runGate(scorecard, baseline, CONTRACTS);
}
