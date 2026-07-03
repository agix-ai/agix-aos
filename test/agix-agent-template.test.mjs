// agix-agent-template — agent scaffolding generator unit tests (AGIX.ONBOARD.1 E.3).
// Runner: node --test test/agix-agent-template.test.mjs
//
// Covers: the template fn produces all 4 files with a valid soul block + a
// policy_file path that is consistent across manifest + policy, for a temp target
// dir; the generated manifest + policy parse as YAML; the entry exports run(); the
// generated source is generic (no operator/product/client strings). Guard rails:
// rejects an existing dir (no clobber) + a bad slug.
//
// Everything writes to a TEMP dir — the real agents/ tree is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import {
  buildAgentFiles,
  scaffoldAgent,
  isValidSlug,
  VALID_TRUST_LEVELS,
  DEFAULT_TRUST_LEVEL,
} from '../lib/agix-agent-template.mjs';

function tmpAgentsDir() {
  return mkdtempSync(join(tmpdir(), 'agix-agent-template-test-'));
}

test('buildAgentFiles produces all four files', () => {
  const files = buildAgentFiles({ name: 'demo-scout', description: 'A demo agent' });
  assert.deepEqual(
    Object.keys(files).sort(),
    ['PERSONA.md', 'agent.mjs', 'manifest.yaml', 'policy.yaml'],
  );
  for (const [k, v] of Object.entries(files)) {
    assert.ok(typeof v === 'string' && v.length > 0, `${k} should be non-empty`);
  }
});

test('manifest parses as YAML with a valid soul block', () => {
  const files = buildAgentFiles({ name: 'demo-scout', description: 'A demo agent' });
  const m = yaml.load(files['manifest.yaml']);
  assert.equal(m.name, 'demo-scout');
  assert.ok(m.display_name.startsWith('Agix '), 'display_name derived');
  assert.equal(m.description, 'A demo agent');
  assert.ok(m.soul, 'soul block present');
  assert.equal(m.soul.version, '1.0');
  assert.equal(m.soul.trust_level, DEFAULT_TRUST_LEVEL);
  assert.ok(Array.isArray(m.soul.core_truths) && m.soul.core_truths.length >= 1, 'core_truths is a non-empty list');
  assert.ok(Array.isArray(m.soul.boundaries) && m.soul.boundaries.length >= 1, 'boundaries is a non-empty list');
  assert.ok(typeof m.soul.vibe === 'string' && m.soul.vibe.length > 0, 'vibe present');
  assert.equal(m.soul.memory_scope, 'wiki/demo-scout/');
  assert.equal(m.soul.policy_file, 'agents/demo-scout/policy.yaml');
});

test('policy parses as YAML and its policy_file path is consistent with the manifest', () => {
  const files = buildAgentFiles({ name: 'demo-scout' });
  const m = yaml.load(files['manifest.yaml']);
  const p = yaml.load(files['policy.yaml']);
  assert.equal(p.agent, 'demo-scout');
  assert.equal(p.trust_level, m.soul.trust_level, 'policy trust_level matches manifest soul.trust_level');
  // The manifest's policy_file pointer must address THIS policy file.
  assert.equal(m.soul.policy_file, 'agents/demo-scout/policy.yaml');
  assert.ok(p.filesystem && Array.isArray(p.filesystem.read), 'filesystem.read present');
  assert.ok(Array.isArray(p.tools.allow) && p.tools.allow.length > 0, 'tools.allow present');
  assert.ok(Array.isArray(p.bash.deny_patterns) && p.bash.deny_patterns.length > 0, 'bash.deny_patterns present');
});

test('agent.mjs exports an async run() and a pure analyze()', async () => {
  const dir = tmpAgentsDir();
  try {
    const r = await scaffoldAgent({ name: 'demo-scout', description: 'A demo agent', agentsDir: dir });
    const entry = resolve(r.dir, 'agent.mjs');
    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`); // cache-bust per run (file:// URL — Windows-safe)
    assert.equal(typeof mod.run, 'function', 'exports run');
    assert.equal(typeof mod.analyze, 'function', 'exports analyze');
    const a = mod.analyze({ text: 'one\ntwo' });
    assert.equal(a.lines, 2);
    assert.equal(a.chars, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldAgent writes the four files to the target dir', async () => {
  const dir = tmpAgentsDir();
  try {
    const r = await scaffoldAgent({ name: 'demo-scout', agentsDir: dir });
    assert.equal(r.name, 'demo-scout');
    assert.equal(r.trust, DEFAULT_TRUST_LEVEL);
    for (const f of ['manifest.yaml', 'agent.mjs', 'PERSONA.md', 'policy.yaml']) {
      assert.ok(existsSync(join(r.dir, f)), `${f} written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trust level flows into manifest + policy', () => {
  for (const trust of VALID_TRUST_LEVELS) {
    const files = buildAgentFiles({ name: 'demo-scout', trust });
    const m = yaml.load(files['manifest.yaml']);
    const p = yaml.load(files['policy.yaml']);
    assert.equal(m.soul.trust_level, trust);
    assert.equal(p.trust_level, trust);
  }
});

test('generated content is generic — no operator/product/client strings', () => {
  const files = buildAgentFiles({ name: 'demo-scout', trust: 'executor', description: 'A demo agent' });
  const blob = Object.values(files).join('\n').toLowerCase();
  for (const leak of ['deep-sync', 'deepsync', 'deeptrace', 'katapult', 'arcgis', 'clearnetworx', 'brandan', 'gmail.com', '@deep-sync.io', 'agix-ai.io']) { // # public-clean: ok leak-detection-test — these literals are the denylist this test enforces, not a real leak
    assert.ok(!blob.includes(leak), `must not contain "${leak}"`);
  }
});

test('rejects a bad slug', () => {
  assert.equal(isValidSlug('demo-scout'), true);
  assert.equal(isValidSlug('Demo-Scout'), false);   // uppercase
  assert.equal(isValidSlug('demo_scout'), false);   // underscore
  assert.equal(isValidSlug('-demo'), false);        // leading dash
  assert.equal(isValidSlug('demo-'), false);        // trailing dash
  assert.equal(isValidSlug('demo--scout'), false);  // double dash
  assert.equal(isValidSlug(''), false);
  assert.throws(() => buildAgentFiles({ name: 'Bad Name' }), /Invalid agent name/);
});

test('rejects an existing dir (no clobber)', async () => {
  const dir = tmpAgentsDir();
  try {
    mkdirSync(join(dir, 'demo-scout'), { recursive: true });
    await assert.rejects(
      scaffoldAgent({ name: 'demo-scout', agentsDir: dir }),
      /already exists/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an invalid trust level', () => {
  assert.throws(() => buildAgentFiles({ name: 'demo-scout', trust: 'admin' }), /Invalid trust level/);
});
