// agix-git — git operations for the Director's code-implementable
// APPROVE executor (Phase 4).
//
// The Director never auto-merges to main. Ever. This module enforces
// that at the function level: every operation here either refuses
// outright when targeting main/master/develop, or only operates on
// branches whose name starts with the configured prefix (default:
// `director/`). Force-push is also blocked.
//
// All operations run via spawnSync against the repo root supplied by
// the runtime. No git library dependency — we stay on the system git
// binary so the operator's existing SSH/credential setup just works.

import { spawnSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Branches that can NEVER be the target of a push, branch creation,
// commit, or checkout — short of an explicit operator override that
// this module does not provide.
const PROTECTED_BRANCHES = new Set([
  'main', 'master', 'develop', 'staging', 'production', 'release',
]);

// Branch prefix the Director is allowed to create/push. Phase 4
// hard-coded; manifest override comes in Phase 5 if multi-tenant needs
// different prefixes per tenant.
const DEFAULT_DIRECTOR_BRANCH_PREFIX = 'director/';

export class GitError extends Error {
  constructor(message, { code = 'git_error', stderr = '' } = {}) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

function git(repoRoot, args, { input = null } = {}) {
  const opts = { cwd: repoRoot, encoding: 'utf8' };
  if (input !== null) opts.input = input;
  const result = spawnSync('git', args, opts);
  if (result.error) {
    throw new GitError(`git ${args[0]} failed to spawn: ${result.error.message}`, { code: 'spawn_error' });
  }
  return result;
}

// Hard-rule check before any branch-mutating operation. Throws if the
// requested branch name is on the protected list or doesn't start with
// the Director's allowed prefix.
function assertSafeBranchName(branchName, { prefix = DEFAULT_DIRECTOR_BRANCH_PREFIX } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    throw new GitError('branch name is required', { code: 'invalid_branch' });
  }
  if (PROTECTED_BRANCHES.has(branchName.toLowerCase())) {
    throw new GitError(`refusing to operate on protected branch: ${branchName}`, { code: 'protected_branch' });
  }
  if (!branchName.startsWith(prefix)) {
    throw new GitError(
      `branch name "${branchName}" does not start with required prefix "${prefix}". ` +
      `The Director can only operate on its own branches.`,
      { code: 'wrong_prefix' }
    );
  }
}

// Returns the current branch name. Used to verify we're NOT on a
// protected branch before committing.
export function currentBranch(repoRoot) {
  const r = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) {
    throw new GitError(`failed to read current branch: ${r.stderr}`, { code: 'read_branch_failed', stderr: r.stderr });
  }
  return r.stdout.trim();
}

// True if the working tree is clean (no unstaged changes, no untracked
// files). The Director should refuse to start a new code-implementable
// APPROVE run if the working tree is dirty — its commits would mix
// operator work with drafted work.
export function isWorkingTreeClean(repoRoot) {
  const r = git(repoRoot, ['status', '--porcelain']);
  if (r.status !== 0) return false;
  return r.stdout.trim() === '';
}

// Create a new branch from the latest origin/<base>. Fetches first so
// we branch off the actual remote tip, not whatever the local main is.
// Throws if branchName is protected or doesn't match the prefix.
export function createBranchFromOrigin(repoRoot, branchName, { base = 'main', prefix } = {}) {
  assertSafeBranchName(branchName, { prefix });
  if (PROTECTED_BRANCHES.has(base) === false && !['main', 'master'].includes(base)) {
    // Defensive: callers should pass main/master. Other bases are unsupported.
    throw new GitError(`unsupported base ref: ${base}. Use main or master.`, { code: 'invalid_base' });
  }

  // Fetch the latest base ref so we branch off the actual remote tip.
  const fetch = git(repoRoot, ['fetch', 'origin', base]);
  if (fetch.status !== 0) {
    throw new GitError(`git fetch origin ${base} failed: ${fetch.stderr}`, { code: 'fetch_failed', stderr: fetch.stderr });
  }

  // Create + checkout. If the branch already exists locally, fail — we
  // never overwrite an existing branch (could lose operator work).
  const checkout = git(repoRoot, ['checkout', '-b', branchName, `origin/${base}`]);
  if (checkout.status !== 0) {
    throw new GitError(
      `failed to create branch ${branchName} from origin/${base}: ${checkout.stderr}`,
      { code: 'checkout_failed', stderr: checkout.stderr }
    );
  }
  return { branchName, base };
}

