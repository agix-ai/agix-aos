// agix-mentor-gate.mjs — the anticipating-mentor decision primitive (North Star P5).
//
// The mentor leader agent (Sensei / chief-of-staff) should GUIDE, not interrogate.
// A friend who runs your back-office doesn't ask permission for everything — they
// act on what they already know about you, propose where they're unsure, and only
// interrupt you when it genuinely matters. That judgment is this primitive.
//
// It is a RUNTIME construct (like the §19 question-budget gate): a hard gate
// evaluated BEFORE any operator-facing question is emitted. It resolves Lewis-Pack
// open questions Q14 (question budget) + Q15 (autonomy gate criteria) with a
// concrete, testable rule — see architecture/03-ai-ml/agent-architecture/MENTOR_LEADER_AGENT.md.
//
// Three gates (Q15), evaluated against what the mentor REMEMBERS about the operator:
//   G1 precedent      — gbrain has >=3 backlinked precedents within >=0.7 similarity
//   G2 recentApproval — Bonsai shows the operator approved similar work <=14 days ago
//   G3 reversible      — the action has no destructive / hard-to-undo side effects
//
// Decision:
//   high-risk AND irreversible        -> ASK     (the one combo that always surfaces)
//   gates held == 3                    -> PROCEED (full autonomous; the mentor just does it)
//   gates held in 1..2                 -> PROPOSE (do it unless the operator objects in N hours)
//   gates held == 0                    -> ASK     (genuinely needs the human)
//   ...then: high-risk never PROCEEDs silently -> capped to PROPOSE
//
// The "question budget" is therefore an OUTCOME, not a fixed cap: the better the
// mentor's memory of the operator, the more would-be-questions become proceed/propose.

export const GATE_DEFAULTS = {
  precedentCountMin: 3,
  precedentSimilarityMin: 0.7,
  recentApprovalDaysMax: 14,
  proposeObjectionWindowHours: 4,
};

/**
 * @param {{title:string, reversible:boolean, riskTier:'low'|'med'|'high'}} action
 * @param {{precedentCount?:number, precedentSimilarity?:number, operatorApprovedSimilarWithinDays?:number|null}} memory
 * @param {object} [cfg]
 * @returns {{decision:'ask'|'propose'|'proceed', gates:{precedent:boolean,recentApproval:boolean,reversible:boolean}, held:number, why:string}}
 */
export function decide(action, memory = {}, cfg = GATE_DEFAULTS) {
  const c = { ...GATE_DEFAULTS, ...cfg };
  const reversible = action.reversible === true;
  const risk = action.riskTier || 'med';

  const gates = {
    precedent:
      (memory.precedentCount ?? 0) >= c.precedentCountMin &&
      (memory.precedentSimilarity ?? 0) >= c.precedentSimilarityMin,
    recentApproval:
      memory.operatorApprovedSimilarWithinDays != null &&
      memory.operatorApprovedSimilarWithinDays <= c.recentApprovalDaysMax,
    reversible,
  };
  const held = (gates.precedent ? 1 : 0) + (gates.recentApproval ? 1 : 0) + (gates.reversible ? 1 : 0);

  // The one combo that always surfaces to the human.
  if (risk === 'high' && !reversible) {
    return { decision: 'ask', gates, held, why: 'high-risk AND irreversible — always surfaced regardless of precedent' };
  }

  let decision = held === 3 ? 'proceed' : held >= 1 ? 'propose' : 'ask';
  let why =
    held === 3 ? 'all three gates hold — the mentor knows you well enough to just do this'
    : held >= 1 ? `${held}/3 gates hold — propose and proceed unless you object within ${c.proposeObjectionWindowHours}h`
    : 'no gate holds — genuinely needs your call';

  // High-risk never proceeds silently, even with full precedent.
  if (risk === 'high' && decision === 'proceed') {
    decision = 'propose';
    why = 'all gates hold but high-risk — proposed (never silent) so you see it before it lands';
  }

  return { decision, gates, held, why };
}

/**
 * Question-budget tracker. The budget is emergent: count what the gate routed to
 * each path over a set of actions, so a reflection routine can later grade whether
 * the ASKs were *necessary* (could a gate have answered them?) and tune thresholds.
 */
export function budget() {
  const tally = { ask: 0, propose: 0, proceed: 0, total: 0 };
  return {
    record(decision) { tally[decision]++; tally.total++; return decision; },
    summary() {
      const askRate = tally.total ? tally.ask / tally.total : 0;
      return { ...tally, askRate, autonomyRate: tally.total ? (tally.proceed + tally.propose) / tally.total : 0 };
    },
  };
}
