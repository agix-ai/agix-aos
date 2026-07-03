// agix-onboard — first-run AOS self-setup unit tests (AGIX.ONBOARD.1 Phase D).
// Runner: node --test test/agix-onboard.test.mjs
//
// Covers DL.12 (all-inclusive zero-prompt auto-provision), DL.13 (no API key —
// provider defaults to the detected CLI agent), D.2/D.3 (get-to-know-you, defaults
// path), D.1/DL.4 (first-run marker), and idempotence.
//
// EVERYTHING runs in a TEMP HOME + temp config/data dirs — the real ~/.config and
// ~/.local/state are NEVER touched. We override via AGIX_CONFIG_DIR + AGIX_DATA_DIR
// (resolved at call time inside the module) and a smoke LocalRuntime (no disk gbrain,
// no API spend). detectCliAgent is stubbed (no real `which claude`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import {
  isOnboarded,
  autoProvision,
  selectProvider,
  getToKnowYou,
  runOnboarding,
  chooseWorkspace,
} from '../lib/agix-onboard.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';

// A fresh sandbox per test: temp config dir + temp data root, wired via env so the
// module resolves paths there. Returns { configDir, dataRoot, cleanup }.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'agix-onboard-test-'));
  const configDir = resolve(base, 'config');
  const dataRoot = resolve(base, 'data');
  const prevConfig = process.env.AGIX_CONFIG_DIR;
  const prevData = process.env.AGIX_DATA_DIR;
  process.env.AGIX_CONFIG_DIR = configDir;
  process.env.AGIX_DATA_DIR = dataRoot;
  return {
    configDir,
    dataRoot,
    // A smoke runtime: gbrain is the in-memory stub (no disk), outputRoot() falls back
    // to AGIX_DATA_DIR (no .git in dataRoot) so wiki/ scaffolds under our temp.
    runtime: new LocalRuntime({ agentName: 'onboarding', smoke: true }),
    cleanup() {
      if (prevConfig === undefined) delete process.env.AGIX_CONFIG_DIR; else process.env.AGIX_CONFIG_DIR = prevConfig;
      if (prevData === undefined) delete process.env.AGIX_DATA_DIR; else process.env.AGIX_DATA_DIR = prevData;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const stubDetect = (kind) => () => kind; // () => 'claude-code' | 'codex' | null

// An INSTALL-flavored sandbox: temp HOME + temp AGIX_CONFIG_DIR, AGIX_DATA_DIR UNSET, a
// non-git repoRoot (simulating an installed pack — no .git above it). This is the case
// where the user chooses a VISIBLE workspace dir (data_dir in settings.json) and
// outputRoot() honors it. AGIX_CONFIG_DIR is set so both the onboard module's configDir()
// and the runtime's readConfiguredDataDir() agree on the temp config; AGIX_DATA_DIR stays
// UNSET so workspace resolution (and ~/agix default) flows through the chosen dir / HOME.
// Returns { home, configDir, packRoot, runtime, cleanup }.
function installSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'agix-install-test-'));
  const home = resolve(base, 'home');
  const packRoot = resolve(base, 'pack'); // NON-git → install case
  const configDir = resolve(base, 'config');
  const prevHome = process.env.HOME;
  const prevConfig = process.env.AGIX_CONFIG_DIR;
  const prevData = process.env.AGIX_DATA_DIR;
  process.env.HOME = home;
  process.env.AGIX_CONFIG_DIR = configDir;
  delete process.env.AGIX_DATA_DIR;   // the whole point — no env override
  return {
    home,
    configDir,
    packRoot,
    // A NON-smoke runtime so gbrain writes a real store under outputRoot() (the proof
    // that wiki + gbrain land in the chosen dir, not the hidden ~/.local/state).
    runtime: new LocalRuntime({ agentName: 'onboarding', repoRoot: packRoot }),
    cleanup() {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfig === undefined) delete process.env.AGIX_CONFIG_DIR; else process.env.AGIX_CONFIG_DIR = prevConfig;
      if (prevData === undefined) delete process.env.AGIX_DATA_DIR; else process.env.AGIX_DATA_DIR = prevData;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('isOnboarded is false on a fresh machine, true after runOnboarding', async () => {
  const sb = sandbox();
  try {
    assert.equal(isOnboarded(), false, 'fresh machine is not onboarded');

    await runOnboarding({
      interactive: false,
      runtime: sb.runtime,
      dataRoot: sb.dataRoot,
      detect: stubDetect('claude-code'),
      isTTY: false,
      log: () => {},
    });

    assert.equal(isOnboarded(), true, 'after onboarding the marker + identity exist');
  } finally {
    sb.cleanup();
  }
});

test('autoProvision is all-inclusive: gbrain seeded, wiki scaffolded, soul + settings created', () => {
  const sb = sandbox();
  try {
    const r = autoProvision({ runtime: sb.runtime, dataRoot: sb.dataRoot });

    // gbrain seeded (a page exists) — via the runtime's stub.
    assert.ok(sb.runtime.getGbrain().getPage('getting-started'), 'gbrain has a starter page');
    assert.equal(r.gbrainSeeded, true);

    // wiki/ scaffolded under the temp data root.
    assert.ok(existsSync(resolve(sb.dataRoot, 'wiki', 'README.md')), 'wiki/README.md created');
    assert.ok(existsSync(resolve(sb.dataRoot, 'wiki', 'notes', 'welcome.md')), 'wiki/notes/ scaffolded');

    // soul.md + settings.json created in the temp config dir.
    assert.ok(existsSync(resolve(sb.configDir, 'soul.md')), 'soul.md created');
    assert.ok(existsSync(resolve(sb.configDir, 'settings.json')), 'settings.json created');

    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.tier, 'basic');
    assert.equal(settings.autonomy, 'ask');
  } finally {
    sb.cleanup();
  }
});

