// agix-loop-sim/scenarios — synthetic scenario generator.
//
// GUARDS: "loop tuning was validated against live data we can't replay"
// (loop-sim/SYNTHETIC). All tuning of the efficiency + trust modules runs
// against SYNTHETIC streams generated here — deterministic, CI-safe, and
// free of any real ledger. A scenario is two correlated streams:
//
//   ledger[]   — model-call cost records (real buildLedgerEntry shape)
//   outcomes[] — run-outcome events, joined to the ledger by call_id
//
// Every value is drawn from a mulberry32 stream (prng.mjs) and every
// timestamp comes from a SEEDED clock — never Date.now(). Identical
// (seed, config) => byte-identical streams.
//
// Named PLANTED-VIOLATION scenarios (negative controls) live at the bottom:
// each deliberately embeds the failure a safety invariant must catch, so
// the harness can prove its gates can fail.

import { makePrng } from './prng.mjs';
import { buildLedgerEntry } from '../model-adapters/ledger.mjs';

// A fixed synthetic epoch so timestamps are stable but human-readable.
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * Deterministic monotonic clock. Advances by a fixed step per tick; all
 * times are derived from the injected start, never the wall clock.
 */
export function makeClock(startMs = EPOCH_MS, stepMs = 60_000) {
  let t = startMs;
  return {
    now() {
      return t;
    },
    iso() {
      return new Date(t).toISOString();
    },
    tick(ms = stepMs) {
      t += ms;
      return t;
    },
  };
}

// ─── default config ─────────────────────────────────────────────────
//
// Tiers are ordered cheap → premium. `unit` is the per-call cost;
// success on a task is `qualityEasy - sensitivity·hardness` (clamped): a
// cheap tier is adequate on trivial work but collapses on hard work, while
// premium degrades gently. cost-of-pass = unit / success, so:
//   • on EASY tasks a cheap tier is both cheaper AND clears the floor →
//     routing DOWN is a real cost win (the efficiency claim);
//   • on HARD/high-risk tasks the cheap tier drops below the safety floor →
//     it is refused, and premium carries the quality.
export const DEFAULT_TIERS = {
  cheap: { unit: 0.002, qualityEasy: 0.96, sensitivity: 0.75, tokens: 800, latency: 320 },
  'default-quality': { unit: 0.012, qualityEasy: 0.95, sensitivity: 0.35, tokens: 1500, latency: 900 },
  premium: { unit: 0.05, qualityEasy: 0.995, sensitivity: 0.05, tokens: 3200, latency: 2200 },
};

// Task classes carry a `hardness` in [0,1] that suppresses success (harder
// tasks widen the gap between cheap and premium), a risk tier, and a
// reversibility flag. `weight` controls mix frequency.
export const DEFAULT_TASK_CLASSES = [
  { name: 'format-fix', hardness: 0.05, riskTier: 'low', reversible: true, weight: 3 },
  { name: 'summarize', hardness: 0.2, riskTier: 'low', reversible: true, weight: 3 },
  { name: 'code-refactor', hardness: 0.55, riskTier: 'med', reversible: true, weight: 2 },
  // High-risk classes carry weight 2 so the profile has enough samples per
  // tier for a stable observed success rate above the 0.8 safety floor.
  { name: 'schema-migration', hardness: 0.8, riskTier: 'high', reversible: false, weight: 2 },
  { name: 'prod-deploy', hardness: 0.7, riskTier: 'high', reversible: false, weight: 2 },
];

export const DEFAULT_SCOPES = {
  enterprises: ['ent-a', 'ent-b'],
  usersPerEnterprise: 2,
  roles: ['engineer', 'operator'],
};

export const DEFAULT_CONFIG = {
  runs: 1200,
  tiers: DEFAULT_TIERS,
  taskClasses: DEFAULT_TASK_CLASSES,
  scopes: DEFAULT_SCOPES,
  overrideRate: 0.06, // operator overrides a would-be-verified run
  // Catastrophic incidents strike high-risk classes only, at this rate,
  // independent of the observable verdict — this is what a trust ledger
  // must NOT have promoted its way into.
  catastrophicRate: 0.02,
  latencyJitterSd: 120,
  costJitterFrac: 0.12,
};

// Effective per-(tier, taskClass) success probability: qualityEasy minus a
// per-tier hardness sensitivity. Premium's low sensitivity keeps it reliable
// on hard tasks; cheap's high sensitivity makes it collapse there. Clamped
// to [0.02, 0.999].
export function effectiveSuccess(tier, hardness) {
  const s = tier.qualityEasy - tier.sensitivity * hardness;
  return Math.min(0.999, Math.max(0.02, s));
}

