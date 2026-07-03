// getLedger() runtime seam + Phase B tier filter — unit tests.
// Runner: node --test test/agix-getledger.test.mjs
//
// Covers the two coherence fixes of the CLI-integration pass:
//   1. LocalRuntime.getLedger() — a tenant-scoped AuditLedger, cached, backed
//      by a FileLedgerStore under outputRoot()/governance (smoke → sandbox).
//   2. The declarative manifest `tier:` assignments Phase B's tarball filter
//      reads (the free public pack = every basic-tier agent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalRuntime } from '../lib/agix-runtime.mjs';
import { AuditLedger } from '../lib/agix-audit-ledger.mjs';
import yaml from 'js-yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── getLedger() ─────────────────────────────────────────────────────────

test('getLedger: returns an AuditLedger scoped to the runtime tenant', () => {
  const rt = new LocalRuntime({ agentName: 'version-manager', tenantId: 'agix' });
  const ledger = rt.getLedger();
  assert.ok(ledger instanceof AuditLedger);
  assert.equal(ledger.scope.enterpriseId, 'agix');
});

test('getLedger: is cached (same instance across calls, like _scheduler)', () => {
  const rt = new LocalRuntime({ agentName: 'release-manager' });
  assert.equal(rt.getLedger(), rt.getLedger());
});

test('getLedger: a non-default tenant is carried onto the ledger scope', () => {
  const rt = new LocalRuntime({ agentName: 'gtm-advisor', tenantId: 'acme' });
  assert.equal(rt.getLedger().scope.enterpriseId, 'acme');
});

test('getLedger: smoke mode uses the sandbox store (no real system of record)', async () => {
  const rt = new LocalRuntime({ agentName: 'version-manager', smoke: true });
  const ledger = rt.getLedger();
  assert.equal(ledger.store.smoke, true);
  // A smoke append is readable within the run but writes to no file.
  const rec = await ledger.append({ kind: 'version_bump', scope: { runId: 'r1' }, verdict: 'GO' });
  assert.equal(rec.kind, 'version_bump');
  const back = await ledger.read({ kind: 'version_bump' });
  assert.equal(back.length, 1);
});

test('getLedger: non-smoke writes a FileLedger under outputRoot()/governance', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'agix-getledger-'));
  const prev = process.env.AGIX_DATA_DIR;
  process.env.AGIX_DATA_DIR = dir;
  try {
    const rt = new LocalRuntime({ agentName: 'version-manager', tenantId: 'agix' });
    const ledger = rt.getLedger();
    assert.notEqual(ledger.store.smoke, true);
    await ledger.append({ kind: 'release', scope: { runId: 'rel-1' }, verdict: 'GO' });
    // The append lands under <outputRoot>/governance/tenants/agix/ledger.jsonl.
    const path = resolve(dir, 'governance', 'tenants', 'agix', 'ledger.jsonl');
    const s = await stat(path);
    assert.ok(s.isFile());
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, 'release');
  } finally {
    if (prev === undefined) delete process.env.AGIX_DATA_DIR; else process.env.AGIX_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('getLedger: read/stats round-trip works over the seeded ledger', async () => {
  const rt = new LocalRuntime({ agentName: 'version-manager', smoke: true });
  const ledger = rt.getLedger();
  await ledger.append({ kind: 'gate_decision', scope: { runId: 'r1' }, phase: 'release', verdict: 'GO' });
  await ledger.append({ kind: 'verdict', scope: { runId: 'r1' }, phase: 'release', verdict: 'GO' });
  const stats = await ledger.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.byKind.verdict, 1);
  assert.ok(stats.dora);
  assert.ok(stats.gates);
});

// ─── Phase B: manifest tier assignments (the tarball filter's source data) ──

// Mirror the tarball's dependency-light read: grep the first `tier:` line.
async function agentTier(name) {
  const raw = await readFile(resolve(REPO_ROOT, 'agents', name, 'manifest.yaml'), 'utf8');
  const m = raw.match(/^tier:\s*(\S+)/m);
  return m ? m[1] : null;
}

async function listAgentDirs() {
  const entries = await readdir(resolve(REPO_ROOT, 'agents'), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try { await stat(resolve(REPO_ROOT, 'agents', e.name, 'manifest.yaml')); out.push(e.name); }
    catch { /* not an agent dir */ }
  }
  return out;
}

const EXPECTED_BASIC = [
  'onboarding', 'sensei', 'architect', 'research', 'git-orchestrator',
  'tester', 'investigator', 'context-warden', 'version-manager', 'release-manager',
];

test('Phase B: every agent manifest declares a tier (fail-closed data)', async () => {
  for (const name of await listAgentDirs()) {
    assert.ok(await agentTier(name), `agents/${name}/manifest.yaml is missing a tier:`);
  }
});

test('Phase B: the tier filter (basic) selects exactly the 10 basic agents', async () => {
  const names = await listAgentDirs();
  const selected = [];
  for (const name of names) if ((await agentTier(name)) === 'basic') selected.push(name);
  assert.deepEqual(selected.slice().sort(), EXPECTED_BASIC.slice().sort());
  assert.equal(selected.length, 10);
});

test('Phase B: gtm-advisor is pro; enterprise agents are excluded from the free pack', async () => {
  assert.equal(await agentTier('gtm-advisor'), 'pro');
  for (const name of ['secretary', 'director', 'curator', 'madoguchi', 'sprite-agent']) {
    assert.equal(await agentTier(name), 'enterprise', `${name} should be enterprise`);
  }
});

test('Phase B: tier values are one of the known distribution tiers + YAML parses', async () => {
  const known = new Set(['basic', 'pro', 'enterprise']);
  for (const name of await listAgentDirs()) {
    const raw = await readFile(resolve(REPO_ROOT, 'agents', name, 'manifest.yaml'), 'utf8');
    const parsed = yaml.load(raw);   // parse must not throw
    assert.ok(known.has(parsed.tier), `agents/${name} tier "${parsed.tier}" not a known tier`);
  }
});