test('selectProvider picks the detected CLI agent — no API key required (DL.13)', () => {
  const sb = sandbox();
  try {
    const claude = selectProvider({ detect: stubDetect('claude-code') });
    assert.equal(claude.provider, 'claude-code');
    assert.equal(claude.source, 'cli');
    assert.equal(claude.key_required, false);
    assert.match(claude.message, /Claude Code/);
    // Persisted as the default provider.
    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.default_provider, 'claude-code');

    const codex = selectProvider({ detect: stubDetect('codex') });
    assert.equal(codex.provider, 'codex');
    assert.equal(codex.key_required, false);
    assert.match(codex.message, /Codex/);
  } finally {
    sb.cleanup();
  }
});

test('selectProvider does NOT hard-fail when no CLI agent + no key — returns clear guidance', () => {
  const sb = sandbox();
  // Ensure no provider key leaks in from the real env for this assertion.
  const saved = {};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const none = selectProvider({ detect: stubDetect(null) });
    assert.equal(none.provider, null);
    assert.equal(none.source, 'none');
    assert.equal(none.key_required, true);
    assert.match(none.message, /Install Claude Code or Codex/);
    assert.match(none.message, /continues either way/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    sb.cleanup();
  }
});

test('selectProvider prefers the LOCAL model lane when AGIX_LOCAL_MODEL_URL + AGIX_LOCAL_MODEL are set', () => {
  const sb = sandbox();
  // Save/restore the local-lane env around the assertion (and any provider key that
  // could otherwise leak in — local must win regardless, but keep the case clean).
  const saved = {};
  for (const k of ['AGIX_LOCAL_MODEL_URL', 'AGIX_LOCAL_MODEL']) { saved[k] = process.env[k]; }
  process.env.AGIX_LOCAL_MODEL_URL = 'http://127.0.0.1:11434';
  process.env.AGIX_LOCAL_MODEL = 'gemma2:2b';
  try {
    // Even with a CLI agent "detected", the local lane is checked FIRST and wins.
    const local = selectProvider({ detect: stubDetect('claude-code') });
    assert.equal(local.provider, 'local');
    assert.equal(local.source, 'local');
    assert.equal(local.key_required, false);
    assert.match(local.message, /local model/);
    assert.match(local.message, /gemma2:2b/);
    assert.match(local.message, /127\.0\.0\.1:11434/);
    // Persisted as the default provider.
    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.default_provider, 'local');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    sb.cleanup();
  }
});

test('selectProvider ignores the LOCAL lane unless BOTH env vars are set (behavior unchanged otherwise)', () => {
  const sb = sandbox();
  // With only ONE of the two set, the lane is NOT configured → CLI detection still wins.
  const saved = {};
  for (const k of ['AGIX_LOCAL_MODEL_URL', 'AGIX_LOCAL_MODEL']) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.AGIX_LOCAL_MODEL_URL = 'http://127.0.0.1:11434'; // model name missing
  try {
    const claude = selectProvider({ detect: stubDetect('claude-code') });
    assert.equal(claude.provider, 'claude-code', 'half-configured local lane is ignored');
    assert.equal(claude.source, 'cli');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    sb.cleanup();
  }
});

test('getToKnowYou (defaults path, no TTY) writes placeholders without prompting', async () => {
  const sb = sandbox();
  try {
    autoProvision({ runtime: sb.runtime, dataRoot: sb.dataRoot }); // soul.md must exist for the append
    const id = await getToKnowYou({ interactive: false, isTTY: false });
    assert.ok(existsSync(resolve(sb.configDir, 'identity.json')), 'identity.json written even with no answers');
    // No prompting, no hardcoded operator — the identity carries no operator name.
    // (Empty placeholders are not persisted as noise; the field is simply absent.)
    assert.ok(!id.operator_first_name, 'no operator name set on the defaults/no-TTY path');
    assert.ok(!id.role, 'no role set on the defaults/no-TTY path');
  } finally {
    sb.cleanup();
  }
});

