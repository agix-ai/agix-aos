// agix-gate — the gate primitive tests.
// Runner: node --test test/agix-gate.test.mjs
//
// Covers LOOP_ENGINEERED_SDLC §2 + §3:
//   - evaluate returns a Stage-Gate Verdict (GO/KILL/HOLD/RECYCLE), not pass/fail
//   - THE load-bearing rule: verifier === actor throws (no self-verification)
//   - entry → work → exit ordering
//   - entry-not-met → HOLD (does not run the work)
//   - requiresHuman routes a would-be GO to HOLD (the four hard human gates)
//   - immutable verifier surface: criteria come from construction, not context
//   - every evaluate records a gate_decision + verdict to the ledger
//   - composeGate builds gates from the §2 registry (actor ≠ verifier baked in)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gate, VERDICT, GATE_REGISTRY, composeGate } from '../lib/agix-gate.mjs';
import { AuditLedger, MemoryLedgerStore } from '../lib/agix-audit-ledger.mjs';

function seams(startMs = Date.parse('2026-07-03T00:00:00.000Z')) {
  let n = 0;
  return { idgen: () => `entry-${String(++n).padStart(4, '0')}`, clock: () => new Date(startMs).toISOString() };
}

function newLedger() {
  return new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), ...seams() });
}

// ─── The load-bearing rule ─────────────────────────────────────────────

test('evaluate throws when verifier === actor (no self-verification)', async () => {
  const gate = new Gate({
    name: 'self-check',
    actor: 'coder',
    verifier: 'coder',
    exitCriteria: () => VERDICT.GO,
  });
  await assert.rejects(() => gate.evaluate({}), /verifier must differ from actor/);
});

test('a distinct verifier is allowed through', async () => {
  const gate = new Gate({
    name: 'implement-gate',
    actor: 'coder',
    verifier: 'architect',
    exitCriteria: () => VERDICT.GO,
  });
  const r = await gate.evaluate({});
  assert.equal(r.verdict, 'GO');
});

// ─── Verdict values (not pass/fail) ────────────────────────────────────

test('exitCriteria may return any of the four verdicts', async () => {
  for (const v of ['GO', 'KILL', 'HOLD', 'RECYCLE']) {
    const gate = new Gate({ name: `g-${v}`, actor: 'a', verifier: 'b', exitCriteria: () => v });
    assert.equal((await gate.evaluate({})).verdict, v);
  }
});

test('exitCriteria can return an object with reason + confidence', async () => {
  const gate = new Gate({
    name: 'rich',
    actor: 'a', verifier: 'b',
    exitCriteria: () => ({ verdict: VERDICT.RECYCLE, reason: 'held-out gap too wide', confidence: 0.4 }),
  });
  const r = await gate.evaluate({});
  assert.equal(r.verdict, 'RECYCLE');
  assert.equal(r.reason, 'held-out gap too wide');
  assert.equal(r.confidence, 0.4);
});

test('an invalid verdict from criteria throws', async () => {
  const gate = new Gate({ name: 'bad', actor: 'a', verifier: 'b', exitCriteria: () => 'pass' });
  await assert.rejects(() => gate.evaluate({}), /invalid verdict/);
});

// ─── entry → work → exit ───────────────────────────────────────────────

test('entry → work → exit run in order and thread the work result', async () => {
  const calls = [];
  const gate = new Gate({
    name: 'ordered',
    actor: 'a', verifier: 'b',
    entryCriteria: () => { calls.push('entry'); return true; },
    work: () => { calls.push('work'); return { built: true }; },
    exitCriteria: (_ctx, workResult) => { calls.push('exit'); return workResult.built ? VERDICT.GO : VERDICT.RECYCLE; },
  });
  const r = await gate.evaluate({});
  assert.deepEqual(calls, ['entry', 'work', 'exit']);
  assert.equal(r.verdict, 'GO');
  assert.deepEqual(r.workResult, { built: true });
});

test('entry criteria not met → HOLD and the work never runs', async () => {
  let ranWork = false;
  const gate = new Gate({
    name: 'lease-gate',
    actor: 'a', verifier: 'b',
    entryCriteria: () => ({ ok: false }),          // e.g. lease not held
    work: () => { ranWork = true; return {}; },
    exitCriteria: () => VERDICT.GO,
  });
  const r = await gate.evaluate({});
  assert.equal(r.verdict, 'HOLD');
  assert.equal(r.entryOk, false);
  assert.equal(ranWork, false);
});

// ─── requiresHuman routing ─────────────────────────────────────────────

test('requiresHuman routes a would-be GO to HOLD (hard human gate)', async () => {
  const gate = new Gate({
    name: 'merge-to-main',
    actor: 'git-orchestrator', verifier: 'ci-warden',
    requiresHuman: true,
    exitCriteria: () => VERDICT.GO,
  });
  const r = await gate.evaluate({});
  assert.equal(r.verdict, 'HOLD');
  assert.equal(r.routedToHuman, true);
  assert.match(r.reason, /human co-sign/);
});

