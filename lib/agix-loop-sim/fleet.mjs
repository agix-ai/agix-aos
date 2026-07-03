// agix-loop-sim/fleet — the 32-agent fleet model (blueprint §4). A three-tier
// TREE (director → middle-managers → workers), Magentic-One ledgers with a
// stall-detector → re-plan rule, CoAgent-style MTPO coordination (fixed serial
// rank → predetermined order → provably deadlock-free; targeted repair; saga
// compensation), a structural actor≠verifier property, a single-leader property,
// and runtime-enforced anti-runaway caps.
//
// Pure / deterministic over a single seeded stream: no wall clock, no
// Math.random, no model / API / network. A "30h" horizon is SIMULATED-CLOCK
// time — the whole fleet run completes in milliseconds and spends zero tokens.
//
// GUARDS: the multi-agent reliability properties (ecosystem-sim/FLEET). MAST
// reports coordination as the dominant failure class (44% system-design + 32%
// inter-agent) — a SYSTEM-DESIGN problem, not a model problem, so it is fully
// modelable in a deterministic sim. Every structural property below is an
// assertable data structure with a checker + a planted-violation negative
// control (the self-testing-gate discipline), so a regression cannot slip past
// a green run.
//
// This module owns the fleet STRUCTURE + coordination + ledgers + the fleet
// invariants. The MAST-14 + collapse anomaly taxonomy that scores a fleet run
// lives in ./anomalies.mjs (it imports runFleet from here).

import { makePrng } from './prng.mjs';
import { fingerprint } from './record-replay.mjs';
import { runReservoir } from './context-reservoir.mjs';
import { runMemorySession, computeMemoryMetrics } from './memory-model.mjs';

export const DEFAULT_FLEET_CONFIG = {
  agents: 32, // worker count — the "32-agent fleet"; also the concurrency cap
  span: 8, // span-of-control: workers per middle-manager (tunable 4..8; 8 = STRESS)
  maxSpan: 8, // above the ~4-agent flat plateau → 8 is an explicit stress config
  rounds: 12, // coordination rounds (structural; endurance comes from the reservoir)
  hours: 30, // simulated-clock horizon fed to the reservoir + memory sub-models

  // anti-runaway ceilings (enforced by the runtime, not goodwill).
  concurrencyCap: 32,
  runTokenCeiling: 8_000_000,
  sessionTokenCeiling: 40_000_000,
  stallWindow: 3, // rounds with no progress on a manager → director re-plans

  // coordination token accounting (CoAgent target ≈ 1.15× vs the ideal).
  actionTokens: 120,
  actionsPerWorkerPerRound: 3,
  writeFraction: 0.34, // fraction of worker-rounds that issue a shared-state write
  sharedKeys: 6, // small shared-state keyspace → deterministic write contention
  notifyTokens: 90, // notify the higher-rank affected worker of a conflict
  reExecTokens: 132, // re-execute ONE stale-premised action (targeted repair)
  compensateTokens: 80, // saga inverse for one out-of-order write

  // seeded texture rates for the anomaly-relevant event streams.
  findingRate: 0.14, // worker-rounds that surface a finding (must be reported up)
  ambiguousRate: 0.1, // tasks that are ambiguous (must get a clarify first)
  meltdownRunThreshold: 5, // identical-action run length that reads as a meltdown loop
};

// ─── the tree (three tiers, never a mesh) ────────────────────────────

/**
 * Build the fleet tree: 1 director → ceil(agents/span) middle-managers → workers
 * (contiguous span-of-control blocks). Every worker gets a FIXED global serial
 * rank at launch — the CoAgent MTPO order that makes coordination deadlock-free.
 *
 * `flags.mesh` (negative control) returns a flat all-to-all wiring with no
 * single owner per node; `flags.orphanWorker` leaves one worker unowned.
 */
