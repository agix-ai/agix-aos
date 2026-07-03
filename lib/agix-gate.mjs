// agix-gate — the gate primitive of the loop-engineered SDLC.
//
// A Gate is a phase transition guarded by a verifier that is NOT the actor
// (LOOP_ENGINEERED_SDLC §2, "actor ≠ verifier is the load-bearing rule"). It
// runs entry → work → exit and returns a Stage-Gate Verdict ∈
// {GO, KILL, HOLD, RECYCLE} — richer than pass/fail:
//   GO      → advance to the next phase
//   KILL    → abandon the branch
//   HOLD    → escalate to a human gate
//   RECYCLE → send back to the actor for another L0 iteration
//
// Three structural invariants, enforced here (not by convention):
//  1. verifier ≠ actor — `evaluate` throws if they are the same. This is the
//     anti-spec-gaming control (§3): the surface that judges the work cannot be
//     the surface that produced it.
//  2. Immutable verifier surface (§3.2) — the gate's criteria are captured at
//     construction and frozen; `evaluate` never reads criteria from the actor's
//     context, so the actor cannot edit the harness / gate to make itself pass.
//  3. Every evaluation is recorded — a `gate_decision` + a `verdict` entry are
//     appended to the audit ledger (the L2 substrate; you cannot learn priors
//     you did not record).
//
// `requiresHuman: true` marks one of the four hard human gates (§2: spec
// approval, high-risk design sign-off, merge-to-main, prod promotion): a passing
// exit is not allowed to auto-advance — a would-be GO is routed to HOLD (the
// human then issues the real GO). KILL/RECYCLE still pass through.

import { VERDICTS } from './agix-audit-ledger.mjs';

export const VERDICT = Object.freeze({
  GO: 'GO',
  KILL: 'KILL',
  HOLD: 'HOLD',
  RECYCLE: 'RECYCLE',
});
export { VERDICTS };

function isVerdict(v) {
  return VERDICTS.includes(v);
}

// Normalize whatever a criteria fn returned into { verdict, reason, confidence,
// meta }. Accepts a bare verdict string or an object carrying one.
function normalizeVerdict(result, fallback) {
  if (result == null) return { verdict: fallback, reason: null, confidence: null, meta: null };
  if (typeof result === 'string') {
    if (!isVerdict(result)) throw new Error(`gate: criteria returned invalid verdict "${result}"`);
    return { verdict: result, reason: null, confidence: null, meta: null };
  }
  if (typeof result === 'object') {
    const v = result.verdict ?? fallback;
    if (!isVerdict(v)) throw new Error(`gate: criteria returned invalid verdict "${v}"`);
    return {
      verdict: v,
      reason: result.reason ?? null,
      confidence: result.confidence ?? null,
      meta: result.meta ?? null,
    };
  }
  throw new Error('gate: criteria must return a verdict string or an object');
}

export class Gate {
  // {
  //   name, phase,
  //   actor,            // the agent that produced the work
  //   verifier,         // the agent that judges it — MUST differ from actor
  //   entryCriteria,    // (context) => bool | { ok, verdict? } — the precondition (e.g. lease held)
  //   work,             // (context) => any — optional; the actor's production step
  //   exitCriteria,     // (context, workResult) => Verdict | { verdict, reason, confidence } — the DoD
  //   requiresHuman,    // one of the four hard human gates → GO becomes HOLD
  //   ledger,           // AuditLedger — every evaluate() records a gate_decision + verdict
  // }
  constructor(config = {}) {
    const { name, phase, actor, verifier, entryCriteria, work, exitCriteria, requiresHuman = false, ledger } = config;
    if (!name) throw new Error('Gate: name is required');
    if (typeof exitCriteria !== 'function') throw new Error(`Gate "${name}": exitCriteria(context, workResult) is required`);
    // Criteria are captured here and frozen — the immutable verifier surface.
    // The actor cannot reach in and swap them at evaluate() time.
    this.name = name;
    this.phase = phase ?? null;
    this.actor = actor ?? null;
    this.verifier = verifier ?? null;
    this.requiresHuman = Boolean(requiresHuman);
    this._entryCriteria = typeof entryCriteria === 'function' ? entryCriteria : null;
    this._work = typeof work === 'function' ? work : null;
    this._exitCriteria = exitCriteria;
    this.ledger = ledger ?? null;
    Object.freeze(this);  // ratchet: no field (incl. criteria refs) is reassignable after construction
  }

  // Run the gate. `context` carries whatever the criteria need (the artifact,
  // the scope, the actor's inputs) — but NEVER the criteria themselves.
  // Returns { verdict, reason, confidence, routedToHuman, entry, gate: name/phase }.
  async evaluate(context = {}) {
    // (1) Structural anti-spec-gaming: no agent verifies its own output.
    if (this.actor != null && this.verifier != null && this.actor === this.verifier) {
      throw new Error(
        `Gate "${this.name}": verifier must differ from actor (both "${this.actor}") — ` +
        `no agent may verify its own output (LOOP_ENGINEERED_SDLC §2).`,
      );
    }

    // (2) Entry precondition. A false/{ok:false} entry does not run the work; it
    // yields HOLD (the precondition — e.g. a missing lease — needs a human/setup
    // step) unless the criteria named an explicit verdict.
    let entryOk = true;
    let entryVerdict = null;
    if (this._entryCriteria) {
      const raw = await this._entryCriteria(context);
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        entryOk = Boolean(raw.ok);
        if (raw.verdict && isVerdict(raw.verdict)) entryVerdict = raw.verdict;
      } else {
        entryOk = Boolean(raw);
      }
    }

