// Sensei role-channeling — Phase 1 enforcement.
//
// Spec: wiki/concepts/sensei-role-tracks.md
// Policy YAMLs: agents/sensei/policies/{cto,cpo,ceo}.yaml
// Persona MDs: agents/sensei/persona/{cto,cpo,ceo}.md
//
// Loaded by agents/sensei/agent.mjs at the start of run() and consumed
// at three checkpoints:
//   1. session start          → assertOperatorAllowed
//   2. plan-mode edit proposal → assertEditPathAllowed
//   3. pre-/fire               → assertFireAllowed
// Plus a fourth, structural check before any git spawnSync:
//                                assertGitOperationAllowed
//
// Phase 2 (BUILD_FRAMEWORK Track N3 — Hanko) will take this over as the
// authoritative gate; in-process enforcement here is the bridge.

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

// Pure enforcement logic lives in policy.mjs (dependency-free, so the
// eval harness + tests can import the checkpoints without js-yaml). The
// loaders below stay here because they parse YAML / shell git.
import {
  VALID_ROLES,
  RolePolicyError,
  assertOperatorAllowed,
  assertEditPathAllowed,
  assertFireAllowed,
  assertGitOperationAllowed,
  gitRequiresConfirm,
  matchesGlob,
  mergeOperatorOverrides,
} from './policy.mjs';

// Re-export the pure surface so existing importers (agent.mjs) are
// unchanged.
export {
  VALID_ROLES,
  RolePolicyError,
  assertOperatorAllowed,
  assertEditPathAllowed,
  assertFireAllowed,
  assertGitOperationAllowed,
  gitRequiresConfirm,
  matchesGlob,
  mergeOperatorOverrides,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SENSEI_DIR = resolve(__dirname, '..');

// ─── Loaders ─────────────────────────────────────────────────────────

let _policyCache = null;
let _personaCache = null;

export function getActiveRole(opts = {}) {
  const raw = (opts.role || '').toString().toLowerCase();
  if (!raw) return 'cto';                   // Default preserves the operator's solo-operator flow.
  if (!VALID_ROLES.includes(raw)) {
    throw new RolePolicyError(`Unknown --role "${opts.role}". Valid roles: ${VALID_ROLES.join(', ')}.`);
  }
  return raw;
}

export async function loadRolePolicy(role) {
  _policyCache ??= {};
  if (_policyCache[role]) return _policyCache[role];
  const path = resolve(SENSEI_DIR, 'policies', `${role}.yaml`);
  if (!existsSync(path)) {
    throw new RolePolicyError(`Missing policy file: ${path}. See wiki/concepts/sensei-role-tracks.md.`);
  }
  const parsed = yaml.load(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new RolePolicyError(`Policy file ${path} parsed empty or non-object.`);
  }
  // Merge LOCAL, UNCOMMITTED operator override (see mergeOperatorOverrides
  // in policy.mjs). A real operator opts themselves in WITHOUT committing
  // their email into the tracked YAML, via either:
  //   - the file  ~/.config/agix/operators_allowed  (one email per line), or
  //   - the env   AGIX_OPERATORS_ALLOWED             (comma-separated).
  // The override only ADDS — the tracked placeholder stays the floor.
  parsed.operators_allowed = mergeOperatorOverrides(parsed.operators_allowed, {
    fileContent: readLocalOperatorsFile(),
    envValue: process.env.AGIX_OPERATORS_ALLOWED,
  });
  _policyCache[role] = parsed;
  return parsed;
}

// Read the local override file if present. Lives outside the repo at
// ~/.config/agix/operators_allowed so a real operator email is never
// committed. Absent file → empty string (no override). Errors are
// swallowed: a malformed/unreadable override must never harden the gate
// against the tracked operators.
function readLocalOperatorsFile() {
  const path = resolve(homedir(), '.config/agix/operators_allowed');
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export async function loadRolePersona(role) {
  _personaCache ??= {};
  if (_personaCache[role]) return _personaCache[role];
  const path = resolve(SENSEI_DIR, 'persona', `${role}.md`);
  if (!existsSync(path)) {
    // Persona is non-fatal — return an empty overlay so existing prompts work.
    _personaCache[role] = '';
    return '';
  }
  _personaCache[role] = await readFile(path, 'utf8');
  return _personaCache[role];
}

// ─── Operator identity ───────────────────────────────────────────────

// Resolution order:
//   1. env var AGIX_OPERATOR_EMAIL  (explicit override, e.g. tenant runtime)
//   2. `git config user.email`       (the implicit signature on any commit)
//   3. null                          (caller decides whether to fail open or closed)
export function getOperatorEmail() {
  if (process.env.AGIX_OPERATOR_EMAIL) return process.env.AGIX_OPERATOR_EMAIL.trim();
  try {
    const r = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim() || null;
  } catch { /* ignore */ }
  return null;
}

// Enforcement checkpoints + the glob matcher + RolePolicyError now live
// in ./policy.mjs (dependency-free) and are re-exported at the top of
// this file. Loaders above are the only YAML/git-touching surface.