test('getToKnowYou accepts scripted answers and seeds the soul North Star', async () => {
  const sb = sandbox();
  try {
    autoProvision({ runtime: sb.runtime, dataRoot: sb.dataRoot });
    const id = await getToKnowYou({
      interactive: false,
      answers: { operator_first_name: 'Sam', role: 'founder', goals: 'ship the AOS', constraints: 'small team' },
    });
    assert.equal(id.operator_first_name, 'Sam');
    assert.equal(id.operator_full_name, 'Sam', 'full name derived from first when only first given');
    assert.equal(id.role, 'founder');

    const soul = readFileSync(resolve(sb.configDir, 'soul.md'), 'utf8');
    assert.match(soul, /North Star: ship the AOS/);
    assert.match(soul, /Constraints: small team/);
  } finally {
    sb.cleanup();
  }
});

test('runOnboarding is idempotent: a second run does NOT clobber identity or soul', async () => {
  const sb = sandbox();
  try {
    await runOnboarding({
      interactive: false, runtime: sb.runtime, dataRoot: sb.dataRoot,
      detect: stubDetect('claude-code'), isTTY: false, log: () => {},
      answers: { operator_first_name: 'Sam', goals: 'ship the AOS' },
    });
    const idPath = resolve(sb.configDir, 'identity.json');
    const soulPath = resolve(sb.configDir, 'soul.md');
    const id1 = readFileSync(idPath, 'utf8');
    const soul1 = readFileSync(soulPath, 'utf8');
    assert.match(JSON.parse(id1).operator_first_name, /Sam/);

    // Second run with DIFFERENT answers — existing non-empty fields must win.
    const sb2runtime = new LocalRuntime({ agentName: 'onboarding', smoke: true });
    await runOnboarding({
      interactive: false, runtime: sb2runtime, dataRoot: sb.dataRoot,
      detect: stubDetect('claude-code'), isTTY: false, log: () => {},
      answers: { operator_first_name: 'NotSam', goals: 'something else' },
    });
    const id2 = JSON.parse(readFileSync(idPath, 'utf8'));
    assert.equal(id2.operator_first_name, 'Sam', 'existing name preserved on re-run');

    // soul.md is append-growing — present + still references the original North Star.
    const soul2 = readFileSync(soulPath, 'utf8');
    assert.match(soul2, /North Star: ship the AOS/);
    // It must not have shrunk (append-only growth, never a rewrite).
    assert.ok(soul2.length >= soul1.length, 'soul.md only grows');
  } finally {
    sb.cleanup();
  }
});

test('isOnboarded requires BOTH the marker and identity (half-state re-offers)', async () => {
  const sb = sandbox();
  try {
    // Only auto-provision (no marker, no identity yet) → still not onboarded.
    autoProvision({ runtime: sb.runtime, dataRoot: sb.dataRoot });
    assert.equal(isOnboarded(), false, 'provisioned-but-no-identity is not onboarded');
  } finally {
    sb.cleanup();
  }
});

// ─── chooseWorkspace: the visible, user-owned workspace dir ────────────────────────

