// agix-efficiency-profile — learned-efficiency auto-tiering (pure).
//
// GUARDS: "auto-tiering routed a high-risk task to a tier that has failed
// it" (loop-sim/FALSIFIABLE-SAFETY-b). This module turns a stream of model
// calls (ledger) + their run outcomes into a per-taskClass efficiency
// profile, then recommends the CHEAPEST tier that clears a learned quality
// floor — while REFUSING, for high-risk tasks, any tier with a recorded
// failure on that class.
//
// Pure + deterministic: no I/O, no clock, no randomness. The same inputs
// always produce byte-identical output, with stable key ordering, so the
// RELIABILITY suite can byte-compare two runs.
//
// Cost-of-pass is the headline metric: total cost spent (across ALL
// attempts, passed or failed) divided by the number of VERIFIED passes. A
// cheap tier that fails often costs MORE per verified pass than a pricier
// tier that lands first-try — the exact economics learned auto-tiering
// exploits.

const SAFE_DEFAULT_TIER = 'default-quality';
const HIGH_RISK = new Set(['high']);
// High-risk tasks demand a stricter learned reliability floor: a tier is
// "trusted" for a high-risk class only if its observed success rate on that
// class clears this bar. A tier below it has "failed the task" too often to
// carry it — this is the falsifiable safety invariant (b).
export const DEFAULT_HIGH_RISK_FLOOR = 0.8;

/** Stable numeric round to keep byte-identical serialization. */
function r6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Build a per-(taskClass, tier) efficiency profile.
 *
 * @param {Array} ledgerEntries  buildLedgerEntry-shaped records (carry cost).
 * @param {Array} runOutcomes    outcome events joined to ledger by call_id.
 * @param {object} opts
 * @param {(outcome)=>string} [opts.taskClassOf]  defaults to o => o.taskClass.
 * @returns {{ taskClasses: object, order: string[] }}
 */
export function buildProfile(ledgerEntries, runOutcomes, { taskClassOf = (o) => o.taskClass } = {}) {
  const costById = new Map();
  const tokById = new Map();
  const latById = new Map();
  for (const e of ledgerEntries) {
    costById.set(e.call_id, e.cost_usd || 0);
    tokById.set(e.call_id, (e.input_tokens || 0) + (e.output_tokens || 0));
    latById.set(e.call_id, e.latency_ms || 0);
  }

  // taskClass -> tier -> accumulator
  const acc = new Map();
  const ensure = (tc, tier) => {
    if (!acc.has(tc)) acc.set(tc, new Map());
    const byTier = acc.get(tc);
    if (!byTier.has(tier)) {
      byTier.set(tier, {
        attempts: 0,
        verified: 0,
        failed: 0,
        totalCost: 0,
        totalTokens: 0,
        totalLatency: 0,
        catastrophes: 0,
      });
    }
    return byTier.get(tier);
  };

  for (const o of runOutcomes) {
    const tc = taskClassOf(o);
    const tier = o.tierUsed;
    const a = ensure(tc, tier);
    a.attempts += 1;
    if (o.verdict === 'verified' && !o.overridden) a.verified += 1;
    else a.failed += 1;
    if (o.catastrophic) a.catastrophes += 1;
    a.totalCost += costById.get(o.callId) ?? 0;
    a.totalTokens += tokById.get(o.callId) ?? 0;
    a.totalLatency += latById.get(o.callId) ?? 0;
  }

  const taskClasses = {};
  for (const tc of [...acc.keys()].sort()) {
    const byTier = acc.get(tc);
    const tiers = {};
    for (const tier of [...byTier.keys()].sort()) {
      const a = byTier.get(tier);
      const successRate = a.attempts ? a.verified / a.attempts : 0;
      // cost-of-pass: all cost / verified passes. Infinity when no pass yet
      // (a tier that has never landed this class is worthless, not free).
      const costOfPass = a.verified > 0 ? r6(a.totalCost / a.verified) : Infinity;
      tiers[tier] = {
        attempts: a.attempts,
        verified: a.verified,
        failed: a.failed,
        catastrophes: a.catastrophes,
        successRate: r6(successRate),
        costOfPass,
        meanTokens: a.attempts ? r6(a.totalTokens / a.attempts) : 0,
        meanLatency: a.attempts ? r6(a.totalLatency / a.attempts) : 0,
        hadFailure: a.failed > 0,
      };
    }
    taskClasses[tc] = { tiers };
  }

  return { taskClasses, order: Object.keys(taskClasses) };
}

