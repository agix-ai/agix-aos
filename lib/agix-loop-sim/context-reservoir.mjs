// agix-loop-sim/context-reservoir — the leader's working-context reservoir +
// the 4 endurance hazards (blueprint §2). Pure/deterministic over a seeded
// step clock: no wall clock, no Math.random, no model / API / network. A "30h"
// horizon is SIMULATED-CLOCK time — it completes in milliseconds and spends
// zero tokens.
//
// GUARDS: the endurance properties of a single leader over a long horizon
// (ecosystem-sim/CONTEXT). The reservoir is:
//
//   C(t+1) = C(t) + inflow(t) − offload(t) − prune(t)
//
//   inflow  dominates (~100:1 in:out, ~50 tool calls/subtask) and carries
//           explicit DISTRACTOR tokens (context rot: even one distractor hurts).
//   offload passive capture writes the tool-result BODY to external memory and
//           leaves a lightweight REFERENCE in-context (RESTORABLE — keep the
//           pointer, drop the body).
//   prune   context-editing clears stale tool results older than a window.
//
// Rot-knee: per-step success p_step = p0·g(C)·h(distractor_fraction), where g
// is flat until a knee (~40–50% window utilization) then falls — so the model
// REWARDS PRUNING, not just offloading (offload alone still lets the window
// fill).
//
// The 4 failure modes are SEPARATE hazard functions — offload/forgetting fixes
// only the first two require distinct guardrails:
//   context-rot     → fixed by offload + prune       (reservoir + rot-knee)
//   goal-drift      → fixed by recite()              (re-inject the goal)
//   compounding-err → fixed by verify()              (reset dependent-step ε)
//   planning-err    → fixed by replan()              (checkpoint refresh)
//
// Vending-Bench warning: collapse is UNCORRELATED with context-buffer fill
// (r≈0.167) — running out of context is NOT what breaks agents; coherence loss
// is. So we compute hoursToCollapse AND report its correlation with context
// fill: if forgetting works, the two DECOUPLE (low |r|) — that decoupling is
// itself the headline "forgetting-works" signal.

import { makePrng } from './prng.mjs';
import { fingerprint } from './record-replay.mjs';

export const DEFAULT_CONTEXT_CONFIG = {
  hours: 30, // simulated-clock horizon
  stepsPerHour: 10, // subtasks per simulated hour (each ~50 tool calls)
  windowTokens: 200_000, // the leader's context window
  kneeUtil: 0.45, // rot-knee at ~45% utilization
  hardCeilingUtil: 0.95, // absolute window ceiling

  // inflow — tool-result bodies per subtask (~100:1 in:out; inflow dominates).
  inflowMean: 6000,
  inflowJitter: 400,
  distilledSummary: 400, // the leader's own working note kept in-context
  distractorFraction: 0.18, // fraction of inflow that is distractor tokens

  // offload — bodies go to external memory, a small ref stays (restorable).
  refTokens: 150,
  // prune — clear tool results older than this many steps.
  pruneWindow: 20,

  // rot-knee shape.
  p0: 0.98,
  gSlope: 1.6, // post-knee decline of g(C)
  hSlope: 0.5, // distractor penalty in h(δ)

  // hazard 2 — goal drift (recitation resets it).
  driftRate: 0.02,
  reciteInterval: 8,
  // hazard 3 — compounding error (verification resets ε).
  eps0: 0.01,
  compoundRate: 0.012,
  compoundGrowth: 1.06,
  verifyInterval: 10,
  // hazard 4 — planning error (re-planning checkpoint resets it).
  planRate: 0.02,
  replanInterval: 12,

  // collapse: productive action has stopped once productiveProb stays below
  // the floor for `collapseRun` consecutive steps.
  collapseFloor: 0.35,
  collapseRun: 3,

  // residual: a small permanent degradation each fix-cycle that the periodic
  // reset does NOT fully clear. 0 for the endurance run (no collapse in 30h);
  // seed-jittered > 0 in the correlation study so collapses occur at varying
  // hours while context stays bounded.
  residualRate: 0,
};

// ─── rot-knee factors ────────────────────────────────────────────────

/** g(C): flat (=1) up to the knee, then declines with utilization (U-shaped). */
export function rotGain(util, cfg) {
  if (util <= cfg.kneeUtil) return 1;
  return Math.max(0, 1 - cfg.gSlope * (util - cfg.kneeUtil));
}

/** h(δ): per-step success penalty from the distractor fraction. */
export function distractorGain(distractorFraction, cfg) {
  return Math.max(0, 1 - cfg.hSlope * distractorFraction);
}

