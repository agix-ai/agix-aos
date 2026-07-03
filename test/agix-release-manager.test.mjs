// agix release-manager — pure-core + gate + ledger tests.
// Runner: node --test test/agix-release-manager.test.mjs
//
// Covers RELEASE_GTM_MANAGEMENT.md §2.1 (the release-manager spec):
//   - computeReleaseTrain: ordered freeze/RC/release dates
//   - checkFeatureFreeze (G1) + checkCodeFreeze (G2)
//   - evaluateLaunchReadiness (G3, Google-LCE seven-part PRR)
//   - checkRollout (G4)
//   - releaseSuccessRate over the audit ledger (ITIL ≥90%)
//   - the G1–G4 gates return the right verdicts, incl. G3 human go/no-go → HOLD

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeReleaseTrain,
  checkFeatureFreeze,
  checkCodeFreeze,
  evaluateLaunchReadiness,
  checkRollout,
  releaseSuccessRate,
  buildReleaseGates,
  LCE_DIMENSIONS,
} from '../agents/release-manager/agent.mjs';
import { AuditLedger, MemoryLedgerStore } from '../lib/agix-audit-ledger.mjs';
import { VERDICT } from '../lib/agix-gate.mjs';

function seams(startMs = Date.parse('2026-07-03T00:00:00.000Z')) {
  let n = 0;
  return { idgen: () => `entry-${String(++n).padStart(4, '0')}`, clock: () => new Date(startMs).toISOString() };
}
function newLedger() {
  return new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), ...seams() });
}
const fullReadiness = Object.fromEntries(LCE_DIMENSIONS.map((d) => [d, true]));

// ─── computeReleaseTrain ────────────────────────────────────────────────

test('computeReleaseTrain: milestones are ordered before the release date', () => {
  const t = computeReleaseTrain({ anchorDate: '2026-07-17', featureFreezeLeadDays: 14, codeFreezeLeadDays: 5, rcLeadDays: 3 });
  assert.equal(t.valid, true);
  assert.equal(t.releaseDate, '2026-07-17');
  assert.equal(t.featureFreezeDate, '2026-07-03');
  assert.equal(t.codeFreezeDate, '2026-07-12');
  assert.equal(t.rcDate, '2026-07-14');
  assert.ok(t.featureFreezeDate < t.codeFreezeDate && t.codeFreezeDate < t.rcDate && t.rcDate < t.releaseDate);
});

test('computeReleaseTrain: overlapping leads are flagged invalid', () => {
  const t = computeReleaseTrain({ anchorDate: '2026-07-17', featureFreezeLeadDays: 2, codeFreezeLeadDays: 10 });
  assert.equal(t.valid, false);
});

// ─── G1 feature-freeze ──────────────────────────────────────────────────

test('checkFeatureFreeze: no new scope → GO', () => {
  assert.equal(checkFeatureFreeze({ frozen: true, newScopeAfterFreeze: [] }).verdict, VERDICT.GO);
});

test('checkFeatureFreeze: new scope after freeze → RECYCLE', () => {
  const r = checkFeatureFreeze({ frozen: true, newScopeAfterFreeze: ['shiny-feature'] });
  assert.equal(r.verdict, VERDICT.RECYCLE);
  assert.deepEqual(r.added, ['shiny-feature']);
});

// ─── G2 code-freeze / RC ────────────────────────────────────────────────

test('checkCodeFreeze: only blocker cherry-picks → GO (ship build)', () => {
  const r = checkCodeFreeze({ rcChanges: [{ id: 'crash-fix', blocker: true }] });
  assert.equal(r.verdict, VERDICT.GO);
  assert.equal(r.isShipBuild, true);
});

test('checkCodeFreeze: a non-blocker change in the RC → RECYCLE', () => {
  const r = checkCodeFreeze({ rcChanges: [{ id: 'crash-fix', blocker: true }, { id: 'nice-to-have', blocker: false }] });
  assert.equal(r.verdict, VERDICT.RECYCLE);
  assert.deepEqual(r.nonBlockers, ['nice-to-have']);
});

// ─── G3 launch-readiness (PRR) ──────────────────────────────────────────

