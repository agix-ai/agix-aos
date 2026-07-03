// agix-identity.mjs — the instance's identity: enterprise (tenant), users, and
// roles. Foundation of the Agent Coordination & Identity Fabric
// (architecture/03-ai-ml/agent-architecture/AGENT_COORDINATION_FABRIC.md §1-2).
//
// A generic AOS must never hardcode the author/operator. Identity lives in
// ~/.config/agix/identity.json (written by `agix init` / first-run onboarding)
// and is read here with GENERIC fallbacks.
//
// BACKWARD COMPATIBLE: the original single-operator surface
// (operatorFirstName/operatorFullName/operatorEmail) is preserved exactly. The
// new surface (enterpriseId/loadUsers/rolesForUser/currentActor) generalizes it
// to multi-user without breaking existing callers.
//
// identity.json shape (all fields optional):
//   {
//     "enterprise_id": "agix",            // the tenant id; default 'agix'
//     "enterprise_name": "Agix",
//     // legacy single-operator (still honored — maps to the primary owner user):
//     "operator_first_name": "Sam",
//     "operator_full_name": "Sam Rivera",
//     "operator_email": "sam@example.com",
//     "role": "founder",
//     // multi-user (the generalization):
//     "users": [
//       { "id": "sam", "email": "sam@example.com", "name": "Sam Rivera", "roles": ["owner"] },
//       { "id": "jo",  "email": "jo@example.com",  "name": "Jo Lee",     "roles": ["operator"] }
//     ],
//     "roles": ["owner", "operator", "reviewer", "viewer"]   // roles declared in this enterprise
//   }

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const IDENTITY_PATH = resolve(homedir(), '.config/agix/identity.json');

// The roles every enterprise has unless it declares its own set. `owner` has
// full authority; `viewer` is read-only. The policy binding (AGENT_POLICY.yaml)
// gives these roles their concrete agent/action grants.
export const DEFAULT_ROLES = ['owner', 'operator', 'reviewer', 'viewer'];

let _cache;
export function loadIdentity() {
  if (_cache !== undefined) return _cache;
  try {
    _cache = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8')) || {};
  } catch {
    _cache = {}; // not onboarded yet → empty; callers use generic fallbacks
  }
  return _cache;
}

/** Test seam: drop the cached identity (so a freshly-written file is re-read). */
export function _resetIdentityCache() {
  _cache = undefined;
}

/** Test seam: inject an in-memory identity object (bypasses the config file). */
export function _setIdentityForTest(obj) {
  _cache = obj || {};
}

// ─── Enterprise (tenant) ─────────────────────────────────────────────

/** The enterprise/tenant id. Env override > identity.json > fallback. */
export function enterpriseId(fallback = 'agix') {
  const e = (process.env.AGIX_ENTERPRISE_ID || '').trim() || loadIdentity().enterprise_id;
  return (typeof e === 'string' && e.trim()) ? e.trim() : fallback;
}

/** Human-readable enterprise name; falls back to the id. */
export function enterpriseName(fallback) {
  const n = loadIdentity().enterprise_name;
  return (typeof n === 'string' && n.trim()) ? n.trim() : (fallback ?? enterpriseId());
}

/** The roles declared for this enterprise (or the sensible defaults). */
export function declaredRoles() {
  const r = loadIdentity().roles;
  return Array.isArray(r) && r.length ? r.map(String) : [...DEFAULT_ROLES];
}

// ─── Users ───────────────────────────────────────────────────────────

// Raw operator email (no example fallback) — used to synthesize a primary user
// from the legacy single-operator fields.
function rawOperatorEmail() {
  const id = loadIdentity();
  const e = id.operator_email || process.env.AGIX_OPERATOR_EMAIL;
  return (typeof e === 'string' && e.trim()) ? e.trim().toLowerCase() : null;
}

function idFromEmail(email, fallback = 'operator') {
  if (!email) return fallback;
  const local = String(email).split('@')[0].replace(/[^a-z0-9._-]/gi, '');
  return local || fallback;
}

function normalizeUser(u) {
  return {
    id: String(u.id || idFromEmail(u.email)),
    email: u.email ? String(u.email).trim().toLowerCase() : null,
    name: u.name ? String(u.name) : (u.email ? String(u.email) : 'Operator'),
    roles: Array.isArray(u.roles) && u.roles.length ? u.roles.map(String) : ['owner'],
  };
}