// ─── the 4 hazards as separate coherence factors ────────────────────

/** Goal-drift coherence — falls with steps since the goal was last recited. */
export function goalDriftFactor(stepsSinceRecite, residual, cfg) {
  return Math.exp(-(cfg.driftRate * stepsSinceRecite + residual));
}

/** Compounding-error coherence — 1 − ε, where ε compounds until verify() resets it. */
export function compoundingFactor(epsilon) {
  return Math.max(0, 1 - epsilon);
}

/** Planning-error coherence — falls with steps since the last re-plan. */
export function planningFactor(stepsSinceReplan, residual, cfg) {
  return Math.exp(-(cfg.planRate * stepsSinceReplan + residual));
}

// ─── one deterministic reservoir run ────────────────────────────────

/**
 * Simulate the reservoir + hazards over the horizon. Pure given (seed, config,
 * flags). `flags.noOffload` / `flags.noPrune` are the ablations. Returns the
 * per-step trace plus a summary (plateau slope, max utilization, hours to
 * collapse, useful-work-per-token slope, context-fill signal).
 */
export function runReservoir(seed, config = {}, flags = {}) {
  const cfg = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  const prng = makePrng((seed >>> 0) ^ 0x51ed270b);
  const steps = Math.round(cfg.hours * cfg.stepsPerHour);
  const offload = !flags.noOffload;
  const prune = !flags.noPrune;

  // Sliding record of in-context contributions (signal + distractor tokens).
  const live = [];
  const trace = [];

  let stepsSinceRecite = 0;
  let stepsSinceReplan = 0;
  let epsilon = cfg.eps0;
  let residualGoal = 0;
  let residualPlan = 0;
  let collapseRun = 0;
  let collapseStep = -1;

  for (let t = 0; t < steps; t++) {
    // ── inflow ──
    const gross = Math.max(1, Math.round(cfg.inflowMean + prng.gaussian(0, cfg.inflowJitter)));
    const distract = Math.round(cfg.distractorFraction * gross);
    // ── offload ── bodies → memory, a small ref stays (restorable); distractor
    // bodies are offloaded too, so the distractor fraction stays low.
    const signalRetained = offload ? cfg.refTokens + cfg.distilledSummary : gross - distract + cfg.distilledSummary;
    const distractRetained = offload ? Math.round(cfg.distractorFraction * cfg.refTokens) : distract;
    live.push({ t, signal: signalRetained, distract: distractRetained });

    // ── prune ── context-editing clears tool results older than the window.
    if (prune) {
      while (live.length && live[0].t < t - cfg.pruneWindow) live.shift();
    }

    // ── reservoir level ──
    let C = 0;
    let distractTokens = 0;
    for (const e of live) {
      C += e.signal + e.distract;
      distractTokens += e.distract;
    }
    const util = C / cfg.windowTokens;
    const distractorFraction = C > 0 ? distractTokens / C : 0;

    // ── periodic fixes (recite / verify / replan) with residual leakage ──
    const recited = t > 0 && t % cfg.reciteInterval === 0;
    const verified = t > 0 && t % cfg.verifyInterval === 0;
    const replanned = t > 0 && t % cfg.replanInterval === 0;
    if (recited) {
      stepsSinceRecite = 0;
      residualGoal += cfg.residualRate;
    } else {
      stepsSinceRecite += 1;
    }
    if (verified) {
      epsilon = cfg.eps0 + cfg.residualRate; // verify resets ε (minus a residual)
    } else {
      epsilon = (epsilon + cfg.compoundRate) * cfg.compoundGrowth;
    }
    if (replanned) {
      stepsSinceReplan = 0;
      residualPlan += cfg.residualRate;
    } else {
      stepsSinceReplan += 1;
    }

    // ── per-step productive probability ──
    const g = rotGain(util, cfg);
    const h = distractorGain(distractorFraction, cfg);
    const pStep = cfg.p0 * g * h;
    const cGoal = goalDriftFactor(stepsSinceRecite, residualGoal, cfg);
    const cErr = compoundingFactor(epsilon);
    const cPlan = planningFactor(stepsSinceReplan, residualPlan, cfg);
    const productiveProb = round6(pStep * cGoal * cErr * cPlan);

    // useful work per token, expressed per 1K in-context tokens (a scale where
    // the trend is resolvable): productive probability per 1000 tokens held.
    const usefulWorkPerToken = round6((1000 * productiveProb) / Math.max(1, C));

    if (productiveProb < cfg.collapseFloor) {
      collapseRun += 1;
      if (collapseRun >= cfg.collapseRun && collapseStep < 0) collapseStep = t;
    } else {
      collapseRun = 0;
    }

    trace.push({ t, C: Math.round(C), util: round6(util), distractorFraction: round6(distractorFraction), pStep: round6(pStep), cGoal: round6(cGoal), cErr: round6(cErr), cPlan: round6(cPlan), productiveProb, usefulWorkPerToken });
  }

  // ── summary ── measured post-warmup (after the sliding window fills).
  const warm = Math.min(cfg.pruneWindow + 1, Math.floor(steps / 2));
  const post = trace.slice(warm);
  const cSlope = regressionSlope(post.map((r, i) => [i, r.C]));
  const uwptSlope = regressionSlope(post.map((r, i) => [i, r.usefulWorkPerToken]));
  const maxUtil = Math.max(...post.map((r) => r.util));
  const meanUtil = post.reduce((s, r) => s + r.util, 0) / post.length;
  const finalC = trace[trace.length - 1].C;
  const hoursToCollapse = collapseStep < 0 ? cfg.hours : round6(collapseStep / cfg.stepsPerHour);
  const collapsed = collapseStep >= 0;

  return {
    seed,
    cfg,
    flags,
    trace,
    steps,
    summary: {
      contextSlope: round6(cSlope), // tokens/step; ≈0 = plateau (the win)
      usefulWorkSlope: round6(uwptSlope),
      maxUtil: round6(maxUtil),
      meanUtil: round6(meanUtil),
      finalC,
      contextFill: round6(maxUtil), // the fill signal correlated against collapse
      hoursToCollapse,
      collapsed,
    },
  };
}

