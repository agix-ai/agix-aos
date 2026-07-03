// agix-loop-sim/anomalies — the anomaly taxonomy that scores a fleet run
// (blueprint §5). The schema is MAST's 14 failure modes in 3 categories
// (system-design, inter-agent, verification) PLUS the Vending-Bench long-horizon
// collapse signatures (meltdown loop, tool-call-syntax degradation, state-misread
// cascade) — 17 detectors total.
//
// Each detector is a checker + probe + PLANTED-VIOLATION negative control: it
// reads a fleet run and counts occurrences of its mode (0 on the clean path),
// and it ships a `plant(seed)` that manufactures exactly that fault so the
// detector is PROVEN able to fire. This is the ratchet: the set of detectable
// faults may only grow, and a detector that cannot demonstrate a catch is not
// trusted. The gate is `total_anomalies === 0` — absolute / blocking / fail-closed.
//
// Pure / deterministic: no wall clock, no Math.random, no model / API / network.

import { runFleet } from './fleet.mjs';

// ─── categories ──────────────────────────────────────────────────────

export const ANOMALY_CATEGORIES = {
  'system-design': 'MAST Category 1 — specification & system design',
  'inter-agent': 'MAST Category 2 — inter-agent misalignment',
  verification: 'MAST Category 3 — task verification & termination',
  collapse: 'Vending-Bench long-horizon collapse signatures',
};

// ─── small append helper (plants inject onto a fresh healthy run) ─────

function nextOrder(run) {
  return run.events.length ? run.events[run.events.length - 1].order + 1 : 0;
}
function inject(run, events) {
  let ord = nextOrder(run);
  for (const e of events) run.events.push({ order: ord++, ...e });
  return run;
}

// ─── derived views over a run's event stream ─────────────────────────

function views(run) {
  const ev = run.events;
  const assignedTasks = new Set();
  const assignedGoal = {};
  const certifyByTask = new Map();
  const clarifiedBefore = new Map(); // task -> earliest clarify order
  const reports = new Set(); // findingIds that were reported
  const acks = new Set(); // findingIds that were acked
  for (const e of ev) {
    if (e.type === 'assign') { assignedTasks.add(e.task); assignedGoal[e.task] = e.goal; }
    else if (e.type === 'certify' && !certifyByTask.has(e.task)) certifyByTask.set(e.task, e);
    else if (e.type === 'clarify') { if (!clarifiedBefore.has(e.task)) clarifiedBefore.set(e.task, e.order); }
    else if (e.type === 'report') reports.add(e.findingId);
    else if (e.type === 'ack') acks.add(e.findingId);
  }
  return { ev, assignedTasks, assignedGoal, certifyByTask, clarifiedBefore, reports, acks };
}

// ─── the 17 detectors ────────────────────────────────────────────────

