// agix-ecosystem-sim — unit + falsification tests for the ecosystem sim.
// Runner: node --test test/agix-ecosystem-sim.test.mjs
//
// Phases 1–3 of the 30h single-leader endurance / context-efficiency / memory
// test (blueprint: docs/strategy/2026-07-03-ecosystem-sim-test-design.md).
// Everything is pure-synthetic and deterministic — no clock, no Math.random,
// no model / API / network. Covers each module's units, byte-identical
// determinism, and — the point of the exercise — every negative control
// (proving each detector can fail).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Phase 1: record / replay ────────────────────────────────────────

import {
  record,
  replay,
  ReplayError,
  fingerprintLog,
  replayDeterminismChecker,
  makeSyntheticRun,
  runReplayInvariants,
  REPLAY_INVARIANTS,
  liveModelEnabled,
  liveModelCall,
  stableStringify,
  fingerprint,
} from '../lib/agix-loop-sim/record-replay.mjs';

test('record/replay: a seeded run records every transition and replays byte-identically', () => {
  const run = makeSyntheticRun(123, { steps: 16 });
  const a = record(run, { seed: 123, runId: 'r' });
  const b = record(run, { seed: 123, runId: 'r' });
  assert.equal(fingerprintLog(a), fingerprintLog(b));
  // Replay round-trips and consumes exactly the recorded events.
  const rp = replay(a, run);
  assert.equal(rp.steps, a.events.length);
  assert.deepEqual(rp.output, a.output);
});

test('record: monotonic step IDs, one run ID, model params recorded AS-SENT', () => {
  const run = makeSyntheticRun(5, { steps: 4 });
  const log = record(run, { seed: 5, runId: 'as-sent' });
  log.events.forEach((e, i) => {
    assert.equal(e.step, i, 'step IDs are monotonic');
    assert.equal(e.runId, 'as-sent', 'single run ID');
  });
  const firstModel = log.events.find((e) => e.kind === 'model');
  assert.ok(firstModel.params && 'temperature' in firstModel.params, 'sampling params captured even though the oracle may ignore them');
});

test('replay: an un-recorded call fails loudly (no silent live fallthrough)', () => {
  const run = makeSyntheticRun(9, { steps: 4 });
  const log = record(run, { seed: 9 });
  const greedy = (io) => {
    run(io);
    io.world('ghost', () => 1); // extra, un-recorded
  };
  assert.throws(() => replay(log, greedy), ReplayError);
});

test('replay: a kind/key divergence throws rather than returning a mismatched value', () => {
  const run = makeSyntheticRun(9, { steps: 4 });
  const log = record(run, { seed: 9 });
  const wrong = (io) => io.model('NOPE', {}, () => 'x');
  assert.throws(() => replay(log, wrong), ReplayError);
});

test('replay determinism gate: two records of the same seed match', () => {
  const g = replayDeterminismChecker(makeSyntheticRun(77, { steps: 20 }), { seed: 77 });
  assert.equal(g.ok, true);
  assert.equal(g.fpA, g.fpB);
});

test('Phase 1 NEGATIVE CONTROLS: every replay invariant catches its planted violation', () => {
  for (const inv of REPLAY_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    assert.equal(pos.ok, true, `${inv.id} should hold: ${pos.detail || ''}`);
    assert.equal(neg.ok, false, `${inv.id} negative control MUST be caught`);
  }
});

test('runReplayInvariants: 0 safety violations, all negative controls caught, stable fingerprint', () => {
  const r = runReplayInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, r.invariantsTotal);
  assert.equal(r.fingerprintStable, true);
});

test('live-model tier is DISABLED in this build (pure-synthetic, zero API)', () => {
  assert.equal(liveModelEnabled(), false, 'AGIX_SIM_LIVE_MODEL must be unset by default');
  assert.throws(() => liveModelCall(), /not enabled in this build/);
});

test('shared determinism helpers: stableStringify sorts keys, fingerprint is stable', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(fingerprint({ x: [1, 2, 3] }), fingerprint({ x: [1, 2, 3] }));
  assert.equal(stableStringify({ v: Infinity }), '{"v":"Infinity"}');
});

// ─── Phase 2: memory model ───────────────────────────────────────────

