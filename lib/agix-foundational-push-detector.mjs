// agix-foundational-push-detector — auto-PR opener for the Director's
// post-run pass (Phase 4.3, with Phase 4.3.1 calibration refinements).
//
// Scans recent remote-tracking branches for "foundational" pushes —
// pushes that land canonical artifacts (architecture/, wiki/concepts/,
// docs/handoffs/, …) or carry a `sensei:` / `foundational:` commit
// prefix or a recognized agent's primary-author / Co-authored-by
// signature. For each detected push that has no existing open PR, the
// Director opens a PR against `target_branch` (default `main`).
//
// Transport (Phase 4.3.1): the canonical path is the GitHub MCP server
// via `runtime.openPR` + `runtime.listOpenPRs` + `runtime.getPullRequestState`.
// Director runs as a local launchd Node process where MCP is not always
// wired, so when `runtime.openPR` is undefined and `gh_fallback_enabled`
// is true the detector shells out to `gh pr create` / `gh pr list` /
// `gh pr view`. Each opened-PR result records which transport opened it.
//
// Hard rules (mirrored from DIRECTOR_AGENT.md §Foundational-push detector):
//   - Never auto-merges. Same ceiling as the rest of Director.
//   - Never opens duplicate PRs — asks GitHub directly before opening.
//   - Never opens against a protected branch other than `target_branch`.
//   - Branch must have unmerged commits (`merge-base --is-ancestor`).
//   - Honors `dry_run`; ships true for the calibration week.
//
// Run logs land in <cacheRoot>/foundational-push-detector.jsonl. Each
// line is either a pass entry (`kind: "pass"`) or a stale-PR reminder
// (`kind: "reminder"`). Pre-4.3.1 entries have no `kind` field; they
// are treated as pass entries when read.
//
// Verification (no MCP required, no PRs opened):
//
//   node --input-type=module -e "
//     import { scanPushes } from './lib/agix-foundational-push-detector.mjs';
//     const repoRoot = process.cwd();
//     const { candidates, triggered, skipped } = scanPushes(
//       { repoRoot, fetchAndPrune: false },
//       { scan_window_hours: 72 }
//     );
//     console.log(JSON.stringify({ candidates: candidates.length, triggered: triggered.length, skipped: skipped.length }, null, 2));
//   "

import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  listRecentPushes,
  getCommitMessage,
  getCommitAuthor,
  getChangedFiles,
  isAncestorOf,
  fetchAndPrune,
  PROTECTED,
} from './agix-git.mjs';

// Default configuration. The Director's manifest overrides any of
// these via the `foundational_push_detector` block. Per Phase 4.3.1,
// `repo_owner` and `repo_name` are no longer here — they live in the
// manifest's foundational_push_detector block so the detector ships
// without any tenant-identifying string.
export const DEFAULT_CONFIG = {
  enabled: true,
  dry_run: true,                                   // flip to false after first clean week
  commit_prefixes: ['sensei:', 'foundational:'],
  canonical_paths: [
    'architecture/',
    'wiki/concepts/',
    'wiki/entities/',
    'docs/handoffs/',
    'docs/framework/',
  ],
  recognized_agent_authors: ['Sensei', 'Curator'],
  target_branch: 'main',
  remote: 'origin',
  scan_window_hours: 24,
  auto_remind_after_hours: 48,
  max_prs_per_run: 5,
  fetch_first: true,
  gh_fallback_enabled: true,
};

// GitHub repos commonly forbid PRs against these from outside main-tracking
// integrations. The detector refuses to ever target one of these (other
// than its configured target_branch).
const PROTECTED_TARGETS = new Set([
  'main', 'master', 'develop', 'staging', 'production', 'release',
]);

function nowIso() {
  return new Date().toISOString();
}

// ── matchers ────────────────────────────────────────────────────────

function matchesCommitPrefix(message, prefixes) {
  if (!message) return false;
  const firstLine = message.split('\n', 1)[0].trim();
  return prefixes.some(p => firstLine.toLowerCase().startsWith(p.toLowerCase()));
}

