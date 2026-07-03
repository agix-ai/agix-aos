// agix-fleet — Linux/non-macOS platform guard tests.
//   node --test test/agix-fleet-platform-guard.test.mjs
//
// The fleet lifecycle (install / uninstall / doctor) is built on launchd
// (`launchctl` + ~/Library/LaunchAgents/*.plist), which is macOS-only. On any
// other platform the launchctl helpers used to crash with an opaque
// `TypeError: Cannot read properties of undefined (reading 'split')` (spawnSync
// returns `{ status: null, stdout: undefined }` for a missing binary). These
// tests pin the guard: every launchd entry point must return a CLEAN, flagged
// result on a non-darwin platform — never throw.
//
// We force `process.platform = 'linux'` BEFORE importing the module, because the
// `LAUNCHD_SUPPORTED` constant is evaluated at module-load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Force non-macOS for the whole module under test.
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

const {
  LAUNCHD_SUPPORTED,
  unsupportedPlatformMessage,
  installAgent,
  installAll,
  uninstallAgent,
  uninstallAll,
  doctor,
} = await import('../lib/agix-fleet.mjs');

test('LAUNCHD_SUPPORTED is false on a non-darwin platform', () => {
  assert.equal(LAUNCHD_SUPPORTED, false);
});

test('unsupportedPlatformMessage is clear + actionable (no opaque ENOENT)', () => {
  const msg = unsupportedPlatformMessage('Installing agent "sensei"');
  assert.match(msg, /macOS-only/);
  assert.match(msg, /agix agent run/);          // points at the cross-platform path
  assert.match(msg, /cron|systemd/);            // names the roadmap alternative
  assert.match(msg, /nothing was changed/);     // reassures the user
  assert.doesNotMatch(msg, /ENOENT|undefined/); // not a raw crash string
});

test('installAgent returns a flagged failure (does NOT throw) on Linux', async () => {
  const r = await installAgent({ name: 'sensei', log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.unsupportedPlatform, true);
  assert.match(r.error, /macOS-only/);
});

test('installAll returns a flagged failure summary (does NOT throw) on Linux', async () => {
  const r = await installAll({ log: () => {} });
  assert.equal(r.allOk, false);
  assert.equal(r.unsupportedPlatform, true);
  assert.deepEqual(r.results, []);
  assert.equal(r.summary.ok, 0);
});

test('uninstallAgent is a graceful no-op (ok=true) on Linux', async () => {
  const r = await uninstallAgent({ name: 'sensei', log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.unsupportedPlatform, true);
  assert.equal(r.alreadyAbsent, true);
});

test('uninstallAll is a graceful no-op (allOk=true) on Linux', async () => {
  const r = await uninstallAll({ log: () => {} });
  assert.equal(r.allOk, true);
  assert.equal(r.unsupportedPlatform, true);
  assert.deepEqual(r.results, []);
});

test('doctor returns a clean unsupported report (does NOT throw) on Linux', async () => {
  const r = await doctor({});
  assert.equal(r.unsupportedPlatform, true);
  assert.match(r.message, /macOS-only/);
  assert.deepEqual(r.agents, []);
  assert.equal(r.summary.total, 0);
  assert.equal(r.doctor_schema_version, '0.1');
});