export function buildFleet(cfg = DEFAULT_FLEET_CONFIG, flags = {}) {
  const c = { ...DEFAULT_FLEET_CONFIG, ...cfg };
  const director = { id: 'director', role: 'director' };
  const managerCount = Math.ceil(c.agents / c.span);
  const managers = [];
  for (let m = 0; m < managerCount; m++) {
    managers.push({ id: `mgr-${m}`, role: 'manager', owner: director.id, goal: `goal-${m}`, workers: [] });
  }
  const workers = [];
  const ownerOfWorker = {};
  const ownerOfManager = {};
  for (const m of managers) ownerOfManager[m.id] = director.id;
  for (let w = 0; w < c.agents; w++) {
    const managerIdx = Math.floor(w / c.span);
    const managerId = `mgr-${managerIdx}`;
    const workerId = `wkr-${w}`;
    workers.push({ id: workerId, role: 'worker', owner: managerId, rank: w });
    ownerOfWorker[workerId] = managerId;
    managers[managerIdx].workers.push(workerId);
  }

  // Channel math: the tree is O(n) (director↔manager + manager↔worker); a flat
  // mesh would be n(n-1)/2. This is WHY we forbid a mesh.
  const treeChannels = managerCount + c.agents;
  const meshChannels = (c.agents * (c.agents - 1)) / 2;

  const fleet = { director, managers, workers, ownerOfWorker, ownerOfManager, managerCount, span: c.span, maxSpan: c.maxSpan, treeChannels, meshChannels, isMesh: false };

  // ── structural negative controls ──
  if (flags.mesh) {
    // A flat mesh: every worker is "connected" to every other → no single owner.
    fleet.isMesh = true;
    fleet.treeChannels = meshChannels;
    for (const w of workers) {
      w.owner = null;
      fleet.ownerOfWorker[w.id] = null;
    }
  }
  if (flags.orphanWorker && workers.length) {
    const orphan = workers[workers.length - 1];
    orphan.owner = null;
    fleet.ownerOfWorker[orphan.id] = null;
  }
  return fleet;
}

// ─── one deterministic fleet run ─────────────────────────────────────

/**
 * Simulate the fleet over `rounds` coordination rounds. Pure given (seed, cfg,
 * flags). Returns the ledgers, the normalized event stream (consumed by the
 * anomaly taxonomy), the coordination accounting (tax, wait-for graph, targeted
 * repair, saga compensation), the anti-runaway counters, and the coherence
 * signals sourced from the reservoir + memory sub-models (the ablation lever).
 *
 * `flags`:
 *   context: { noOffload, noPrune }   → reservoir ablation (drives collapse anomalies)
 *   memory:  { noForgetting }         → memory ablation (drives stale-read anomalies)
 *   agent:   'healthy'|'null'|'random'|'planted'  → preflight driver behaviors
 *   structural negative controls: mesh, orphanWorker, workerSelfCertify,
 *     managerReplans, uncapped, noStallDetector, cyclicWait, overRepair,
 *     noCompensation, noStall (alias)
 */