export const ANOMALY_DETECTORS = [
  // ── Category 1: specification & system design ──
  {
    id: 'FM-1.1-disobey-task-specification', category: 'system-design',
    hypothesis: 'Every worker action is on a task its manager actually assigned.',
    detect(run) {
      const { ev, assignedTasks } = views(run);
      return ev.filter((e) => e.type === 'progress' && !assignedTasks.has(e.task)).length;
    },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'progress', actor: 'wkr-0', role: 'worker', task: 't-OFF-SPEC', goal: 'goal-0', stepHash: 'x', completeness: 1, intent: 'apply', effect: 'apply' }]); },
  },
  {
    id: 'FM-1.2-disobey-role-specification', category: 'system-design',
    hypothesis: 'Actions stay within role: only managers/director assign or re-plan; only workers progress.',
    detect(run) {
      return run.events.filter((e) =>
        ((e.type === 'assign' || e.type === 'replan') && e.role === 'worker') ||
        (e.type === 'progress' && e.role && e.role !== 'worker')).length;
    },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'replan', actor: 'wkr-3', role: 'worker', cause: 'usurp' }]); },
  },
  {
    id: 'FM-1.3-step-repetition', category: 'system-design',
    hypothesis: 'No worker redundantly repeats an identical step (same actor+task+stepHash).',
    detect(run) {
      const seen = new Set();
      let dup = 0;
      for (const e of run.events) {
        if (e.type !== 'progress') continue;
        const k = `${e.actor}|${e.task}|${e.stepHash}`;
        if (seen.has(k)) dup += 1; else seen.add(k);
      }
      return dup;
    },
    plant(seed) {
      const run = runFleet(seed);
      const p = run.events.find((e) => e.type === 'progress');
      return inject(run, [{ round: p.round, type: 'progress', actor: p.actor, role: 'worker', task: p.task, goal: p.goal, stepHash: p.stepHash, completeness: 1, intent: 'apply', effect: 'apply' }]);
    },
  },
  {
    id: 'FM-1.4-loss-of-conversation-history', category: 'system-design',
    hypothesis: 'No restorable history is dropped from context (offload keeps the pointer).',
    detect(run) { return run.events.filter((e) => e.type === 'historyDrop').length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'historyDrop', actor: 'director', reason: 'planted' }]); },
  },
  {
    id: 'FM-1.5-unaware-of-termination', category: 'system-design',
    hypothesis: 'No agent keeps acting on a task after it was certified done (no meltdown continuation).',
    detect(run) { return run.events.filter((e) => e.type === 'progress' && e.afterCertify === true).length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'progress', actor: 'wkr-0', role: 'worker', task: 't-0-wkr-0', goal: 'goal-0', stepHash: 'post', completeness: 1, intent: 'apply', effect: 'apply', afterCertify: true }]); },
  },

  // ── Category 2: inter-agent misalignment ──
  {
    id: 'FM-2.1-conversation-reset', category: 'inter-agent',
    hypothesis: 'No manager sub-ledger is reset mid-run (assignments are not lost).',
    detect(run) { return run.events.filter((e) => e.type === 'ledgerReset').length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'ledgerReset', actor: 'mgr-0', role: 'manager' }]); },
  },
  {
    id: 'FM-2.2-fail-to-ask-clarification', category: 'inter-agent',
    hypothesis: 'An ambiguous task is clarified before any progress is made on it.',
    detect(run) {
      const { ev, clarifiedBefore } = views(run);
      let miss = 0;
      for (const e of ev) {
        if (e.type !== 'progress' || e.ambiguous !== true) continue;
        const c = clarifiedBefore.get(e.task);
        if (c === undefined || c > e.order) miss += 1;
      }
      return miss;
    },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'progress', actor: 'wkr-4', role: 'worker', task: 't-ambiguous', goal: 'goal-0', stepHash: 'a', completeness: 1, intent: 'apply', effect: 'apply', ambiguous: true }]); },
  },
  {
    id: 'FM-2.3-task-derailment', category: 'inter-agent',
    hypothesis: 'Worker progress stays on the goal its manager assigned for that task.',
    detect(run) {
      const { ev, assignedGoal } = views(run);
      let off = 0;
      for (const e of ev) {
        if (e.type !== 'progress') continue;
        const g = assignedGoal[e.task];
        if (g !== undefined && e.goal !== undefined && e.goal !== g) off += 1;
      }
      return off;
    },
    plant(seed) { return inject(runFleet(seed), [
      { round: 99, type: 'assign', actor: 'mgr-0', role: 'manager', owner: 'wkr-0', task: 't-derail', goal: 'goal-0' },
      { round: 99, type: 'progress', actor: 'wkr-0', role: 'worker', task: 't-derail', goal: 'goal-WRONG', stepHash: 'd', completeness: 1, intent: 'apply', effect: 'apply' }]); },
  },
  {
    id: 'FM-2.4-information-withholding', category: 'inter-agent',
    hypothesis: 'Every finding a worker surfaces is reported upward (ground truth ≠ self-report).',
    detect(run) {
      const { ev, reports } = views(run);
      return ev.filter((e) => e.type === 'finding' && !reports.has(e.findingId)).length;
    },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'finding', actor: 'wkr-6', role: 'worker', task: 't-6', findingId: 'f-hidden' }]); },
  },
  {
    id: 'FM-2.5-ignored-other-agents-input', category: 'inter-agent',
    hypothesis: "Every escalated report is acknowledged (the recipient does not ignore input).",
    detect(run) {
      const { ev, acks } = views(run);
      return ev.filter((e) => e.type === 'report' && !acks.has(e.findingId)).length;
    },
    plant(seed) { return inject(runFleet(seed), [
      { round: 99, type: 'finding', actor: 'wkr-7', role: 'worker', task: 't-7', findingId: 'f-noack' },
      { round: 99, type: 'report', actor: 'wkr-7', role: 'worker', to: 'mgr-0', findingId: 'f-noack' }]); },
  },
  {
    id: 'FM-2.6-reasoning-action-mismatch', category: 'inter-agent',
    hypothesis: 'A worker\'s declared intent matches the action it actually executes.',
    detect(run) { return run.events.filter((e) => e.type === 'progress' && e.intent !== undefined && e.effect !== undefined && e.intent !== e.effect).length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'progress', actor: 'wkr-8', role: 'worker', task: 't-8', goal: 'goal-1', stepHash: 'm', completeness: 1, intent: 'apply', effect: 'other' }]); },
  },

  // ── Category 3: task verification & termination ──
  {
    id: 'FM-3.1-premature-termination', category: 'verification',
    hypothesis: 'No task is certified before it is complete (completeness == 1).',
    detect(run) { return run.events.filter((e) => e.type === 'certify' && e.completeness !== undefined && e.completeness < 1).length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'certify', actor: 'mgr-0', role: 'manager', worker: 'wkr-0', task: 't-early', verdict: 'pass', groundTruth: 'pass', completeness: 0.4 }]); },
  },
  {
    id: 'FM-3.2-no-or-incomplete-verification', category: 'verification',
    hypothesis: 'Every task that was worked to completion is certified by a verifier.',
    detect(run) {
      const { ev, certifyByTask } = views(run);
      const worked = new Set();
      for (const e of ev) if (e.type === 'progress' && e.completeness === 1 && e.afterCertify !== true) worked.add(e.task);
      let missing = 0;
      for (const t of worked) if (!certifyByTask.has(t)) missing += 1;
      return missing;
    },
    plant(seed) { return inject(runFleet(seed), [
      { round: 99, type: 'assign', actor: 'mgr-0', role: 'manager', owner: 'wkr-0', task: 't-noverify', goal: 'goal-0' },
      { round: 99, type: 'progress', actor: 'wkr-0', role: 'worker', task: 't-noverify', goal: 'goal-0', stepHash: 'n', completeness: 1, intent: 'apply', effect: 'apply' }]); },
  },
  {
    id: 'FM-3.3-incorrect-verification', category: 'verification',
    hypothesis: 'A passing certification matches ground truth (the verifier is not fooled by stale state).',
    detect(run) { return run.events.filter((e) => e.type === 'certify' && e.verdict !== undefined && e.groundTruth !== undefined && e.verdict !== e.groundTruth).length; },
    plant(seed) { return inject(runFleet(seed), [{ round: 99, type: 'certify', actor: 'mgr-0', role: 'manager', worker: 'wkr-0', task: 't-badcert', verdict: 'pass', groundTruth: 'fail', completeness: 1 }]); },
  },

  // ── Vending-Bench long-horizon collapse signatures ──
  {
    id: 'COLLAPSE-1-meltdown-loop', category: 'collapse',
    hypothesis: 'No agent enters an identical-action loop (a run of ≥ threshold identical tool calls).',
    detect(run) {
      const counts = {};
      for (const e of run.events) if (e.type === 'toolcall') counts[`${e.actor}|${e.loopHash}`] = (counts[`${e.actor}|${e.loopHash}`] ?? 0) + 1;
      return Object.values(counts).filter((n) => n >= run.cfg.meltdownRunThreshold).length;
    },
    plant(seed) {
      const run = runFleet(seed);
      const ev = [];
      for (let i = 0; i < run.cfg.meltdownRunThreshold + 2; i++) ev.push({ round: 99, type: 'toolcall', actor: 'wkr-0', role: 'worker', call: 'noop()', malformed: false, loopHash: 'MELT' });
      return inject(run, ev);
    },
  },
  {
    id: 'COLLAPSE-2-tool-syntax-degradation', category: 'collapse',
    hypothesis: 'Tool-call syntax does not degrade (no malformed tool calls accumulate).',
    detect(run) { return run.events.filter((e) => e.type === 'toolcall' && e.malformed === true).length; },
    plant(seed) {
      const run = runFleet(seed);
      const ev = [];
      for (let i = 0; i < 4; i++) ev.push({ round: 99, type: 'toolcall', actor: 'wkr-1', role: 'worker', call: 'brok(', malformed: true, loopHash: `S${i}` });
      return inject(run, ev);
    },
  },
  {
    id: 'COLLAPSE-3-state-misread-cascade', category: 'collapse',
    hypothesis: 'No cascade of stale reads (a state misread that spawns further stale reads).',
    detect(run) {
      const stale = run.events.filter((e) => e.type === 'read' && e.stale === true).length;
      return stale >= 2 ? stale : 0;
    },
    plant(seed) {
      const run = runFleet(seed);
      const ev = [];
      for (let i = 0; i < 4; i++) ev.push({ round: 99, type: 'read', actor: `wkr-${i}`, role: 'worker', key: 'k-0', stale: true, cascade: i });
      return inject(run, ev);
    },
  },
];

