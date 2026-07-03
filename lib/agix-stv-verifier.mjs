// agix-stv-verifier — Phase 2 self-trained verifier (G10).
//
// V_0 is a feature-based logistic-regression scalar verifier trained on
// the bootstrap labels. Deterministic, dependency-free, auditable
// (rationale = top-weighted contributing features). This is the plan's
// named "scalar-head PRM fallback", chosen as the first *executable*
// proof; the generative LLM-judge variant stays documented in the plan.
//
// OWNED BY: Phase 2 agent. Fill the bodies; keep the signatures frozen.
//
// Determinism requirements (the eval depends on these):
//   - No RNG, or a fixed-seed RNG only. Gradient descent with fixed
//     iterations/learning-rate and zero-initialised weights is fine.
//   - Standardize features with train-set mean/std; store in the model
//     so scoreFinding() reproduces the transform at inference.

import { resolveFinding } from './agix-stv-deploy-health.mjs';

/** @type {import('@agix/types').VerifierThresholds} */
export const DEFAULT_THRESHOLDS = {
  gate: { minAgreement: 0.7, maxCalibrationError: 0.2 },
  decision: { emit: 0.6, revise: 0.4 },
};

/**
 * Deterministic numeric features for a (snapshot, finding) pair. The
 * `history` lets you compute cross-cycle features (e.g. how many prior
 * consecutive cycles this finding key has already appeared). Return a
 * STABLE, FIXED-ORDER feature list (same names every call).
 * Suggested features (extend as useful):
 *   sev_critical, sev_warn, cat_ci_failing, cat_deploy_skipped,
 *   cat_apphosting_gap, cat_apphosting_rollout_failed,
 *   ci_fail_streak (norm), apphosting_gap (norm), rollout_state_bad,
 *   persisted_cycles (norm).
 * @returns {import('@agix/types').FeatureVector}
 */
const FEATURE_NAMES = [
  'sev_critical',
  'sev_warn',
  'cat_ci_failing',
  'cat_deploy_skipped',
  'cat_apphosting_gap',
  'cat_apphosting_rollout_failed',
  'ci_fail_streak_norm',
  'apphosting_gap_norm',
  'rollout_state_bad',
  'persisted_cycles_norm',
];

export function extractFeatures(snapshot, finding, history = []) {
  const sev = finding?.severity;
  const cat = finding?.category;

  // Leading consecutive 'failure' conclusions among CI runs, from the top.
  const runs = snapshot?.ci?.runs ?? [];
  let ciStreak = 0;
  for (const r of runs) {
    if (r.workflowName === 'CI' || r.name === 'CI') {
      if (r.conclusion === 'failure') ciStreak += 1;
      else break;
    } else {
      break;
    }
  }

  const gap = snapshot?.appHosting?.gap || 0;
  const rolloutState = snapshot?.appHosting?.latestRolloutState;
  const rolloutBad = rolloutState && !/SUCCEEDED/.test(rolloutState) ? 1 : 0;

  // Count snapshots up to AND including the one matching snapshot.runId
  // whose findings contain finding.key. Default to 1 if key absent.
  let persisted = 0;
  const key = finding?.key;
  if (key != null) {
    for (const snap of history) {
      const hit = (snap.findings || []).some((f) => f.key === key);
      if (hit) persisted += 1;
      if (snap.runId === snapshot?.runId) break;
    }
  }
  if (persisted === 0) persisted = 1;

  const values = [
    sev === 'critical' ? 1 : 0,
    sev === 'warn' ? 1 : 0,
    cat === 'ci-failing' ? 1 : 0,
    cat === 'deploy-skipped' ? 1 : 0,
    cat === 'apphosting-gap' ? 1 : 0,
    cat === 'apphosting-rollout-failed' ? 1 : 0,
    Math.min(ciStreak / 5, 1),
    Math.min(gap / 10, 1),
    rolloutBad,
    Math.min(persisted / 5, 1),
  ];

  return { names: [...FEATURE_NAMES], values };
}

