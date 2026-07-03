// agix-audit-ledger — unit + isolation + DORA tests.
// Runner: node --test test/agix-audit-ledger.test.mjs
//
// Covers the LOOP_ENGINEERED_SDLC §5 substrate + MULTI_LEVEL_ENTERPRISE_AOS_SPEC
// §1.3 governance extension:
//   - append is atomic + deterministic under injected clock + idgen
//   - read filters by scope / kind / since
//   - the closed kind + verdict vocabularies reject garbage
//   - structural isolation: a ledger cannot append/read a foreign enterprise
//   - the canonical key degenerates to today's tenants/agix/... layout
//   - DORA (5) + gate metrics compute correctly on a fixture ledger
//   - FileLedgerStore round-trips JSONL on disk

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  AuditLedger,
  MemoryLedgerStore,
  FileLedgerStore,
  makeSmokeLedgerStore,
  ledgerDocSegments,
  LEDGER_KINDS,
  VERDICTS,
} from '../lib/agix-audit-ledger.mjs';
import {
  computeDora,
  gateMetrics,
  deploymentFrequency,
  changeLeadTime,
  changeFailureRate,
  failedDeploymentRecoveryTime,
  deploymentReworkRate,
  gateRejectionRate,
  firstPassGateYield,
} from '../lib/agix-dora.mjs';

// Deterministic seams: a monotonic id counter + a fixed clock.
function seams(startMs = Date.parse('2026-07-03T00:00:00.000Z')) {
  let n = 0;
  let t = startMs;
  return {
    idgen: () => `entry-${String(++n).padStart(4, '0')}`,
    clock: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
    setTs: (isoOrMs) => { t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs); },
  };
}

// ─── Canonical key ─────────────────────────────────────────────────────

test('ledgerDocSegments degenerates to today\'s tenants/agix layout', () => {
  assert.deepEqual(ledgerDocSegments({ enterpriseId: 'agix' }), ['tenants', 'agix', 'ledger']);
  assert.deepEqual(ledgerDocSegments({ enterpriseId: 'acme-corp' }), ['tenants', 'acme-corp', 'ledger']);
});

test('ledgerDocSegments rejects a traversal enterpriseId', () => {
  assert.throws(() => ledgerDocSegments({ enterpriseId: '../etc' }), /not a valid identifier/);
});

// ─── Append: deterministic + atomic ────────────────────────────────────

test('append fills entry_id + ts from injected seams (deterministic)', async () => {
  const s = seams();
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), clock: s.clock, idgen: s.idgen });
  const rec = await ledger.append({ kind: 'merge', actor: 'git-orchestrator', phase: 'integrate' });
  assert.equal(rec.entry_id, 'entry-0001');
  assert.equal(rec.ts, '2026-07-03T00:00:00.000Z');
  assert.equal(rec.kind, 'merge');
  assert.equal(rec.overridden_by_human, false);
  assert.deepEqual(rec.scope, { enterpriseId: 'agix' });
});

test('append preserves the deep governance scope + carries meta', async () => {
  const s = seams();
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), clock: s.clock, idgen: s.idgen });
  const rec = await ledger.append({
    kind: 'verdict',
    scope: { userId: 'u1', roleId: 'operator', mandateId: 'm1', runId: 'r1' },
    verdict: 'GO',
    verifier: 'architect',
    actor: 'coder',
    authority_used: ['edit:lib/**'],
    inputs_hash: 'sha256:abc',
    cost: { cost_usd: 0.01, tokens: 1200 },
    meta: { gate: 'implement-gate' },
  });
  assert.deepEqual(rec.scope, { enterpriseId: 'agix', userId: 'u1', roleId: 'operator', mandateId: 'm1', runId: 'r1' });
  assert.equal(rec.verdict, 'GO');
  assert.deepEqual(rec.cost, { cost_usd: 0.01, tokens: 1200 });
  assert.equal(rec.meta.gate, 'implement-gate');
});

test('append rejects an unknown kind and an unknown verdict', async () => {
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore() });
  await assert.rejects(() => ledger.append({ kind: 'nope' }), /unknown kind/);
  await assert.rejects(() => ledger.append({ kind: 'verdict', verdict: 'MAYBE' }), /unknown verdict/);
});

test('the closed vocabularies are what the doc specifies', () => {
  assert.deepEqual([...LEDGER_KINDS].sort(), ['gate_decision', 'launch', 'lease', 'merge', 'release', 'verdict', 'version_bump'].sort());
  assert.deepEqual([...VERDICTS], ['GO', 'KILL', 'HOLD', 'RECYCLE']);
});

// ─── Read: filter by scope / kind / since ──────────────────────────────