// ─── scoring a run ───────────────────────────────────────────────────

/**
 * Count anomalies over a fleet run, by mode + by category. The gate is
 * `total === 0`. Anti-gaming: the detectors read the run's ground-truth event
 * stream, never a self-reported "I'm clean" flag.
 */
export function detectAnomalies(run) {
  const byMode = {};
  const byCategory = {};
  let total = 0;
  for (const d of ANOMALY_DETECTORS) {
    const n = d.detect(run);
    byMode[d.id] = n;
    byCategory[d.category] = (byCategory[d.category] ?? 0) + n;
    total += n;
  }
  return { total, byMode, byCategory };
}

/** A run that trips EVERY mode at once — the planted-violation agent + the
 *  proof the taxonomy has full coverage (used by the preflight + tests). */
export function plantAllAnomalies(seed) {
  const run = runFleet(seed);
  const baseLen = run.events.length; // every d.plant(seed) shares this clean base
  for (const d of ANOMALY_DETECTORS) {
    // reuse each detector's own plant, folding just its injected tail onto ONE run.
    const planted = d.plant(seed);
    const injected = planted.events.slice(baseLen).map(({ order, ...e }) => e); // eslint-disable-line no-unused-vars
    inject(run, injected);
  }
  return run;
}

/** Coordination token-tax (CoAgent target ≈ 1.15×) — reported, not gated. */
export function coordinationTax(seed, cfg = {}) {
  return runFleet(seed, cfg).coordination.coordinationTax;
}

// ─── anomaly invariants (checker + planted-violation negative control) ─

/**
 * For every detector: the clean run scores 0 for that mode (checkOk) AND its
 * planted violation is caught (negativeControlCaught). Aggregate shape mirrors
 * the other phases so the scorecard consumes it uniformly.
 */
export function runAnomalyInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const d of ANOMALY_DETECTORS) {
    const clean = runFleet(1); // the clean fleet run
    const cleanCount = d.detect(clean);
    const plantedCount = d.detect(d.plant(1));
    const checkOk = cleanCount === 0;
    const negCaught = plantedCount > 0;
    if (!checkOk) safetyViolations += cleanCount;
    if (negCaught) negativeControlsCaught += 1;
    results.push({ id: d.id, category: d.category, hypothesis: d.hypothesis, checkOk, negativeControlCaught: negCaught, detail: `clean ${cleanCount}, planted ${plantedCount}` });
  }
  return { safetyViolations, negativeControlsCaught, invariantsTotal: ANOMALY_DETECTORS.length, results };
}