export function runFleet(seed, cfg = {}, flags = {}) {
  const c = { ...DEFAULT_FLEET_CONFIG, ...cfg };
  const prng = makePrng((seed >>> 0) ^ 0x7f4a7c15);
  const fleet = buildFleet(c, flags);

  // ── Magentic-One ledgers ──
  // Task Ledger: facts + the director's plan (one plan step per round).
  const taskLedger = {
    facts: [`agents=${c.agents}`, `span=${c.span}`, `rounds=${c.rounds}`],
    plan: Array.from({ length: c.rounds }, (_, r) => ({ step: r, goal: `phase-${r}` })),
    replans: [], // every entry MUST be authored by the director (single-leader)
  };
  // Progress Ledger: per-manager assignment + progress (owned by the director).
  const progressLedger = {};
  for (const m of fleet.managers) progressLedger[m.id] = { assigned: 0, done: 0, lastProgressRound: -1, stalledRounds: 0 };
  // Sub-ledgers: each manager tracks its own workers.
  const subLedgers = {};
  for (const m of fleet.managers) subLedgers[m.id] = { workers: m.workers.slice(), assigned: 0, done: 0 };

  const events = [];
  const writes = []; // { round, rank, workerId, key, value, order }
  let emitOrder = 0;
  const push = (e) => { events.push({ order: emitOrder++, ...e }); };

  let maxConcurrency = 0;
  let runTokens = 0;
  const breakerTrips = [];
  const findings = []; // { id, workerId, round, reported, acked }

  // ── coordination rounds ──
  for (let r = 0; r < c.rounds; r++) {
    // concurrency this round = every worker that acts (bounded by the cap).
    const active = fleet.workers.length;
    maxConcurrency = Math.max(maxConcurrency, active);

    for (const m of fleet.managers) {
      const goal = m.goal;
      let managerProgressed = false;
      // probe: starve mgr-0 of progress for stallWindow rounds so the stall
      // detector has something to fire on (FLEET-6 / FLEET-4 controls).
      if (flags.forceStall && m.id === 'mgr-0' && r <= c.stallWindow) {
        progressLedger[m.id].stalledRounds += 1;
        continue;
      }
      for (const workerId of m.workers) {
        const worker = fleet.workers.find((w) => w.id === workerId);
        const task = `t-${r}-${workerId}`;

        // director/manager assignment (ownership is a data structure).
        push({ round: r, type: 'assign', actor: m.id, role: 'manager', owner: workerId, task, goal, planStep: r });
        progressLedger[m.id].assigned += 1;
        subLedgers[m.id].assigned += 1;

        // ambiguous tasks must be clarified BEFORE any progress (FM-2.2).
        const ambiguous = prng.float() < c.ambiguousRate;
        if (ambiguous) push({ round: r, type: 'clarify', actor: workerId, role: 'worker', task, resolvedBy: m.id });

        // worker executes: investigation is context-isolated; the write below is
        // the only decision serialized on shared state. intent === effect (no
        // reasoning/action mismatch on the clean path).
        const stepHash = fingerprint({ task, r, rank: worker.rank });
        push({ round: r, type: 'progress', actor: workerId, role: 'worker', task, goal, stepHash, completeness: 1, intent: 'apply', effect: 'apply', ambiguous, certified: false });
        runTokens += c.actionsPerWorkerPerRound * c.actionTokens;
        managerProgressed = true;

        // a fraction of worker-rounds surface a finding → MUST be reported up and
        // acknowledged (FM-2.4 withholding / FM-2.5 ignored-input on the clean path).
        if (prng.float() < c.findingRate) {
          const fid = `f-${r}-${workerId}`;
          push({ round: r, type: 'finding', actor: workerId, role: 'worker', task, findingId: fid });
          push({ round: r, type: 'report', actor: workerId, role: 'worker', to: m.id, findingId: fid });
          push({ round: r, type: 'ack', actor: m.id, role: 'manager', findingId: fid });
          findings.push({ id: fid, workerId, round: r, reported: true, acked: true });
        }

        // a fraction of worker-rounds issue a shared-state write (a decision).
        if (prng.float() < c.writeFraction) {
          const key = `k-${prng.int(0, c.sharedKeys - 1)}`;
          const value = `v-${r}-${worker.rank}`;
          writes.push({ round: r, rank: worker.rank, workerId, key, value, order: writes.length });
        }

        // ACTOR ≠ VERIFIER: the worker NEVER closes its own task; the manager
        // certifies (kills the whole MAST FC3 verification category).
        // negative control: a worker certifies its own task (violates actor≠verifier).
        const certifier = flags.workerSelfCertify ? workerId : m.id;
        push({ round: r, type: 'certify', actor: certifier, role: flags.workerSelfCertify ? 'worker' : 'manager', worker: workerId, task, verdict: 'pass', groundTruth: 'pass', completeness: 1 });
        progressLedger[m.id].done += 1;
        subLedgers[m.id].done += 1;
      }
      if (managerProgressed) {
        progressLedger[m.id].lastProgressRound = r;
        progressLedger[m.id].stalledRounds = 0;
      } else {
        progressLedger[m.id].stalledRounds += 1;
      }
    }

    // SINGLE-LEADER: only the director re-plans. Stall detector → re-plan
    // (Magentic-One): a manager with no progress for `stallWindow` rounds forces
    // a plan rewrite. On the clean path every manager progresses each round, so
    // the detector is ARMED but does not need to fire — we prove it fires under
    // the negative control instead.
    if (!flags.noStallDetector && !flags.noStall) {
      for (const m of fleet.managers) {
        if (progressLedger[m.id].stalledRounds >= c.stallWindow) {
          const actor = flags.managerReplans ? m.id : fleet.director.id; // negative control: a manager re-plans
          taskLedger.plan.push({ step: taskLedger.plan.length, goal: `replan-after-stall@${r}`, cause: m.id });
          taskLedger.replans.push({ round: r, actor, cause: m.id });
          push({ round: r, type: 'replan', actor, role: actor === fleet.director.id ? 'director' : 'manager', cause: m.id });
          progressLedger[m.id].stalledRounds = 0;
        }
      }
    }

    // Circuit breaker: the director checks the run-token ceiling BEFORE the next
    // round (anti-runaway). On the clean path it never trips.
    if (!flags.uncapped) {
      push({ round: r, type: 'breaker', actor: fleet.director.id, role: 'director', runTokens, tripped: runTokens > c.runTokenCeiling });
      if (runTokens > c.runTokenCeiling) breakerTrips.push({ round: r, runTokens });
    }
  }

  // ── CoAgent MTPO coordination accounting ──
  const coordination = computeCoordination(writes, c, flags);

  // ── anti-runaway counters ──
  const sessionTokens = runTokens + coordination.overheadTokens;
  const runaway = {
    maxConcurrency,
    concurrencyCap: c.concurrencyCap,
    runTokens: runTokens + coordination.overheadTokens,
    runCeiling: c.runTokenCeiling,
    sessionTokens,
    sessionCeiling: c.sessionTokenCeiling,
    breakerPresent: !flags.uncapped,
    breakerTrips,
    stallDetectorPresent: !(flags.noStallDetector || flags.noStall),
  };
  if (flags.uncapped) {
    // negative control: no breaker → a runaway loop blows past the ceiling.
    runaway.runTokens = c.runTokenCeiling * 12;
    runaway.sessionTokens = c.sessionTokenCeiling * 12;
    runaway.maxConcurrency = c.concurrencyCap + 40;
  }

  // ── coherence signals (the ablation lever) ──
  const ctxFlags = flags.context ?? {};
  const memFlags = flags.memory ?? {};
  const reservoir = runReservoir(seed, { hours: c.hours }, ctxFlags);
  const memSession = runMemorySession(seed, {}, memFlags);
  const memMetrics = computeMemoryMetrics(memSession, memFlags);
  const kneeUtil = reservoir.cfg.kneeUtil;
  const contextRot = reservoir.summary.maxUtil >= kneeUtil; // crossed the rot-knee
  const coherence = {
    contextCollapsed: reservoir.summary.collapsed,
    hoursToCollapse: reservoir.summary.hoursToCollapse,
    contextSlope: reservoir.summary.contextSlope,
    maxUtil: reservoir.summary.maxUtil,
    kneeUtil,
    contextRot,
    // "context bounded" = below the rot-knee AND no collapse (the endurance win).
    contextBounded: reservoir.summary.maxUtil < kneeUtil && !reservoir.summary.collapsed,
    FAA: memMetrics.FAA,
    MPA: memMetrics.MPA,
    staleLeak: memMetrics.FAA < 0.9,
    mpaBroken: memMetrics.MPA < 1,
  };

  const run = {
    seed,
    cfg: c,
    flags,
    fleet,
    taskLedger,
    progressLedger,
    subLedgers,
    events,
    coordination,
    runaway,
    coherence,
    findings,
  };

  // ── driver-behavior transforms (preflight agents) ──
  if (flags.agent && flags.agent !== 'healthy') applyAgent(run, flags.agent, prng);

  // ── coherence-driven anomaly injection (the ablation arms) ──
  injectCoherenceAnomalies(run);

  run.summary = summarizeFleet(run);
  return run;
}

