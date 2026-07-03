// agix-soul — the instance soul GROWS, unit tests (AGIX.ONBOARD.1 Phase E.2).
// Runner: node --test test/agix-soul.test.mjs
//
// Covers Q3 (append-growing, minimal): appendLearning creates the
// `## Learnings (accreted)` section with a dated bullet; a second append APPENDS
// (both present, original sections intact); an exact duplicate is de-duped; readSoul
// reflects the growth; recordLearning is the same surface under a stable name; and the
// `agix soul show` / `agix soul note` CLI work end-to-end. The mentor accretes an
// approval into the soul as a best-effort side-effect.
//
// EVERYTHING runs in a TEMP HOME + temp config dir — the real ~/.config is NEVER
// touched. We pin BOTH $HOME and $AGIX_CONFIG_DIR (the module resolves at call time);
// pinning HOME too is belt-and-suspenders so even a code path that ignored
// AGIX_CONFIG_DIR could not escape the sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { soulPath, readSoul, appendLearning, recordLearning } from '../lib/agix-soul.mjs';

const AGIX_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agix');

// A fresh sandbox per test: temp HOME + temp config dir, wired via env so the module
// resolves paths there. Returns { home, configDir, cleanup, env }.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'agix-soul-test-'));
  const home = resolve(base, 'home');
  const configDir = resolve(home, '.config', 'agix');
  mkdirSync(configDir, { recursive: true });
  const prev = { HOME: process.env.HOME, AGIX_CONFIG_DIR: process.env.AGIX_CONFIG_DIR };
  process.env.HOME = home;
  process.env.AGIX_CONFIG_DIR = configDir;
  return {
    home,
    configDir,
    // env for child processes (the CLI end-to-end test).
    env: { ...process.env, HOME: home, AGIX_CONFIG_DIR: configDir },
    cleanup() {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// Write a minimal soul.md skeleton mirroring what onboarding scaffolds, so we can prove
// appendLearning leaves the original sections intact.
function scaffoldSoul() {
  writeFileSync(soulPath(), [
    '# Agix Instance Soul',
    '',
    '## Identity',
    '',
    '_Set during onboarding._',
    '',
    '## North Star',
    '',
    '_What you are trying to build._',
    '',
    '## Preferences',
    '',
    '- autonomy: ask',
    '',
  ].join('\n'), { mode: 0o600 });
}

test('soulPath resolves under AGIX_CONFIG_DIR (sandboxed, never ~/.config)', () => {
  const sb = sandbox();
  try {
    assert.equal(soulPath(), resolve(sb.configDir, 'soul.md'));
    assert.ok(soulPath().startsWith(sb.home), 'soul path is inside the temp HOME');
  } finally {
    sb.cleanup();
  }
});

test('appendLearning creates the Learnings section with a dated bullet', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const r = appendLearning('prefers concise reports', { now: Date.parse('2026-06-19T12:00:00Z') });
    assert.equal(r.appended, true);
    assert.equal(r.createdSection, true);
    const soul = readSoul();
    assert.match(soul, /## Learnings \(accreted\)/);
    assert.match(soul, /- 2026-06-19: prefers concise reports/);
    // Original sections survive (append-only, never clobbered).
    assert.match(soul, /## Identity/);
    assert.match(soul, /## North Star/);
    assert.match(soul, /## Preferences/);
  } finally {
    sb.cleanup();
  }
});

test('a second appendLearning APPENDS — both bullets present, section reused', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const before = readSoul();
    appendLearning('prefers X', { now: Date.parse('2026-06-19T00:00:00Z') });
    const r2 = appendLearning('prefers Y', { now: Date.parse('2026-06-20T00:00:00Z') });
    assert.equal(r2.appended, true);
    assert.equal(r2.createdSection, false, 'section already exists on the 2nd append');
    const soul = readSoul();
    assert.match(soul, /- 2026-06-19: prefers X/);
    assert.match(soul, /- 2026-06-20: prefers Y/);
    // Only ONE Learnings heading (the section was reused, not duplicated).
    assert.equal((soul.match(/## Learnings \(accreted\)/g) || []).length, 1);
    // The soul only grew.
    assert.ok(soul.length > before.length, 'soul.md only grows');
  } finally {
    sb.cleanup();
  }
});

test('an exact-duplicate learning is de-duped (no-op)', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const now = Date.parse('2026-06-19T00:00:00Z');
    appendLearning('prefers concise reports', { now });
    const soulAfterFirst = readSoul();
    const r = appendLearning('prefers concise reports', { now });
    assert.equal(r.appended, false);
    assert.equal(r.deduped, true);
    const soulAfterSecond = readSoul();
    assert.equal(soulAfterSecond, soulAfterFirst, 'duplicate did not change the soul');
    assert.equal((soulAfterSecond.match(/- 2026-06-19: prefers concise reports/g) || []).length, 1);
  } finally {
    sb.cleanup();
  }
});

test('appendLearning captures a learning even before a soul is scaffolded', () => {
  const sb = sandbox();
  try {
    // No scaffoldSoul() — soul.md does not exist yet.
    assert.equal(readSoul(), '');
    const r = appendLearning('early learning', { now: Date.parse('2026-06-19T00:00:00Z') });
    assert.equal(r.appended, true);
    assert.equal(r.createdSection, true);
    assert.ok(existsSync(soulPath()), 'soul.md created on first learning');
    assert.match(readSoul(), /- 2026-06-19: early learning/);
  } finally {
    sb.cleanup();
  }
});

test('category is rendered inline; empty text is a no-op', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const r = appendLearning('ships on Fridays', { category: 'cadence', now: Date.parse('2026-06-19T00:00:00Z') });
    assert.equal(r.appended, true);
    assert.match(readSoul(), /- 2026-06-19 \(cadence\): ships on Fridays/);
    const empty = appendLearning('   ');
    assert.equal(empty.appended, false);
    assert.equal(empty.deduped, false);
  } finally {
    sb.cleanup();
  }
});

test('recordLearning is the same surface under a stable (mentor-callable) name', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const r = recordLearning('approved weekly investor update', { category: 'approved', now: Date.parse('2026-06-19T00:00:00Z') });
    assert.equal(r.appended, true);
    assert.match(readSoul(), /- 2026-06-19 \(approved\): approved weekly investor update/);
  } finally {
    sb.cleanup();
  }
});

