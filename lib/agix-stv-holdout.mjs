// agix-stv-holdout — the model-free held-out generalization metric (G10 / S1).
//
// This is the reusable core of "does verifier-gated emission beat unfiltered
// emission on a DISJOINT test split?" — the provable generalization number the
// plan demands WITHOUT any model in the loop (V_0 is the deterministic
// logistic-regression head). Extracted verbatim from scripts/stv-eval.mjs so
// the offline server (services/stv-trainer) and the eval harness share ONE
// implementation and can never silently diverge.
//
// Pure: no RNG, no network, no filesystem. Deterministic in its inputs.

import { gateFindings } from './agix-stv-gate.mjs';
import { labelDeployHealthExecution } from './agix-stv-labeler.mjs';

/**
 * Precision / recall / F1 of a predicted-positive key set against the
 * execution-grounded truth labels (label===1 is the positive class).
 * @param {Set<string>} predictedPos
 * @param {Map<string, number>} truthByKey  findingKey → +1/-1/0
 */
export function prf(predictedPos, truthByKey) {
  let tp = 0;
  let fp = 0;
  let totalPos = 0;
  for (const [, label] of truthByKey) if (label === 1) totalPos += 1;
  for (const key of predictedPos) {
    if (truthByKey.get(key) === 1) tp += 1;
    else fp += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = totalPos === 0 ? 0 : tp / totalPos;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, emitted: predictedPos.size, totalPos };
}

/**
 * Run the gate over every episode's FIRST snapshot in `history` and collect
 * the keys it emits, plus revise-budget telemetry. The decision at emit time
 * is taken on the first snapshot the finding key appears in.
 * @param {import('@agix/types').VerifierVersion} verifier
 * @param {import('@agix/types').DeployHealthSnapshot[]} history
 * @param {import('@agix/types').VerifierThresholds} thresholds
 */
export function evaluateGated(verifier, history, thresholds) {
  const predPos = new Set();
  const seen = new Set();
  let reviseCount = 0;
  let maxRevise = 0;
  for (const s of history) {
    for (const f of s.findings) {
      if (f.key == null || seen.has(f.key)) continue;
      const firstSnap = history.find((x) => x.findings.some((y) => y.key === f.key));
      if (firstSnap !== s) continue;
      seen.add(f.key);
      const res = gateFindings(verifier, s, history, { thresholds });
      const revises = res.scores.filter((sc) => sc.decision === 'revise').length;
      reviseCount += revises;
      maxRevise = Math.max(maxRevise, revises);
      if (res.emitted.some((e) => e.key === f.key)) predPos.add(f.key);
    }
  }
  return { predPos, reviseCount, maxRevise };
}

/** Universe of gradable keys present in a history (each counted once). */
export function allKeys(history) {
  const keys = new Set();
  for (const s of history) for (const f of s.findings) if (f.key != null) keys.add(f.key);
  return keys;
}

/**
 * Select the emit/revise decision band on the VALIDATION split by sweeping a
 * grid and maximizing F1. The test split is never touched here — this is
 * standard operating-point selection.
 * @param {import('@agix/types').VerifierVersion} verifier
 * @param {import('@agix/types').DeployHealthSnapshot[]} valHistory
 */
export function selectOperatingThreshold(verifier, valHistory) {
  const truth = new Map(labelDeployHealthExecution(valHistory).map((l) => [l.findingKey, l.label]));
  let best = { emit: 0.5, revise: 0.3, f1: -1 };
  for (let emit = 0.3; emit <= 0.85 + 1e-9; emit += 0.05) {
    const revise = Math.max(0.2, emit - 0.2);
    const thresholds = { gate: verifier.thresholds.gate, decision: { emit, revise } };
    const { predPos } = evaluateGated(verifier, valHistory, thresholds);
    const { f1 } = prf(predPos, truth);
    if (f1 > best.f1) best = { emit: Number(emit.toFixed(2)), revise: Number(revise.toFixed(2)), f1 };
  }
  return { gate: verifier.thresholds.gate, decision: { emit: best.emit, revise: best.revise }, valF1: best.f1 };
}

/**
 * The held-out generalization number, end to end and model-free: tune the
 * operating point on the validation split, then compare verifier-gated vs
 * unfiltered finding emission on the DISJOINT test split against the
 * execution-grounded truth. This is the single function the offline server
 * and the eval harness both call.
 *
 * @param {import('@agix/types').VerifierVersion} verifier  a trained V_n
 * @param {{ valHistory: import('@agix/types').DeployHealthSnapshot[], testHistory: import('@agix/types').DeployHealthSnapshot[] }} splits
 * @returns {{ tuned: object, gated: object, unfiltered: object, f1Delta: number, reviseCount: number, maxRevisePerFinding: number }}
 */
export function computeHoldoutGeneralization(verifier, { valHistory, testHistory }) {
  const tuned = selectOperatingThreshold(verifier, valHistory);
  const testTruth = new Map(labelDeployHealthExecution(testHistory).map((l) => [l.findingKey, l.label]));
  const { predPos: gatedPos, reviseCount, maxRevise: maxRevisePerFinding } = evaluateGated(verifier, testHistory, tuned);
  const allPos = allKeys(testHistory);
  const gated = prf(gatedPos, testTruth);
  const unfiltered = prf(allPos, testTruth);
  const f1Delta = gated.f1 - unfiltered.f1;
  return { tuned, gated, unfiltered, f1Delta, reviseCount, maxRevisePerFinding };
}