test('read filters by kind, partial scope, and since', async () => {
  const s = seams();
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), clock: s.clock, idgen: s.idgen });
  await ledger.append({ kind: 'merge', scope: { mandateId: 'm1' } });
  s.advance(1000);
  await ledger.append({ kind: 'verdict', verdict: 'GO', scope: { mandateId: 'm1' } });
  s.advance(1000);
  await ledger.append({ kind: 'verdict', verdict: 'RECYCLE', scope: { mandateId: 'm2' } });

  assert.equal((await ledger.read({ kind: 'verdict' })).length, 2);
  assert.equal((await ledger.read({ scope: { mandateId: 'm1' } })).length, 2);
  assert.equal((await ledger.read({ scope: { mandateId: 'm2' } })).length, 1);
  const since = new Date(Date.parse('2026-07-03T00:00:00.000Z') + 1500).toISOString();
  const recent = await ledger.read({ since });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].verdict, 'RECYCLE');
});

// ─── Isolation ─────────────────────────────────────────────────────────

test('a ledger cannot append an entry naming a foreign enterprise', async () => {
  const ledger = new AuditLedger({ scope: { enterpriseId: 'tenant-a' }, store: new MemoryLedgerStore() });
  await assert.rejects(
    () => ledger.append({ kind: 'merge', scope: { enterpriseId: 'tenant-b' } }),
    /foreign enterprise/,
  );
});

test('two enterprises on one store never see each other\'s entries', async () => {
  const store = new MemoryLedgerStore();
  const a = new AuditLedger({ scope: { enterpriseId: 'tenant-a' }, store, ...seams() });
  const b = new AuditLedger({ scope: { enterpriseId: 'tenant-b' }, store, ...seams() });
  await a.append({ kind: 'release', verdict: 'GO' });
  await b.append({ kind: 'release', verdict: 'KILL' });
  const aEntries = await a.read();
  const bEntries = await b.read();
  assert.equal(aEntries.length, 1);
  assert.equal(bEntries.length, 1);
  assert.equal(aEntries[0].verdict, 'GO');
  assert.equal(bEntries[0].verdict, 'KILL');
  // A cross-enterprise read filter returns nothing.
  assert.equal((await a.read({ scope: { enterpriseId: 'tenant-b' } })).length, 0);
});

// ─── FileLedgerStore round-trip ────────────────────────────────────────

test('FileLedgerStore appends JSONL and reads it back in order', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'agix-ledger-'));
  const store = new FileLedgerStore({ root: dir });
  const s = seams();
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store, clock: s.clock, idgen: s.idgen });
  await ledger.append({ kind: 'merge' });
  s.advance(1000);
  await ledger.append({ kind: 'release', verdict: 'GO' });

  const onDisk = await readFile(resolve(dir, 'tenants', 'agix', 'ledger.jsonl'), 'utf8');
  const lines = onDisk.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, 'merge');
  assert.equal(JSON.parse(lines[1]).kind, 'release');

  const readBack = await ledger.read();
  assert.equal(readBack.length, 2);
  assert.equal(readBack[0].entry_id, 'entry-0001');
});

test('FileLedgerStore.readLines returns [] when the ledger does not exist yet', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'agix-ledger-empty-'));
  const store = new FileLedgerStore({ root: dir });
  assert.deepEqual(await store.readLines(['tenants', 'agix', 'ledger']), []);
});

// ─── Smoke store ───────────────────────────────────────────────────────

test('smoke store keeps writes in-process and out of the real ledger', async () => {
  const store = makeSmokeLedgerStore();
  assert.equal(store.smoke, true);
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store, ...seams() });
  await ledger.append({ kind: 'merge' });
  assert.equal((await ledger.read()).length, 1);
});

// ─── DORA + gate metrics on a fixture ledger ───────────────────────────
//
// Fixture: two changes (m1, m2). m1 merges then releases 1h later (clean).
// m2 merges, is RECYCLE'd once then GO'd, releases, that release FAILS, and a
// later clean release recovers it 2h after the failure.

function fixtureEntries() {
  const t0 = Date.parse('2026-07-03T00:00:00.000Z');
  const h = 3_600_000;
  const iso = (ms) => new Date(ms).toISOString();
  return [
    // change m1: clean
    { kind: 'merge',   scope: { mandateId: 'm1' }, phase: 'integrate', actor: 'git-orchestrator', ts: iso(t0) },
    { kind: 'verdict', scope: { mandateId: 'm1' }, phase: 'implement', actor: 'coder', verifier: 'architect', verdict: 'GO', ts: iso(t0) },
    { kind: 'release', scope: { mandateId: 'm1' }, phase: 'release', actor: 'release-engineer', verdict: 'GO', ts: iso(t0 + 1 * h) },
    // change m2: one recycle then go, a failing release, then a recovering release
    { kind: 'verdict', scope: { mandateId: 'm2' }, phase: 'implement', actor: 'coder', verifier: 'architect', verdict: 'RECYCLE', ts: iso(t0 + 1 * h) },
    { kind: 'verdict', scope: { mandateId: 'm2' }, phase: 'implement', actor: 'coder', verifier: 'architect', verdict: 'GO', ts: iso(t0 + 2 * h) },
    { kind: 'merge',   scope: { mandateId: 'm2' }, phase: 'integrate', actor: 'git-orchestrator', ts: iso(t0 + 2 * h) },
    { kind: 'release', scope: { mandateId: 'm2' }, phase: 'release', actor: 'release-engineer', verdict: 'GO', ts: iso(t0 + 3 * h), meta: { failed: true } },
    { kind: 'release', scope: { mandateId: 'm2' }, phase: 'release', actor: 'release-engineer', verdict: 'GO', ts: iso(t0 + 5 * h) },
  ];
}

