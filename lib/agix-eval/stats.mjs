// agix-eval/stats — decision-grade statistics for eval scores.
//
// Bare accuracy numbers without error bars are not decision-grade
// (Anthropic, "A statistical approach to model evals"). Every aggregate
// the harness reports carries a standard error and a 95% CI derived
// from the Central Limit Theorem: CI = mean ± 1.96·SEM.
//
// Reliability ≠ capability for stochastic agents (τ-bench): a 90%
// pass@1 agent is only ~57% reliable at pass^8. We expose both pass@k
// (best-of-k, capability) and pass^k (all-of-k, reliability).
//
// Grounding: wiki/research/2026-06-05-agent-evaluation-methodology.md §3.

const Z_95 = 1.959963984540054; // two-sided 95% normal quantile

/** Mean of a numeric array (0 for empty). */
export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Sample standard deviation (Bessel-corrected; 0 for n<2). */
export function stddev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/** Standard error of the mean. */
export function sem(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  return stddev(xs) / Math.sqrt(n);
}

/**
 * Mean with a 95% confidence interval (mean ± 1.96·SEM).
 * @returns {{ mean, sem, n, ci95: [lo, hi], half: number }}
 */
export function meanCI(xs) {
  const m = mean(xs);
  const s = sem(xs);
  const half = Z_95 * s;
  return { mean: m, sem: s, n: xs.length, ci95: [m - half, m + half], half };
}

/**
 * Clustered standard error. When observations arrive in correlated
 * groups (e.g. several cases drawn from one brief), the naive SEM
 * understates uncertainty — Anthropic reports up to ~3× inflation.
 * We compute the cluster-robust SEM by treating each cluster's mean as
 * the unit of analysis.
 * @param {Array<{value:number, cluster:string|number}>} rows
 */
export function clusteredMeanCI(rows) {
  const byCluster = new Map();
  for (const r of rows) {
    if (!byCluster.has(r.cluster)) byCluster.set(r.cluster, []);
    byCluster.get(r.cluster).push(r.value);
  }
  const clusterMeans = [...byCluster.values()].map(mean);
  const ci = meanCI(clusterMeans);
  // Overall point estimate is the grand mean over all observations,
  // but the interval width comes from between-cluster variance.
  const grand = mean(rows.map((r) => r.value));
  return { ...ci, mean: grand, clusters: byCluster.size };
}

/**
 * pass@k — unbiased estimator that at least one of k samples succeeds,
 * given n total samples of which c passed (Kulal et al. / HumanEval):
 *   pass@k = 1 − C(n−c, k) / C(n, k)
 * Returns NaN when n < k (don't inflate to 1.0).
 */
export function passAtK(n, c, k) {
  if (k > n) return NaN;
  if (n - c < k) return 1; // every k-subset contains a success
  // 1 − Π_{i=0..k-1} (n-c-i)/(n-i)   (numerically stable form)
  let prod = 1;
  for (let i = 0; i < k; i++) prod *= (n - c - i) / (n - i);
  return 1 - prod;
}

/**
 * pass^k — the agent succeeds on ALL k independent attempts. The
 * reliability metric (τ-bench): with per-attempt success rate p,
 * pass^k = p^k. Estimated from c successes out of n attempts.
 */
export function passPowK(n, c, k) {
  if (n === 0) return NaN;
  const p = c / n;
  return Math.pow(p, k);
}

/** Binomial proportion with a Wilson 95% interval (better at the tails). */
export function proportionCI(successes, total) {
  if (total === 0) return { p: 0, ci95: [0, 0], n: 0 };
  const p = successes / total;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return { p, ci95: [Math.max(0, centre - margin), Math.min(1, centre + margin)], n: total };
}

// ─── Learning-over-time metrics ──────────────────────────────────────
//
// Point-in-time eval measures a snapshot; an agent that LEARNS needs the
// time axis. These operate on a time-ordered metric series (oldest →
// newest) and stay error-barred so a noisy run doesn't read as a trend.
// Grounding: wiki/research/2026-06-06-dive-S3-learning-eval-harness.md.

/** Coerce a series of numbers or {value} objects to a number[]. */
function toValues(series) {
  return series.map((s) => (typeof s === 'number' ? s : s.value));
}

/**
 * Learning curve — ordinary-least-squares slope of a metric over its
 * (ordered) index, with the slope's standard error and 95% CI. Direction
 * is decided by whether the CI excludes zero, so flat-but-noisy series
 * read as 'plateau', not a false trend.
 * @returns {{ slope, intercept, slopeSE, ci95:[lo,hi], n, direction }}
 */
export function learningCurve(series) {
  const ys = toValues(series);
  const n = ys.length;
  if (n < 2) {
    return { slope: 0, intercept: ys[0] ?? 0, slopeSE: NaN, ci95: [NaN, NaN], n, direction: 'insufficient' };
  }
  const xs = ys.map((_, i) => i);
  const xbar = mean(xs);
  const ybar = mean(ys);
  let Sxy = 0;
  let Sxx = 0;
  for (let i = 0; i < n; i++) {
    Sxy += (xs[i] - xbar) * (ys[i] - ybar);
    Sxx += (xs[i] - xbar) * (xs[i] - xbar);
  }
  const slope = Sxx === 0 ? 0 : Sxy / Sxx;
  const intercept = ybar - slope * xbar;

  // Residual std → slope SE → CI. Needs n ≥ 3 for a residual dof.
  if (n < 3 || Sxx === 0) {
    const direction = slope > 0 ? 'improving' : slope < 0 ? 'regressing' : 'plateau';
    return { slope, intercept, slopeSE: NaN, ci95: [NaN, NaN], n, direction, lowConfidence: true };
  }
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i] - (intercept + slope * xs[i]);
    sse += resid * resid;
  }
  const slopeSE = Math.sqrt(sse / (n - 2) / Sxx);
  const half = Z_95 * slopeSE;
  const ci95 = [slope - half, slope + half];
  const direction = ci95[0] > 0 ? 'improving' : ci95[1] < 0 ? 'regressing' : 'plateau';
  return { slope, intercept, slopeSE, ci95, n, direction };
}

/**
 * Regression / catastrophic-forgetting gate. Compares `current` against a
 * moving baseline window and flags a regression only when the drop clears
 * `sigma` standard deviations — error-barred so normal variance doesn't
 * trip it. With a zero-variance baseline, any strict drop below the mean
 * regresses.
 * @returns {{ regressed, current, baselineMean, baselineStd, threshold, sigma, z, n }}
 */
export function regressionGate({ baseline = [], current, sigma = 2 }) {
  const n = baseline.length;
  const baselineMean = mean(baseline);
  const baselineStd = stddev(baseline);
  if (n === 0) {
    return { regressed: false, current, baselineMean: NaN, baselineStd: NaN, threshold: NaN, sigma, z: NaN, n, reason: 'no-baseline' };
  }
  const threshold = baselineMean - sigma * baselineStd;
  const regressed = baselineStd === 0 ? current < baselineMean - 1e-9 : current < threshold;
  const z = baselineStd === 0 ? (current < baselineMean ? -Infinity : 0) : (current - baselineMean) / baselineStd;
  return { regressed, current, baselineMean, baselineStd, threshold, sigma, z, n };
}

/**
 * Skill retention — did a metric measured at `before` persist (within
 * `tolerance`) at `after`? Catches silent forgetting of a skill after
 * intervening training on unrelated tasks.
 * @returns {{ before, after, delta, retained }}
 */
export function skillRetention({ before, after, tolerance = 0 }) {
  return { before, after, delta: after - before, retained: after >= before - tolerance };
}

export { Z_95 };
