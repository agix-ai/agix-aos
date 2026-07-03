// agix-loop-sim/ecosystem-harness — aggregate phases 1–3 into one scorecard the
// schema-agnostic gate judges against a committed baseline.
//
// GUARDS: "phases 1–3 were tuned on a run we can't reproduce / a gate quietly
// loosened" (ecosystem-sim). Deterministic, CI-safe, zero model/API/network.
// Correctness metrics are absolute/blocking (zero tolerance); the MPA hard gate
// is exact 1.0; performance metrics ratchet against the baseline; noisy signals
// are reported, not gated. Reuses gate.mjs verbatim.

import { runReplayInvariants } from './record-replay.mjs';
import {
  runMemorySession,
  computeMemoryMetrics,
  runMemoryInvariants,
  memorySessionFingerprint,
  DEFAULT_MEMORY_CONFIG,
} from './memory-model.mjs';
import {
  runReservoir,
  runContextInvariants,
  collapseStudy,
  reservoirFingerprint,
} from './context-reservoir.mjs';
import { runGate, selfTest as gateSelfTest } from './gate.mjs';
import { fingerprint } from './record-replay.mjs';
import { runFleet, runFleetInvariants, fleetFingerprint } from './fleet.mjs';
import { detectAnomalies, runAnomalyInvariants, plantAllAnomalies, ANOMALY_DETECTORS } from './anomalies.mjs';

export const DEFAULT_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

// The ablation runs on a longer simulated horizon so a single-mechanism arm has
// time to cross the rot-knee / collapse while the both-on arm stays flat.
export const ABLATION_HOURS = 200;
export const PASS_K = 5; // pass^k repeats (deterministic → k identical replays)

/**
 * Negative-control PREFLIGHT (blueprint §6.4): before trusting a clean run, prove
 * the harness can FAIL. Run a null agent (does nothing), a random agent, and a
 * planted-violation agent (trips every MAST mode). If ANY scores anomaly-0 the
 * harness is broken, not passing.
 */
export function runPreflight(seed = 1) {
  const nullAnomalies = detectAnomalies(runFleet(seed, {}, { agent: 'null' })).total;
  const randomAnomalies = detectAnomalies(runFleet(seed, {}, { agent: 'random' })).total;
  const plantedRun = plantAllAnomalies(seed);
  const plantedScore = detectAnomalies(plantedRun);
  const modesTripped = Object.values(plantedScore.byMode).filter((n) => n > 0).length;
  const ok = nullAnomalies > 0 && randomAnomalies > 0 && plantedScore.total > 0 && modesTripped === ANOMALY_DETECTORS.length;
  return { ok, nullAnomalies, randomAnomalies, plantedAnomalies: plantedScore.total, modesTripped, modesTotal: ANOMALY_DETECTORS.length };
}

/**
 * The ablation (blueprint §7, the causal proof): no-offload / no-forgetting /
 * both. Only *both* (both mechanisms on) keeps C(t) bounded AND survives the
 * horizon at anomaly-0 — removing either mechanism breaks it.
 */
export function ablationStudy(seed = 3, hours = ABLATION_HOURS) {
  const arms = {
    'no-offload': { context: { noOffload: true } },
    'no-forgetting': { context: { noPrune: true }, memory: { noForgetting: true } },
    both: {},
  };
  const results = {};
  for (const [name, flags] of Object.entries(arms)) {
    const run = runFleet(seed, { hours }, flags);
    const a = detectAnomalies(run);
    results[name] = {
      contextSlope: run.coherence.contextSlope,
      maxUtil: run.coherence.maxUtil,
      hoursToCollapse: run.coherence.hoursToCollapse,
      collapsed: run.coherence.contextCollapsed,
      contextBounded: run.coherence.contextBounded,
      survived: !run.coherence.contextCollapsed,
      anomalies: a.total,
      byCategory: a.byCategory,
    };
  }
  const passes = (r) => r.contextBounded && r.survived && r.anomalies === 0;
  const causalOk = passes(results.both) && !passes(results['no-offload']) && !passes(results['no-forgetting']);
  return { seed, hours, results, causalOk };
}