// ─── invariants (checker + probe + negative control) ────────────────

/** C(t) is bounded: the post-warmup plateau slope is ≈ 0 (not growth to the knee). */
export function contextBoundedChecker(seed, cfg, flags, { slopeTol = 8 } = {}) {
  const r = runReservoir(seed, cfg, flags);
  const ok = Math.abs(r.summary.contextSlope) <= slopeTol && r.summary.maxUtil < r.cfg.kneeUtil;
  return { ok, violations: ok ? [] : [{ contextSlope: r.summary.contextSlope, maxUtil: r.summary.maxUtil }], detail: `slope ${r.summary.contextSlope} tok/step, maxUtil ${r.summary.maxUtil}`, summary: r.summary };
}

/** Utilization stays below the rot-knee (not merely below the hard ceiling). */
export function utilizationBelowKneeChecker(seed, cfg, flags) {
  const r = runReservoir(seed, cfg, flags);
  const ok = r.summary.maxUtil < r.cfg.kneeUtil;
  return { ok, violations: ok ? [] : [{ maxUtil: r.summary.maxUtil, knee: r.cfg.kneeUtil }], detail: `maxUtil ${r.summary.maxUtil} vs knee ${r.cfg.kneeUtil}`, summary: r.summary };
}

/** Useful-work-per-token is flat or improving (post-warmup slope ≥ −tol). */
export function usefulWorkChecker(seed, cfg, flags, { tol = 5e-5 } = {}) {
  const r = runReservoir(seed, cfg, flags);
  const ok = r.summary.usefulWorkSlope >= -tol;
  return { ok, violations: ok ? [] : [{ usefulWorkSlope: r.summary.usefulWorkSlope }], detail: `useful-work slope ${r.summary.usefulWorkSlope}`, summary: r.summary };
}

// ─── the collapse-vs-context-fill correlation study ─────────────────

/**
 * Run a seed sweep in which collapses actually occur (seed-jittered residual
 * degradation) and correlate context-fill with hoursToCollapse. If forgetting
 * works (offload+prune ON, context bounded), the two DECOUPLE → low |r| — the
 * Vending-Bench "forgetting-works" signal (they measured r≈0.167). `flags`
 * ablations (no offload/prune) reproduce the COUPLED regime → high |r|.
 */