/** CoAgent MTPO coordination: rank-serialized writes → deadlock-free; targeted
 *  repair of only stale-premised actions; saga compensation of out-of-order
 *  writes. Returns the accounting + the wait-for graph + the resolved states. */
function computeCoordination(writes, c, flags) {
  // Group writes by key; a key with ≥2 distinct-rank writers is a conflict.
  const byKey = {};
  for (const w of writes) (byKey[w.key] ??= []).push(w);

  let conflicts = 0;
  let repairCount = 0; // # of stale-premised actions re-executed (TARGETED, not all)
  let compensations = 0; // # of out-of-order writes undone via a saga inverse
  const repairSet = [];
  const waitFor = {}; // rank -> Set(rank) : who waits on whom (must stay acyclic)
  const rankOrderState = {}; // state if writes apply in serial-RANK order (highest rank wins)
  const arrivalState = {}; // state if writes apply in ARRIVAL order (last emitted wins)

  for (const [key, group] of Object.entries(byKey)) {
    // arrival order = emission order.
    const arrival = group.slice().sort((a, b) => a.order - b.order);
    for (const w of arrival) arrivalState[key] = w.value;
    // rank order = ascending rank; highest rank wins (applied last).
    const byRank = group.slice().sort((a, b) => a.rank - b.rank);
    const winner = byRank[byRank.length - 1];
    rankOrderState[key] = winner.value;

    // A conflict needs ≥2 DISTINCT ranks (two different workers). Same-worker
    // re-writes are not cross-agent contention and never wait on themselves.
    const distinctRanks = new Set(group.map((w) => w.rank));
    if (distinctRanks.size >= 2) {
      conflicts += 1;
      // targeted repair: every strictly-lower-rank write premised a downstream
      // action on a value the winner overwrote → exactly those re-execute (not
      // the whole set). Edges point UP in rank only → total order → acyclic
      // (never a self-edge, so the deadlock-freedom proof holds).
      for (const w of byRank) {
        if (w.rank >= winner.rank) continue;
        repairCount += 1;
        repairSet.push({ key, rank: w.rank, order: w.order });
        (waitFor[w.rank] ??= new Set()).add(winner.rank);
      }
      // saga compensation: any lower-rank write that ARRIVED after the winner
      // would have clobbered it → undo via the pre-registered inverse.
      for (const w of arrival) {
        if (w.rank < winner.rank && w.order > winner.order) compensations += 1;
      }
    }
  }

  // ── negative controls ──
  if (flags.cyclicWait) {
    // introduce a back-edge: a higher rank waits on a lower rank → a cycle.
    const ranks = Object.keys(waitFor);
    if (ranks.length) {
      const lo = Number(ranks[0]);
      const hi = [...waitFor[lo]][0];
      (waitFor[hi] ??= new Set()).add(lo); // hi→lo closes the cycle lo→hi→lo
    } else {
      waitFor[1] = new Set([2]);
      waitFor[2] = new Set([1]);
    }
  }
  if (flags.overRepair) {
    // over-repair: re-execute EVERY action, not just the stale-premised ones.
    repairCount = writes.length;
    repairSet.length = 0;
    for (const w of writes) repairSet.push({ key: w.key, rank: w.rank, order: w.order });
  }

  const totalActions = Math.max(1, writes.length * 1 + c.agents * c.rounds * c.actionsPerWorkerPerRound);
  const baselineTokens = totalActions * c.actionTokens;
  const overheadTokens = conflicts * c.notifyTokens + repairCount * c.reExecTokens + compensations * c.compensateTokens;
  const coordinationTax = round6((baselineTokens + overheadTokens) / baselineTokens);

  // final state: healthy MTPO applies in RANK order (compensating out-of-order
  // arrivals) → linearizable to the serial order. Skipping compensation (negative
  // control) leaves the ARRIVAL state, which diverges when there are conflicts.
  const finalState = flags.noCompensation ? arrivalState : rankOrderState;

  return {
    conflicts,
    repairCount,
    repairSet,
    compensations,
    waitFor,
    rankOrderState,
    arrivalState,
    finalState,
    baselineTokens,
    overheadTokens,
    coordinationTax,
    writeCount: writes.length,
  };
}