import {
  classifyTier,
  decay,
  salience,
  ingestionGuard,
  consolidationGuard,
  retrievalGuard,
  createStore,
  ingest,
  retrieve,
  consolidate,
  prune,
  generateMemoryStream,
  runMemorySession,
  computeMemoryMetrics,
  consolidationIdempotence,
  runMemoryInvariants,
  MEMORY_INVARIANTS,
  memorySessionFingerprint,
  TIERS,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_TIER_DECAY,
} from '../lib/agix-loop-sim/memory-model.mjs';

test('classifyTier: the explicit classifier routes typed features to the right tier', () => {
  assert.equal(classifyTier({ kind: 'preference', subject: 'user' }), 'Relationship');
  assert.equal(classifyTier({ kind: 'process', subject: 'team' }), 'Organizational');
  assert.equal(classifyTier({ kind: 'goal', subject: 'org' }), 'Strategic');
  assert.equal(classifyTier({ kind: 'audit', immutable: true }), 'Institutional');
  // scramble (negative-control only) deterministically mis-routes.
  assert.notEqual(classifyTier({ kind: 'goal' }, { scramble: true }), 'Strategic');
});

test('decay: Weibull is 1 at Δτ=0 and monotonically decreasing; retrieval resets Δτ', () => {
  const p = DEFAULT_TIER_DECAY.Organizational;
  assert.equal(decay(0, p), 1);
  assert.ok(decay(5, p) > decay(20, p));
  assert.ok(decay(20, p) > 0 && decay(20, p) < 1);
});

test('salience: importance and retrieval both raise salience; ablation drops the retrieval reward', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;
  const base = { tier: 'Organizational', importance: 0.1, retrievalCount: 0, createdHour: 0, lastRetrievalHour: 0 };
  const retrieved = { ...base, retrievalCount: 4, lastRetrievalHour: 20 };
  assert.ok(salience(retrieved, 20, cfg) > salience(base, 20, cfg));
  // Under the no-reinforcement ablation the retrieval-count reward is removed.
  assert.ok(salience(retrieved, 20, cfg, { fromCreation: true }) < salience(retrieved, 20, cfg));
});

test('pipeline guards: ingestion rejects low trust; consolidation rejects core contradiction; retrieval flags conflicts', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;
  assert.equal(ingestionGuard({ trustScore: 0.1 }, cfg).pass, false);
  assert.equal(ingestionGuard({ trustScore: 0.9 }, cfg).pass, true);
  const core = { id: 'x', key: 'k', value: 'a', provenance: true };
  assert.equal(consolidationGuard({ key: 'k', value: 'b' }, core).pass, false);
  assert.equal(consolidationGuard({ key: 'k', value: 'a' }, core).pass, true);
  // Two OPEN (valid) candidates disagree → conflict flagged, never merged.
  const rg = retrievalGuard([{ id: '1', key: 'k', value: 'a', staleAtHour: null, createdHour: 1, provenance: false }, { id: '2', key: 'k', value: 'b', staleAtHour: null, createdHour: 2, provenance: true }], 10);
  assert.equal(rg.conflict, true, 'conflicting values are flagged, never silently merged');
  assert.equal(rg.chosen.id, '2', 'prefers the provenance candidate');
  // A stale candidate is skipped in favour of the open validity window.
  const rg2 = retrievalGuard([{ id: '1', key: 'k', value: 'a', staleAtHour: 5, createdHour: 1, provenance: false }, { id: '2', key: 'k', value: 'b', staleAtHour: null, createdHour: 2, provenance: false }], 10);
  assert.equal(rg2.chosen.id, '2', 'prefers the open validity window');
  assert.equal(rg2.conflict, false, 'only one candidate is still valid → no conflict');
});

test('capture: novelty gate turns a re-emitted duplicate into a NOOP (no write amplification)', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;
  const store = createStore();
  const ev = { id: 'e1', hour: 0, features: { kind: 'process', subject: 'team' }, groundTruthTier: 'Organizational', key: 'k', content: 'c', importance: 0.4, provenanceFlag: false, trustScore: 1, retrievalSchedule: [], staleAtHour: null };
  const first = ingest(store, ev, cfg);
  const second = ingest(store, { ...ev, id: 'e2' }, cfg);
  assert.equal(first.op, 'ADD');
  assert.equal(second.op, 'NOOP');
});