    let decision;
    let workResult = context.workResult ?? null;
    if (!entryOk) {
      decision = normalizeVerdict(entryVerdict || VERDICT.HOLD, VERDICT.HOLD);
      decision.reason = decision.reason || `entry criteria not met for gate "${this.name}"`;
    } else {
      // (3) Optional work step (the actor's production), then the exit DoD.
      if (this._work) workResult = await this._work(context);
      decision = normalizeVerdict(await this._exitCriteria(context, workResult), VERDICT.RECYCLE);
    }

    // (4) Human-gate routing: a hard human gate never auto-advances.
    let routedToHuman = false;
    if (this.requiresHuman && decision.verdict === VERDICT.GO) {
      decision.verdict = VERDICT.HOLD;
      routedToHuman = true;
      decision.reason = decision.reason
        ? `${decision.reason} (requires human co-sign)`
        : `gate "${this.name}" requires human co-sign`;
    }
    if (decision.verdict === VERDICT.HOLD && this.requiresHuman) routedToHuman = true;

    // (5) Record to the ledger: a gate_decision (the gate ran) + a verdict.
    let ledgerEntries = null;
    if (this.ledger) {
      const scope = context.scope || undefined;
      const actorTag = context.actor ?? this.actor ?? null;
      const cost = context.cost ?? null;
      const inputs_hash = context.inputs_hash ?? null;
      const authority_used = context.authority_used ?? null;
      const gateDecision = await this.ledger.append({
        kind: 'gate_decision',
        scope,
        phase: this.phase,
        actor: actorTag,
        verifier: this.verifier,
        authority_used,
        inputs_hash,
        cost,
        meta: { gate: this.name, entry_ok: entryOk, requires_human: this.requiresHuman, reason: decision.reason },
      });
      const verdictEntry = await this.ledger.append({
        kind: 'verdict',
        scope,
        phase: this.phase,
        actor: actorTag,
        verifier: this.verifier,
        verdict: decision.verdict,
        authority_used,
        inputs_hash,
        cost,
        overridden_by_human: Boolean(context.overridden_by_human),
        meta: {
          gate: this.name,
          routed_to_human: routedToHuman,
          confidence: decision.confidence,
          reason: decision.reason,
          ...(decision.meta ? { detail: decision.meta } : {}),
        },
      });
      ledgerEntries = { gateDecision, verdict: verdictEntry };
    }

    return {
      gate: this.name,
      phase: this.phase,
      verdict: decision.verdict,
      reason: decision.reason,
      confidence: decision.confidence,
      routedToHuman,
      entryOk,
      workResult,
      ledgerEntries,
    };
  }
}

// ─── Gate registry — the LOOP_ENGINEERED_SDLC §2 phase table ────────────
//
// The nine dev-loop phases + their actor/verifier/human-gate defaults, straight
// from the §2 table (actor ≠ verifier baked in). `composeGate` builds a live
// Gate for a phase by supplying the criteria (the immutable verifier surface)
// and the ledger. The registry fixes WHO verifies WHOM; the caller supplies the
// concrete DoD checks. The four `requiresHuman` phases are the four hard human
// gates (§2). Release/GTM phases (RELEASE_GTM_MANAGEMENT.md §2) extend the same
// table with their own gates keyed by phase.

export const GATE_REGISTRY = Object.freeze({
  orient:     { phase: 'orient',     actor: 'onboarding',       verifier: 'architect',        requiresHuman: false },
  spec:       { phase: 'spec',       actor: 'architect',        verifier: 'human',            requiresHuman: true  },
  design:     { phase: 'design',     actor: 'architect',        verifier: 'architect-2',      requiresHuman: false },
  implement:  { phase: 'implement',  actor: 'coder',            verifier: 'architect',        requiresHuman: false },
  test:       { phase: 'test',       actor: 'tester',           verifier: 'holdout-suite',    requiresHuman: false },
  integrate:  { phase: 'integrate',  actor: 'git-orchestrator', verifier: 'ci-warden',        requiresHuman: true  },
  root_cause: { phase: 'root_cause', actor: 'investigator',     verifier: 'tester',           requiresHuman: false },
  release:    { phase: 'release',    actor: 'release-engineer', verifier: 'canary-eval',      requiresHuman: true  },
  operate:    { phase: 'operate',    actor: 'release-engineer', verifier: 'monitoring',       requiresHuman: false },
});

// Build a Gate for a registry phase. `criteria` supplies { entryCriteria, work,
// exitCriteria }; `ledger` wires the audit record. Overrides let a caller swap
// the actor/verifier (e.g. name a real coder instance) as long as the
// actor ≠ verifier invariant still holds at evaluate() time.
export function composeGate(phaseKey, { criteria = {}, ledger, overrides = {} } = {}) {
  const base = GATE_REGISTRY[phaseKey];
  if (!base) {
    throw new Error(`composeGate: unknown phase "${phaseKey}" (known: ${Object.keys(GATE_REGISTRY).join(', ')})`);
  }
  if (typeof criteria.exitCriteria !== 'function') {
    throw new Error(`composeGate("${phaseKey}"): criteria.exitCriteria is required`);
  }
  return new Gate({
    name: overrides.name || `${phaseKey}-gate`,
    phase: base.phase,
    actor: overrides.actor ?? base.actor,
    verifier: overrides.verifier ?? base.verifier,
    requiresHuman: overrides.requiresHuman ?? base.requiresHuman,
    entryCriteria: criteria.entryCriteria,
    work: criteria.work,
    exitCriteria: criteria.exitCriteria,
    ledger,
  });
}