/** Preflight driver behaviors that must NOT score anomaly-0 (harness self-check). */
function applyAgent(run, agent, prng) {
  if (agent === 'null') {
    // A null agent does nothing useful: strip all verification, reporting, and
    // acknowledgement. Work happens but nothing is certified or escalated →
    // FM-3.2 (no verification) + FM-2.4 (withholding) light up.
    run.events = run.events.filter((e) => e.type !== 'certify' && e.type !== 'report' && e.type !== 'ack');
    for (const f of run.findings) { f.reported = false; f.acked = false; }
    return;
  }
  if (agent === 'random') {
    // A random agent corrupts a seeded subset of events across many modes.
    for (const e of run.events) {
      if (e.type === 'certify' && prng.float() < 0.3) e.actor = e.worker; // self-certify (FM verification)
      if (e.type === 'progress' && prng.float() < 0.2) e.effect = 'other'; // reasoning/action mismatch (FM-2.6)
      if (e.type === 'progress' && prng.float() < 0.15) e.ambiguous = true; // ambiguous, no clarify (FM-2.2)
    }
    run.coordination.finalState = run.coordination.arrivalState; // no compensation
    run.runaway.maxConcurrency = run.runaway.concurrencyCap + 9; // blow the cap
    return;
  }
  // 'planted' is handled by anomalies.plantAll (injects one of every mode).
}

/** Inject the collapse / stale anomalies implied by the coherence signals. On
 *  the healthy ("both mechanisms on") path there is no collapse and no stale
 *  leak → nothing is injected → the run stays anomaly-0. */