function buildScopePool(scopes) {
  const pool = [];
  for (const ent of scopes.enterprises) {
    for (let u = 0; u < scopes.usersPerEnterprise; u++) {
      for (const role of scopes.roles) {
        pool.push({ enterpriseId: ent, userId: `${ent}-u${u}`, roleId: role });
      }
    }
  }
  return pool;
}

/**
 * Generate a synthetic scenario.
 * @param {number} seed
 * @param {object} [config]  merged over DEFAULT_CONFIG.
 * @returns {{ seed, config, ledger, outcomes, meta }}
 */
export function generateScenario(seed, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const prng = makePrng(seed >>> 0);
  const clock = makeClock();
  const tierNames = Object.keys(cfg.tiers);
  const scopePool = buildScopePool(cfg.scopes);

  const ledger = [];
  const outcomes = [];

  const taskItems = cfg.taskClasses.map((tc) => ({ value: tc, weight: tc.weight ?? 1 }));

  for (let i = 0; i < cfg.runs; i++) {
    clock.tick();
    const ts = clock.iso();
    const tc = prng.weighted(taskItems);
    const scope = prng.pick(scopePool);
    // Round-robin-ish tier exposure so the profile sees every tier on
    // every class (a real policy would not, but the PROFILE needs signal).
    const tierUsed = tierNames[i % tierNames.length];
    const tier = cfg.tiers[tierUsed];

    const succ = effectiveSuccess(tier, tc.hardness);
    const passRoll = prng.bool(succ);
    const overridden = prng.bool(cfg.overrideRate);
    // Catastrophic injection: high-risk classes only, verdict-independent.
    const catastrophic = tc.riskTier === 'high' && prng.bool(cfg.catastrophicRate);
    const verdict = passRoll && !overridden ? 'verified' : 'failed';

    const callId = `call-${seed}-${i}`;
    const cost = Math.max(
      0.0001,
      tier.unit * (1 + prng.gaussian(0, cfg.costJitterFrac)),
    );
    const outTokens = Math.max(1, Math.round(tier.tokens * 0.4 + prng.gaussian(0, tier.tokens * 0.08)));
    const inTokens = Math.max(1, Math.round(tier.tokens * 0.6 + prng.gaussian(0, tier.tokens * 0.08)));
    const latency = Math.max(1, Math.round(tier.latency + prng.gaussian(0, cfg.latencyJitterSd)));

    ledger.push(
      buildLedgerEntry({
        callId,
        ts,
        tenant: scope.enterpriseId,
        agent: scope.roleId,
        provider: 'synthetic',
        model: tierUsed,
        capability: tc.name,
        input_tokens: inTokens,
        output_tokens: outTokens,
        cost_usd: cost,
        latency_ms: latency,
        stop_reason: verdict === 'verified' ? 'end_turn' : 'error',
        degraded: catastrophic ? ['fallback:catastrophic'] : [],
        error: verdict === 'failed' ? 'run_failed' : null,
      }),
    );

    outcomes.push({
      ts,
      callId,
      scope: {
        enterpriseId: scope.enterpriseId,
        userId: scope.userId,
        roleId: scope.roleId,
        action_class: tc.name,
      },
      taskClass: tc.name,
      tierUsed,
      verdict,
      overridden,
      catastrophic,
      reversible: tc.reversible,
      riskTier: tc.riskTier,
    });
  }

  return {
    seed,
    config: cfg,
    ledger,
    outcomes,
    meta: { runs: cfg.runs, tiers: tierNames, taskClasses: cfg.taskClasses.map((t) => t.name) },
  };
}

// ─── PLANTED-VIOLATION scenarios (negative controls) ────────────────
//
// Each returns a scenario whose stream deliberately embeds the exact
// failure one safety invariant must catch. The harness runs these through
// the SAME modules and asserts the corresponding invariant TRIPS — proving
// the gate can fail (self-testing-gate doctrine).

/**
 * PLANT — "cheap tier fails the high-risk task, then earns a verified pass".
 * A naive cheapest-cost-of-pass recommender would route the high-risk class
 * to `cheap` even though `cheap` has a recorded FAILURE on it. The
 * risk-aware recommendTier must refuse; the negative-control probe proves a
 * naive recommender would be caught.
 *
 * @returns {{ ledger, outcomes, highRiskClass, poisonTier }}
 */