/**
 * Every user in this enterprise. If `users` is declared, use it. Otherwise
 * synthesize a single primary user from the legacy single-operator fields (so a
 * pre-multi-user install still has exactly one owner). Empty only when truly
 * un-onboarded.
 * @returns {{id:string,email:string|null,name:string,roles:string[]}[]}
 */
export function loadUsers() {
  const id = loadIdentity();
  if (Array.isArray(id.users) && id.users.length) {
    return id.users.map(normalizeUser);
  }
  const email = rawOperatorEmail();
  const name = id.operator_full_name || id.operator_first_name || (email ? email : null);
  if (!email && !name) return [];
  return [normalizeUser({ id: idFromEmail(email), email, name, roles: ['owner'] })];
}

/** The primary user (first `owner`, else the first declared user, else null). */
export function primaryUser() {
  const users = loadUsers();
  if (!users.length) return null;
  return users.find((u) => u.roles.includes('owner')) || users[0];
}

/**
 * Resolve a user by email (case-insensitive). Defaults to the "current"
 * identity (AGIX_OPERATOR_EMAIL or the legacy operator email). Returns null when
 * no match and no current operator is known.
 */
export function resolveUser({ email } = {}) {
  const target = (email || process.env.AGIX_OPERATOR_EMAIL || rawOperatorEmail() || '')
    .toString().trim().toLowerCase();
  if (!target) return primaryUser();
  const users = loadUsers();
  const hit = users.find((u) => u.email === target);
  if (hit) return hit;
  // Known operator email but not in users[] → treat as the owner (back-compat).
  if (target === rawOperatorEmail()) return primaryUser();
  return null;
}

/** Roles for a user identified by email or id. Unknown user → [] (deny-friendly). */
export function rolesForUser(emailOrId) {
  const key = (emailOrId || '').toString().trim().toLowerCase();
  if (!key) return resolveUser()?.roles ?? [];
  const u = loadUsers().find((x) => x.email === key || x.id.toLowerCase() === key);
  return u ? u.roles : [];
}

/**
 * The current human actor — "who am I right now" — used by the authority layer.
 * Resolves the operator's identity from AGIX_OPERATOR_EMAIL / identity.json.
 * @returns {{kind:'human',enterpriseId:string,actorId:string,userId:string|null,email:string|null,name:string,roles:string[]}}
 */
export function currentActor() {
  const ent = enterpriseId();
  const user = resolveUser();
  const userId = user?.id ?? null;
  return {
    kind: 'human',
    enterpriseId: ent,
    actorId: `ent:${ent}/user:${userId ?? 'unknown'}`,
    userId,
    email: user?.email ?? rawOperatorEmail(),
    name: user?.name ?? operatorFullName(),
    roles: user?.roles ?? [],
  };
}

// ─── Legacy single-operator surface (preserved exactly) ──────────────

/** First name for greetings/prompts. Generic fallback when not onboarded. */
export function operatorFirstName(fallback = 'there') {
  const n = loadIdentity().operator_first_name;
  if (typeof n === 'string' && n.trim()) return n.trim();
  // Derive from the primary user when the legacy field is absent.
  const pu = primaryUser();
  if (pu?.name) return pu.name.trim().split(/\s+/)[0];
  return fallback;
}

/** Full name for signatures/FROM_NAME. Generic fallback when not onboarded. */
export function operatorFullName(fallback = 'Operator') {
  const id = loadIdentity();
  const n = id.operator_full_name || id.operator_first_name;
  if (typeof n === 'string' && n.trim()) return n.trim();
  const pu = primaryUser();
  if (pu?.name) return pu.name.trim();
  return fallback;
}

/** Operator email for From/co-author. From identity or AGIX_OPERATOR_EMAIL; generic fallback. */
export function operatorEmail(fallback = 'operator@example.com') {
  const n = loadIdentity().operator_email || process.env.AGIX_OPERATOR_EMAIL;
  if (typeof n === 'string' && n.trim()) return n.trim();
  const pu = primaryUser();
  if (pu?.email) return pu.email;
  return fallback;
}