/**
 * Deterministic tie-break comparator over tier stat rows.
 * cost-of-pass asc → successRate desc → tier-name asc.
 */
function compareTiers(a, b) {
  if (a.costOfPass !== b.costOfPass) return a.costOfPass - b.costOfPass;
  if (a.successRate !== b.successRate) return b.successRate - a.successRate;
  return a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0;
}

/**
 * Recommend a tier for one task.
 *
 * @param {object} profile      from buildProfile.
 * @param {string} taskClass
 * @param {object} opts
 * @param {string[]} opts.candidateTiers
 * @param {string} [opts.riskTier]        'low'|'med'|'high'.
 * @param {number} [opts.minQuality]      learned success floor, default 0.7.
 * @param {number} [opts.highRiskFloor]   stricter floor for high-risk, default 0.85.
 * @param {string} [opts.defaultTier]     safe fallback, default 'default-quality'.
 * @returns {{ tier, reason, costOfPass, successRate, fellBack, floor }}
 */
export function recommendTier(profile, taskClass, opts = {}) {
  const {
    candidateTiers,
    riskTier = 'med',
    minQuality = 0.7,
    highRiskFloor = DEFAULT_HIGH_RISK_FLOOR,
    defaultTier = SAFE_DEFAULT_TIER,
  } = opts;
  const highRisk = HIGH_RISK.has(riskTier);
  // Effective floor: high-risk tasks clear the STRICTER of the two bars.
  const floor = highRisk ? Math.max(minQuality, highRiskFloor) : minQuality;
  if (!Array.isArray(candidateTiers) || candidateTiers.length === 0) {
    return { tier: defaultTier, reason: 'no-candidates', costOfPass: Infinity, successRate: 0, fellBack: true, floor };
  }
  const tc = profile.taskClasses?.[taskClass];

  const rows = [];
  for (const tier of candidateTiers) {
    const stat = tc?.tiers?.[tier];
    if (!stat) continue; // no learned data for this tier on this class
    // SAFETY floor: a tier only qualifies if its learned success rate on
    // this class clears the effective floor (stricter for high-risk). This
    // is what refuses a tier that has "failed the task" too often.
    if (stat.successRate < floor) continue;
    rows.push({ tier, ...stat });
  }

  if (rows.length === 0) {
    // No learned tier clears the floor. Fall back to the SAFEST tier we have
    // evidence for — the highest observed success rate among candidates —
    // never a cheaper-but-weaker tier. (A caller may treat a fell-back
    // high-risk recommendation as a signal to escalate to a human instead.)
    let safest = null;
    for (const tier of candidateTiers) {
      const stat = tc?.tiers?.[tier];
      if (!stat) continue;
      if (!safest || stat.successRate > safest.successRate) safest = { tier, ...stat };
    }
    if (safest) {
      return { tier: safest.tier, reason: 'no-tier-cleared-floor:safest', costOfPass: safest.costOfPass, successRate: safest.successRate, fellBack: true, floor };
    }
    return { tier: defaultTier, reason: 'no-profile-data', costOfPass: Infinity, successRate: 0, fellBack: true, floor };
  }

  rows.sort(compareTiers);
  const best = rows[0];
  return {
    tier: best.tier,
    reason: 'learned-min-cost-of-pass',
    costOfPass: best.costOfPass,
    successRate: best.successRate,
    fellBack: false,
    floor,
  };
}

/**
 * Plan tier assignment for a swarm / fan-out of subtasks.
 *
 * @param {object} profile
 * @param {Array<{id, taskClass, riskTier?, minQuality?}>} subtasks
 * @param {object} opts  { candidateTiers, minQuality?, defaultTier? }
 * @returns {Array<{ id, taskClass, tier, reason, costOfPass, successRate, fellBack }>}
 */
export function planFanout(profile, subtasks, opts = {}) {
  return subtasks.map((st) => {
    const rec = recommendTier(profile, st.taskClass, {
      candidateTiers: opts.candidateTiers,
      riskTier: st.riskTier,
      minQuality: st.minQuality ?? opts.minQuality,
      highRiskFloor: opts.highRiskFloor,
      defaultTier: opts.defaultTier,
    });
    return { id: st.id, taskClass: st.taskClass, ...rec };
  });
}

export { SAFE_DEFAULT_TIER };