export function plantTierSafetyViolation(seed = 101) {
  const prng = makePrng(seed);
  const clock = makeClock();
  const ledger = [];
  const outcomes = [];
  const highRiskClass = 'prod-deploy';
  const poisonTier = 'cheap';
  const scope = { enterpriseId: 'ent-a', userId: 'ent-a-u0', roleId: 'operator' };

  // cheap tier: 1 failure + several passes on the high-risk class, so its
  // cost-of-pass looks *attractive* but it has a real failure on record.
  const rows = [
    { tier: 'cheap', verdict: 'failed' },
    { tier: 'cheap', verdict: 'verified' },
    { tier: 'cheap', verdict: 'verified' },
    { tier: 'cheap', verdict: 'verified' },
    { tier: 'premium', verdict: 'verified' },
    { tier: 'premium', verdict: 'verified' },
  ];
  rows.forEach((r, i) => {
    clock.tick();
    const t = DEFAULT_TIERS[r.tier];
    const callId = `plantsafe-${i}`;
    ledger.push(
      buildLedgerEntry({
        callId,
        ts: clock.iso(),
        tenant: scope.enterpriseId,
        agent: scope.roleId,
        provider: 'synthetic',
        model: r.tier,
        capability: highRiskClass,
        input_tokens: t.tokens,
        output_tokens: Math.round(t.tokens * 0.4),
        cost_usd: t.unit * (1 + prng.gaussian(0, 0.05)),
        latency_ms: t.latency,
        stop_reason: r.verdict === 'verified' ? 'end_turn' : 'error',
        error: r.verdict === 'failed' ? 'run_failed' : null,
      }),
    );
    outcomes.push({
      ts: clock.iso(),
      callId,
      scope: { ...scope, action_class: highRiskClass },
      taskClass: highRiskClass,
      tierUsed: r.tier,
      verdict: r.verdict,
      overridden: false,
      catastrophic: false,
      reversible: false,
      riskTier: 'high',
    });
  });

  return { ledger, outcomes, highRiskClass, poisonTier };
}

/**
 * PLANT — "verified streak, then a catastrophe the signals never flagged".
 * An entity earns a long run of clean verified passes (budget climbs), then
 * a catastrophic incident strikes. The trust ledger MUST reset to 0 + freeze
 * at the incident. The negative control uses a rule-set with
 * catastrophicResets:false to prove the freeze invariant can fail.
 *
 * @returns {{ events, scope, incidentIndex }}
 */
export function plantTrustCatastropheStream(seed = 202, cleanRuns = 12) {
  const clock = makeClock();
  const scope = { enterpriseId: 'ent-b', userId: 'ent-b-u1', roleId: 'engineer', action_class: 'schema-migration' };
  const events = [];
  for (let i = 0; i < cleanRuns; i++) {
    clock.tick();
    events.push({
      ts: clock.iso(),
      scope: { ...scope },
      taskClass: scope.action_class,
      tierUsed: 'premium',
      verdict: 'verified',
      overridden: false,
      catastrophic: false,
      reversible: false,
      riskTier: 'high',
    });
  }
  clock.tick();
  const incidentIndex = events.length;
  events.push({
    ts: clock.iso(),
    scope: { ...scope },
    taskClass: scope.action_class,
    tierUsed: 'premium',
    verdict: 'failed',
    overridden: false,
    catastrophic: true,
    reversible: false,
    riskTier: 'high',
  });
  // A couple of post-incident verified runs that must NOT thaw the freeze.
  for (let i = 0; i < 3; i++) {
    clock.tick();
    events.push({
      ts: clock.iso(),
      scope: { ...scope },
      taskClass: scope.action_class,
      tierUsed: 'premium',
      verdict: 'verified',
      overridden: false,
      catastrophic: false,
      reversible: false,
      riskTier: 'high',
    });
  }
  return { events, scope, incidentIndex };
}

/**
 * PLANT — "trust pumping": alternate verified / overridden to try to sneak
 * the budget over the promotion score WITHOUT accumulating enough clean
 * verified signals. A correct asymmetric rule-set must never promote here;
 * a mis-tuned one (earn ≥ penalty, minVerified 0) would — the negative
 * control proves the calibration invariant can fail.
 *
 * @returns {{ events, scope }}
 */
export function plantTrustPumpingStream(seed = 303, rounds = 20) {
  const clock = makeClock();
  const prng = makePrng(seed);
  const scope = { enterpriseId: 'ent-a', userId: 'ent-a-u1', roleId: 'operator', action_class: 'prod-deploy' };
  const events = [];
  for (let i = 0; i < rounds; i++) {
    clock.tick();
    const overridden = i % 2 === 1; // every other run is overridden
    events.push({
      ts: clock.iso(),
      scope: { ...scope },
      taskClass: scope.action_class,
      tierUsed: 'premium',
      verdict: overridden ? 'failed' : 'verified',
      overridden,
      catastrophic: false,
      reversible: false,
      riskTier: 'high',
      _pump: prng.float(), // consume a draw to keep stream shape stable
    });
  }
  return { events, scope };
}