test('capture: Institutional writes are ADD-only (append tombstone), never destructive', () => {
  const s = runMemorySession(1);
  const instOps = s.store.opLog.filter((o) => o.tier === 'Institutional');
  assert.ok(instOps.every((o) => o.op === 'ADD' || o.op === 'NOOP'), 'Institutional is append-only');
});

test('retrieve: reinforces the chosen leaf (resets Δτ, bumps retrieval count)', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;
  const store = createStore();
  ingest(store, { id: 'e', hour: 0, features: { kind: 'process' }, groundTruthTier: 'Organizational', key: 'k', content: 'c', importance: 0.4, provenanceFlag: false, trustScore: 1, retrievalSchedule: [], staleAtHour: null }, cfg);
  const { leaf } = retrieve(store, 'k', 12);
  assert.equal(leaf.retrievalCount, 1);
  assert.equal(leaf.lastRetrievalHour, 12);
});

test('generateMemoryStream: byte-identical per seed; every event carries the FAMA seed tuple', () => {
  const a = generateMemoryStream(5);
  const b = generateMemoryStream(5);
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  for (const ev of a.events) {
    assert.ok('groundTruthTier' in ev && 'importance' in ev && 'provenanceFlag' in ev && 'staleAtHour' in ev && 'retrievalSchedule' in ev);
  }
});

test('runMemorySession: deterministic (byte-identical stored surface on rerun)', () => {
  assert.equal(memorySessionFingerprint(runMemorySession(3)), memorySessionFingerprint(runMemorySession(3)));
});

test('memory metrics: MPA==1.0, FAA→1, FAMA clears threshold, ~5x reduction, twin reinforced (multi-seed)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = computeMemoryMetrics(runMemorySession(seed));
    assert.equal(m.MPA, 1, `seed ${seed}: MPA must be exactly 1.0 (no over-forgetting)`);
    assert.ok(m.FAA >= 0.9, `seed ${seed}: FAA ${m.FAA}`);
    assert.ok(m.FAMA >= DEFAULT_MEMORY_CONFIG.famaThreshold, `seed ${seed}: FAMA ${m.FAMA}`);
    assert.ok(m.recordReduction >= DEFAULT_MEMORY_CONFIG.reductionTarget, `seed ${seed}: reduction ${m.recordReduction}`);
    assert.equal(m.crossTierLeakage, 0);
    assert.equal(m.provenanceViolations, 0);
    assert.equal(m.twinReinforced, true);
    assert.ok(m.onDiagonalFraction >= DEFAULT_MEMORY_CONFIG.confusionThreshold);
  }
});

test('consolidation is idempotent on the clean pipeline (0 new merges on a second pass)', () => {
  const r = consolidationIdempotence(8, {}, {});
  assert.equal(r.secondPassMerges, 0);
  assert.ok(r.provAfter >= r.provBefore, 'never drops a provenance leaf');
});

test('Phase 2 — every FAMA invariant HOLDS and its NEGATIVE CONTROL is caught', () => {
  for (const inv of MEMORY_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    assert.equal(pos.ok, true, `${inv.id} should hold: ${pos.detail || ''}`);
    assert.equal(neg.ok, false, `${inv.id} negative control MUST be caught`);
  }
});

test('runMemoryInvariants: 0 safety violations, all 8 negative controls caught', () => {
  const r = runMemoryInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, r.invariantsTotal);
  assert.equal(r.invariantsTotal, 8);
});

test('NEGATIVE CONTROL (over-prune): ignoring the shield drops an important/provenance fact → MPA < 1', () => {
  const s = runMemorySession(5, {}, { overPrune: true });
  const m = computeMemoryMetrics(s, { overPrune: true });
  assert.ok(m.MPA < 1, 'over-pruning must break the MPA hard gate');
});

test('NEGATIVE CONTROL (no-forgetting): stale facts persist → FAA and FAMA collapse', () => {
  const s = runMemorySession(6, {}, { noForgetting: true });
  const m = computeMemoryMetrics(s, { noForgetting: true });
  assert.ok(m.FAA < 0.9);
  assert.ok(m.FAMA < DEFAULT_MEMORY_CONFIG.famaThreshold);
});

void TIERS;
void prune;

// ─── Phase 3: context reservoir ──────────────────────────────────────

