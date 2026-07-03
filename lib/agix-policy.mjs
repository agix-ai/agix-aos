// agix-policy.mjs — load + evaluate the Policy Binding (AGENT_POLICY.yaml).
// The data layer + a minimal decision function for the Agent Coordination &
// Identity Fabric (AGENT_COORDINATION_FABRIC.md §2-4).
//
// This is the SEED of the Hanko PDP (the permission decision point). It is a
// pure, in-process function today — no separate agent, no credential broker
// (Kagi), no network. Those are later phases (Track N). What's here:
//   loadPolicy()       → the parsed binding (repo file, or a local override)
//   grantsForAgent()   → merged {allow,deny,requireApproval} for an agent
//   decide()           → allow/deny/requires-approval for (roles, agent, action)
//   checkAuthority()   → decide() for a resolved Actor (ties in agix-identity)
//
// Resolution rules: a user → their roles → the UNION of role grants for an
// agent (plus any per-user override). DENY wins over allow. Absence of any
// allow = deny (deny-by-default). `*` is a wildcard for action OR agent.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_POLICY = resolve(__dirname, '..', 'architecture/01-business/AGENT_POLICY.yaml');
const LOCAL_POLICY = resolve(homedir(), '.config/agix/AGENT_POLICY.yaml');

// Resolution order: explicit env path > per-install local override > repo file.
function policyPath() {
  const env = (process.env.AGIX_POLICY_PATH || '').trim();
  if (env) return env;
  if (existsSync(LOCAL_POLICY)) return LOCAL_POLICY;
  return REPO_POLICY;
}

const _cache = new Map();
export function loadPolicy(opts = {}) {
  const p = opts.path || policyPath();
  if (_cache.has(p)) return _cache.get(p);
  let parsed;
  try {
    parsed = yaml.load(readFileSync(p, 'utf8')) || {};
  } catch {
    parsed = { version: 1, default_decision: 'deny', enterprises: {} };
  }
  _cache.set(p, parsed);
  return parsed;
}

/** Test seam: clear the parsed-policy cache. */
export function _resetPolicyCache() {
  _cache.clear();
}

// ─── grant resolution ────────────────────────────────────────────────

const toArr = (x) => (Array.isArray(x) ? x.map(String) : x == null ? [] : [String(x)]);

// Read one grant block into the accumulator. Accepts both this repo's compact
// keys (allow/deny/require_approval) and the verbose Kagi/Hanko-doc keys
// (allowed_actions/forbidden_actions/requires_approval).
function readGrantBlock(block, acc) {
  if (!block || typeof block !== 'object') return;
  for (const a of toArr(block.allow ?? block.allowed_actions)) acc.allow.add(a);
  for (const a of toArr(block.deny ?? block.forbidden_actions)) acc.deny.add(a);
  for (const a of toArr(block.require_approval ?? block.requires_approval)) acc.requireApproval.add(a);
}

function enterpriseBlock(policy, enterpriseId) {
  return (policy && policy.enterprises && policy.enterprises[enterpriseId]) || {};
}

/** Roles a user is bound to IN THE POLICY for an enterprise (email-keyed). */
export function rolesForUserInPolicy(policy, enterpriseId, email) {
  const ent = enterpriseBlock(policy, enterpriseId);
  const key = (email || '').toString().trim().toLowerCase();
  const u = (ent.users && (ent.users[key] || ent.users[email])) || null;
  return Array.isArray(u && u.roles) ? u.roles.map(String) : [];
}

/**
 * Merge the grants that apply to `agent` for a set of `roles` (+ optional
 * per-user override), within an enterprise. Wildcards (`*` agent and `*` role
 * grants) are merged in. Returns Sets so the caller can test membership.
 * @returns {{allow:Set<string>,deny:Set<string>,requireApproval:Set<string>}}
 */
export function grantsForAgent(policy, { enterpriseId, roles = [], userEmail = null, agent }) {
  const acc = { allow: new Set(), deny: new Set(), requireApproval: new Set() };
  const ent = enterpriseBlock(policy, enterpriseId);

  for (const role of roles) {
    const agents = (ent.roles && ent.roles[role] && ent.roles[role].agents) || {};
    readGrantBlock(agents['*'], acc);
    readGrantBlock(agents[agent], acc);
  }

  // Per-user explicit agent overrides (additive — they only ever ADD grants).
  const key = (userEmail || '').toString().trim().toLowerCase();
  const uAgents =
    (ent.users && ((ent.users[key] && ent.users[key].agents) || (ent.users[userEmail] && ent.users[userEmail].agents))) ||
    {};
  readGrantBlock(uAgents['*'], acc);
  readGrantBlock(uAgents[agent], acc);

  return acc;
}

/**
 * Decide whether `roles` may have `agent` take `action`. Deny wins; no allow =
 * deny-by-default; an allowed action may still require human approval.
 * @returns {{allowed:boolean,requiresApproval:boolean,reason:string}}
 */
export function decide(policy, { enterpriseId, roles = [], userEmail = null, agent, action }) {
  const g = grantsForAgent(policy, { enterpriseId, roles, userEmail, agent });
  if (g.deny.has(action) || g.deny.has('*')) {
    return { allowed: false, requiresApproval: false, reason: `denied: ${agent}.${action} is forbidden by policy` };
  }
  if (!(g.allow.has(action) || g.allow.has('*'))) {
    return { allowed: false, requiresApproval: false, reason: `denied: no grant for ${agent}.${action} (deny-by-default)` };
  }
  const requiresApproval = g.requireApproval.has(action) || g.requireApproval.has('*');
  return {
    allowed: true,
    requiresApproval,
    reason: requiresApproval ? `allowed (requires approval): ${agent}.${action}` : `allowed: ${agent}.${action}`,
  };
}

/**
 * The Hanko PDP entry point (in-process seed): can this resolved Actor have
 * `agent` take `action`? Roles come from the policy's user binding, falling
 * back to the actor's own roles (from agix-identity).
 * @param {{enterpriseId:string,email?:string|null,roles?:string[]}} actor
 */
export function checkAuthority(actor, agent, action, opts = {}) {
  const policy = opts.policy || loadPolicy(opts);
  const enterpriseId = (actor && actor.enterpriseId) || 'agix';
  const email = (actor && actor.email) || null;
  const policyRoles = rolesForUserInPolicy(policy, enterpriseId, email);
  const roles = policyRoles.length ? policyRoles : (actor && actor.roles) || [];
  return decide(policy, { enterpriseId, roles, userEmail: email, agent, action });
}