// Apply a set of file edits to the working tree. Each edit is either:
//   { path: 'wiki/foo.md', action: 'create', content: '...' }
//   { path: 'lib/bar.mjs', action: 'modify', content: '<full new content>' }
// We use full-content replacement rather than diff hunks — simpler,
// more robust, and Opus emits cleaner full-file output than diff hunks.
export async function applyEdits(repoRoot, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new GitError('applyEdits: edits array required', { code: 'no_edits' });
  }
  const applied = [];
  for (const e of edits) {
    if (!e || typeof e.path !== 'string' || typeof e.content !== 'string') {
      throw new GitError('applyEdits: each edit needs path + content (string)', { code: 'invalid_edit' });
    }
    if (!['create', 'modify'].includes(e.action)) {
      throw new GitError(`applyEdits: action must be create|modify, got ${e.action}`, { code: 'invalid_action' });
    }
    const abs = resolve(repoRoot, e.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, e.content);
    applied.push(e.path);
  }
  return applied;
}

// Stage + commit. Refuses to commit on a protected branch — final
// safety net. Author is whatever git config has locally (so on the
// operator's Mac, commits are authored by the operator). A
// Co-Authored-By footer attributes the Director.
export function commitEdits(repoRoot, message, paths, { coAuthor = 'Director <noreply@example.com>' } = {}) {
  const branch = currentBranch(repoRoot);
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    throw new GitError(
      `refusing to commit on protected branch ${branch}. Create a director/<...> branch first.`,
      { code: 'commit_on_protected' }
    );
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitError('commitEdits: paths array required', { code: 'no_paths' });
  }

  const add = git(repoRoot, ['add', '--', ...paths]);
  if (add.status !== 0) {
    throw new GitError(`git add failed: ${add.stderr}`, { code: 'add_failed', stderr: add.stderr });
  }

  const fullMessage = coAuthor
    ? `${message}\n\nCo-Authored-By: ${coAuthor}`
    : message;

  // Pass message via stdin (-F -) to avoid shell quoting issues.
  const commit = git(repoRoot, ['commit', '-F', '-'], { input: fullMessage });
  if (commit.status !== 0) {
    throw new GitError(`git commit failed: ${commit.stderr}`, { code: 'commit_failed', stderr: commit.stderr });
  }

  // Return the new commit's short SHA for the ack email.
  const sha = git(repoRoot, ['rev-parse', '--short', 'HEAD']);
  return {
    branch,
    sha: sha.stdout.trim(),
    paths,
  };
}

// Push the named branch to origin. Refuses to push protected branches
// or force-push. Returns { remoteRef, pushed: true } on success.
export function pushBranch(repoRoot, branchName, { prefix } = {}) {
  assertSafeBranchName(branchName, { prefix });
  const push = git(repoRoot, ['push', '-u', 'origin', branchName]);
  if (push.status !== 0) {
    throw new GitError(
      `git push origin ${branchName} failed: ${push.stderr}`,
      { code: 'push_failed', stderr: push.stderr }
    );
  }
  return {
    branch: branchName,
    remoteRef: `origin/${branchName}`,
    pushed: true,
  };
}