function injectCoherenceAnomalies(run) {
  const { coherence } = run;
  let ord = run.events.length ? run.events[run.events.length - 1].order + 1 : 0;
  const add = (e) => run.events.push({ order: ord++, ...e });

  const r = run.cfg.rounds;
  // Crossing the rot-knee (even without full collapse) is a bounded-context
  // failure: restorable history is dropped and tool calls degrade (FM-1.4 +
  // tool-syntax signature). This is the no-offload arm — prune keeps it from
  // fully collapsing, but it is no longer BOUNDED below the knee.
  if (coherence.contextRot || coherence.contextCollapsed) {
    add({ round: r, type: 'historyDrop', actor: 'director', reason: 'context-rot' });
    for (let i = 0; i < 4; i++) add({ round: r, type: 'toolcall', actor: 'wkr-1', role: 'worker', call: 'brok(', malformed: true, loopHash: `S${i}` });
  }
  if (coherence.contextCollapsed) {
    // meltdown: activity continues past a certified-done task (FM-1.5) + an
    // identical-action loop (Vending-Bench meltdown signature).
    add({ round: r + 1, type: 'progress', actor: 'wkr-0', role: 'worker', task: 't-0-wkr-0', goal: 'goal-0', stepHash: 'post', completeness: 1, intent: 'apply', effect: 'apply', afterCertify: true });
    for (let i = 0; i < run.cfg.meltdownRunThreshold + 2; i++) add({ round: r + 1, type: 'toolcall', actor: 'wkr-0', role: 'worker', call: 'noop()', malformed: false, loopHash: 'MELT' });
    // tool-call syntax degrades (Vending-Bench signature).
    for (let i = 0; i < 4; i++) add({ round: r + 1, type: 'toolcall', actor: 'wkr-1', role: 'worker', call: 'brok(', malformed: true, loopHash: `S${i}` });
  }
  if (coherence.staleLeak || coherence.mpaBroken) {
    // a verifier certifies against a stale/failed ground truth (FM-3.3) and stale
    // reads cascade (Vending-Bench state-misread cascade).
    add({ round: run.cfg.rounds, type: 'certify', actor: 'mgr-0', role: 'manager', worker: 'wkr-2', task: 't-stale', verdict: 'pass', groundTruth: 'fail', completeness: 1 });
    for (let i = 0; i < 4; i++) add({ round: run.cfg.rounds, type: 'read', actor: `wkr-${i}`, role: 'worker', key: 'k-0', stale: true, cascade: i });
  }
}

function summarizeFleet(run) {
  const c = run.cfg;
  return {
    agents: c.agents,
    span: c.span,
    managerCount: run.fleet.managerCount,
    rounds: c.rounds,
    treeChannels: run.fleet.treeChannels,
    meshChannels: run.fleet.meshChannels,
    coordinationTax: run.coordination.coordinationTax,
    conflicts: run.coordination.conflicts,
    repairCount: run.coordination.repairCount,
    compensations: run.coordination.compensations,
    maxConcurrency: run.runaway.maxConcurrency,
    runTokens: run.runaway.runTokens,
    events: run.events.length,
    contextCollapsed: run.coherence.contextCollapsed,
    hoursToCollapse: run.coherence.hoursToCollapse,
    contextSlope: run.coherence.contextSlope,
  };
}

/** A determinism fingerprint over the whole fleet run. */
export function fleetFingerprint(run) {
  return fingerprint({
    fleet: { ownerOfWorker: run.fleet.ownerOfWorker, treeChannels: run.fleet.treeChannels },
    events: run.events,
    coordination: { tax: run.coordination.coordinationTax, finalState: run.coordination.finalState, repairCount: run.coordination.repairCount, compensations: run.coordination.compensations },
    runaway: run.runaway,
    coherence: run.coherence,
  });
}

// ─── cycle detection (for the deadlock-freedom proof) ────────────────

/** True iff the wait-for adjacency (rank -> Set(rank)) contains a cycle. */
export function hasCycle(adj) {
  const color = {}; // 0=unvisited, 1=in-stack, 2=done
  const nodes = new Set(Object.keys(adj).map(Number));
  for (const outs of Object.values(adj)) for (const v of outs) nodes.add(Number(v));
  const dfs = (u) => {
    color[u] = 1;
    for (const v of adj[u] ?? []) {
      if (color[v] === 1) return true;
      if (!color[v] && dfs(v)) return true;
    }
    color[u] = 2;
    return false;
  };
  for (const n of nodes) if (!color[n] && dfs(n)) return true;
  return false;
}

// ─── fleet invariants (checker + probe + planted-violation control) ──

/** FLEET-1: three-tier TREE with complete single-owner ownership, span within
 *  bound, channel count O(n) not O(n²). */