function matchesCanonicalPath(changedFiles, canonicalPaths) {
  for (const f of changedFiles) {
    if (f.status !== 'A' && f.status !== 'M' && f.status !== 'R') continue;
    for (const p of canonicalPaths) {
      if (f.path.startsWith(p)) return true;
    }
  }
  return false;
}

// Returns the recognized-author names that signed this commit, by
// EITHER a `Co-authored-by:` trailer match OR a primary-author match.
// Phase 4.3.1: extended from co-author-only to also catch Sensei
// direct commits (where Sensei is the primary author and there is no
// trailer). Case-insensitive on names.
function matchesAgentAuthor(commitMessage, primaryAuthorName, recognizedAuthors) {
  if (recognizedAuthors.length === 0) return [];
  const matched = new Set();

  // Primary-author match.
  if (primaryAuthorName) {
    const primaryLc = primaryAuthorName.toLowerCase();
    for (const a of recognizedAuthors) {
      if (primaryLc === a.toLowerCase()) matched.add(a);
    }
  }

  // Co-author trailer match.
  if (commitMessage) {
    const re = /^\s*Co-authored-by:\s*([^<]+?)\s*</gim;
    let m;
    while ((m = re.exec(commitMessage)) !== null) {
      const nameLc = m[1].trim().toLowerCase();
      for (const a of recognizedAuthors) {
        if (nameLc === a.toLowerCase()) matched.add(a);
      }
    }
  }

  return [...matched];
}

// ── gh CLI fallback ─────────────────────────────────────────────────
//
// Director's local launchd runtime typically has no MCP wired but does
// have gh authenticated. These helpers are the fallback path; the audit
// jsonl records which transport opened each PR.

function ghRun(repoRoot, args) {
  return spawnSync('gh', args, { cwd: repoRoot, encoding: 'utf8' });
}

function ghAvailable(repoRoot) {
  const r = ghRun(repoRoot, ['auth', 'status']);
  // gh auth status exits 0 when at least one authenticated host exists.
  return r.status === 0;
}

// Returns { number, url } if an open PR exists for `head → base`,
// null otherwise. Returns the sentinel `{ inconclusive: true, error }`
// when gh errored — callers treat that as "do not open, but do not
// skip the candidate either" since opening blind could create a dup.
function ghFindOpenPR(repoRoot, head, base) {
  const r = ghRun(repoRoot, [
    'pr', 'list',
    '--head', head,
    '--base', base,
    '--state', 'open',
    '--json', 'number,url',
    '--limit', '1',
  ]);
  if (r.status !== 0) {
    return { inconclusive: true, error: (r.stderr || '').trim() || 'gh pr list failed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || '[]');
  } catch (err) {
    return { inconclusive: true, error: `gh pr list returned malformed JSON: ${err.message}` };
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    return { number: parsed[0].number, url: parsed[0].url };
  }
  return null;
}

function ghCreatePR(repoRoot, { title, body, head, base }) {
  const r = ghRun(repoRoot, [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--head', head,
    '--base', base,
  ]);
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || 'gh pr create failed');
  }
  // gh prints the PR URL on the last non-empty stdout line.
  const url = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!url) throw new Error('gh pr create succeeded but printed no URL');
  // Extract the PR number from the URL's trailing path segment.
  const m = url.match(/\/pull\/(\d+)/);
  const number = m ? Number(m[1]) : null;
  return { number, url };
}

// Returns 'open' | 'closed' | 'merged' | null on lookup failure.
function ghPullRequestState(repoRoot, prNumber) {
  const r = ghRun(repoRoot, [
    'pr', 'view', String(prNumber),
    '--json', 'state',
  ]);
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || '{}');
    if (!parsed.state) return null;
    return String(parsed.state).toLowerCase();
  } catch {
    return null;
  }
}

// ── transport resolution ────────────────────────────────────────────
//
// Returns a transport object exposing { name, openFn, listFn, stateFn }.
// Each fn is async. `name` is 'mcp' | 'gh' | 'none' and is written into
// every audit jsonl result so the operator can audit which path opened
// each PR.