import {
  rotGain,
  distractorGain,
  goalDriftFactor,
  compoundingFactor,
  planningFactor,
  runReservoir,
  contextBoundedChecker,
  utilizationBelowKneeChecker,
  usefulWorkChecker,
  collapseStudy,
  runContextInvariants,
  CONTEXT_INVARIANTS,
  reservoirFingerprint,
  regressionSlope,
  pearson,
  CORR_THRESHOLD,
  DEFAULT_CONTEXT_CONFIG,
} from '../lib/agix-loop-sim/context-reservoir.mjs';

test('rot-knee: g is flat below the knee then declines; h penalizes distractors', () => {
  const cfg = DEFAULT_CONTEXT_CONFIG;
  assert.equal(rotGain(0.2, cfg), 1);
  assert.equal(rotGain(cfg.kneeUtil, cfg), 1);
  assert.ok(rotGain(0.6, cfg) < 1, 'declines past the knee');
  assert.ok(distractorGain(0.3, cfg) < distractorGain(0, cfg), 'distractors hurt');
});

test('the 4 hazards are separate functions with their own reset levers', () => {
  const cfg = DEFAULT_CONTEXT_CONFIG;
  assert.ok(goalDriftFactor(10, 0, cfg) < goalDriftFactor(0, 0, cfg), 'drift rises with steps since recite');
  assert.ok(compoundingFactor(0.3) < compoundingFactor(0.01), 'compounding error lowers coherence');
  assert.ok(planningFactor(10, 0, cfg) < planningFactor(0, 0, cfg), 'planning error rises since last replan');
});

test('reservoir: healthy run plateaus below the knee and survives the 30h horizon', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = runReservoir(seed).summary;
    assert.ok(Math.abs(s.contextSlope) <= 8, `seed ${seed} slope ${s.contextSlope}`);
    assert.ok(s.maxUtil < DEFAULT_CONTEXT_CONFIG.kneeUtil, `seed ${seed} maxUtil ${s.maxUtil}`);
    assert.equal(s.collapsed, false, `seed ${seed} must survive 30h`);
    assert.equal(s.hoursToCollapse, DEFAULT_CONTEXT_CONFIG.hours);
  }
});

test('reservoir: no-offload+no-prune ablation grows unbounded and collapses fast', () => {
  const s = runReservoir(1, {}, { noOffload: true, noPrune: true }).summary;
  assert.ok(s.contextSlope > 100, 'reservoir grows without forgetting');
  assert.ok(s.maxUtil > DEFAULT_CONTEXT_CONFIG.kneeUtil, 'crosses the rot-knee');
  assert.equal(s.collapsed, true);
  assert.ok(s.hoursToCollapse < DEFAULT_CONTEXT_CONFIG.hours);
});

test('reservoir: deterministic (byte-identical trace on rerun)', () => {
  assert.equal(reservoirFingerprint(runReservoir(4)), reservoirFingerprint(runReservoir(4)));
});

test('collapse DECOUPLES from context fill when forgetting works (Vending-Bench signal)', () => {
  const healthy = collapseStudy([1, 2, 3, 4, 5, 6, 7, 8], {}, {});
  const coupled = collapseStudy([1, 2, 3, 4, 5, 6, 7, 8], {}, { coupled: true, ablation: { noOffload: true, noPrune: true } });
  assert.ok(healthy.pairs.every((p) => p.collapsed), 'the study must produce collapses to correlate');
  assert.ok(healthy.absPearson <= CORR_THRESHOLD, `healthy |r| ${healthy.absPearson} must be low`);
  assert.ok(coupled.absPearson > CORR_THRESHOLD, `coupled |r| ${coupled.absPearson} must be high`);
  assert.ok(healthy.absPearson < coupled.absPearson, 'forgetting decouples collapse from context fill');
});

test('stats helpers: regression slope and Pearson behave', () => {
  assert.ok(Math.abs(regressionSlope([[0, 0], [1, 2], [2, 4]]) - 2) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0, 'no variance → 0, not NaN');
});

test('Phase 3 — every context invariant HOLDS and its NEGATIVE CONTROL is caught', () => {
  for (const inv of CONTEXT_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    assert.equal(pos.ok, true, `${inv.id} should hold: ${pos.detail || ''}`);
    assert.equal(neg.ok, false, `${inv.id} negative control MUST be caught`);
  }
});