test('requiresHuman still lets KILL and RECYCLE pass through', async () => {
  const kill = new Gate({ name: 'k', actor: 'a', verifier: 'b', requiresHuman: true, exitCriteria: () => VERDICT.KILL });
  assert.equal((await kill.evaluate({})).verdict, 'KILL');
  const recycle = new Gate({ name: 'r', actor: 'a', verifier: 'b', requiresHuman: true, exitCriteria: () => VERDICT.RECYCLE });
  assert.equal((await recycle.evaluate({})).verdict, 'RECYCLE');
});

// ─── Immutable verifier surface ────────────────────────────────────────

test('the gate is frozen — the actor cannot reassign its criteria', () => {
  const gate = new Gate({ name: 'immutable', actor: 'a', verifier: 'b', exitCriteria: () => VERDICT.GO });
  assert.throws(() => { gate._exitCriteria = () => VERDICT.KILL; }, TypeError);
  assert.throws(() => { gate.verifier = 'a'; }, TypeError);
});

test('criteria come from construction, not from the evaluate context', async () => {
  const gate = new Gate({ name: 'sealed', actor: 'a', verifier: 'b', exitCriteria: () => VERDICT.RECYCLE });
  // A malicious context trying to smuggle in a passing exitCriteria is ignored.
  const r = await gate.evaluate({ exitCriteria: () => VERDICT.GO, entryCriteria: () => true });
  assert.equal(r.verdict, 'RECYCLE');
});

// ─── Ledger recording ──────────────────────────────────────────────────

test('every evaluate records a gate_decision + a verdict entry', async () => {
  const ledger = newLedger();
  const gate = new Gate({
    name: 'implement-gate', phase: 'implement',
    actor: 'coder', verifier: 'architect',
    exitCriteria: () => VERDICT.GO,
    ledger,
  });
  await gate.evaluate({ scope: { mandateId: 'm1', runId: 'r1' }, cost: { cost_usd: 0.02, tokens: 900 } });

  const entries = await ledger.read();
  assert.equal(entries.length, 2);
  const decision = entries.find((e) => e.kind === 'gate_decision');
  const verdict = entries.find((e) => e.kind === 'verdict');
  assert.equal(decision.meta.gate, 'implement-gate');
  assert.equal(decision.verifier, 'architect');
  assert.equal(verdict.verdict, 'GO');
  assert.equal(verdict.phase, 'implement');
  assert.deepEqual(verdict.scope, { enterpriseId: 'agix', mandateId: 'm1', runId: 'r1' });
  assert.deepEqual(verdict.cost, { cost_usd: 0.02, tokens: 900 });
});

test('overridden_by_human from context lands on the verdict entry', async () => {
  const ledger = newLedger();
  const gate = new Gate({ name: 'g', actor: 'a', verifier: 'b', exitCriteria: () => VERDICT.GO, ledger });
  await gate.evaluate({ overridden_by_human: true });
  const verdict = (await ledger.read({ kind: 'verdict' }))[0];
  assert.equal(verdict.overridden_by_human, true);
});

// ─── Registry + composeGate ────────────────────────────────────────────

test('GATE_REGISTRY encodes actor ≠ verifier for every phase', () => {
  for (const [phase, g] of Object.entries(GATE_REGISTRY)) {
    assert.notEqual(g.actor, g.verifier, `phase ${phase} must have actor ≠ verifier`);
  }
  // The four hard human gates.
  const human = Object.entries(GATE_REGISTRY).filter(([, g]) => g.requiresHuman).map(([k]) => k);
  assert.deepEqual(human.sort(), ['integrate', 'release', 'spec'].sort());
  // (spec, integrate, release are human-gated here; design high-risk sign-off is caller-flagged.)
});

test('composeGate builds a live gate from a registry phase', async () => {
  const ledger = newLedger();
  const gate = composeGate('implement', {
    criteria: { exitCriteria: () => VERDICT.GO },
    ledger,
  });
  assert.equal(gate.phase, 'implement');
  assert.equal(gate.actor, 'coder');
  assert.equal(gate.verifier, 'architect');
  const r = await gate.evaluate({ scope: { mandateId: 'm9' } });
  assert.equal(r.verdict, 'GO');
  assert.equal((await ledger.read()).length, 2);
});

test('composeGate rejects an unknown phase and a missing exitCriteria', () => {
  assert.throws(() => composeGate('nope', { criteria: { exitCriteria: () => VERDICT.GO } }), /unknown phase/);
  assert.throws(() => composeGate('implement', { criteria: {} }), /exitCriteria is required/);
});

test('composeGate overrides still enforce actor ≠ verifier at evaluate', async () => {
  const gate = composeGate('implement', {
    criteria: { exitCriteria: () => VERDICT.GO },
    overrides: { actor: 'x', verifier: 'x' },
  });
  await assert.rejects(() => gate.evaluate({}), /verifier must differ from actor/);
});