function resolveTransport(runtime, cfg, repoRoot) {
  if (typeof runtime?.openPR === 'function') {
    return {
      name: 'mcp',
      openFn: (payload) => runtime.openPR(payload),
      listFn: typeof runtime.listOpenPRs === 'function'
        ? (args) => runtime.listOpenPRs(args)
        : null,
      stateFn: typeof runtime.getPullRequestState === 'function'
        ? (args) => runtime.getPullRequestState(args)
        : null,
    };
  }
  if (cfg.gh_fallback_enabled && ghAvailable(repoRoot)) {
    return {
      name: 'gh',
      openFn: async (payload) => ghCreatePR(repoRoot, payload),
      listFn: async ({ head, base }) => ghFindOpenPR(repoRoot, head, base),
      stateFn: async ({ pr_number }) => ghPullRequestState(repoRoot, pr_number),
    };
  }
  return { name: 'none', openFn: null, listFn: null, stateFn: null };
}

// ── push record + scan ──────────────────────────────────────────────

function pushRecord({
  branch, tipSha, tipUnix, commitSubject = '', reasons = [], matchedFiles = [],
  matchedAuthors = [], skipReason = null,
}) {
  return {
    branch,
    tip_sha: tipSha,
    tip_unix: tipUnix,
    commit_subject: commitSubject,
    triggered: reasons.length > 0 && !skipReason,
    reasons,
    matched_files: matchedFiles,
    matched_authors: matchedAuthors,
    skip_reason: skipReason,
  };
}

// Pure scan. Returns { candidates, triggered, skipped, errors, config }.
// Triggered list is sorted oldest-first (by tip committer date) before
// the per-run cap is applied, so a foundational push that has been
// sitting for two days wins the cap slot over one that landed an hour
// ago. The existing-PR check happens in openPRs against GitHub directly,
// not here — local refspec heuristics were removed in 4.3.1.
export function scanPushes(runtime, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const repoRoot = runtime?.repoRoot;
  if (!repoRoot) {
    throw new Error('scanPushes: runtime.repoRoot is required');
  }

  const errors = [];

  if (cfg.target_branch !== 'main' && PROTECTED_TARGETS.has(cfg.target_branch.toLowerCase())) {
    throw new Error(
      `foundational-push-detector: target_branch "${cfg.target_branch}" is protected and not allowed. ` +
      `Set target_branch to "main".`
    );
  }

  if (cfg.fetch_first && runtime?.fetchAndPrune !== false) {
    try {
      fetchAndPrune(repoRoot, cfg.remote);
    } catch (err) {
      errors.push({ stage: 'fetch', error: err.message });
    }
  }

  let recent = [];
  try {
    recent = listRecentPushes(repoRoot, {
      remote: cfg.remote,
      windowHours: cfg.scan_window_hours,
      targetBranch: cfg.target_branch,
    });
  } catch (err) {
    errors.push({ stage: 'list_recent_pushes', error: err.message });
    return { candidates: [], triggered: [], skipped: [], errors, config: cfg };
  }

  const targetRef = `${cfg.remote}/${cfg.target_branch}`;
  const candidates = [];
  const skipped = [];

  for (const push of recent) {
    const branchRef = `${cfg.remote}/${push.branch}`;

    if (PROTECTED.has(push.branch.toLowerCase())) {
      candidates.push(pushRecord({
        branch: push.branch, tipSha: push.tipSha, tipUnix: push.tipUnix,
        skipReason: 'head_is_protected_branch',
      }));
      continue;
    }

    let commitMessage = '';
    try {
      commitMessage = getCommitMessage(repoRoot, push.tipSha);
    } catch (err) {
      errors.push({ stage: 'commit_message', branch: push.branch, error: err.message });
      continue;
    }
    const commitSubject = commitMessage.split('\n', 1)[0].trim();

    let primaryAuthor = '';
    try {
      primaryAuthor = getCommitAuthor(repoRoot, push.tipSha);
    } catch (err) {
      errors.push({ stage: 'commit_author', branch: push.branch, error: err.message });
      // Non-fatal: rule 3 can still match on Co-authored-by trailers alone.
    }

    let changed = [];
    try {
      changed = getChangedFiles(repoRoot, branchRef, targetRef);
    } catch (err) {
      errors.push({ stage: 'changed_files', branch: push.branch, error: err.message });
    }

    const reasons = [];
    const matchedFiles = [];
    const matchedAuthors = [];

    if (matchesCommitPrefix(commitMessage, cfg.commit_prefixes)) {
      reasons.push('commit_prefix');
    }
    if (matchesCanonicalPath(changed, cfg.canonical_paths)) {
      reasons.push('canonical_path');
      for (const f of changed) {
        if ((f.status === 'A' || f.status === 'M' || f.status === 'R')
            && cfg.canonical_paths.some(p => f.path.startsWith(p))) {
          matchedFiles.push(f.path);
        }
      }
    }
    const authors = matchesAgentAuthor(commitMessage, primaryAuthor, cfg.recognized_agent_authors);
    if (authors.length > 0) {
      reasons.push('agent_author');
      matchedAuthors.push(...authors);
    }

    if (reasons.length === 0) {
      candidates.push(pushRecord({
        branch: push.branch, tipSha: push.tipSha, tipUnix: push.tipUnix,
        commitSubject,
      }));
      continue;
    }

    // Hard rule 4: branch must have unmerged commits.
    let merged = false;
    try {
      merged = isAncestorOf(repoRoot, branchRef, targetRef);
    } catch (err) {
      candidates.push(pushRecord({
        branch: push.branch, tipSha: push.tipSha, tipUnix: push.tipUnix,
        commitSubject, reasons, matchedFiles, matchedAuthors,
        skipReason: `ancestor_check_failed: ${err.message}`,
      }));
      continue;
    }
    if (merged) {
      const rec = pushRecord({
        branch: push.branch, tipSha: push.tipSha, tipUnix: push.tipUnix,
        commitSubject, reasons, matchedFiles, matchedAuthors,
        skipReason: 'already_merged_into_target',
      });
      candidates.push(rec);
      skipped.push(rec);
      continue;
    }

    candidates.push(pushRecord({
      branch: push.branch, tipSha: push.tipSha, tipUnix: push.tipUnix,
      commitSubject, reasons, matchedFiles, matchedAuthors,
    }));
  }

  // Cap ordering: oldest first by branch-tip committer date, then apply
  // the per-run sanity cap. A push that has been sitting for two days is
  // more likely to be blocking parallel agents than one from an hour ago.
  const triggered = candidates
    .filter(c => c.triggered)
    .sort((a, b) => a.tip_unix - b.tip_unix)
    .slice(0, cfg.max_prs_per_run);

  return { candidates, triggered, skipped, errors, config: cfg };
}

