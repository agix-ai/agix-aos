// agix version-manager — pure-core + gate + ledger tests.
// Runner: node --test test/agix-version-manager.test.mjs
//
// Covers RELEASE_GTM_MANAGEMENT.md §2.2 (the version-manager spec):
//   - bumpCorrectness: PATCH/MINOR/MAJOR, incl. the breaking-change-in-MINOR case
//   - validateChangelog: Keep-a-Changelog conformance
//   - checkDeprecationSLA: compliant + violation
//   - assignScheme: SemVer (contracts) vs CalVer (cadenced)
//   - checkArtifactIdentity: build-once/promote-many vs rebuild
//   - the V1–V4 gates return the right verdicts and record to the audit ledger

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bumpCorrectness,
  validateChangelog,
  checkDeprecationSLA,
  assignScheme,
  checkArtifactIdentity,
  buildVersionGates,
  BUMP,
} from '../agents/version-manager/agent.mjs';
import { AuditLedger, MemoryLedgerStore } from '../lib/agix-audit-ledger.mjs';
import { VERDICT } from '../lib/agix-gate.mjs';

function seams(startMs = Date.parse('2026-07-03T00:00:00.000Z')) {
  let n = 0;
  return { idgen: () => `entry-${String(++n).padStart(4, '0')}`, clock: () => new Date(startMs).toISOString() };
}
function newLedger() {
  return new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), ...seams() });
}

// ─── bumpCorrectness ───────────────────────────────────────────────────

test('bumpCorrectness: fixes only → PATCH', () => {
  const r = bumpCorrectness({ declared: 'PATCH', fixed: ['a bug'] });
  assert.equal(r.correct, BUMP.PATCH);
  assert.equal(r.agrees, true);
  assert.equal(r.breakingHidden, false);
});

test('bumpCorrectness: added backward-compatible surface → MINOR', () => {
  const r = bumpCorrectness({ declared: 'MINOR', added: ['new endpoint'] });
  assert.equal(r.correct, BUMP.MINOR);
  assert.equal(r.agrees, true);
});

test('bumpCorrectness: a removed public symbol → MAJOR', () => {
  const r = bumpCorrectness({ declared: 'MAJOR', removed: ['legacyApi'] });
  assert.equal(r.correct, BUMP.MAJOR);
  assert.equal(r.breaking, true);
  assert.equal(r.breakingHidden, false);
});

test('bumpCorrectness: THE case — a breaking change hiding in a MINOR', () => {
  const r = bumpCorrectness({ declared: 'MINOR', added: ['new endpoint'], removed: ['legacyApi'] });
  assert.equal(r.correct, BUMP.MAJOR, 'a removal forces MAJOR regardless of additions');
  assert.equal(r.declared, BUMP.MINOR);
  assert.equal(r.agrees, false);
  assert.equal(r.breakingHidden, true, 'the mislabel must be flagged');
});

test('bumpCorrectness: no declaration → agrees (nothing to contradict)', () => {
  const r = bumpCorrectness({ fixed: true });
  assert.equal(r.correct, BUMP.PATCH);
  assert.equal(r.declared, null);
  assert.equal(r.agrees, true);
});

// ─── validateChangelog ─────────────────────────────────────────────────

test('validateChangelog: a Keep-a-Changelog document is valid', () => {
  const text = ['# Changelog', '', '## [Unreleased]', '### Added', '- thing', '### Fixed', '- bug'].join('\n');
  const r = validateChangelog(text);
  assert.equal(r.valid, true);
  assert.equal(r.hasUnreleased, true);
  assert.deepEqual(r.categories.sort(), ['Added', 'Fixed']);
});

test('validateChangelog: a non-standard category is rejected', () => {
  const text = ['## [1.2.0] - 2026-07-03', '### Improvements', '- thing'].join('\n');
  const r = validateChangelog(text);
  assert.equal(r.valid, false);
  assert.deepEqual(r.invalidCategories, ['Improvements']);
});

test('validateChangelog: no version section is invalid', () => {
  const r = validateChangelog('### Added\n- thing');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /Unreleased|x\.y\.z/.test(i)));
});

// ─── checkDeprecationSLA ───────────────────────────────────────────────

test('checkDeprecationSLA: removal after the window is compliant', () => {
  const r = checkDeprecationSLA(
    [{ id: 'x', deprecatedInVersion: '0.1.0', removedInVersion: '0.3.0', notice: true }],
    { minMinorCycles: 1 },
  );
  assert.equal(r.compliant, true);
  assert.equal(r.checked, 1);
});

test('checkDeprecationSLA: removal inside the window is a violation', () => {
  const r = checkDeprecationSLA(
    [{ id: 'y', deprecatedInVersion: '0.2.0', removedInVersion: '0.2.0', notice: true }],
    { minMinorCycles: 1 },
  );
  assert.equal(r.compliant, false);
  assert.equal(r.violations[0].id, 'y');
});

test('checkDeprecationSLA: removal without a notice is a violation', () => {
  const r = checkDeprecationSLA(
    [{ id: 'z', deprecatedInVersion: '0.1.0', removedInVersion: '0.5.0', notice: false }],
    { minMinorCycles: 1 },
  );
  assert.equal(r.compliant, false);
  assert.match(r.violations[0].reason, /notice/);
});

// ─── assignScheme ──────────────────────────────────────────────────────