test('fresh install: runOnboarding puts wiki + gbrain in the CHOSEN workspace, config stays put', async () => {
  const sb = installSandbox();
  try {
    const chosen = resolve(sb.home, 'agix');
    const summary = await runOnboarding({
      interactive: false,
      runtime: sb.runtime,            // non-git repoRoot → install case; no dataRoot override
      detect: stubDetect('claude-code'),
      answers: { operator_first_name: 'Sam', goals: 'build a CSA box service', data_dir: chosen },
      isTTY: false,
      log: () => {},
    });

    assert.equal(summary.workspace.dir, chosen, 'summary reports the chosen workspace');
    assert.equal(summary.workspace.source, 'chosen');

    // wiki + gbrain land in the CHOSEN dir (NOT ~/.local/state/agix).
    assert.ok(existsSync(resolve(chosen, 'wiki', 'README.md')), 'wiki scaffolded in chosen dir');
    assert.ok(existsSync(resolve(chosen, 'gbrain', 'store.json')), 'gbrain store in chosen dir');
    const hiddenState = resolve(sb.home, '.local/state/agix');
    assert.ok(!existsSync(resolve(hiddenState, 'wiki')), 'NO wiki under ~/.local/state/agix');
    assert.ok(!existsSync(resolve(hiddenState, 'gbrain')), 'NO gbrain under ~/.local/state/agix');

    // settings.json merged: data_dir AND the defaults coexist.
    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.data_dir, chosen, 'data_dir persisted');
    assert.equal(settings.tier, 'basic', 'merge preserved the tier default');
    assert.equal(settings.autonomy, 'ask', 'merge preserved the autonomy default');
    assert.equal(settings.default_provider, 'claude-code', 'provider write preserved through merge');

    // Config did NOT move into the workspace — it stays in the config dir.
    assert.ok(existsSync(resolve(sb.configDir, 'soul.md')), 'soul.md stays in config dir');
    assert.ok(existsSync(resolve(sb.configDir, 'sensei/instances/agix/persona.md')), 'sensei instance stays in config dir');

    // A second run does NOT re-prompt and does NOT clobber the chosen workspace.
    const rt2 = new LocalRuntime({ agentName: 'onboarding', repoRoot: sb.packRoot });
    const s2 = await runOnboarding({
      interactive: false, runtime: rt2, detect: stubDetect('claude-code'),
      answers: { operator_first_name: 'NotSam', data_dir: resolve(sb.home, 'OTHER') },
      isTTY: false, log: () => {},
    });
    assert.equal(s2.workspace.source, 'configured', 'second run is idempotent (no re-prompt)');
    assert.equal(s2.workspace.dir, chosen, 'second run keeps the original workspace');
    assert.ok(!existsSync(resolve(sb.home, 'OTHER')), 'second run did NOT create a new workspace');
  } finally {
    sb.cleanup();
  }
});

test('fresh install (non-interactive, no answer) defaults the workspace to ~/agix', async () => {
  const sb = installSandbox();
  try {
    const ws = await chooseWorkspace({ interactive: false, isTTY: false, runtime: sb.runtime });
    assert.equal(ws.dir, resolve(sb.home, 'agix'), 'default workspace is ~/agix');
    assert.equal(ws.source, 'chosen');
    assert.equal(ws.prompted, false, 'no prompt on non-TTY');
    // Persisted so the next outputRoot() agrees.
    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.data_dir, resolve(sb.home, 'agix'));
  } finally {
    sb.cleanup();
  }
});

test('dev checkout: chooseWorkspace returns the repo (source dev-checkout) and outputRoot stays in-tree even with a configured data_dir', async () => {
  const sb = installSandbox();
  try {
    // Make repoRoot a dev checkout.
    mkdirSync(resolve(sb.packRoot, '.git'), { recursive: true });
    // Plant a data_dir in settings.json that MUST be ignored on a dev checkout.
    mkdirSync(sb.configDir, { recursive: true });
    writeFileSync(resolve(sb.configDir, 'settings.json'), JSON.stringify({ data_dir: resolve(sb.home, 'somewhere-else') }));

    const rt = new LocalRuntime({ agentName: 'onboarding', repoRoot: sb.packRoot });
    const ws = await chooseWorkspace({ interactive: false, isTTY: false, runtime: rt });
    assert.equal(ws.source, 'dev-checkout');
    assert.equal(ws.dir, sb.packRoot, 'workspace is the repo on a dev checkout');
    assert.equal(ws.prompted, false);
    // The operator's dev workflow is untouched: outputRoot() is still the repo.
    assert.equal(rt.outputRoot(), sb.packRoot, 'outputRoot stays in-tree despite a configured data_dir');
  } finally {
    sb.cleanup();
  }
});

test('AGIX_DATA_DIR env override wins over a configured data_dir and never prompts/persists', async () => {
  const sb = installSandbox();
  try {
    const envDir = resolve(sb.home, 'env-override');
    const settingsDir = resolve(sb.home, 'settings-dir');
    mkdirSync(sb.configDir, { recursive: true });
    writeFileSync(resolve(sb.configDir, 'settings.json'), JSON.stringify({ data_dir: settingsDir }));
    process.env.AGIX_DATA_DIR = envDir;

    const rt = new LocalRuntime({ agentName: 'onboarding', repoRoot: sb.packRoot });
    assert.equal(rt.outputRoot(), envDir, 'outputRoot() honors the env override over settings');

    const ws = await chooseWorkspace({ interactive: false, isTTY: false, runtime: rt });
    assert.equal(ws.source, 'env');
    assert.equal(ws.dir, envDir);
    assert.equal(ws.prompted, false);
    // settings.json was NOT rewritten by the env path (data_dir unchanged).
    const settings = JSON.parse(readFileSync(resolve(sb.configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.data_dir, settingsDir, 'env path does not persist / clobber settings');
  } finally {
    // installSandbox.cleanup restores AGIX_DATA_DIR.
    sb.cleanup();
  }
});
