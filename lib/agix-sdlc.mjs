// agix-sdlc — the deterministic phase-runner for the loop-engineered SDLC.
//
// Drives a task through the nine-phase dev lifecycle
// (LOOP_ENGINEERED_SDLC.md §1):
//
//   Orient → Spec → Design → Implement → Test → Integrate
//          → (Root-cause on a Test/Integrate fail) → Release → Operate
//
// For each phase the runner:
//   1. resolves the phase's gate via composeGate() — the §2 GATE_REGISTRY fixes
//      WHO verifies WHOM (actor ≠ verifier, enforced by the Gate at evaluate),
//      and marks the four hard human gates (Spec, Integrate/merge, Release).
//   2. runs the phase's ACTOR (pluggable — a DEFAULT deterministic stub for
//      smoke/tests, or a real-agent adapter that calls runtime.runAgent()).
//   3. hands the actor's workResult to gate.evaluate(), which returns a
//      Stage-Gate Verdict ∈ {GO, KILL, HOLD, RECYCLE} and appends a
//      gate_decision + verdict pair to the audit ledger (the L2 substrate).
//   4. routes on the verdict (below).
//
// Verdict routing (LOOP_ENGINEERED_SDLC §2 verdict semantics):
//   GO       → advance to the next phase.
//   RECYCLE  → re-run the actor, bounded to `maxAttempts` tries, then HOLD
//              (awaiting_human) once the budget is spent.
//   HOLD     → halt the run and mark it `awaiting_human` (records the escalation).
//   KILL     → abort the run.
//   On a Test or Integrate KILL/RECYCLE → branch to the Root-cause phase
//   (investigator) and, once root-cause GOes, resume by re-running the failed
//   phase (still bounded by that phase's attempt budget). This is the §1
//   "Root-cause as a first-class failure branch".
//
// The four hard human gates never auto-advance: the Gate turns their would-be GO
// into HOLD. The runner resolves that HOLD against the caller-supplied
// `approvals` (a human co-sign). No approval → the run halts awaiting_human at
// that gate (the correct default: a stranger's run stops at the first human gate).
//
// Determinism: given deterministic actors + injected clock/idgen, a run produces
// a byte-identical trajectory. The DEFAULT actors are descriptor-driven (they
// read per-phase directives off the task descriptor), so `agix sdlc plan` needs
// no API key and touches no network — it is a pure walk of the gate machine.
//
// The returned trajectory IS the L1 run-level reflection envelope
// (LOOP_ENGINEERED_SDLC §5): every phase's verified verdict, who verified it, and
// every human/HOLD escalation, in order.

import { composeGate, GATE_REGISTRY, VERDICT } from './agix-gate.mjs';
import { VERDICTS } from './agix-audit-ledger.mjs';

// ─── Phase order + agent mapping ─────────────────────────────────────────

// The linear phase spine (LOOP_ENGINEERED_SDLC §1). `root_cause` is NOT in the
// linear order — it is the failure branch reached from Test/Integrate.
export const SDLC_PHASES = Object.freeze([
  'orient', 'spec', 'design', 'implement', 'test', 'integrate', 'release', 'operate',
]);

// Which existing fleet agent OWNS each phase (LOOP_ENGINEERED_SDLC §2 table).
// Used by the real-agent adapter to pick runtime.runAgent() targets. `implement`
// has no dedicated `coder` agent yet (the §2 documented gap) — the architect
// carries it until a coder is named, but the GATE_REGISTRY still records the
// distinct `coder` actor so actor ≠ verifier holds.
export const PHASE_AGENTS = Object.freeze({
  orient:     'onboarding',
  spec:       'architect',
  design:     'architect',
  implement:  'architect',          // no dedicated coder agent yet (§2 gap)
  test:       'tester',
  integrate:  'git-orchestrator',
  root_cause: 'investigator',
  release:    'release-engineer',
  operate:    'release-engineer',
});

// The phases whose failure (KILL/RECYCLE) branches to Root-cause (§1).
const FAILURE_BRANCH_PHASES = new Set(['test', 'integrate']);