test('evaluateLaunchReadiness: all seven dimensions → complete', () => {
  const r = evaluateLaunchReadiness(fullReadiness);
  assert.equal(r.complete, true);
  assert.equal(r.missing.length, 0);
});

test('evaluateLaunchReadiness: a missing dimension → gap', () => {
  const r = evaluateLaunchReadiness({ ...fullReadiness, security: false });
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['security']);
});

// ─── G4 rollout ─────────────────────────────────────────────────────────

test('checkRollout: within the canary/bake/abort envelope → withinEnvelope', () => {
  const r = checkRollout({ canaryPercent: 5, bakeMinutes: 60, abortCriteriaMet: true, maxCanaryPercent: 5, minBakeMinutes: 30 });
  assert.equal(r.withinEnvelope, true);
});

test('checkRollout: canary over the ceiling / short bake / no abort → problems', () => {
  const r = checkRollout({ canaryPercent: 25, bakeMinutes: 5, abortCriteriaMet: false, maxCanaryPercent: 5, minBakeMinutes: 30 });
  assert.equal(r.withinEnvelope, false);
  assert.equal(r.problems.length, 3);
});

// ─── releaseSuccessRate over the ledger ─────────────────────────────────

test('releaseSuccessRate: computes 1 − change-failure-rate from release entries', () => {
  const entries = [
    { kind: 'release', ts: '2026-07-01T00:00:00Z', scope: { runId: 'a' } },
    { kind: 'release', ts: '2026-07-02T00:00:00Z', scope: { runId: 'b' } },
    { kind: 'release', ts: '2026-07-03T00:00:00Z', scope: { runId: 'c' }, meta: { rollback: true } },
  ];
  const r = releaseSuccessRate(entries);
  assert.equal(r.total, 3);
  assert.equal(r.successes, 2);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
  assert.equal(r.meetsItilTarget, false);
});

test('releaseSuccessRate: no releases → null', () => {
  assert.equal(releaseSuccessRate([]).rate, null);
});

// ─── gates G1–G4 + ledger ───────────────────────────────────────────────

test('G3 launch-readiness: a complete PRR is a human go/no-go → HOLD', async () => {
  const ledger = newLedger();
  const { G3 } = buildReleaseGates({ ledger });
  const r = await G3.evaluate({ scope: { runId: 'rel-1' }, readiness: evaluateLaunchReadiness(fullReadiness) });
  assert.equal(r.verdict, VERDICT.HOLD, 'requiresHuman routes a complete-PRR GO to HOLD');
  assert.equal(r.routedToHuman, true);
});

test('G3 launch-readiness: PRR gaps → RECYCLE (not the human gate yet)', async () => {
  const ledger = newLedger();
  const { G3 } = buildReleaseGates({ ledger });
  const r = await G3.evaluate({ scope: { runId: 'rel-2' }, readiness: evaluateLaunchReadiness({ ...fullReadiness, monitoring: false }) });
  assert.equal(r.verdict, VERDICT.RECYCLE);
});

test('G1/G2/G4 verdicts + a decision is recorded to the ledger', async () => {
  const ledger = newLedger();
  const { G1, G2, G4 } = buildReleaseGates({ ledger });
  assert.equal((await G1.evaluate({ scope: { runId: 'r' }, freeze: checkFeatureFreeze({ frozen: true, newScopeAfterFreeze: [] }) })).verdict, VERDICT.GO);
  assert.equal((await G2.evaluate({ scope: { runId: 'r' }, codeFreeze: checkCodeFreeze({ rcChanges: [{ id: 'x', blocker: false }] }) })).verdict, VERDICT.RECYCLE);
  assert.equal((await G4.evaluate({ scope: { runId: 'r' }, rollout: checkRollout({ canaryPercent: 50 }) })).verdict, VERDICT.HOLD);

  const verdicts = await ledger.read({ kind: 'verdict' });
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.verifier === 'release-manager'));
});

test('the release gates keep actor ≠ verifier', async () => {
  const ledger = newLedger();
  const { G1 } = buildReleaseGates({ ledger, actor: 'release-engineer' });
  assert.equal(G1.actor, 'release-engineer');
  assert.equal(G1.verifier, 'release-manager');
});