// Best-effort rollback: hard-reset the working tree to HEAD and delete
// the local branch if it was created during this operation. Used when
// any step between createBranch and pushBranch fails so we don't leave
// a half-applied state on the operator's machine.
export function rollbackBranch(repoRoot, branchName, { previousBranch = 'main' } = {}) {
  try {
    // Discard any uncommitted changes
    git(repoRoot, ['reset', '--hard', 'HEAD']);
    git(repoRoot, ['clean', '-fd']);
    // Switch back to the previous branch
    git(repoRoot, ['checkout', previousBranch]);
    // Delete the half-created director branch (only if name is safe)
    if (branchName && branchName.startsWith(DEFAULT_DIRECTOR_BRANCH_PREFIX)) {
      git(repoRoot, ['branch', '-D', branchName]);
    }
  } catch {
    // Rollback is best-effort. If it fails, the operator can clean up manually.
  }
}

// Switch back to the operator's previous branch (typically main).
// Used after a successful push so the working tree isn't left on the
// Director's branch.
export function switchBack(repoRoot, branchName = 'main') {
  const r = git(repoRoot, ['checkout', branchName]);
  if (r.status !== 0) {
    throw new GitError(`failed to switch back to ${branchName}: ${r.stderr}`, { code: 'checkout_back_failed', stderr: r.stderr });
  }
  return { branch: branchName };
}

// Look up the remote URL so we can render a GitHub link in the ack email.
// Returns null if origin isn't configured or isn't a GitHub URL we can
// rewrite.
export function getRemoteWebUrl(repoRoot, branchName = null) {
  const r = git(repoRoot, ['remote', 'get-url', 'origin']);
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  // Convert SSH (git@github.com:owner/repo.git) → HTTPS web URL
  let webBase;
  if (url.startsWith('git@github.com:')) {
    webBase = 'https://github.com/' + url.slice('git@github.com:'.length).replace(/\.git$/, '');
  } else if (url.startsWith('https://github.com/')) {
    webBase = url.replace(/\.git$/, '');
  } else {
    return null;
  }
  return branchName ? `${webBase}/tree/${encodeURIComponent(branchName)}` : webBase;
}

export const PROTECTED = PROTECTED_BRANCHES;
export const DIRECTOR_PREFIX = DEFAULT_DIRECTOR_BRANCH_PREFIX;

// ─── Git custodian helpers (Phase 4 add-on) ─────────────────────────
//
// These functions exist for the Director's branch-reaping pass after
// each run. They operate on branches matching configured prefixes
// (claude/, cursor/, director/, ...) — not the hard-coded `director/`
// prefix the executor helpers above enforce. Each delete refuses
// protected branches and only force-deletes when the caller has
// independently verified that every commit is reachable from main.