export function collapseStudy(seeds, config = {}, flags = {}) {
  const base = { hours: 200, ...config }; // long enough that residual wins
  const pairs = [];
  for (const seed of seeds) {
    const prng = makePrng((seed >>> 0) ^ 0x2545f491);
    // Independent per-seed draws so any residual correlation is a property of
    // the DYNAMICS, not shared seed structure. In the healthy regime context
    // fill is set by the leader's scratchpad size (`distilledSummary`) — which,
    // under offload, is what varies the plateau height independently of load —
    // while collapse timing is set by the residual degradation rate. The two
    // are drawn from independent positions in the stream → uncorrelated inputs.
    const inflowMean = Math.round(5200 + prng.range(0, 1600));
    const distilledSummary = Math.round(300 + prng.range(0, 320));
    const residualRate = flags.coupled ? 0 : round6(0.006 + prng.range(0, 0.01));
    const cfg = { ...base, inflowMean, distilledSummary, residualRate };
    const r = runReservoir(seed, cfg, flags.ablation ?? {});
    pairs.push({ seed, contextFill: r.summary.contextFill, hoursToCollapse: r.summary.hoursToCollapse, collapsed: r.summary.collapsed });
  }
  const r = pearson(pairs.map((p) => p.contextFill), pairs.map((p) => p.hoursToCollapse));
  return { pairs, pearson: round6(r), absPearson: round6(Math.abs(r)) };
}

export const CONTEXT_INVARIANTS = [
  {
    id: 'CTX-1-context-bounded',
    hypothesis: 'C(t) plateaus (post-warmup slope ≈ 0) rather than growing toward the rot-knee.',
    check() {
      return contextBoundedChecker(1, {}, {});
    },
    negativeControl() {
      // No offload + no prune → the reservoir grows without bound.
      return contextBoundedChecker(1, {}, { noOffload: true, noPrune: true });
    },
  },
  {
    id: 'CTX-2-utilization-below-knee',
    hypothesis: 'Peak window utilization stays below the rot-knee (not merely below the hard ceiling).',
    check() {
      return utilizationBelowKneeChecker(2, {}, {});
    },
    negativeControl() {
      return utilizationBelowKneeChecker(2, {}, { noOffload: true });
    },
  },
  {
    id: 'CTX-3-useful-work-nondeclining',
    hypothesis: 'Useful-work-per-token is flat or improving over the horizon.',
    check() {
      return usefulWorkChecker(3, {}, {});
    },
    negativeControl() {
      // No prune → the window fills steadily while per-step work stays flat, so
      // useful-work-PER-TOKEN declines. (The full no-offload+no-prune ablation
      // collapses so fast that work/token floors at 0 — flat, not declining — so
      // this milder ablation is the honest control for the slope property.)
      return usefulWorkChecker(3, {}, { noPrune: true });
    },
  },
  {
    id: 'CTX-4-collapse-decoupled-from-context',
    hypothesis: 'When forgetting works, collapse timing decouples from context fill (|r| below threshold).',
    check() {
      const study = collapseStudy([1, 2, 3, 4, 5, 6, 7, 8], {}, {});
      const ok = study.absPearson <= CORR_THRESHOLD && study.pairs.every((p) => p.collapsed);
      return { ok, violations: ok ? [] : [{ absPearson: study.absPearson, allCollapsed: study.pairs.every((p) => p.collapsed) }], detail: `|r| ${study.absPearson} (Vending-Bench ≈0.167)`, study };
    },
    negativeControl() {
      // Coupled regime: no offload/prune → collapse IS driven by context fill.
      const study = collapseStudy([1, 2, 3, 4, 5, 6, 7, 8], {}, { coupled: true, ablation: { noOffload: true, noPrune: true } });
      const ok = study.absPearson <= CORR_THRESHOLD;
      return { ok, violations: ok ? [] : [{ absPearson: study.absPearson }], detail: `coupled |r| ${study.absPearson}`, study };
    },
  },
];

export const CORR_THRESHOLD = 0.4;

/**
 * Run every context invariant + its negative control. Aggregate shape mirrors
 * the other phases so the scorecard consumes it uniformly.
 */
export function runContextInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const inv of CONTEXT_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    if (!pos.ok) safetyViolations += Math.max(1, pos.violations.length);
    if (!neg.ok) negativeControlsCaught += 1;
    results.push({ id: inv.id, hypothesis: inv.hypothesis, checkOk: pos.ok, negativeControlCaught: !neg.ok, detail: pos.detail });
  }
  return { safetyViolations, negativeControlsCaught, invariantsTotal: CONTEXT_INVARIANTS.length, results };
}

/** Fingerprint a reservoir run's trace (determinism gate). */
export function reservoirFingerprint(run) {
  return fingerprint({ trace: run.trace, summary: run.summary });
}

// ─── small deterministic stats helpers ──────────────────────────────

/** Ordinary-least-squares slope of [x, y] points. 0 for < 2 points. */
export function regressionSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sxy - sx * sy) / denom;
}

/** Pearson correlation. 0 when either series has ~no variance. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx < 1e-12 || vy < 1e-12) return 0;
  return cov / Math.sqrt(vx * vy);
}

function round6(x) {
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x;
}