// ─── Actor contract ──────────────────────────────────────────────────────
//
// An actor is `async (context) => workResult`. `context` carries:
//   { task, scope, phase, attempt, actor (agent name), triggeredBy? }
// A workResult is any object; the runner's fixed exit-criteria reads its
// `verdict` field (one of the four Stage-Gate verdicts, default GO) plus an
// optional `reason` / `confidence`. The actor NEVER supplies the gate criteria —
// that is the immutable verifier surface (§3.2); the actor only produces work,
// and the workResult's declared verdict is what a real verifier would compute.

// The runner's fixed exit criteria: read the actor's workResult and normalize it
// to a verdict. This is the (immutable) verifier surface for the stub/plan path —
// it is a pure function of the workResult, captured at gate construction.
function verdictFromWorkResult(_context, workResult) {
  if (!workResult || typeof workResult !== 'object') return VERDICT.GO;
  const v = workResult.verdict;
  const verdict = typeof v === 'string' && VERDICTS.includes(v) ? v : VERDICT.GO;
  return { verdict, reason: workResult.reason ?? null, confidence: workResult.confidence ?? null };
}

// DEFAULT deterministic actor for a phase. Reads the task descriptor's per-phase
// directive so a run is fully driven by (and reproducible from) the descriptor:
//
//   task.phases[phase] = {
//     verdict?: 'GO'|'KILL'|'HOLD'|'RECYCLE',   // constant across attempts
//     verdicts?: ['KILL','GO', ...],            // per-attempt (last repeats)
//     reason?: string,
//   }
//
// Absent directive → GO. `verdicts` lets a descriptor model "fails first, passes
// on the retry" (the Test-KILL → Root-cause → resume shape) deterministically.
export function defaultActor(phase) {
  return async (context) => {
    const spec = context?.task?.phases?.[phase] || {};
    let verdict = VERDICT.GO;
    if (Array.isArray(spec.verdicts) && spec.verdicts.length > 0) {
      const idx = Math.min((context.attempt || 1) - 1, spec.verdicts.length - 1);
      verdict = spec.verdicts[idx];
    } else if (typeof spec.verdict === 'string') {
      verdict = spec.verdict;
    }
    return {
      phase,
      agent: PHASE_AGENTS[phase] || null,
      verdict,
      reason: spec.reason ?? `${phase} actor (stub) → ${verdict}`,
      attempt: context.attempt || 1,
      stub: true,
    };
  };
}

// The full DEFAULT actor map (every phase incl. root_cause). This is the
// no-agent, no-API-key, smoke-safe actor set `agix sdlc plan` runs with.
export function defaultActors() {
  const map = {};
  for (const phase of Object.keys(GATE_REGISTRY)) map[phase] = defaultActor(phase);
  return map;
}

// REAL-agent actor map: each phase's actor calls runtime.runAgent() for the
// mapped fleet agent (PHASE_AGENTS). The agent's result is wrapped as a
// workResult; absent an explicit Stage-Gate verdict from the agent, a completed
// run is treated as GO (the verifier gate still adjudicates). This is the
// non-smoke path `agix sdlc run` documents; it invokes the fleet for real.
export function agentActors(runtime, { runOpts = {} } = {}) {
  if (!runtime || typeof runtime.runAgent !== 'function') {
    throw new Error('agentActors: a runtime exposing runAgent(name, opts) is required');
  }
  const map = {};
  for (const phase of Object.keys(GATE_REGISTRY)) {
    const agent = PHASE_AGENTS[phase];
    map[phase] = async (context) => {
      const result = await runtime.runAgent(agent, { ...runOpts, phase, task: context.task });
      const v = result && typeof result === 'object' ? result.verdict : undefined;
      return {
        phase,
        agent,
        verdict: typeof v === 'string' && VERDICTS.includes(v) ? v : VERDICT.GO,
        reason: `${agent} run for ${phase}`,
        result: result ?? null,
      };
    };
  }
  return map;
}

// ─── Approvals (human co-sign) ───────────────────────────────────────────