test('runContextInvariants: 0 safety violations, all 4 negative controls caught', () => {
  const r = runContextInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, r.invariantsTotal);
  assert.equal(r.invariantsTotal, 4);
});

void contextBoundedChecker;
void utilizationBelowKneeChecker;
void usefulWorkChecker;

// ─── ecosystem harness + gate integration ────────────────────────────

import { runEcosystem, CONTRACTS, judge } from '../lib/agix-loop-sim/ecosystem-harness.mjs';
import { selfTest as gateSelfTest } from '../lib/agix-loop-sim/gate.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('runEcosystem: every correctness metric is green and the gate self-test passes', () => {
  const r = runEcosystem({});
  const c = r.scorecard.correctness;
  const expected = { replayNegativeControlsCaught: 3, memoryNegativeControlsCaught: 8, contextNegativeControlsCaught: 4, fleetNegativeControlsCaught: 7, anomalyNegativeControlsCaught: 17 };
  const zero = new Set(['crossTierLeakage', 'provenanceViolations']);
  for (const [k, v] of Object.entries(c)) assert.equal(v, k.endsWith('Violations') || zero.has(k) ? 0 : (k in expected ? expected[k] : 1), `${k}=${v}`);
  assert.equal(r.gateSelfTest.passed, true);
});

test('runEcosystem: byte-identical scorecard across two full runs (determinism)', () => {
  const a = runEcosystem({});
  const b = runEcosystem({});
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(stableStringify(a.scorecard.correctness), stableStringify(b.scorecard.correctness));
  assert.equal(stableStringify(a.scorecard.performance), stableStringify(b.scorecard.performance));
});

test('ecosystem gate: the committed baseline passes every blocking contract', () => {
  const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, 'lib/agix-loop-sim/ecosystem-baseline.json'), 'utf8'));
  const r = runEcosystem({});
  const g = judge(r.scorecard, baseline);
  assert.equal(g.allBlockingPassed, true, JSON.stringify(g.blockingFailures));
  assert.equal(gateSelfTest().passed, true);
});

test('ecosystem: a longer simulated horizon still holds every property (endurance scales)', () => {
  const r = runEcosystem({ hours: 120, seeds: [1, 2, 3] });
  assert.equal(r.scorecard.correctness.mpaHardGate, 1);
  assert.equal(r.scorecard.correctness.enduranceHeld, 1, 'no collapse across 120 simulated hours');
  assert.equal(r.scorecard.correctness.contextBoundedOk, 1);
  assert.ok(r.scorecard.performance.faaWorst >= 0.9);
});

void CONTRACTS;

// ─── Phase 4: the 32-agent fleet ─────────────────────────────────────

import {
  buildFleet,
  runFleet,
  runFleetInvariants,
  FLEET_INVARIANTS,
  fleetFingerprint,
  hasCycle,
  DEFAULT_FLEET_CONFIG,
} from '../lib/agix-loop-sim/fleet.mjs';

test('fleet: three-tier TREE — 1 director → 4 managers → 32 workers, complete single-owner ownership', () => {
  const fleet = buildFleet();
  assert.equal(fleet.workers.length, 32);
  assert.equal(fleet.managerCount, 4);
  for (const w of fleet.workers) {
    assert.ok(fleet.ownerOfWorker[w.id], `${w.id} must have exactly one manager owner`);
    assert.ok(fleet.managers.some((m) => m.id === fleet.ownerOfWorker[w.id]));
  }
  for (const m of fleet.managers) {
    assert.equal(fleet.ownerOfManager[m.id], fleet.director.id);
    assert.ok(m.workers.length <= fleet.maxSpan);
  }
  // channel math is WHY we forbid a mesh: tree O(n) ≪ mesh O(n²).
  assert.ok(fleet.treeChannels < fleet.meshChannels);
  assert.equal(fleet.meshChannels, (32 * 31) / 2);
});

test('fleet: span-of-control is tunable (4 → 8 managers, still 32 workers)', () => {
  const fleet = buildFleet({ agents: 32, span: 4 });
  assert.equal(fleet.managerCount, 8);
  assert.equal(fleet.workers.length, 32);
  for (const m of fleet.managers) assert.equal(m.workers.length, 4);
});

test('fleet: every worker gets a fixed serial rank at launch (the MTPO order)', () => {
  const fleet = buildFleet();
  const ranks = fleet.workers.map((w) => w.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, Array.from({ length: 32 }, (_, i) => i));
});