test('deploymentFrequency counts releases + a per-day rate', () => {
  const df = deploymentFrequency(fixtureEntries());
  assert.equal(df.count, 3);
  assert.ok(df.perDay > 0);
});

test('changeLeadTime is the median merge→release gap (per release)', () => {
  const lt = changeLeadTime(fixtureEntries());
  // m1 release: 1h. m2 merges t0+2h → first release t0+3h = 1h, recovery release
  // t0+5h = 3h. samples = 3 (each release), median of [1h,1h,3h] = 1h.
  assert.equal(lt.medianMs, 3_600_000);
  assert.equal(lt.samples, 3);
});

test('changeFailureRate = failed releases / total', () => {
  const cf = changeFailureRate(fixtureEntries());
  assert.equal(cf.total, 3);
  assert.equal(cf.failed, 1);
  assert.equal(cf.rate, 1 / 3);
});

test('failedDeploymentRecoveryTime = median gap to next clean release', () => {
  const rt = failedDeploymentRecoveryTime(fixtureEntries());
  assert.equal(rt.recovered, 1);
  assert.equal(rt.unrecovered, 0);
  assert.equal(rt.medianMs, 2 * 3_600_000);
});

test('deploymentReworkRate = RECYCLE / total gate verdicts', () => {
  const rw = deploymentReworkRate(fixtureEntries());
  // Only verdict/gate_decision kinds count (release stamps are DORA, not gate
  // verdicts): m1 GO, m2 RECYCLE, m2 GO = 3.
  assert.equal(rw.total, 3);
  assert.equal(rw.recycled, 1);
  assert.equal(rw.rate, 1 / 3);
});

test('gateRejectionRate groups by phase and by actor', () => {
  const byPhase = gateRejectionRate(fixtureEntries(), { by: 'phase' });
  // implement phase: GO, RECYCLE, GO → 1 rejected / 3
  assert.equal(byPhase.implement.total, 3);
  assert.equal(byPhase.implement.rejected, 1);
  assert.equal(byPhase.implement.rate, 1 / 3);
  const byActor = gateRejectionRate(fixtureEntries(), { by: 'actor' });
  assert.equal(byActor.coder.total, 3);
  assert.equal(byActor.coder.rejected, 1);
});

test('firstPassGateYield counts (change,phase) gate sequences whose first verdict was GO', () => {
  const fp = firstPassGateYield(fixtureEntries());
  // Gate sequences (verdict/gate_decision kinds only): (m1,implement)=GO first-pass;
  // (m2,implement)=RECYCLE first (not first-pass). total=2, firstPass=1.
  assert.equal(fp.total, 2);
  assert.equal(fp.firstPass, 1);
  assert.equal(fp.rate, 1 / 2);
});

test('computeDora + gateMetrics bundle all metrics', () => {
  const dora = computeDora(fixtureEntries());
  assert.ok(dora.deploymentFrequency && dora.changeLeadTime && dora.changeFailureRate);
  assert.ok(dora.failedDeploymentRecoveryTime && dora.deploymentReworkRate);
  const g = gateMetrics(fixtureEntries());
  assert.ok(g.rejectionRateByPhase && g.rejectionRateByActor && g.firstPassGateYield);
});

test('ledger.stats rolls up counts + DORA + gates from history', async () => {
  const ledger = new AuditLedger({ scope: { enterpriseId: 'agix' }, store: new MemoryLedgerStore(), ...seams() });
  for (const e of fixtureEntries()) await ledger.append(e);
  const stats = await ledger.stats();
  assert.equal(stats.total, 8);
  assert.equal(stats.byKind.release, 3);
  assert.equal(stats.byVerdict.GO, 5);
  assert.equal(stats.byVerdict.RECYCLE, 1);
  assert.equal(stats.dora.changeFailureRate.rate, 1 / 3);
  assert.equal(stats.gates.firstPassGateYield.total, 2);
});

test('empty ledger yields null rates, not NaN or throws', () => {
  const dora = computeDora([]);
  assert.equal(dora.changeFailureRate.rate, null);
  assert.equal(dora.deploymentFrequency.count, 0);
  assert.equal(dora.deploymentFrequency.perDay, null);
  assert.equal(firstPassGateYield([]).rate, null);
});
