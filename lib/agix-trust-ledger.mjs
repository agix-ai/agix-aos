// agix-trust-ledger — L1 earned-autonomy trust ledger (pure, D-104 replay).
//
// GUARDS: "trust promoted an entity before an incident its verified signals
// never flagged" (loop-sim/FALSIFIABLE-SAFETY-a) and "a catastrophe left the
// budget standing" (freeze invariant). This module replays a stream of
// run-outcome events into a per-scope trust TIMELINE, keyed
// (enterpriseId, userId, roleId, action_class).
//
// Design (MULTI_LEVEL_ENTERPRISE_AOS_SPEC §2.1–2.2):
//   • verified & !overridden      -> budget += earnRate ; cleanStreak++
//   • failed | overridden          -> budget -= penalty  ; cleanStreak = 0
//   • catastrophic                 -> budget = 0 ; FREEZE (sticky)
//   Penalty is ASYMMETRIC (penalty > earnRate): trust is slow to earn and
//   fast to lose. Promotion to autonomy requires ALL of:
//     budget >= promotionScore  AND  verifiedCount >= minVerified  AND
//     cleanStreak >= cleanStreak  AND  not frozen.
//
// Pure + deterministic: no clock, no randomness, stable ordering. Replaying
// the same (events, rules) yields byte-identical output — the RELIABILITY
// suite byte-compares two runs.

export const DEFAULT_RULES = {
  earnRate: 0.06,
  penalty: 0.34, // asymmetric: >> earnRate
  promotionScore: 0.75,
  minVerified: 8,
  cleanStreak: 6,
  catastrophicResets: true,
};

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function r6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** Canonical scope key. */
export function scopeKey(scope) {
  return [scope.enterpriseId, scope.userId, scope.roleId, scope.action_class].join('|');
}

/** Is a state promoted to autonomy under `rules`? Pure predicate. */
export function isPromoted(state, rules) {
  return (
    !state.frozen &&
    state.budget >= rules.promotionScore &&
    state.verifiedCount >= rules.minVerified &&
    state.cleanStreak >= rules.cleanStreak
  );
}

/**
 * Replay events into a trust timeline.
 *
 * @param {Array} events   run-outcome events (see scenarios.mjs).
 * @param {object} [rules] merged over DEFAULT_RULES.
 * @returns {{ snapshots, states, order }}
 *   snapshots: per-event state records (chronological, stable-sorted).
 *   states:    final state per scopeKey.
 *   order:     sorted scopeKeys.
 */
export function replay(events, rules = {}) {
  const R = { ...DEFAULT_RULES, ...rules };
  // Stable chronological order: (ts, original-index). Never depends on the
  // wall clock — ts is a synthetic ISO string, index breaks ties.
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    const ta = a.e.ts || '';
    const tb = b.e.ts || '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.i - b.i;
  });

  const states = new Map();
  const ensure = (key) => {
    if (!states.has(key)) {
      states.set(key, { budget: 0, verifiedCount: 0, failCount: 0, cleanStreak: 0, frozen: false, catastrophes: 0 });
    }
    return states.get(key);
  };

  const snapshots = [];
  for (const { e } of indexed) {
    const key = scopeKey(e.scope);
    const s = ensure(key);

    if (e.catastrophic) {
      s.catastrophes += 1;
      if (R.catastrophicResets) {
        s.budget = 0;
        s.frozen = true;
        s.cleanStreak = 0;
      } else {
        // NEGATIVE-CONTROL rule-set: catastrophe does NOT reset. The freeze
        // invariant must catch a timeline produced under these rules.
        s.cleanStreak = 0;
      }
    } else if (s.frozen) {
      // Frozen scopes accrue nothing; a failure still can't go below 0.
      if (e.verdict === 'failed' || e.overridden) s.cleanStreak = 0;
    } else if (e.verdict === 'verified' && !e.overridden) {
      s.budget = clamp01(s.budget + R.earnRate);
      s.verifiedCount += 1;
      s.cleanStreak += 1;
    } else {
      s.budget = clamp01(s.budget - R.penalty);
      s.failCount += 1;
      s.cleanStreak = 0;
    }

    const promoted = isPromoted(s, R);
    snapshots.push({
      ts: e.ts,
      scopeKey: key,
      budget: r6(s.budget),
      verifiedCount: s.verifiedCount,
      cleanStreak: s.cleanStreak,
      frozen: s.frozen,
      catastrophic: Boolean(e.catastrophic),
      promoted,
    });
  }

  // Freeze the final states into plain, ordered records.
  const order = [...states.keys()].sort();
  const finalStates = {};
  for (const key of order) {
    const s = states.get(key);
    finalStates[key] = {
      budget: r6(s.budget),
      verifiedCount: s.verifiedCount,
      failCount: s.failCount,
      cleanStreak: s.cleanStreak,
      frozen: s.frozen,
      catastrophes: s.catastrophes,
      promoted: isPromoted(s, R),
    };
  }

  return { snapshots, states: finalStates, order, rules: R };
}

/**
 * Read the earned trust budget (0..1) for a scope from a replay result.
 * @param {object} replayResult  from replay().
 * @param {object} scope         { enterpriseId, userId, roleId, action_class }.
 * @returns {number} 0..1
 */
export function trustBudget(replayResult, scope) {
  const key = scopeKey(scope);
  return replayResult.states?.[key]?.budget ?? 0;
}

/**
 * Adjust an autonomy tier by earned trust, never relaxing the HITL floor.
 *
 * GUARDS: "earned trust dropped an action below its human-in-the-loop floor"
 * (loop-sim/FALSIFIABLE-SAFETY-c). The returned autonomy level is
 * max(staticFloor, earnedTier) — earned trust can only ADD autonomy above
 * the floor, never subtract from it.
 *
 * @param {number} trustBudgetValue  0..1 earned budget.
 * @param {number} staticFloor       0..1 minimum autonomy the policy mandates.
 * @returns {number} 0..1 effective autonomy level.
 */
export function gateAdjust(trustBudgetValue, staticFloor) {
  const earned = clamp01(trustBudgetValue);
  const floor = clamp01(staticFloor);
  return Math.max(floor, earned);
}
