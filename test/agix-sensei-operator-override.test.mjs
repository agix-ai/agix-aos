// Sensei — local operator-allowlist override (PII-safe).
//   node --test test/agix-sensei-operator-override.test.mjs
//
// The tracked policy YAMLs ship a placeholder operator so a real
// operator's email is never committed. A real operator opts in via a
// LOCAL, UNCOMMITTED source — the file ~/.config/agix/operators_allowed
// or the env var AGIX_OPERATORS_ALLOWED — and loadRolePolicy() UNIONs
// those into operators_allowed. The override only ADDS; the tracked
// placeholder stays the floor.
//
// Covers: (1) the pure merge helper (file + env parsing, union, dedupe,
// no-op when nothing is set); (2) the real loader picks up the env-var
// override and assertOperatorAllowed then passes for the extra email;
// (3) with nothing set, behavior is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeOperatorOverrides } from '../agents/sensei/lib/policy.mjs';
import {
  loadRolePolicy,
  assertOperatorAllowed,
  RolePolicyError,
} from '../agents/sensei/lib/role.mjs';

// ─── Pure merge helper ───────────────────────────────────────────────

test('mergeOperatorOverrides — no-op when nothing is set', () => {
  const base = ['operator@example.com'];
  const out = mergeOperatorOverrides(base, {});
  assert.deepEqual(out, ['operator@example.com']);
});

test('mergeOperatorOverrides — env var adds (comma-separated)', () => {
  const out = mergeOperatorOverrides(['operator@example.com'], {
    envValue: 'real@example.com, second@example.com',
  });
  assert.deepEqual(out, ['operator@example.com', 'real@example.com', 'second@example.com']);
});

test('mergeOperatorOverrides — file adds (one per line, strips comments/blanks)', () => {
  const fileContent = '# my operators\nreal@example.com\n\n  spaced@example.com  # trailing comment\n';
  const out = mergeOperatorOverrides(['operator@example.com'], { fileContent });
  assert.deepEqual(out, ['operator@example.com', 'real@example.com', 'spaced@example.com']);
});

test('mergeOperatorOverrides — union is de-duplicated and tracked stays first', () => {
  const out = mergeOperatorOverrides(['operator@example.com'], {
    fileContent: 'real@example.com\noperator@example.com\n',
    envValue: 'real@example.com',
  });
  assert.deepEqual(out, ['operator@example.com', 'real@example.com']);
});

test('mergeOperatorOverrides — never removes the tracked operators', () => {
  const out = mergeOperatorOverrides(['ceo@example.com', 'operator@example.com'], {
    envValue: 'real@example.com',
  });
  assert.ok(out.includes('ceo@example.com'));
  assert.ok(out.includes('operator@example.com'));
  assert.ok(out.includes('real@example.com'));
});

// ─── Loader integration (env-var path — filesystem-independent) ──────

const EXTRA = 'override-test@example.com';

test('loadRolePolicy — AGIX_OPERATORS_ALLOWED extends operators_allowed and assert passes', async () => {
  const saved = process.env.AGIX_OPERATORS_ALLOWED;
  try {
    process.env.AGIX_OPERATORS_ALLOWED = EXTRA;
    // Bust the module-level policy cache: a fresh import gives a fresh
    // loader so the override is read at load time for this case.
    const { loadRolePolicy: load, assertOperatorAllowed: assertOp } =
      await import(`../agents/sensei/lib/role.mjs?override=${Date.now()}`);
    const policy = await load('cto');
    assert.ok(
      policy.operators_allowed.includes(EXTRA),
      `expected ${EXTRA} in operators_allowed, got ${policy.operators_allowed.join(', ')}`,
    );
    // The tracked placeholder is still present (override only adds).
    assert.ok(policy.operators_allowed.includes('operator@example.com'));
    // assertOperatorAllowed now passes for the extra operator.
    assert.doesNotThrow(() => assertOp(policy, EXTRA));
  } finally {
    if (saved === undefined) delete process.env.AGIX_OPERATORS_ALLOWED;
    else process.env.AGIX_OPERATORS_ALLOWED = saved;
  }
});

test('loadRolePolicy — with nothing set, behavior is unchanged (extra email denied)', async () => {
  const saved = process.env.AGIX_OPERATORS_ALLOWED;
  try {
    delete process.env.AGIX_OPERATORS_ALLOWED;
    const { loadRolePolicy: load, assertOperatorAllowed: assertOp } =
      await import(`../agents/sensei/lib/role.mjs?noenv=${Date.now()}`);
    const policy = await load('cto');
    // Tracked placeholder still allowed.
    assert.doesNotThrow(() => assertOp(policy, 'operator@example.com'));
    // The extra email is NOT in the list (assuming no local file grants
    // it on this machine — the env override is the variable under test).
    if (!policy.operators_allowed.includes(EXTRA)) {
      assert.throws(() => assertOp(policy, EXTRA), RolePolicyError);
    }
  } finally {
    if (saved === undefined) delete process.env.AGIX_OPERATORS_ALLOWED;
    else process.env.AGIX_OPERATORS_ALLOWED = saved;
  }
});