/**
 * Train V_n from a LabeledCorpus. Uses corpus.training (drop label===0
 * abstentions; map +1→1, -1→0 for the logistic target), extracting
 * features by resolving each label back to its (snapshot, finding) via
 * resolveFinding(history, ...). Then evaluates the anchor gate on
 * corpus.anchor and sets anchorScores (incl. gatePassed).
 * @param {import('@agix/types').LabeledCorpus} corpus
 * @param {import('@agix/types').DeployHealthSnapshot[]} history
 * @param {{ version: string, thresholds?: import('@agix/types').VerifierThresholds, parentVersion?: string|null }} opts
 * @returns {import('@agix/types').VerifierVersion}
 */
export function trainVerifier(corpus, history, { version, thresholds = DEFAULT_THRESHOLDS, parentVersion = null } = {}) {
  const training = corpus?.training ?? [];

  // Corpus-level label mix (over all training labels, before resolution).
  const labelMix = { pos: 0, neg: 0, abstain: 0 };
  for (const l of training) {
    if (l.label === 1) labelMix.pos += 1;
    else if (l.label === -1) labelMix.neg += 1;
    else labelMix.abstain += 1;
  }

  // Build examples: drop abstentions, resolve to (snapshot, finding).
  const xs = [];
  const ys = [];
  for (const l of training) {
    if (l.label === 0) continue;
    const resolved = resolveFinding(history, l.runId, l.findingKey);
    if (!resolved) continue;
    const fv = extractFeatures(resolved.snapshot, resolved.finding, history);
    xs.push(fv.values);
    ys.push(l.label === 1 ? 1 : 0);
  }

  const nFeatures = FEATURE_NAMES.length;
  const n = xs.length;

  // Zero-example fallback: zero-weight model, abstain anchorScores.
  if (n === 0) {
    const model = {
      type: 'logreg',
      weights: new Array(nFeatures).fill(0),
      bias: 0,
      featureNames: [...FEATURE_NAMES],
      standardization: {
        mean: new Array(nFeatures).fill(0),
        std: new Array(nFeatures).fill(1),
      },
    };
    return {
      envelope: 'agent.verifier.version.v1',
      version,
      trainedAt: new Date().toISOString(),
      model,
      trainCorpus: { size: 0, labelMix: { pos: 0, neg: 0, abstain: 0 } },
      anchorScores: evaluateAnchorGate(model, corpus?.anchor ?? [], history, thresholds),
      thresholds,
      parentVersion,
    };
  }

  // Standardize per-feature with train mean/std (std===0 => 1).
  const mean = new Array(nFeatures).fill(0);
  const std = new Array(nFeatures).fill(0);
  for (let j = 0; j < nFeatures; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += xs[i][j];
    mean[j] = sum / n;
  }
  for (let j = 0; j < nFeatures; j++) {
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const d = xs[i][j] - mean[j];
      sq += d * d;
    }
    const variance = sq / n;
    const s = Math.sqrt(variance);
    std[j] = s === 0 ? 1 : s;
  }

  const standardized = xs.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));

  // Logistic regression, full-batch gradient descent. Deterministic.
  const weights = new Array(nFeatures).fill(0);
  let bias = 0;
  const learningRate = 0.1;
  const iterations = 2000;
  const l2 = 1e-3;

  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < nFeatures; j++) z += weights[j] * standardized[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - ys[i];
      for (let j = 0; j < nFeatures; j++) gradW[j] += err * standardized[i][j];
      gradB += err;
    }
    for (let j = 0; j < nFeatures; j++) {
      const grad = gradW[j] / n + l2 * weights[j];
      weights[j] -= learningRate * grad;
    }
    bias -= learningRate * (gradB / n);
  }

  const model = {
    type: 'logreg',
    weights,
    bias,
    featureNames: [...FEATURE_NAMES],
    standardization: { mean, std },
  };

  return {
    envelope: 'agent.verifier.version.v1',
    version,
    trainedAt: new Date().toISOString(),
    model,
    trainCorpus: { size: n, labelMix },
    anchorScores: evaluateAnchorGate(model, corpus?.anchor ?? [], history, thresholds),
    thresholds,
    parentVersion,
  };
}

