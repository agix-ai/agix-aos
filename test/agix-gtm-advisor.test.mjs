// agix gtm-advisor — pure-core + gate + ledger tests.
// Runner: node --test test/agix-gtm-advisor.test.mjs
//
// Covers RELEASE_GTM_MANAGEMENT.md §2.3 (the gtm-advisor spec):
//   - assignTier: Tier 0–4 from the change shape
//   - tierMatchesBump (M1): match + mismatch (a MAJOR shipping low-tier)
//   - evaluateGtmReadiness (M2) + evaluateSalesSupportReadiness (M3)
//   - checkLaunchSync (M4)
//   - the M1–M4 gates return the right verdicts, incl. Tier 0/1 → HOLD (human)
//     and a tier↔bump mismatch → HOLD, and record to the audit ledger

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignTier,
  tierMatchesBump,
  evaluateGtmReadiness,
  evaluateSalesSupportReadiness,
  checkLaunchSync,
  buildGtmGates,
  buildTierGate,
  GTM_READINESS_DIMENSIONS,
  SALES_SUPPORT_DIMENSIONS,
} from '../agents/gtm-advisor/agent.mjs';
import { AuditLedger, MemoryLedgerStore } from '../lib/agix-audit-ledger.mjs';
import { VERDICT } from '../lib/agix-gate.mjs';

function seams(startMs = Date.parse('2026-07-03T00:00:00.000Z')) {
  let n = 0;
  return { idgen: () => `entry-${String(++n).padStart(4, '0')}`, clock: () => new Date(startMs).toISOString() };
}
function newLedger() {
  return new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), ...seams() });
}
const fullGtm = Object.fromEntries(GTM_READINESS_DIMENSIONS.map((d) => [d, true]));
const fullSS = Object.fromEntries(SALES_SUPPORT_DIMENSIONS.map((d) => [d, true]));

// ─── assignTier ─────────────────────────────────────────────────────────

test('assignTier: a company-defining launch → Tier 0', () => {
  assert.equal(assignTier({ bump: 'MAJOR', marketDefining: true }).tier, 0);
});

test('assignTier: a MAJOR → Tier 1', () => {
  assert.equal(assignTier({ bump: 'MAJOR' }).tier, 1);
});

test('assignTier: a MINOR CX update → Tier 3', () => {
  assert.equal(assignTier({ bump: 'MINOR', cxUpdate: true }).tier, 3);
});

test('assignTier: a PATCH → Tier 4', () => {
  assert.equal(assignTier({ bump: 'PATCH' }).tier, 4);
});

// ─── tierMatchesBump (M1) ───────────────────────────────────────────────

test('tierMatchesBump: Tier 1 matches a MAJOR', () => {
  assert.equal(tierMatchesBump(1, 'MAJOR').matches, true);
});

test('tierMatchesBump: THE mismatch — a MAJOR shipping as a Tier-4 silent update', () => {
  const r = tierMatchesBump(4, 'MAJOR');
  assert.equal(r.matches, false);
  assert.deepEqual(r.allowedTiers, [0, 1]);
  assert.match(r.reason, /MAJOR/);
});

test('tierMatchesBump: Tier 4 matches a PATCH; Tier 2 matches a MINOR', () => {
  assert.equal(tierMatchesBump(4, 'PATCH').matches, true);
  assert.equal(tierMatchesBump(2, 'MINOR').matches, true);
});

// ─── readiness checklists ───────────────────────────────────────────────

test('evaluateGtmReadiness: complete vs a gap', () => {
  assert.equal(evaluateGtmReadiness(fullGtm).complete, true);
  const gap = evaluateGtmReadiness({ ...fullGtm, pricing: false });
  assert.equal(gap.complete, false);
  assert.deepEqual(gap.missing, ['pricing']);
});

test('evaluateSalesSupportReadiness: complete vs a gap', () => {
  assert.equal(evaluateSalesSupportReadiness(fullSS).complete, true);
  assert.equal(evaluateSalesSupportReadiness({ ...fullSS, faq: false }).complete, false);
});

// ─── checkLaunchSync (M4) ───────────────────────────────────────────────

test('checkLaunchSync: marketing + embargo on the release date → synced', () => {
  const r = checkLaunchSync({ releaseDate: '2026-07-17', marketingDate: '2026-07-17', embargoLiftDate: '2026-07-17', toleranceDays: 0 });
  assert.equal(r.synced, true);
});

test('checkLaunchSync: marketing off the release calendar → not synced', () => {
  const r = checkLaunchSync({ releaseDate: '2026-07-17', marketingDate: '2026-07-25', toleranceDays: 0 });
  assert.equal(r.synced, false);
  assert.ok(r.problems.length >= 1);
});

// ─── gates M1–M4 + ledger ───────────────────────────────────────────────

test('M1: a matching Tier 3 (MINOR) auto-clears → GO', async () => {
  const ledger = newLedger();
  const gate = buildTierGate({ ledger, tier: 3 });
  const r = await gate.evaluate({ scope: { runId: 'gtm-1' }, tierMatch: tierMatchesBump(3, 'MINOR'), tier: 3 });
  assert.equal(r.verdict, VERDICT.GO);
});

test('M1: a matching Tier 1 (MAJOR) is a human gate → HOLD', async () => {
  const ledger = newLedger();
  const gate = buildTierGate({ ledger, tier: 1 });
  const r = await gate.evaluate({ scope: { runId: 'gtm-2' }, tierMatch: tierMatchesBump(1, 'MAJOR'), tier: 1 });
  assert.equal(r.verdict, VERDICT.HOLD);
  assert.equal(r.routedToHuman, true);
});

test('M1: a tier↔bump mismatch (a MAJOR at Tier 4) → HOLD (escalate)', async () => {
  const ledger = newLedger();
  const gate = buildTierGate({ ledger, tier: 4 });
  const r = await gate.evaluate({ scope: { runId: 'gtm-3' }, tierMatch: tierMatchesBump(4, 'MAJOR'), tier: 4 });
  assert.equal(r.verdict, VERDICT.HOLD);
});

test('M2/M3/M4 verdicts + a launch decision is recorded to the ledger', async () => {
  const ledger = newLedger();
  const { M2, M3, M4 } = buildGtmGates({ ledger });
  assert.equal((await M2.evaluate({ scope: { runId: 'g' }, gtmReadiness: evaluateGtmReadiness(fullGtm) })).verdict, VERDICT.GO);
  assert.equal((await M2.evaluate({ scope: { runId: 'g' }, gtmReadiness: evaluateGtmReadiness({ ...fullGtm, messaging: false }) })).verdict, VERDICT.RECYCLE);
  assert.equal((await M3.evaluate({ scope: { runId: 'g' }, salesSupport: evaluateSalesSupportReadiness(fullSS) })).verdict, VERDICT.GO);
  assert.equal((await M4.evaluate({ scope: { runId: 'g' }, launchSync: checkLaunchSync({ releaseDate: '2026-07-17', marketingDate: '2026-08-01' }) })).verdict, VERDICT.HOLD);

  const verdicts = await ledger.read({ kind: 'verdict' });
  assert.equal(verdicts.length, 4);
});

test('the GTM gates keep actor ≠ verifier', () => {
  const ledger = newLedger();
  const m1 = buildTierGate({ ledger, tier: 1 });
  assert.equal(m1.actor, 'gtm-advisor');
  assert.equal(m1.verifier, 'version-manager');
  const { M2 } = buildGtmGates({ ledger });
  assert.equal(M2.actor, 'gtm-advisor');
  assert.equal(M2.verifier, 'release-manager');
});