test('assignScheme: a contract-bearing artifact → SemVer', () => {
  assert.equal(assignScheme({ kind: 'sdk' }).scheme, 'SemVer');
  assert.equal(assignScheme({ kind: 'cli' }).scheme, 'SemVer');
});

test('assignScheme: a cadenced product → CalVer', () => {
  assert.equal(assignScheme({ kind: 'website' }).scheme, 'CalVer');
  assert.equal(assignScheme({ kind: 'service' }).scheme, 'CalVer');
});

// ─── checkArtifactIdentity ─────────────────────────────────────────────

test('checkArtifactIdentity: same digest across rings → identical', () => {
  const r = checkArtifactIdentity({ dev: 'sha:1', canary: 'sha:1', prod: 'sha:1' });
  assert.equal(r.identical, true);
});

test('checkArtifactIdentity: a rebuild across rings → not identical', () => {
  const r = checkArtifactIdentity({ dev: 'sha:1', canary: 'sha:1', prod: 'sha:2' });
  assert.equal(r.identical, false);
  assert.deepEqual(r.mismatched, ['prod']);
});

// ─── gates V1–V4 + ledger ──────────────────────────────────────────────

test('V1: a correct MINOR bump → GO', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger });
  const r = await V1.evaluate({ scope: { runId: 'ver-1' }, bump: bumpCorrectness({ declared: 'MINOR', added: ['x'] }) });
  assert.equal(r.verdict, VERDICT.GO);
});

test('V1: a breaking change hidden in a MINOR → HOLD (escalate to human)', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger });
  const bump = bumpCorrectness({ declared: 'MINOR', removed: ['legacyApi'] });
  const r = await V1.evaluate({ scope: { runId: 'ver-2' }, bump });
  assert.equal(r.verdict, VERDICT.HOLD, 'a masquerading MAJOR must escalate');
  assert.match(r.reason, /masquerading|MAJOR/);
});

test('V1: a MAJOR bump → HOLD (human co-sign)', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger });
  const r = await V1.evaluate({ scope: { runId: 'ver-3' }, bump: bumpCorrectness({ declared: 'MAJOR', removed: ['x'] }) });
  assert.equal(r.verdict, VERDICT.HOLD);
});

test('V1: a mislabeled non-breaking bump → RECYCLE', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger });
  // declared PATCH, but an addition warrants MINOR → relabel, not escalate.
  const r = await V1.evaluate({ scope: { runId: 'ver-4' }, bump: bumpCorrectness({ declared: 'PATCH', added: ['x'] }) });
  assert.equal(r.verdict, VERDICT.RECYCLE);
});

test('V2/V3/V4 verdicts', async () => {
  const ledger = newLedger();
  const { V2, V3, V4 } = buildVersionGates({ ledger });
  const goodCl = validateChangelog('## [Unreleased]\n### Added\n- x');
  const badCl = validateChangelog('### Nope\n- x');
  assert.equal((await V2.evaluate({ scope: { runId: 'v' }, changelog: goodCl })).verdict, VERDICT.GO);
  assert.equal((await V2.evaluate({ scope: { runId: 'v' }, changelog: badCl })).verdict, VERDICT.RECYCLE);

  const okSla = checkDeprecationSLA([{ id: 'a', deprecatedInVersion: '0.1.0', removedInVersion: '0.3.0' }], { minMinorCycles: 1 });
  const badSla = checkDeprecationSLA([{ id: 'a', deprecatedInVersion: '0.3.0', removedInVersion: '0.3.0' }], { minMinorCycles: 1 });
  assert.equal((await V3.evaluate({ scope: { runId: 'v' }, sla: okSla })).verdict, VERDICT.GO);
  assert.equal((await V3.evaluate({ scope: { runId: 'v' }, sla: badSla })).verdict, VERDICT.HOLD);

  assert.equal((await V4.evaluate({ scope: { runId: 'v' }, identity: checkArtifactIdentity({ a: '1', b: '1' }) })).verdict, VERDICT.GO);
  assert.equal((await V4.evaluate({ scope: { runId: 'v' }, identity: checkArtifactIdentity({ a: '1', b: '2' }) })).verdict, VERDICT.HOLD);
});

test('every gate evaluation records a gate_decision + verdict to the ledger', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger });
  await V1.evaluate({ scope: { runId: 'ver-led' }, bump: bumpCorrectness({ declared: 'MINOR', added: ['x'] }) });
  const decisions = await ledger.read({ kind: 'gate_decision' });
  const verdicts = await ledger.read({ kind: 'verdict' });
  assert.equal(decisions.length, 1);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].verifier, 'version-manager');
  assert.equal(verdicts[0].verdict, VERDICT.GO);
});

test('the actor ≠ verifier invariant holds for the version gates', async () => {
  const ledger = newLedger();
  const { V1 } = buildVersionGates({ ledger, actor: 'dev-fleet' });
  assert.equal(V1.actor, 'dev-fleet');
  assert.equal(V1.verifier, 'version-manager');
  // A gate whose actor equals its verifier throws at evaluate() (the load-bearing rule).
  const { V2 } = buildVersionGates({ ledger, actor: 'version-manager' });
  await assert.rejects(() => V2.evaluate({ scope: { runId: 'v' }, changelog: validateChangelog('## [Unreleased]\n### Added\n- x') }), /verifier must differ from actor/);
});