// Returns a list of local branch names. Excludes HEAD.
export function listLocalBranches(repoRoot) {
  const r = git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (r.status !== 0) {
    throw new GitError(`failed to list local branches: ${r.stderr}`, { code: 'list_local_failed', stderr: r.stderr });
  }
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

// Returns remote branch names without the `origin/` prefix. Skips
// the `HEAD` symbolic ref.
export function listRemoteBranches(repoRoot, remote = 'origin') {
  const r = git(repoRoot, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}/`]);
  if (r.status !== 0) {
    throw new GitError(`failed to list remote branches: ${r.stderr}`, { code: 'list_remote_failed', stderr: r.stderr });
  }
  const prefix = `${remote}/`;
  return r.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s.startsWith(prefix))
    .map(s => s.slice(prefix.length))
    .filter(s => s !== 'HEAD');
}

// True iff every commit reachable from `branch` is also reachable from
// `target` — i.e., `branch` has been merged or its commits cherry-picked
// into `target`. Uses `merge-base --is-ancestor` which exits 0 for true
// and 1 for false; any other status is an error.
export function isAncestorOf(repoRoot, branch, target) {
  const r = git(repoRoot, ['merge-base', '--is-ancestor', branch, target]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new GitError(
    `merge-base --is-ancestor ${branch} ${target} failed: ${r.stderr}`,
    { code: 'is_ancestor_failed', stderr: r.stderr }
  );
}

// Milliseconds since the most recent commit on `branch`. The Director's
// age floor uses this to avoid racing with a still-active session that
// pushed minutes ago.
export function branchAgeMs(repoRoot, branch) {
  const r = git(repoRoot, ['log', '-1', '--format=%ct', branch]);
  if (r.status !== 0) {
    throw new GitError(`failed to read tip commit time for ${branch}: ${r.stderr}`, { code: 'tip_time_failed', stderr: r.stderr });
  }
  const unixSec = Number(r.stdout.trim());
  if (!Number.isFinite(unixSec)) {
    throw new GitError(`unexpected tip commit time output for ${branch}: ${r.stdout}`, { code: 'tip_time_parse' });
  }
  return Date.now() - unixSec * 1000;
}

// Fetch + prune remote tracking refs. Run before any reap pass so the
// ancestor checks compare against the actual remote tip, and so we
// don't try to delete a remote branch that's already gone.
export function fetchAndPrune(repoRoot, remote = 'origin') {
  const r = git(repoRoot, ['fetch', '--prune', remote]);
  if (r.status !== 0) {
    throw new GitError(`git fetch --prune ${remote} failed: ${r.stderr}`, { code: 'fetch_prune_failed', stderr: r.stderr });
  }
  return true;
}

// Safe local branch delete. Refuses protected branches. Uses `-d` (not
// `-D`) — git itself refuses to delete a branch with unmerged commits,
// which is exactly the safety we want even if the caller miscomputed
// ancestry.
export function deleteLocalBranch(repoRoot, branchName, { extraProtected = [] } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    throw new GitError('branch name is required', { code: 'invalid_branch' });
  }
  const protectedSet = new Set([...PROTECTED_BRANCHES, ...extraProtected.map(s => s.toLowerCase())]);
  if (protectedSet.has(branchName.toLowerCase())) {
    throw new GitError(`refusing to delete protected branch: ${branchName}`, { code: 'protected_branch' });
  }
  if (currentBranch(repoRoot) === branchName) {
    throw new GitError(`refusing to delete the currently checked-out branch: ${branchName}`, { code: 'current_branch' });
  }
  const r = git(repoRoot, ['branch', '-d', branchName]);
  if (r.status !== 0) {
    throw new GitError(
      `git branch -d ${branchName} failed: ${r.stderr.trim()}`,
      { code: 'local_delete_failed', stderr: r.stderr }
    );
  }
  return true;
}

// Safe remote branch delete. Refuses protected branches. Uses
// `git push origin --delete <name>` which is the standard, atomic way
// to remove a branch from the remote without force-pushing anything.
export function deleteRemoteBranch(repoRoot, branchName, { remote = 'origin', extraProtected = [] } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    throw new GitError('branch name is required', { code: 'invalid_branch' });
  }
  const protectedSet = new Set([...PROTECTED_BRANCHES, ...extraProtected.map(s => s.toLowerCase())]);
  if (protectedSet.has(branchName.toLowerCase())) {
    throw new GitError(`refusing to delete protected remote branch: ${branchName}`, { code: 'protected_branch' });
  }
  const r = git(repoRoot, ['push', remote, '--delete', branchName]);
  if (r.status !== 0) {
    // Treat "remote ref does not exist" as a soft success — the caller
    // wanted the branch gone and it already is.
    if (/remote ref does not exist/i.test(r.stderr) || /not found/i.test(r.stderr)) {
      return false;
    }
    throw new GitError(
      `git push ${remote} --delete ${branchName} failed: ${r.stderr.trim()}`,
      { code: 'remote_delete_failed', stderr: r.stderr }
    );
  }
  return true;
}

// ─── Foundational-push detector helpers (Phase 4.3 add-on) ──────────
//
// Read-only helpers that feed lib/agix-foundational-push-detector.mjs.
// They walk recent remote-tracking branches to find ones that look
// like a foundational push (sensei: prefix, canonical-doc edits, or
// recognized-agent co-author signature). None mutate the working tree.

// List remote-tracking branches whose tip commit was made within
// `windowHours`. Returns `[{ branch, tipSha, tipUnix }]`. Skips HEAD
// and skips `<remote>/<targetBranch>` itself (no point scanning the
// target ref for pushes against itself).
export function listRecentPushes(repoRoot, { remote = 'origin', windowHours = 24, targetBranch = 'main' } = {}) {
  const sinceUnix = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const r = git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)\t%(objectname)\t%(committerdate:unix)',
    `refs/remotes/${remote}/`,
  ]);
  if (r.status !== 0) {
    throw new GitError(`failed to list remote branches: ${r.stderr}`, { code: 'list_remote_failed', stderr: r.stderr });
  }
  const prefix = `${remote}/`;
  const targetRef = `${remote}/${targetBranch}`;
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [refShort, sha, tipUnixStr] = line.split('\t');
    if (!refShort || refShort === `${prefix}HEAD` || refShort === targetRef) continue;
    if (!refShort.startsWith(prefix)) continue;
    const tipUnix = Number(tipUnixStr);
    if (!Number.isFinite(tipUnix)) continue;
    if (tipUnix < sinceUnix) continue;
    out.push({
      branch: refShort.slice(prefix.length),
      tipSha: sha,
      tipUnix,
    });
  }
  return out;
}

// Read the full commit message (subject + body + trailers) for a SHA.
// Used by the detector for commit-prefix matches and Co-authored-by
// trailer parsing.
export function getCommitMessage(repoRoot, sha) {
  const r = git(repoRoot, ['log', '-1', '--format=%B', sha]);
  if (r.status !== 0) {
    throw new GitError(`failed to read commit message for ${sha}: ${r.stderr}`, { code: 'commit_message_failed', stderr: r.stderr });
  }
  // git log emits a trailing newline; preserve internal whitespace but
  // trim the single trailing newline.
  return r.stdout.replace(/\n$/, '');
}

// Primary author name for a commit (%an). The detector's rule 3 matches
// when the primary author is a recognized agent name even if there is
// no Co-authored-by trailer (e.g., a Sensei direct commit).
export function getCommitAuthor(repoRoot, sha) {
  const r = git(repoRoot, ['log', '-1', '--format=%an', sha]);
  if (r.status !== 0) {
    throw new GitError(`failed to read commit author for ${sha}: ${r.stderr}`, { code: 'commit_author_failed', stderr: r.stderr });
  }
  return r.stdout.trim();
}

// Files added or modified between `base` and `branch` tip. Returns
// `[{ path, status }]` where status is the git letter (A/M/D/R/T).
// The detector cares about A and M (and the new path on R). `base`
// may be a local or remote ref; the function resolves the merge-base
// internally so the diff is scoped to the branch's own commits, not
// to unrelated history on `base`.
export function getChangedFiles(repoRoot, branch, base = 'origin/main') {
  // Find merge-base; if there isn't one, fall back to base itself so
  // we still get a usable diff. Worst case: more files than the push
  // actually added, which fails toward over-detection — acceptable
  // for a Phase 4.3 detector running in dry-run.
  let diffBase = base;
  const mb = git(repoRoot, ['merge-base', branch, base]);
  if (mb.status === 0 && mb.stdout.trim()) {
    diffBase = mb.stdout.trim();
  }
  const r = git(repoRoot, ['diff', '--name-status', `${diffBase}..${branch}`]);
  if (r.status !== 0) {
    throw new GitError(
      `git diff ${diffBase}..${branch} failed: ${r.stderr}`,
      { code: 'diff_failed', stderr: r.stderr }
    );
  }
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Status is one letter (A, M, D, T) or letter+digits (R100, C75).
    // Rename/copy lines have two paths; we take the new path.
    const parts = trimmed.split(/\t/);
    if (parts.length < 2) continue;
    const status = parts[0][0];
    const path = parts[parts.length - 1];
    out.push({ path, status });
  }
  return out;
}