// Normalize the caller's `approvals` into a predicate (phase, context) => bool.
// Accepts: a function, an array/Set of approved phase keys, an object map
// { phase: true }, or true (approve every human gate — the "operator co-signs
// everything" convenience for a clean end-to-end run). Default: approve nothing.
function normalizeApprovals(approvals) {
  if (approvals === true) return () => true;
  if (typeof approvals === 'function') return approvals;
  if (approvals instanceof Set) return (phase) => approvals.has(phase);
  if (Array.isArray(approvals)) { const s = new Set(approvals); return (phase) => s.has(phase); }
  if (approvals && typeof approvals === 'object') return (phase) => Boolean(approvals[phase]);
  return () => false;
}

// ─── The runner ──────────────────────────────────────────────────────────

// runSdlc — drive a task through the SDLC phases, recording every gate verdict
// to the ledger and returning the full trajectory.
//
//   {
//     task,           // the task descriptor (drives the default actors)
//     scope,          // ledger governance scope ({ mandateId?, runId? }); runId
//                     //   is filled from idgen() when absent so entries group.
//     actors,         // { phase → async(context) => workResult }; default = defaultActors()
//     ledger,         // AuditLedger — every gate.evaluate() records to it
//     approvals,      // human co-sign for the hard human gates (see normalizeApprovals)
//     maxAttempts,    // per-phase attempt cap for RECYCLE / resume (default 3)
//     clock,          // () => ISO string — escalation timestamps (injected in tests)
//     idgen,          // () => id — runId + step ids (injected in tests)
//   }
//
// Returns { task, scope, status, phasesCompleted, trajectory, escalations,
//           ledgerEntries } — the L1 reflection envelope.
export async function runSdlc({
  task = {},
  scope = {},
  actors = null,
  ledger = null,
  approvals = false,
  maxAttempts = 3,
  clock = () => new Date().toISOString(),
  idgen = () => `sdlc-${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  const actorMap = actors || defaultActors();
  const isApproved = normalizeApprovals(approvals);
  const runScope = { ...scope };
  if (!runScope.runId) runScope.runId = idgen();

  const trajectory = [];
  const escalations = [];
  let ledgerEntries = 0;

  function resolveActor(phase) {
    const fn = actorMap[phase];
    if (typeof fn !== 'function') {
      throw new Error(`runSdlc: no actor registered for phase "${phase}"`);
    }
    return fn;
  }

  function recordEscalation(esc) {
    escalations.push({ ...esc, at: clock() });
  }

  // Run one phase attempt: actor → gate.evaluate → record the trajectory step.
  // Returns { effectiveVerdict, routedToHuman }. Handles the human co-sign so
  // the caller routes on a single effective verdict.
  async function runOnePhase(phase, attempt, extra = {}) {
    // Compose the gate first so the registry's canonical actor/verifier identities
    // are known (actor ≠ verifier). `gate.actor` is the OWNER identity the §2 table
    // records (e.g. 'coder' for implement); PHASE_AGENTS is the FLEET agent the
    // real-agent adapter fires (e.g. 'architect' for implement — the §2 gap). The
    // trajectory records the owner identity so actor ≠ verifier stays coherent.
    const gate = composeGate(phase, {
      criteria: { exitCriteria: verdictFromWorkResult },
      ledger: ledger || undefined,
    });
    const agent = gate.actor;
    const actor = resolveActor(phase);
    const context = { task, scope: runScope, phase, attempt, actor: agent, ...extra };
    const workResult = await actor(context);

    const evalContext = { scope: runScope, workResult, actor: agent };
    if (extra.overriddenByHuman) evalContext.overridden_by_human = true;
    const result = await gate.evaluate(evalContext);
    if (result.ledgerEntries) ledgerEntries += 2;

    let effectiveVerdict = result.verdict;
    let humanCosign = false;

    // Hard human gate: the Gate turned a would-be GO into a routed HOLD. Resolve
    // it against the caller's approvals (the human co-sign).
    if (result.routedToHuman && result.verdict === VERDICT.HOLD) {
      if (isApproved(phase, context)) {
        effectiveVerdict = VERDICT.GO;
        humanCosign = true;
        recordEscalation({ phase, kind: 'human_gate', resolution: 'approved', attempt, verifier: gate.verifier });
        // Record the human's real GO on the ledger (overrides the auto-HOLD).
        if (ledger) {
          await ledger.append({
            kind: 'verdict', scope: runScope, phase: gate.phase,
            actor: agent, verifier: 'human', verdict: VERDICT.GO, overridden_by_human: true,
            meta: { gate: gate.name, human_cosign: true, reason: 'human co-sign approved' },
          });
          ledgerEntries += 1;
        }
      } else {
        effectiveVerdict = VERDICT.HOLD;
        recordEscalation({ phase, kind: 'human_gate', resolution: 'pending', attempt, verifier: gate.verifier });
      }
    }

    trajectory.push({
      id: idgen(),
      phase,
      agent,
      verifier: gate.verifier,
      attempt,
      verdict: effectiveVerdict,
      rawVerdict: result.verdict,
      reason: result.reason,
      requiresHuman: gate.requiresHuman,
      routedToHuman: result.routedToHuman,
      humanCosign,
      isRootCause: phase === 'root_cause',
      triggeredBy: extra.triggeredBy || null,
    });

    return { effectiveVerdict, routedToHuman: result.routedToHuman };
  }

  // The Root-cause branch (investigator). Runs bounded; on GO the caller resumes
  // the failed phase. HOLD/KILL propagate as halt/abort.
  async function runRootCauseBranch(failedPhase) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { effectiveVerdict } = await runOnePhase('root_cause', attempt, { triggeredBy: failedPhase });
      if (effectiveVerdict === VERDICT.GO) return { disposition: 'advance' };
      if (effectiveVerdict === VERDICT.KILL) {
        recordEscalation({ phase: 'root_cause', kind: 'abort', resolution: 'killed', attempt, triggeredBy: failedPhase });
        return { disposition: 'abort' };
      }
      if (effectiveVerdict === VERDICT.HOLD) {
        recordEscalation({ phase: 'root_cause', kind: 'hold', resolution: 'pending', attempt, triggeredBy: failedPhase });
        return { disposition: 'halt' };
      }
      // RECYCLE → loop (bounded).
    }
    recordEscalation({ phase: 'root_cause', kind: 'recycle_exhausted', resolution: 'pending', triggeredBy: failedPhase });
    return { disposition: 'halt' };
  }

  // Run a phase to a terminal disposition, applying the verdict routing +
  // bounded retries + the Test/Integrate root-cause branch.
  async function runPhase(phase) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { effectiveVerdict } = await runOnePhase(phase, attempt);

      if (effectiveVerdict === VERDICT.GO) return { disposition: 'advance' };

      if (effectiveVerdict === VERDICT.HOLD) {
        // A non-human HOLD (entry precondition, or an unapproved human gate).
        recordEscalation({ phase, kind: 'hold', resolution: 'pending', attempt });
        return { disposition: 'halt' };
      }

      if (effectiveVerdict === VERDICT.KILL) {
        if (FAILURE_BRANCH_PHASES.has(phase)) {
          const rc = await runRootCauseBranch(phase);
          if (rc.disposition !== 'advance') return rc;      // halt/abort propagate
          if (attempt >= maxAttempts) {                     // root-cause fixed it but the budget is spent
            recordEscalation({ phase, kind: 'retry_exhausted', resolution: 'pending', attempt });
            return { disposition: 'halt' };
          }
          continue;                                         // resume: re-run the failed phase
        }
        recordEscalation({ phase, kind: 'abort', resolution: 'killed', attempt });
        return { disposition: 'abort' };
      }

      // RECYCLE
      if (FAILURE_BRANCH_PHASES.has(phase)) {
        const rc = await runRootCauseBranch(phase);
        if (rc.disposition !== 'advance') return rc;
        if (attempt >= maxAttempts) {
          recordEscalation({ phase, kind: 'retry_exhausted', resolution: 'pending', attempt });
          return { disposition: 'halt' };
        }
        continue;                                           // resume after root-cause
      }
      // Non-failure phase RECYCLE: bounded retry, then HOLD.
      if (attempt >= maxAttempts) {
        recordEscalation({ phase, kind: 'recycle_exhausted', resolution: 'pending', attempt });
        return { disposition: 'halt' };
      }
      // else loop for another attempt
    }
    // Loop fell through (all attempts consumed without a terminal advance).
    recordEscalation({ phase, kind: 'recycle_exhausted', resolution: 'pending', attempt: maxAttempts });
    return { disposition: 'halt' };
  }

  // ── Walk the linear spine ──
  let status = 'running';
  let phasesCompleted = 0;
  for (const phase of SDLC_PHASES) {
    const { disposition } = await runPhase(phase);
    if (disposition === 'advance') { phasesCompleted += 1; continue; }
    if (disposition === 'halt') { status = 'awaiting_human'; break; }
    if (disposition === 'abort') { status = 'aborted'; break; }
  }
  if (status === 'running') status = 'complete';

  return {
    task: task?.id || task?.title || null,
    scope: runScope,
    status,
    phasesCompleted,
    totalPhases: SDLC_PHASES.length,
    trajectory,
    escalations,
    ledgerEntries,
  };
}

// ─── Render helper (agix sdlc plan) ──────────────────────────────────────

// Render a runSdlc() result as a human phase-by-phase plan: each phase's verdict,
// who verified it, and the human-escalation points. Pure (string in, string out)
// so bin/agix hands the result in and this stays trivially testable.
export function renderSdlcPlan(result, { descriptor } = {}) {
  const L = [];
  const title = descriptor?.title || result.task || '(untitled task)';
  L.push(`agix sdlc · plan · ${title}`);
  L.push(`run=${result.scope?.runId ?? '-'} · status=${result.status} · ${result.phasesCompleted}/${result.totalPhases} phases advanced`);
  L.push('');

  const icon = (v) => ({ GO: '✓', KILL: '✗', HOLD: '⏸', RECYCLE: '↻' })[v] || '?';
  const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

  L.push('Phase-by-phase trajectory');
  for (const step of result.trajectory) {
    const name = step.isRootCause ? `root-cause←${step.triggeredBy}` : step.phase;
    const attemptTag = step.attempt > 1 ? ` (attempt ${step.attempt})` : '';
    const humanTag = step.requiresHuman ? ' [human gate]' : '';
    const cosign = step.humanCosign ? ' ✍ human co-sign' : '';
    L.push(
      `  ${icon(step.verdict)} ${pad(name, 22)} ${pad(step.verdict, 8)} ` +
      `actor=${pad(step.agent ?? '-', 17)} verified-by=${pad(step.verifier ?? '-', 16)}${humanTag}${cosign}${attemptTag}`,
    );
    if (step.reason) L.push(`      ↳ ${step.reason}`);
  }
  L.push('');

  // Human-escalation points.
  L.push('Human-escalation points');
  const humanGates = SDLC_PHASES.filter((p) => GATE_REGISTRY[p]?.requiresHuman);
  L.push(`  Hard human gates (§2): ${humanGates.join(', ')}`);
  if (result.escalations.length === 0) {
    L.push('  No escalations raised this run.');
  } else {
    for (const e of result.escalations) {
      const who = e.verifier ? ` verifier=${e.verifier}` : '';
      const trig = e.triggeredBy ? ` (from ${e.triggeredBy})` : '';
      L.push(`  · ${pad(e.phase, 12)} ${pad(e.kind, 18)} → ${e.resolution}${who}${trig}`);
    }
  }
  L.push('');

  // Ledger note.
  L.push(`Ledger: ${result.ledgerEntries} governance ${result.ledgerEntries === 1 ? 'entry' : 'entries'} written (view with \`agix ledger show\`).`);
  L.push(`Outcome: ${outcomeLine(result.status)}`);
  return L.join('\n') + '\n';
}

function outcomeLine(status) {
  if (status === 'complete') return 'GO through to Operate — clean run, all gates passed.';
  if (status === 'awaiting_human') return 'halted awaiting a human decision (HOLD).';
  if (status === 'aborted') return 'aborted (KILL) — branch abandoned.';
  return status;
}