export function treeOwnershipChecker(seed, cfg, flags) {
  const fleet = buildFleet({ ...DEFAULT_FLEET_CONFIG, ...cfg }, flags);
  const violations = [];
  if (fleet.isMesh) violations.push({ mesh: true, channels: fleet.treeChannels });
  for (const w of fleet.workers) {
    const owner = fleet.ownerOfWorker[w.id];
    if (!owner) violations.push({ worker: w.id, owner });
    else if (!fleet.managers.some((m) => m.id === owner)) violations.push({ worker: w.id, badOwner: owner });
  }
  for (const m of fleet.managers) {
    if (fleet.ownerOfManager[m.id] !== fleet.director.id) violations.push({ manager: m.id });
    if (m.workers.length > fleet.maxSpan) violations.push({ manager: m.id, span: m.workers.length });
  }
  if (fleet.treeChannels >= fleet.meshChannels && fleet.workers.length > 3) violations.push({ channels: fleet.treeChannels, mesh: fleet.meshChannels });
  const ok = violations.length === 0;
  return { ok, violations, detail: `channels ${fleet.treeChannels} (mesh ${fleet.meshChannels}), managers ${fleet.managerCount}` };
}

/** FLEET-2: rank-serialized coordination is deadlock-free (wait-for is acyclic). */
export function deadlockFreeChecker(seed, cfg, flags) {
  const run = runFleet(seed, cfg, flags);
  const cyclic = hasCycle(run.coordination.waitFor);
  const ok = !cyclic;
  return { ok, violations: ok ? [] : [{ cyclic: true }], detail: `wait-for cyclic=${cyclic}, conflicts ${run.coordination.conflicts}` };
}

/** FLEET-3: actor ≠ verifier — no worker ever certifies its own task. */
export function actorVerifierChecker(seed, cfg, flags) {
  const run = runFleet(seed, cfg, flags);
  const violations = run.events.filter((e) => e.type === 'certify' && e.actor === e.worker).map((e) => ({ task: e.task, self: e.actor }));
  const ok = violations.length === 0;
  return { ok, violations, detail: `${run.events.filter((e) => e.type === 'certify').length} certifications, ${violations.length} self-certified` };
}

/** FLEET-4: single-leader — only the director re-plans (and holds the breaker). */
export function singleLeaderChecker(seed, cfg, flags) {
  const run = runFleet(seed, cfg, flags);
  const badReplan = run.taskLedger.replans.filter((rp) => rp.actor !== run.fleet.director.id);
  const badBreaker = run.events.filter((e) => e.type === 'breaker' && e.actor !== run.fleet.director.id);
  const violations = [...badReplan.map((x) => ({ replanBy: x.actor })), ...badBreaker.map((x) => ({ breakerBy: x.actor }))];
  const ok = violations.length === 0;
  return { ok, violations, detail: `${run.taskLedger.replans.length} replans, all director=${ok}` };
}

/** FLEET-5: anti-runaway caps hold (concurrency + run + session token ceilings,
 *  breaker present). */
export function antiRunawayChecker(seed, cfg, flags) {
  const run = runFleet(seed, cfg, flags);
  const rw = run.runaway;
  const violations = [];
  if (rw.maxConcurrency > rw.concurrencyCap) violations.push({ concurrency: rw.maxConcurrency, cap: rw.concurrencyCap });
  if (rw.runTokens > rw.runCeiling) violations.push({ runTokens: rw.runTokens, ceiling: rw.runCeiling });
  if (rw.sessionTokens > rw.sessionCeiling) violations.push({ sessionTokens: rw.sessionTokens, ceiling: rw.sessionCeiling });
  if (!rw.breakerPresent) violations.push({ breaker: 'absent' });
  const ok = violations.length === 0;
  return { ok, violations, detail: `concurrency ${rw.maxConcurrency}/${rw.concurrencyCap}, runTokens ${rw.runTokens}/${rw.runCeiling}` };
}

/** FLEET-6: stall-detector → re-plan actually fires (and only the director does
 *  the re-planning). The probe forces a stall; the negative control removes the
 *  detector so the stall is never resolved. */
export function stallReplanChecker(seed, cfg, flags) {
  // Probe: force a manager to stall by starving progress for stallWindow rounds.
  const run = runFleet(seed, { ...cfg }, { ...flags, forceStall: true });
  // With forceStall the sim marks mgr-0 as stalled; a healthy detector re-plans.
  const fired = run.taskLedger.replans.length > 0;
  const allDirector = run.taskLedger.replans.every((rp) => rp.actor === run.fleet.director.id);
  const ok = fired && allDirector;
  return { ok, violations: ok ? [] : [{ fired, allDirector }], detail: `replans ${run.taskLedger.replans.length}, allDirector ${allDirector}` };
}