/**
 * Apply a trained model to a (snapshot, finding): standardize with the
 * model's stored transform and return logistic score + standardized vector.
 * @returns {{ score: number, standardized: number[], contributions: number[] }}
 */
function _scoreModel(model, snapshot, finding, history = []) {
  const fv = extractFeatures(snapshot, finding, history);
  const { mean, std } = model.standardization;
  const standardized = fv.values.map((v, j) => (v - mean[j]) / std[j]);
  let z = model.bias;
  const contributions = new Array(standardized.length);
  for (let j = 0; j < standardized.length; j++) {
    const c = model.weights[j] * standardized[j];
    contributions[j] = c;
    z += c;
  }
  const score = 1 / (1 + Math.exp(-z));
  return { score, standardized, contributions };
}

/**
 * Score a single finding with a trained verifier. Reproduces the model's
 * standardization, applies the logistic, and returns a 0..1 score plus a
 * short rationale naming the top contributing features.
 * @returns {{ score: number, rationale: string }}
 */
export function scoreFinding(verifierVersion, snapshot, finding, history = []) {
  const model = verifierVersion.model;
  const { score, contributions } = _scoreModel(model, snapshot, finding, history);

  // Top-3 features by absolute contribution (|weight * standardizedValue|).
  const ranked = contributions
    .map((c, j) => ({ name: model.featureNames[j], c }))
    .filter((e) => e.c !== 0)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 3);

  let rationale;
  if (ranked.length === 0) {
    // No non-zero contributions: name the bias direction so rationale is
    // never empty.
    rationale = `bias${model.bias >= 0 ? '↑' : '↓'}`;
  } else {
    rationale = ranked.map((e) => `${e.name}${e.c >= 0 ? '↑' : '↓'}`).join(', ');
  }

  return { score, rationale };
}

/**
 * Agreement + calibration of a model against held-out human anchors.
 * agreement = fraction where (score>=0.5) matches (anchor.label===1),
 * over anchors with label !== 0. calibrationError = mean |score - y|
 * (expected-calibration-style absolute error is also acceptable; state
 * which in code). gatePassed = agreement>=gate.minAgreement &&
 * calibrationError<=gate.maxCalibrationError. When there are no usable
 * anchors, return n:0, gatePassed:false.
 * @returns {import('@agix/types').AnchorScores}
 */
export function evaluateAnchorGate(model, anchorLabels, history, thresholds = DEFAULT_THRESHOLDS) {
  const gate = (thresholds ?? DEFAULT_THRESHOLDS).gate;

  let agreementHits = 0;
  let calibSum = 0;
  let n = 0;
  for (const a of anchorLabels ?? []) {
    if (a.label === 0) continue;
    const resolved = resolveFinding(history, a.runId, a.findingKey);
    if (!resolved) continue;
    const { score } = _scoreModel(model, resolved.snapshot, resolved.finding, history);
    const y = a.label === 1 ? 1 : 0;
    if ((score >= 0.5) === (a.label === 1)) agreementHits += 1;
    calibSum += Math.abs(score - y);
    n += 1;
  }

  if (n === 0) {
    return { agreement: 0, calibrationError: 1, n: 0, gatePassed: false };
  }

  const agreement = agreementHits / n;
  const calibrationError = calibSum / n;
  const gatePassed =
    n > 0 && agreement >= gate.minAgreement && calibrationError <= gate.maxCalibrationError;

  return { agreement, calibrationError, n, gatePassed };
}
