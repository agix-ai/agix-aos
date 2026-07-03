// Sensei role policy — PURE enforcement logic, dependency-free.
//
// Extracted from role.mjs so the enforcement checkpoints can be imported
// without pulling js-yaml (the YAML loaders stay in role.mjs). This is
// the Sensei orchestrator's coordination + safe-action governance layer;
// the eval harness (agents/sensei/eval/) exercises every function here.
//
// Each assert* throws RolePolicyError on DENY and returns undefined on
// ALLOW. The four checkpoints map to MAST orchestrator failure
// categories (wiki/research/2026-06-05-agent-evaluation-methodology.md §5):
//   assertOperatorAllowed   — authz/identity        → Specification
//   assertEditPathAllowed   — role write-scope       → Specification
//   assertFireAllowed       — sub-agent routing      → Coordination
//   assertGitOperationAllowed — autonomy ceiling      → Verification
//
// Spec: wiki/concepts/sensei-role-tracks.md § Permission policy schema

export const VALID_ROLES = ['cto', 'cpo', 'ceo'];

export class RolePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RolePolicyError';
  }
}

// ─── Checkpoints ─────────────────────────────────────────────────────

export function assertOperatorAllowed(policy, email, { smoke = false } = {}) {
  // Smoke mode bypasses operator checks so doctor / smoke runs don't need
  // a real operator identity. All other enforcement still applies.
  if (smoke) return;
  // Basic/solo tier: a '*' in operators_allowed allows any operator identity
  // (including none) so a solo user with no git config isn't rejected. Must
  // return BEFORE the null-email check. Enterprise deployments pin emails.
  const allowedList = Array.isArray(policy.operators_allowed) ? policy.operators_allowed : [];
  if (allowedList.includes('*')) return;
  if (!email) {
    throw new RolePolicyError(
      `Cannot identify operator email. Set AGIX_OPERATOR_EMAIL or run ` +
      `\`git config --global user.email <email>\` in the repo first.`,
    );
  }
  if (!allowedList.includes(email)) {
    throw new RolePolicyError(
      `Operator <${email}> is not in ${policy.role}.yaml operators_allowed list ` +
      `(${allowedList.join(', ') || 'empty'}). Update the policy or switch --role.`,
    );
  }
}

export function assertEditPathAllowed(policy, repoRelPath) {
  const patterns = Array.isArray(policy.edit_paths) ? policy.edit_paths : [];
  if (patterns.length === 0) {
    throw new RolePolicyError(
      `Role "${policy.role}" is read-only (edit_paths: []). ` +
      `Attempted edit on "${repoRelPath}".`,
    );
  }
  const normalized = repoRelPath.replace(/^\.\//, '').replace(/^\/+/, '');
  for (const pat of patterns) {
    if (matchesGlob(pat, normalized)) return;
  }
  throw new RolePolicyError(
    `Role "${policy.role}" cannot edit "${repoRelPath}". ` +
    `Allowed paths: ${patterns.join(', ')}.`,
  );
}

export function assertFireAllowed(policy, manifestAllowlist, agentName) {
  const policyList = Array.isArray(policy.fire_allowlist) ? policy.fire_allowlist : [];
  const manifestList = Array.isArray(manifestAllowlist) ? manifestAllowlist : [];
  const intersection = policyList.filter((a) => manifestList.includes(a));
  if (!intersection.includes(agentName)) {
    throw new RolePolicyError(
      `Role "${policy.role}" cannot /fire "${agentName}". ` +
      `Allowed in this role: ${intersection.join(', ') || '(empty intersection)'}.`,
    );
  }
}

export function assertGitOperationAllowed(policy, operation) {
  const valid = ['commit', 'push', 'branch_create'];
  if (!valid.includes(operation)) {
    throw new RolePolicyError(`Unknown git operation "${operation}". Valid: ${valid.join(', ')}.`);
  }
  const block = policy.git?.[operation];
  if (!block || block.allowed !== true) {
    throw new RolePolicyError(
      `Role "${policy.role}" cannot perform git ${operation}. ` +
      `Policy: ${JSON.stringify(block || { allowed: false })}.`,
    );
  }
}

export function gitRequiresConfirm(policy, operation) {
  return Boolean(policy.git?.[operation]?.require_confirm);
}

// ─── Local operator-allowlist override (PII-safe) ────────────────────
//
// The tracked policy YAMLs ship a placeholder operator (operator@example.com)
// so a real operator's email never has to be committed into the repo —
// exactly the PII the AOS's own `sentinel` agent guards against. To let a
// real operator pass assertOperatorAllowed WITHOUT editing tracked YAML,
// loadRolePolicy() (in role.mjs) UNIONs the policy's operators_allowed with
// emails from two LOCAL, UNCOMMITTED sources, both living OUTSIDE the repo:
//
//   1. file  ~/.config/agix/operators_allowed   (one email per line; `#`
//             comments and blank lines ignored)
//   2. env   AGIX_OPERATORS_ALLOWED              (comma-separated)
//
// The override only ADDS operators — it never removes the tracked ones, so
// the shipped policy is a floor, not a ceiling. This pure helper does the
// parse+union so it can be unit-tested without touching the filesystem.
export function mergeOperatorOverrides(operatorsAllowed, { fileContent = '', envValue = '' } = {}) {
  const base = Array.isArray(operatorsAllowed) ? operatorsAllowed : [];

  const fromFile = String(fileContent || '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim()) // strip `#` comments
    .filter(Boolean);

  const fromEnv = String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Union, preserving order (tracked first), de-duplicated.
  const merged = [...base];
  for (const email of [...fromFile, ...fromEnv]) {
    if (!merged.includes(email)) merged.push(email);
  }
  return merged;
}

// ─── Glob matcher (tiny — only patterns we actually use) ─────────────
//
// Supports:
//   - Trailing slash         "wiki/"                    → directory prefix
//   - Single-segment `*`     "a/*/c.md"                 → matches a/b/c.md
//   - Multi-segment `**`     "a/**/c.md"                → matches a/b/c.md, a/b/c/d/c.md
//   - Filename `?`           "PRODUCT_?.md"             → matches PRODUCT_A.md
//
// No brace expansion, no character classes — keep it tight to what the
// shipped policy YAMLs need. Add features when a real policy needs them.
export function matchesGlob(pattern, candidate) {
  if (pattern.endsWith('/')) {
    // Directory prefix.
    return candidate === pattern.slice(0, -1) || candidate.startsWith(pattern);
  }
  // Build a regex from the pattern.
  const re = globToRegex(pattern);
  return re.test(candidate);
}

function globToRegex(pattern) {
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 2;
      // Skip the slash after `**/` for cleaner matching of `**/foo`.
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}