/**
 * Run every phase over a seed sweep and emit the ecosystem scorecard. Pure /
 * deterministic given (seeds, hours). `hours` scales the simulated horizon for
 * both the memory and context phases (a 30h sim completes in ms).
 */
export function runEcosystem({ seeds = DEFAULT_SEEDS, hours } = {}) {
  const memCfg = hours ? { hours } : {};
  const ctxCfg = hours ? { hours } : {};

  // ── Phase 1: record/replay determinism ──
  const replay = runReplayInvariants();

  // ── Phase 2: memory, worst-of across seeds ──
  const memInv = runMemoryInvariants();
  let mpaMin = Infinity;
  let faaMin = Infinity;
  let famaMin = Infinity;
  let reductionMin = Infinity;
  let onDiagMin = Infinity;
  let leakageMax = 0;
  let provViolMax = 0;
  let twinAll = true;
  const memFps = [];
  const memPerSeed = [];
  for (const seed of seeds) {
    const session = runMemorySession(seed, memCfg);
    const m = computeMemoryMetrics(session);
    mpaMin = Math.min(mpaMin, m.MPA);
    faaMin = Math.min(faaMin, m.FAA);
    famaMin = Math.min(famaMin, m.FAMA);
    reductionMin = Math.min(reductionMin, m.recordReduction);
    onDiagMin = Math.min(onDiagMin, m.onDiagonalFraction);
    leakageMax = Math.max(leakageMax, m.crossTierLeakage);
    provViolMax = Math.max(provViolMax, m.provenanceViolations);
    twinAll = twinAll && m.twinReinforced;
    // determinism: same seed → identical stored surface.
    const fpA = memorySessionFingerprint(session);
    const fpB = memorySessionFingerprint(runMemorySession(seed, memCfg));
    memFps.push({ seed, fingerprint: fpA, stable: fpA === fpB });
    memPerSeed.push({ seed, MPA: m.MPA, FAA: m.FAA, FAMA: m.FAMA, recordReduction: m.recordReduction, finalRecords: m.finalRecords, rawRecords: m.rawRecords });
  }
  const memDeterministic = memFps.every((f) => f.stable);

  // ── Phase 3: context reservoir, worst-of across seeds ──
  const ctxInv = runContextInvariants();
  let slopeMax = 0;
  let utilMax = 0;
  let uwptMin = Infinity;
  let hoursToCollapseMin = Infinity;
  let ctxCollapsedAny = false;
  const ctxFps = [];
  const ctxPerSeed = [];
  for (const seed of seeds) {
    const run = runReservoir(seed, ctxCfg);
    const s = run.summary;
    slopeMax = Math.max(slopeMax, Math.abs(s.contextSlope));
    utilMax = Math.max(utilMax, s.maxUtil);
    uwptMin = Math.min(uwptMin, s.usefulWorkSlope);
    hoursToCollapseMin = Math.min(hoursToCollapseMin, s.hoursToCollapse);
    ctxCollapsedAny = ctxCollapsedAny || s.collapsed;
    const fpA = reservoirFingerprint(run);
    const fpB = reservoirFingerprint(runReservoir(seed, ctxCfg));
    ctxFps.push({ seed, fingerprint: fpA, stable: fpA === fpB });
    ctxPerSeed.push({ seed, contextSlope: s.contextSlope, maxUtil: s.maxUtil, hoursToCollapse: s.hoursToCollapse });
  }
  const ctxDeterministic = ctxFps.every((f) => f.stable);
  const knee = runReservoir(seeds[0], ctxCfg).cfg.kneeUtil;

  // Collapse-vs-context correlation (the forgetting-works signal) + coupled control.
  const collapseHealthy = collapseStudy(seeds, {}, {});
  const collapseCoupled = collapseStudy(seeds, {}, { coupled: true, ablation: { noOffload: true, noPrune: true } });

  // ── Phase 4: fleet (structure + coordination), worst-of across seeds ──
  const fleetInv = runFleetInvariants();
  let taxWorst = 0;
  let taxSum = 0;
  let fleetDeterministic = true;
  let maxConcurrencyMax = 0;
  const fleetPerSeed = [];
  for (const seed of seeds) {
    const run = runFleet(seed);
    taxWorst = Math.max(taxWorst, run.coordination.coordinationTax);
    taxSum += run.coordination.coordinationTax;
    maxConcurrencyMax = Math.max(maxConcurrencyMax, run.runaway.maxConcurrency);
    const fpA = fleetFingerprint(run);
    const fpB = fleetFingerprint(runFleet(seed));
    fleetDeterministic = fleetDeterministic && fpA === fpB;
    fleetPerSeed.push({ seed, coordinationTax: run.coordination.coordinationTax, conflicts: run.coordination.conflicts, repairCount: run.coordination.repairCount, compensations: run.coordination.compensations, managerCount: run.fleet.managerCount, treeChannels: run.fleet.treeChannels, meshChannels: run.fleet.meshChannels, fingerprint: fpA, stable: fpA === fpB });
  }
  const taxMean = round6(taxSum / seeds.length);

  // ── Phase 5: anomalies, worst-of + pass^k across the sweep ──
  const anomInv = runAnomalyInvariants();
  let anomaliesWorst = 0;
  let worstSeed = seeds[0];
  const anomalyByCategoryWorst = {};
  const anomalyPerSeed = [];
  for (const seed of seeds) {
    const a = detectAnomalies(runFleet(seed));
    if (a.total > anomaliesWorst) { anomaliesWorst = a.total; worstSeed = seed; }
    for (const [k, v] of Object.entries(a.byCategory)) anomalyByCategoryWorst[k] = Math.max(anomalyByCategoryWorst[k] ?? 0, v);
    anomalyPerSeed.push({ seed, anomalies: a.total, byCategory: a.byCategory });
  }
  // pass^k: k repeats of the whole scenario, ALL clean (deterministic → k
  // byte-identical replays; the point is determinism makes reliability provable).
  let cleanRuns = 0;
  const totalRuns = PASS_K * seeds.length;
  for (let k = 0; k < PASS_K; k++) for (const seed of seeds) if (detectAnomalies(runFleet(seed)).total === 0) cleanRuns += 1;
  const passK = round6(cleanRuns / totalRuns);
  // rule of three: 0 anomalies in N seeds ⇒ true anomaly rate < 3/N at 95%.
  const ruleOfThreeBound = round6(3 / seeds.length);

  // ── Phase 6: negative-control preflight (the crux) ──
  const preflight = runPreflight(seeds[0]);

  // ── Phase 7: the ablation (causal proof) ──
  const ablation = ablationStudy(seeds[Math.min(2, seeds.length - 1)]);

  const gateSelf = gateSelfTest();

  const scorecard = {
    correctness: {
      // Phase 1
      replayDeterministic: replay.fingerprintStable ? 1 : 0,
      replayNegativeControlsCaught: replay.negativeControlsCaught,
      // Phase 2
      memoryDeterministic: memDeterministic ? 1 : 0,
      memorySafetyViolations: memInv.safetyViolations,
      memoryNegativeControlsCaught: memInv.negativeControlsCaught,
      mpaHardGate: mpaMin === 1 ? 1 : 0, // MPA == 1.0 across every seed
      crossTierLeakage: leakageMax,
      provenanceViolations: provViolMax,
      twinReinforced: twinAll ? 1 : 0,
      routingOnDiagonalOk: onDiagMin >= DEFAULT_MEMORY_CONFIG.confusionThreshold ? 1 : 0,
      staleForgetOk: faaMin >= 0.9 ? 1 : 0,
      // Phase 3
      contextDeterministic: ctxDeterministic ? 1 : 0,
      contextSafetyViolations: ctxInv.safetyViolations,
      contextNegativeControlsCaught: ctxInv.negativeControlsCaught,
      contextBoundedOk: utilMax < knee ? 1 : 0,
      utilizationBelowKneeOk: utilMax < knee ? 1 : 0,
      collapseDecoupledOk: collapseHealthy.absPearson < collapseCoupled.absPearson && collapseHealthy.absPearson <= 0.4 ? 1 : 0,
      enduranceHeld: ctxCollapsedAny ? 0 : 1, // no collapse within the horizon
      // Phase 4 — fleet
      fleetDeterministic: fleetDeterministic ? 1 : 0,
      fleetSafetyViolations: fleetInv.safetyViolations,
      fleetNegativeControlsCaught: fleetInv.negativeControlsCaught,
      concurrencyCapHeld: maxConcurrencyMax <= 32 ? 1 : 0,
      // Phase 5 — anomalies (the absolute anomaly-0 gate + detector ratchet)
      anomalyFreeOk: anomaliesWorst === 0 ? 1 : 0, // worst-of-sweep anomalies == 0
      anomalySafetyViolations: anomInv.safetyViolations,
      anomalyNegativeControlsCaught: anomInv.negativeControlsCaught,
      // Phase 6 — pass^k + negative-control preflight
      passKAllClean: passK === 1 ? 1 : 0,
      preflightOk: preflight.ok ? 1 : 0,
      // Phase 7 — the ablation causal proof
      ablationCausalOk: ablation.causalOk ? 1 : 0,
      // Overall
      gateSelfTestPassed: gateSelf.passed ? 1 : 0,
    },
    performance: {
      // Phase 2 — higher-better (ratchet).
      famaWorst: round6(famaMin),
      faaWorst: round6(faaMin),
      recordReductionWorst: round6(reductionMin),
      // Phase 3 — lower-better plateau + correlation; higher-better endurance.
      contextSlopeMax: round6(slopeMax),
      maxUtilization: round6(utilMax),
      collapseContextCorr: collapseHealthy.absPearson,
      hoursToCollapseMin: round6(hoursToCollapseMin),
      usefulWorkSlopeWorst: round6(uwptMin),
      // Phase 4/5 — coordination token-tax (CoAgent target ≈ 1.15×) + reliability.
      coordinationTaxWorst: round6(taxWorst),
      coordinationTaxMean: taxMean,
      anomaliesWorst,
      passK,
      ruleOfThreeBound,
    },
    observed: {
      seeds,
      hours: hours ?? DEFAULT_MEMORY_CONFIG.hours,
      replay: { fingerprint: replay.fingerprint, results: replay.results },
      memory: { perSeed: memPerSeed, fingerprints: memFps, invariants: memInv.results },
      context: { perSeed: ctxPerSeed, fingerprints: ctxFps, knee, invariants: ctxInv.results, collapseHealthy, collapseCoupled },
      fleet: { perSeed: fleetPerSeed, invariants: fleetInv.results, maxConcurrency: maxConcurrencyMax },
      anomalies: { perSeed: anomalyPerSeed, worstSeed, byCategoryWorst: anomalyByCategoryWorst, invariants: anomInv.results, passK, ruleOfThreeBound },
      preflight,
      ablation,
    },
  };

  return {
    scorecard,
    replay,
    memory: memInv,
    context: ctxInv,
    fleet: fleetInv,
    anomalies: anomInv,
    preflight,
    ablation,
    collapseHealthy,
    collapseCoupled,
    gateSelfTest: gateSelf,
    fingerprint: fingerprint({ replay: replay.fingerprint, memFps, ctxFps, fleet: fleetPerSeed.map((f) => f.fingerprint), anomaliesWorst, passK, preflight: preflight.ok, ablation: ablation.causalOk }),
  };
}