test('fleet: deterministic (byte-identical run on rerun) + coordination tax near the 1.15× target', () => {
  assert.equal(fleetFingerprint(runFleet(3)), fleetFingerprint(runFleet(3)));
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const tax = runFleet(seed).coordination.coordinationTax;
    assert.ok(tax >= 1.0 && tax <= 1.25, `seed ${seed} tax ${tax} should sit near the CoAgent 1.15× target`);
  }
});

test('fleet: MTPO coordination is deadlock-free (wait-for graph acyclic) and linearizable to rank order', () => {
  const run = runFleet(2);
  assert.equal(hasCycle(run.coordination.waitFor), false);
  assert.equal(stableStringify(run.coordination.finalState), stableStringify(run.coordination.rankOrderState), 'final state linearizable to serial rank order');
});

test('fleet: actor ≠ verifier — no worker certifies its own task', () => {
  const run = runFleet(1);
  const selfCert = run.events.filter((e) => e.type === 'certify' && e.actor === e.worker);
  assert.equal(selfCert.length, 0);
  const certs = run.events.filter((e) => e.type === 'certify');
  assert.ok(certs.length > 0 && certs.every((e) => e.role === 'manager'));
});

test('fleet: single-leader — only the director re-plans (Task/Progress ledgers are the director\'s)', () => {
  const run = runFleet(4, {}, { forceStall: true });
  assert.ok(run.taskLedger.replans.length > 0, 'a stall must trigger a re-plan');
  assert.ok(run.taskLedger.replans.every((rp) => rp.actor === run.fleet.director.id));
});

test('fleet: anti-runaway caps hold on the clean path (concurrency ≤ 32, tokens < ceilings, breaker present)', () => {
  const run = runFleet(5);
  assert.ok(run.runaway.maxConcurrency <= run.runaway.concurrencyCap);
  assert.ok(run.runaway.runTokens < run.runaway.runCeiling);
  assert.ok(run.runaway.sessionTokens < run.runaway.sessionCeiling);
  assert.equal(run.runaway.breakerPresent, true);
});

test('hasCycle: detects a planted cycle, clears an acyclic DAG', () => {
  assert.equal(hasCycle({ 1: new Set([2]), 2: new Set([3]) }), false);
  assert.equal(hasCycle({ 1: new Set([2]), 2: new Set([1]) }), true);
});

test('Phase 4 — every FLEET invariant HOLDS and its NEGATIVE CONTROL is caught', () => {
  for (const inv of FLEET_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    assert.equal(pos.ok, true, `${inv.id} should hold: ${pos.detail || ''}`);
    assert.equal(neg.ok, false, `${inv.id} negative control MUST be caught`);
  }
});

test('runFleetInvariants: 0 safety violations, all 7 negative controls caught', () => {
  const r = runFleetInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, r.invariantsTotal);
  assert.equal(r.invariantsTotal, 7);
});

void DEFAULT_FLEET_CONFIG;

// ─── Phase 5: anomaly taxonomy (MAST-14 + collapse signatures) ────────

import {
  detectAnomalies,
  runAnomalyInvariants,
  plantAllAnomalies,
  coordinationTax,
  ANOMALY_DETECTORS,
} from '../lib/agix-loop-sim/anomalies.mjs';

test('anomalies: the clean fleet run scores anomaly-0 across every seed', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const a = detectAnomalies(runFleet(seed));
    assert.equal(a.total, 0, `seed ${seed}: ${JSON.stringify(a.byMode)}`);
  }
});

test('anomalies: the taxonomy is MAST-14 (3 categories) + 3 Vending-Bench collapse signatures = 17 detectors', () => {
  assert.equal(ANOMALY_DETECTORS.length, 17);
  const byCat = {};
  for (const d of ANOMALY_DETECTORS) byCat[d.category] = (byCat[d.category] ?? 0) + 1;
  assert.equal(byCat['system-design'], 5);
  assert.equal(byCat['inter-agent'], 6);
  assert.equal(byCat.verification, 3);
  assert.equal(byCat.collapse, 3);
});

test('Phase 5 — every anomaly detector scores 0 clean and CATCHES its planted violation', () => {
  for (const d of ANOMALY_DETECTORS) {
    assert.equal(d.detect(runFleet(1)), 0, `${d.id} must be clean on the healthy run`);
    assert.ok(d.detect(d.plant(1)) > 0, `${d.id} MUST catch its planted fault`);
  }
});