// ── PR payload rendering ───────────────────────────────────────────

function autoOpenedFooter() {
  return [
    '',
    '---',
    '',
    'Foundational push auto-detected by Director (see DIRECTOR_AGENT.md §Foundational-push detector). Merging stays human-only.',
  ].join('\n');
}

function renderPRPayload(candidate, commitMessage, cfg) {
  const lines = commitMessage.split('\n');
  const title = lines[0].trim();
  const bodyLines = lines.slice(1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
  const reasonLine = `Detection: ${candidate.reasons.join(', ')}`
    + (candidate.matched_authors.length ? ` · agent author(s): ${candidate.matched_authors.join(', ')}` : '')
    + (candidate.matched_files.length ? ` · ${candidate.matched_files.length} canonical-path file(s)` : '');
  const body = [
    bodyLines.join('\n').trim(),
    '',
    reasonLine,
    autoOpenedFooter(),
  ].filter(Boolean).join('\n');
  return { title, body, head: candidate.branch, base: cfg.target_branch };
}

// ── audit log reader (for stale-PR collection) ──────────────────────

async function readAuditEntries(cacheRoot) {
  if (!cacheRoot) return [];
  const logPath = resolve(cacheRoot, 'foundational-push-detector.jsonl');
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines silently — the log is append-only and a
      // partial write should never break a subsequent pass.
    }
  }
  return entries;
}

// ── stale-PR nudge collection ───────────────────────────────────────
//
// Walks the audit jsonl for every PR ever opened by the detector,
// looks up its current state via the transport, and returns the ones
// that are still open AND have not been reminded within
// `auto_remind_after_hours`. The caller writes one reminder entry per
// returned record so the next pass knows when the most recent reminder
// fired.