// ─── metric contracts (the gate's rulebook) ─────────────────────────
//
// Correctness = absolute / zero-tolerance / blocking. The MPA hard gate is an
// exact 1. Performance = relative to the committed baseline (ratchet). Noisy /
// distributional signals (the collapse correlation) are reported, not gated —
// the DECOUPLING is asserted structurally by `collapseDecoupledOk` instead.

export const CONTRACTS = {
  // ── Phase 1 correctness ──
  'correctness.replayDeterministic': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.replayNegativeControlsCaught': { direction: 'exact', expected: 3, blocking: true, robust: true },
  // ── Phase 2 correctness ──
  'correctness.memoryDeterministic': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.memorySafetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.memoryNegativeControlsCaught': { direction: 'exact', expected: 8, blocking: true, robust: true },
  'correctness.mpaHardGate': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.crossTierLeakage': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.provenanceViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.twinReinforced': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.routingOnDiagonalOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.staleForgetOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  // ── Phase 3 correctness ──
  'correctness.contextDeterministic': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.contextSafetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.contextNegativeControlsCaught': { direction: 'exact', expected: 4, blocking: true, robust: true },
  'correctness.contextBoundedOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.utilizationBelowKneeOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.collapseDecoupledOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.enduranceHeld': { direction: 'exact', expected: 1, blocking: true, robust: true },
  // ── Phase 4 correctness (fleet) ──
  'correctness.fleetDeterministic': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.fleetSafetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.fleetNegativeControlsCaught': { direction: 'exact', expected: 7, blocking: true, robust: true },
  'correctness.concurrencyCapHeld': { direction: 'exact', expected: 1, blocking: true, robust: true },
  // ── Phase 5 correctness (anomalies — the absolute anomaly-0 gate + ratchet) ──
  'correctness.anomalyFreeOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.anomalySafetyViolations': { direction: 'exact', expected: 0, blocking: true, robust: true },
  'correctness.anomalyNegativeControlsCaught': { direction: 'exact', expected: 17, blocking: true, robust: true },
  // ── Phase 6 correctness (pass^k + preflight) ──
  'correctness.passKAllClean': { direction: 'exact', expected: 1, blocking: true, robust: true },
  'correctness.preflightOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  // ── Phase 7 correctness (ablation causal proof) ──
  'correctness.ablationCausalOk': { direction: 'exact', expected: 1, blocking: true, robust: true },
  // ── overall ──
  'correctness.gateSelfTestPassed': { direction: 'exact', expected: 1, blocking: true, robust: true },

  // ── performance (ratchet vs baseline) ──
  'performance.famaWorst': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.05 }, blocking: true, robust: true, hardCeiling: undefined },
  'performance.faaWorst': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.05 }, blocking: true, robust: true },
  'performance.recordReductionWorst': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.5 }, blocking: true, robust: true },
  'performance.contextSlopeMax': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 5 }, blocking: true, robust: true, hardCeiling: 50 },
  'performance.maxUtilization': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 0.05 }, blocking: true, robust: true, hardCeiling: 0.45 },
  // Reported-only (distributional / noisy) — the decoupling is gated structurally above.
  'performance.collapseContextCorr': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 0.15 }, blocking: false, robust: false },
  'performance.hoursToCollapseMin': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 1 }, blocking: false, robust: false },
  'performance.usefulWorkSlopeWorst': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 5e-5 }, blocking: false, robust: false },
  // Coordination token-tax: CoAgent target ≈ 1.15× — REPORTED (a coordination
  // design choice, not a pass/fail), with a hard ceiling so a runaway is caught.
  'performance.coordinationTaxWorst': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 0.1 }, blocking: false, robust: false, hardCeiling: 1.6 },
  // Anomalies worst-of + pass^k are gated structurally above (anomalyFreeOk /
  // passKAllClean); reported here as the headline reliability numbers too.
  'performance.anomaliesWorst': { direction: 'lower-better', tolerance: { kind: 'absolute', value: 0 }, blocking: true, robust: true, hardCeiling: 0 },
  'performance.passK': { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0 }, blocking: false, robust: false },
};

/** Run the gate over an ecosystem scorecard + committed baseline. */
export function judge(scorecard, baseline) {
  return runGate(scorecard, baseline, CONTRACTS);
}

function round6(x) {
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x;
}