test('agix soul show / note work end-to-end against the temp soul', () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    // note → appends a learning
    const noteOut = execFileSync('node', [AGIX_BIN, 'soul', 'note', 'prefers dark mode'], {
      env: sb.env, encoding: 'utf8',
    });
    assert.match(noteOut, /✓ noted/);
    assert.match(readSoul(), /prefers dark mode/);

    // show → prints the soul, including the learning we just added
    const showOut = execFileSync('node', [AGIX_BIN, 'soul', 'show'], { env: sb.env, encoding: 'utf8' });
    assert.match(showOut, /## Learnings \(accreted\)/);
    assert.match(showOut, /prefers dark mode/);
    assert.match(showOut, /## Identity/, 'show prints the whole soul');
  } finally {
    sb.cleanup();
  }
});

test('the mentor accretes an approval into the soul (best-effort side-effect)', async () => {
  const sb = sandbox();
  try {
    scaffoldSoul();
    const { seedApprovals } = await import('../lib/agix-mentor.mjs');
    const { LocalRuntime } = await import('../lib/agix-runtime.mjs');
    const store = new LocalRuntime({ agentName: 'sensei', smoke: true }).getMemoryStore();
    await seedApprovals(store, [
      { text: 'approved monthly saas renewal', approvedDaysAgo: 1 },
    ], { now: Date.parse('2026-06-19T00:00:00Z') });
    // The approval accreted into the soul as an "approved" learning.
    assert.match(readSoul(), /\(approved\): approved monthly saas renewal/);
  } finally {
    sb.cleanup();
  }
});