export async function collectStaleNudges(transport, cfg, { cacheRoot } = {}) {
  if (!cacheRoot) return [];
  if (!transport || !transport.stateFn) return [];

  const entries = await readAuditEntries(cacheRoot);

  // Build the per-PR open record from pass entries (where opened: true).
  // Multiple opens of the same PR can't happen (dedup forbids it), so
  // the first open we see is the authoritative open record.
  const openedPRs = new Map(); // pr_number → { branch, opened_at, pr_url, pr_number }
  const reminderHistory = new Map(); // pr_number → [reminder_at iso, …]

  for (const e of entries) {
    if (e?.kind === 'reminder' && e.pr_number != null) {
      if (!reminderHistory.has(e.pr_number)) reminderHistory.set(e.pr_number, []);
      reminderHistory.get(e.pr_number).push(e.reminder_at || e.ts);
      continue;
    }
    // Pass entry (explicit kind: 'pass' or pre-4.3.1 entries with no kind).
    const passTs = e?.ts;
    const results = Array.isArray(e?.results) ? e.results : [];
    for (const r of results) {
      if (!r.opened) continue;
      if (r.pr_number == null) continue;
      if (openedPRs.has(r.pr_number)) continue;
      openedPRs.set(r.pr_number, {
        pr_number: r.pr_number,
        pr_url: r.pr_url || null,
        branch: r.branch || null,
        opened_at: passTs || null,
      });
    }
  }

  if (openedPRs.size === 0) return [];

  const nowMs = Date.now();
  const remindAfterMs = (cfg.auto_remind_after_hours ?? 48) * 3600 * 1000;
  const nudges = [];

  for (const [, rec] of openedPRs) {
    // Look up current state. If we can't tell, leave it alone — the
    // worst case is we nudge after the PR is already closed, which is
    // a low-grade noise problem, not a correctness one.
    let state = null;
    try {
      state = await transport.stateFn({ pr_number: rec.pr_number });
    } catch {
      continue;
    }
    if (!state || state === 'closed' || state === 'merged') continue;

    const reminders = reminderHistory.get(rec.pr_number) || [];
    const lastReminderIso = reminders.length > 0 ? reminders[reminders.length - 1] : null;
    const referenceIso = lastReminderIso || rec.opened_at;
    if (!referenceIso) continue;
    const referenceMs = Date.parse(referenceIso);
    if (!Number.isFinite(referenceMs)) continue;
    if (nowMs - referenceMs < remindAfterMs) continue;

    const openedMs = Date.parse(rec.opened_at || '') || nowMs;
    nudges.push({
      pr_number: rec.pr_number,
      pr_url: rec.pr_url,
      branch: rec.branch,
      opened_at: rec.opened_at,
      hours_open: Math.round((nowMs - openedMs) / 3600 / 1000),
      reminder_count: reminders.length + 1,
    });
  }

  return nudges;
}

// ── openPRs ─────────────────────────────────────────────────────────