/** FLEET-7: targeted repair + saga compensation → the final shared state is
 *  linearizable to the serial rank order, and ONLY stale-premised actions
 *  re-execute (not the whole set). */
export function coordinationRepairChecker(seed, cfg, flags) {
  const run = runFleet(seed, cfg, flags);
  const co = run.coordination;
  const linearizable = deepEqual(co.finalState, co.rankOrderState);
  // targeted: repairCount equals the number of non-winner writes (stale-premised),
  // which is (writers-per-conflict − 1) summed — never the whole action set.
  const targeted = co.repairCount <= co.writeCount && co.repairCount < run.events.length;
  const violations = [];
  if (!linearizable) violations.push({ finalState: co.finalState, expected: co.rankOrderState });
  if (!targeted) violations.push({ repairCount: co.repairCount, actions: run.events.length });
  const ok = violations.length === 0;
  return { ok, violations, detail: `linearizable ${linearizable}, repair ${co.repairCount} (targeted ${targeted}), compensations ${co.compensations}` };
}

export const FLEET_INVARIANTS = [
  {
    id: 'FLEET-1-tree-not-mesh-complete-ownership',
    hypothesis: 'The fleet is a three-tier tree: every worker has exactly one manager owner, span ≤ maxSpan, channels O(n) not O(n²).',
    check() { return treeOwnershipChecker(1, {}, {}); },
    negativeControl() { return treeOwnershipChecker(1, {}, { mesh: true }); },
  },
  {
    id: 'FLEET-2-deadlock-free-rank-serialized',
    hypothesis: 'Rank-serialized (MTPO) coordination is deadlock-free: the wait-for graph is acyclic.',
    check() { return deadlockFreeChecker(2, {}, {}); },
    negativeControl() { return deadlockFreeChecker(2, {}, { cyclicWait: true }); },
  },
  {
    id: 'FLEET-3-actor-not-verifier',
    hypothesis: 'No worker closes its own task — the manager/verifier certifies (kills MAST FC3).',
    check() { return actorVerifierChecker(3, {}, {}); },
    negativeControl() { return actorVerifierChecker(3, {}, { workerSelfCertify: true }); },
  },
  {
    id: 'FLEET-4-single-leader',
    hypothesis: 'Only the director re-plans and holds the circuit breaker (single-leader property).',
    check() { return singleLeaderChecker(4, {}, {}); },
    negativeControl() { return singleLeaderChecker(4, {}, { managerReplans: true, forceStall: true }); },
  },
  {
    id: 'FLEET-5-anti-runaway-caps',
    hypothesis: 'Concurrency, per-run and per-session token ceilings hold and the breaker is present.',
    check() { return antiRunawayChecker(5, {}, {}); },
    negativeControl() { return antiRunawayChecker(5, {}, { uncapped: true }); },
  },
  {
    id: 'FLEET-6-stall-detector-replan',
    hypothesis: 'A stalled manager triggers a director re-plan (Magentic-One stall → re-plan).',
    check() { return stallReplanChecker(6, {}, {}); },
    negativeControl() { return stallReplanChecker(6, {}, { noStallDetector: true }); },
  },
  {
    id: 'FLEET-7-targeted-repair-saga-compensation',
    hypothesis: 'Final shared state is linearizable to the serial rank order and only stale-premised actions re-execute.',
    check() { return coordinationRepairChecker(7, {}, {}); },
    negativeControl() { return coordinationRepairChecker(7, {}, { noCompensation: true, overRepair: true }); },
  },
];

/** Run every fleet invariant + its negative control (aggregate shape mirrors the
 *  other phases so the scorecard consumes it uniformly). */
export function runFleetInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const inv of FLEET_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    if (!pos.ok) safetyViolations += Math.max(1, pos.violations.length);
    if (!neg.ok) negativeControlsCaught += 1;
    results.push({ id: inv.id, hypothesis: inv.hypothesis, checkOk: pos.ok, negativeControlCaught: !neg.ok, detail: pos.detail });
  }
  return { safetyViolations, negativeControlsCaught, invariantsTotal: FLEET_INVARIANTS.length, results };
}

// ─── small helpers ───────────────────────────────────────────────────

function deepEqual(a, b) {
  return fingerprint(a) === fingerprint(b);
}

function round6(x) {
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x;
}