test('runAnomalyInvariants: 0 safety violations, all 17 planted faults caught', () => {
  const r = runAnomalyInvariants();
  assert.equal(r.safetyViolations, 0);
  assert.equal(r.negativeControlsCaught, 17);
  assert.equal(r.invariantsTotal, 17);
});

test('plantAllAnomalies: a single run that trips every one of the 17 modes (full-coverage proof)', () => {
  const a = detectAnomalies(plantAllAnomalies(1));
  assert.ok(a.total > 0);
  const tripped = Object.values(a.byMode).filter((n) => n > 0).length;
  assert.equal(tripped, 17, 'the planted-violation agent must trigger every MAST + collapse mode');
});

test('coordinationTax: reported near the CoAgent 1.15× target', () => {
  const t = coordinationTax(1);
  assert.ok(t > 1.0 && t < 1.25);
});

// ─── Phase 6: pass criterion (preflight + pass^k + rule-of-three) ─────

import { runPreflight, ablationStudy } from '../lib/agix-loop-sim/ecosystem-harness.mjs';

test('preflight (the crux): null, random, and planted agents ALL score > 0 (a broken harness would pass one)', () => {
  const pf = runPreflight(1);
  assert.ok(pf.nullAnomalies > 0, 'a null agent must not score anomaly-0');
  assert.ok(pf.randomAnomalies > 0, 'a random agent must not score anomaly-0');
  assert.ok(pf.plantedAnomalies > 0, 'a planted-violation agent must not score anomaly-0');
  assert.equal(pf.modesTripped, pf.modesTotal, 'the planted agent trips every detector (ratchet coverage)');
  assert.equal(pf.ok, true);
});

test('preflight is a REAL self-check: if the fleet somehow ran clean under a fault agent, ok would be false', () => {
  // Sanity: the null agent genuinely diverges from the clean run.
  assert.notEqual(detectAnomalies(runFleet(1, {}, { agent: 'null' })).total, detectAnomalies(runFleet(1)).total);
});

test('pass^k + rule-of-three surface in the ecosystem scorecard', () => {
  const r = runEcosystem({});
  assert.equal(r.scorecard.correctness.passKAllClean, 1);
  assert.equal(r.scorecard.performance.passK, 1);
  assert.equal(r.scorecard.correctness.preflightOk, 1);
  assert.equal(r.scorecard.performance.anomaliesWorst, 0);
  // 0 anomalies in 8 seeds ⇒ true rate < 3/8 at 95%.
  assert.ok(Math.abs(r.scorecard.performance.ruleOfThreeBound - 3 / 8) < 1e-9);
});

// ─── Phase 7: the ablation (causal proof) ────────────────────────────

test('ablation: ONLY both-mechanisms-on keeps C(t) bounded AND survives the horizon at anomaly-0', () => {
  const ab = ablationStudy(3);
  assert.equal(ab.causalOk, true);
  // both: bounded + survived + clean.
  assert.equal(ab.results.both.contextBounded, true);
  assert.equal(ab.results.both.survived, true);
  assert.equal(ab.results.both.anomalies, 0);
  // no-offload: crosses the rot-knee → not bounded, anomalies appear.
  assert.equal(ab.results['no-offload'].contextBounded, false);
  assert.ok(ab.results['no-offload'].anomalies > 0);
  // no-forgetting: unbounded growth → collapses within the horizon, anomalies appear.
  assert.equal(ab.results['no-forgetting'].survived, false);
  assert.ok(ab.results['no-forgetting'].anomalies > 0);
});

test('ablation is deterministic (byte-identical across two runs)', () => {
  assert.equal(stableStringify(ablationStudy(3)), stableStringify(ablationStudy(3)));
});

test('ecosystem scorecard: the ablation causal proof is a gated correctness metric', () => {
  const r = runEcosystem({});
  assert.equal(r.scorecard.correctness.ablationCausalOk, 1);
  assert.equal(r.scorecard.correctness.fleetNegativeControlsCaught, 7);
  assert.equal(r.scorecard.correctness.anomalyNegativeControlsCaught, 17);
  assert.equal(r.scorecard.correctness.anomalyFreeOk, 1);
});
