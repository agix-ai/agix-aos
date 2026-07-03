// agix-user-agents — install-safe user agent dir + merged discovery (fix/agent-new-user-dir).
// Runner: node --test test/agix-user-agents.test.mjs
//
// The fix: `agix agent new` on an INSTALL must NOT write into the pack's install
// tree (Homebrew Cellar libexec → wiped on `brew upgrade`; read-only on Linux/root).
// Generated agents go to a USER-writable dir (userAgentsDir()), and discovery
// (listAgents) scans BOTH the pack and the user dir so a freshly-generated user
// agent is immediately listable / runnable / smokeable. On a slug collision the
// PACK agent wins.
//
// These tests override AGIX_USER_AGENTS_DIR → a TEMP dir, so the real
// ~/.config/agix/agents/ is never touched, and scaffold into that temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import {
  isDevCheckout,
  userAgentsDir,
  newAgentTargetDir,
  listAgents,
} from '../lib/agix-runtime.mjs';
import { scaffoldAgent } from '../lib/agix-agent-template.mjs';

function withTempUserDir(fn) {
  const prev = process.env.AGIX_USER_AGENTS_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'agix-user-agents-test-'));
  process.env.AGIX_USER_AGENTS_DIR = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.AGIX_USER_AGENTS_DIR;
    else process.env.AGIX_USER_AGENTS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test('isDevCheckout: true for a tree with .git, false for one without', () => {
  const a = mkdtempSync(join(tmpdir(), 'agix-dev-probe-'));
  const b = mkdtempSync(join(tmpdir(), 'agix-install-probe-'));
  try {
    writeFileSync(join(a, '.git'), 'gitdir: /somewhere\n'); // worktree gitlink shape
    assert.equal(isDevCheckout(a), true, 'has .git → dev');
    assert.equal(isDevCheckout(b), false, 'no .git → install');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('userAgentsDir honors AGIX_USER_AGENTS_DIR override', () => withTempUserDir((dir) => {
  assert.equal(userAgentsDir(), resolve(dir));
}));

test('newAgentTargetDir: in-tree agents/ on dev, user dir on install', () => withTempUserDir((dir) => {
  const devRoot = mkdtempSync(join(tmpdir(), 'agix-dev-root-'));
  const installRoot = mkdtempSync(join(tmpdir(), 'agix-install-root-'));
  try {
    writeFileSync(join(devRoot, '.git'), 'gitdir: /x\n');
    // DEV: target is the pack's in-tree agents/.
    assert.equal(newAgentTargetDir({ repoRoot: devRoot }), resolve(devRoot, 'agents'));
    // INSTALL (no .git): target is the user agents dir, NOT the install tree.
    const target = newAgentTargetDir({ repoRoot: installRoot });
    assert.equal(target, resolve(dir));
    assert.notEqual(target, resolve(installRoot, 'agents'), 'install must NOT target the pack tree');
  } finally {
    rmSync(devRoot, { recursive: true, force: true });
    rmSync(installRoot, { recursive: true, force: true });
  }
}));

test('agent new on install → user dir; discovery merges pack + user agents', () => withTempUserDir(async (dir) => {
  // Scaffold a user agent into the temp user dir (what cmdNew does on an install).
  const r = await scaffoldAgent({ name: 'usr-discover-test', trust: 'observer', agentsDir: dir });
  assert.ok(r.dir.startsWith(resolve(dir)), 'scaffolded under the user dir');
  assert.ok(existsSync(join(r.dir, 'manifest.yaml')), 'manifest written');

  const all = await listAgents();
  const mine = all.find((a) => a.name === 'usr-discover-test');
  assert.ok(mine, 'freshly-generated user agent is discovered by listAgents()');
  assert.equal(mine.origin, 'user', 'tagged origin=user');
  // The pack agents are still discovered alongside (merge, not replace).
  assert.ok(all.some((a) => a.origin === 'pack'), 'pack agents still present in the merged list');
}));

test('collision: a pack agent wins over a same-named user agent (no shadow)', () => withTempUserDir(async (dir) => {
  // Find a real shipped pack agent to collide with.
  const before = await listAgents();
  const packAgent = before.find((a) => a.origin === 'pack');
  assert.ok(packAgent, 'expected at least one pack agent to exist');

  // Hand-create a user agent dir with the SAME slug as the pack agent.
  const collisionDir = join(dir, packAgent.name);
  mkdirSync(collisionDir, { recursive: true });
  writeFileSync(join(collisionDir, 'manifest.yaml'), `name: ${packAgent.name}\n`);

  const after = await listAgents();
  const matches = after.filter((a) => a.name === packAgent.name);
  assert.equal(matches.length, 1, 'colliding name appears exactly once (no duplicate)');
  assert.equal(matches[0].origin, 'pack', 'the PACK agent wins, the user one is shadowed');
}));