export async function openPRs(runtime, scanResult, { cacheRoot = null, transport = null, staleNudges = [] } = {}) {
  const cfg = scanResult.config;
  const repoRoot = runtime?.repoRoot;
  const t = transport || resolveTransport(runtime, cfg, repoRoot);

  const results = [];

  for (const c of scanResult.triggered) {
    const result = {
      branch: c.branch,
      tip_sha: c.tip_sha,
      commit_subject: c.commit_subject,
      reasons: c.reasons,
      dry_run: cfg.dry_run,
      transport: t.name,
      opened: false,
      pr_url: null,
      pr_number: null,
      error: null,
    };

    let commitMessage = '';
    try {
      commitMessage = getCommitMessage(repoRoot, c.tip_sha);
    } catch (err) {
      result.error = `commit_message_failed: ${err.message}`;
      results.push(result);
      continue;
    }
    const payload = renderPRPayload(c, commitMessage, cfg);
    result.payload = payload;

    // Real duplicate-PR detection (Phase 4.3.1 hard rule 2). Ask the
    // chosen transport directly. If the transport has no listFn (older
    // MCP runtime), skip the check and rely on the open call to error
    // on a duplicate — better than blocking a real open.
    if (t.listFn) {
      let existing = null;
      try {
        existing = await t.listFn({
          owner: cfg.repo_owner,
          repo: cfg.repo_name,
          head: payload.head,
          base: payload.base,
        });
      } catch (err) {
        // Treat lookup errors as inconclusive; do not open, do not retry.
        result.error = `existing_pr_check_failed: ${err.message}`;
        results.push(result);
        continue;
      }
      if (existing && existing.inconclusive) {
        result.error = `existing_pr_check_inconclusive: ${existing.error}`;
        results.push(result);
        continue;
      }
      if (existing && (existing.number || existing.pr_number || existing.url)) {
        result.pr_url = existing.url || existing.html_url || null;
        result.pr_number = existing.number ?? existing.pr_number ?? null;
        result.error = 'existing_pr';
        results.push(result);
        continue;
      }
    }

    if (cfg.dry_run) {
      results.push(result);
      continue;
    }

    if (t.name === 'none' || !t.openFn) {
      result.error = 'no_transport: runtime.openPR not provided and gh fallback unavailable or disabled';
      results.push(result);
      continue;
    }

    if (t.name === 'mcp' && (!cfg.repo_owner || !cfg.repo_name)) {
      result.error = 'mcp_transport_requires_repo_owner_and_repo_name_in_manifest';
      results.push(result);
      continue;
    }

    try {
      const opened = await t.openFn({
        owner: cfg.repo_owner,
        repo: cfg.repo_name,
        title: payload.title,
        body: payload.body,
        head: payload.head,
        base: payload.base,
      });
      result.opened = true;
      result.pr_url = opened?.html_url || opened?.url || null;
      result.pr_number = opened?.number ?? null;
    } catch (err) {
      result.error = `open_pr_failed: ${err.message}`;
    }
    results.push(result);
  }

  const summary = {
    scanned: scanResult.candidates.length,
    triggered: scanResult.triggered.length,
    opened: results.filter(r => r.opened).length,
    skipped: scanResult.skipped.length,
    failed: results.filter(r => r.error && r.error !== 'existing_pr').length,
    existing: results.filter(r => r.error === 'existing_pr').length,
    stale_nudges: staleNudges.length,
    dry_run: cfg.dry_run,
    transport: t.name,
  };

  if (cacheRoot) {
    const logPath = resolve(cacheRoot, 'foundational-push-detector.jsonl');
    try {
      await mkdir(dirname(logPath), { recursive: true });

      // Pass entry (always).
      const passEntry = {
        ts: nowIso(),
        kind: 'pass',
        cfg: {
          dry_run: cfg.dry_run,
          commit_prefixes: cfg.commit_prefixes,
          canonical_paths: cfg.canonical_paths,
          recognized_agent_authors: cfg.recognized_agent_authors,
          target_branch: cfg.target_branch,
          scan_window_hours: cfg.scan_window_hours,
          gh_fallback_enabled: cfg.gh_fallback_enabled,
        },
        transport: t.name,
        summary,
        results,
        skipped: scanResult.skipped,
        errors: scanResult.errors,
      };
      await appendFile(logPath, JSON.stringify(passEntry) + '\n');

      // Reminder entries (one per stale PR that this pass nudged).
      for (const n of staleNudges) {
        const reminderEntry = {
          ts: nowIso(),
          kind: 'reminder',
          pr_number: n.pr_number,
          pr_url: n.pr_url,
          branch: n.branch,
          opened_at: n.opened_at,
          hours_open: n.hours_open,
          reminder_count: n.reminder_count,
          reminder_at: nowIso(),
        };
        await appendFile(logPath, JSON.stringify(reminderEntry) + '\n');
      }
    } catch {
      // Logging failures must never break the run.
    }
  }

  return { results, summary, transport: t.name, stale_nudges: staleNudges };
}

// Convenience: resolve transport, scan, collect stale nudges, open.
// The Director's run loop calls this once per cycle, after the executor
// pass and alongside the git custodian.
export async function runDetectorPass(runtime, config = {}, { cacheRoot = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const transport = resolveTransport(runtime, cfg, runtime?.repoRoot);
  const scan = scanPushes(runtime, config);
  const staleNudges = await collectStaleNudges(transport, scan.config, { cacheRoot });
  const open = await openPRs(runtime, scan, { cacheRoot, transport, staleNudges });
  return { ...open, scan };
}
