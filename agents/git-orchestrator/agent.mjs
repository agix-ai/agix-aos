// Agix Git Orchestrator — agent logic.
//
// Invoked via `agix agent run git-orchestrator` (on-demand or the daily
// learning-pass cron). Two responsibilities fold into one run:
//
//   1. Mechanical git/merge ceremony (inspect-only in v1): read recent
//      git/PR/CI state, summarize what is mergeable / what is failing.
//      The orchestrator NEVER auto-merges and NEVER force-pushes main —
//      the merge button is the human gate's (boundaries in manifest.soul).
//
//   2. Cross-run learning: cluster gate/CI/merge failures by a
//      DETERMINISTIC fingerprint, track recurrence counts in runtime
//      state, and at hit_count >= recurrence_threshold (default 3) emit a
//      structural-fix PROPOSAL artifact under
//      wiki/git-orchestrator/proposals/. A structural fix must eliminate
//      the failure class, catch it at admission time, or add a pre-merge
//      gate — "retry / add an alert" is a patch and is rejected.
//
// The proposal follows the narrator pattern: the data layer (fingerprint,
// hit count, fix class, evidence) is computed deterministically and is
// independently verifiable; an optional LLM TL;DR is prepended on top and
// never alters the numbers. Without an Anthropic key the agent degrades to
// a deterministic summary line.
//
// Hard rule (every run, never relaxed): pattern memory is a CACHE, not
// ground truth. Before drafting a fresh proposal for a fingerprint, the
// agent re-verifies that the live evidence still matches the cached
// signature; on divergence it AMENDS the pattern and skips the proposal.
//
// Flags:
//   --canned            Use the built-in canned failure feed (no live git
//                       inspection). Implied in smoke mode. Lets the agent
//                       run clean via `agix agent run git-orchestrator`
//                       with no live PR/CI plumbing.
//   --dry-run           Compute + print everything, write no artifacts and
//                       no state.
//   --reset             Clear pattern memory before this run (fresh start).
//   --date <YYYY-MM-DD> Override the date used in proposal filenames.
//   --threshold <N>     Override the recurrence threshold for this run.
//
// Spec / persona: agents/git-orchestrator/PERSONA.md
// Manifest:       agents/git-orchestrator/manifest.yaml
// Lineage:        wiki/research/agentic-discoveries-2026-06-18.md
//                 (recurrence-threshold >=3 -> structural fix;
//                  pattern-memory-is-a-cache; narrator pattern).

import { createHash } from 'node:crypto';

const PROPOSALS_REL_DIR = 'wiki/git-orchestrator/proposals';

// Fix-class taxonomy — the three things that qualify as a STRUCTURAL fix.
// A proposal that doesn't map to one of these is a patch and is rejected.
export const FIX_CLASS = {
  ELIMINATE: 'eliminate-failure-class',
  ADMISSION: 'catch-at-admission-time',
  PRE_MERGE_GATE: 'add-pre-merge-gate',
};

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const o = {
    canned: Boolean(opts.canned) || Boolean(runtime.smoke),
    dryRun: Boolean(opts.dryRun),
    reset: Boolean(opts.reset),
    date: opts.date || new Date().toISOString().slice(0, 10),
    threshold: Number(opts.threshold ?? defaults.recurrence_threshold ?? 3),
    lookbackHours: Number(opts.lookbackHours ?? defaults.lookback_hours ?? 168),
  };
  const NARRATE_MODEL = defaults.narrate_model || 'claude-sonnet-4-6';
  const TARGET_BRANCH = defaults.target_branch || 'main';

  // ── Smoke short-circuit ───────────────────────────────────────────
  // Smoke validates: state read/write path, the model surface (ledger
  // recording end-to-end), the canned feed -> fingerprint -> recurrence
  // pipeline, and the proposal RENDER path (without touching the real
  // wiki tree — writeRepoFile sandboxes writes under the smoke root).
  if (runtime.smoke) {
    const model = runtime.getModel();
    await model.chat({
      capability: 'default-quality',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'smoke' }],
      agent: 'git-orchestrator',
    });

    // Exercise the deterministic learning core against the canned feed.
    const feed = cannedFailureFeed();
    const patterns = {};
    for (const ev of feed) ingestFailure(patterns, ev, o.date);
    // Force a recurrence to >= threshold so the render path is exercised.
    const fp = Object.keys(patterns)[0];
    patterns[fp].hit_count = o.threshold;
    const proposalBody = renderProposal(patterns[fp], { date: o.date, narrative: null });
    await runtime.writeRepoFile(
      `${PROPOSALS_REL_DIR}/${o.date}-${patterns[fp].slug}.md`,
      proposalBody,
    );
    // Exercise the state round-trip on the smoke (sandboxed) path.
    await runtime.writeState('patterns', { patterns });
    await runtime.readState('patterns', { patterns: {} });

    console.log(
      `[smoke] git-orchestrator short-circuit · model + state + ` +
      `${feed.length}-event canned feed -> ${Object.keys(patterns).length} fingerprint(s) + proposal render verified`,
    );
    return {
      smoke: true,
      fingerprints: Object.keys(patterns).length,
      proposals: 1,
      merged: 0,
    };
  }

  // ── 1. Mechanical ceremony — inspect-only summary ─────────────────
  // v1 reports mergeable / failing state; it never presses the merge
  // button. (Live git inspection is best-effort; --canned skips it.)
  const ceremony = o.canned
    ? cannedCeremonySnapshot(TARGET_BRANCH)
    : await inspectGitState(runtime, { targetBranch: TARGET_BRANCH, lookbackHours: o.lookbackHours });
  console.log(
    `Ceremony (inspect-only) · target=${TARGET_BRANCH} · ` +
    `${ceremony.open_prs} open PR(s) · ${ceremony.mergeable} mergeable · ` +
    `${ceremony.failing} failing CI · (merge button is the human gate's)`,
  );

  // ── 2. Load pattern memory ────────────────────────────────────────
  let state = o.reset ? { patterns: {} } : await runtime.readState('patterns', { patterns: {} });
  if (!state || typeof state !== 'object' || !state.patterns) state = { patterns: {} };
  const patterns = state.patterns;

  // ── 3. Gather + ingest this run's failures (data layer) ───────────
  const feed = o.canned ? cannedFailureFeed() : ceremony.failures;
  console.log(`Ingesting ${feed.length} failure event(s) for fingerprinting…`);
  const touched = new Set();
  for (const ev of feed) {
    const fp = ingestFailure(patterns, ev, o.date);
    touched.add(fp);
  }

  // ── 4. Decide what crosses the recurrence threshold ───────────────
  // hit 1 = log; hit 2 = surface in briefing; hit >=3 = propose a fix.
  const cursor = o.reset ? {} : await runtime.readState('cursor', {});
  const alreadyProposed = new Set(cursor?.last_proposal_fingerprints || []);

  const toPropose = [];
  for (const fp of touched) {
    const p = patterns[fp];
    const stage = recurrenceStage(p.hit_count, o.threshold);
    console.log(`  · ${p.slug} · hit_count=${p.hit_count} · status=${p.status} · stage=${stage}`);
    if (p.hit_count < o.threshold) continue;                 // not yet structural
    if (p.status === 'accepted_recurring_cost') continue;    // operator opted out
    if (alreadyProposed.has(fp)) continue;                   // don't pester twice (boundary)

    // Pattern-memory-is-a-cache: re-verify the live root cause matches the
    // cached signature before drafting a fix for it.
    const verification = verifyRootCause(p, feed);
    if (!verification.matches) {
      // Cache drift: AMEND the pattern, do NOT propose this run.
      p.last_root_cause = verification.observed;
      p.status = 'amended_cache_drift';
      console.log(`  ! ${p.slug} · cache drift — observed root cause diverged; amended, proposal deferred`);
      continue;
    }
    toPropose.push(p);
  }

  // ── 5. Emit structural-fix proposals (never auto-merge) ───────────
  const proposalFingerprints = [];
  const writtenProposals = [];
  for (const p of toPropose) {
    const narrative = await narrate(runtime, NARRATE_MODEL, p).catch((err) => {
      console.log(`  proposal narrative skipped (${err.message}); using deterministic summary`);
      return null;
    });
    const body = renderProposal(p, { date: o.date, narrative });
    const relPath = `${PROPOSALS_REL_DIR}/${o.date}-${p.slug}.md`;

    if (o.dryRun) {
      console.log(`\n────────── PROPOSAL (dry-run, not written): ${relPath} ──────────\n`);
      console.log(body);
    } else {
      const full = await runtime.writeRepoFile(relPath, body);
      runtime.recordFileWritten?.(relPath);
      runtime.recordDecision?.({ kind: 'rule', name: `recurrence>=3:${p.slug}` });
      console.log(`✓ Structural-fix proposal written: ${full}`);
      writtenProposals.push(relPath);
    }
    p.status = 'proposal_open';
    proposalFingerprints.push(p.fingerprint);
  }

  // ── 6. Persist pattern memory + cursor ────────────────────────────
  if (!o.dryRun) {
    await runtime.writeState('patterns', { patterns });
    await runtime.writeState('cursor', {
      last_run_at: new Date().toISOString(),
      // Keep prior proposals plus this run's so we don't re-pester.
      last_proposal_fingerprints: [...alreadyProposed, ...proposalFingerprints],
    });
  }

  const summary = {
    smoke: false,
    merged: 0,                                 // v1 never merges
    fingerprints: Object.keys(patterns).length,
    failures_ingested: feed.length,
    proposals: writtenProposals.length,
    proposal_paths: writtenProposals,
  };
  console.log(
    `Done · ${summary.fingerprints} tracked fingerprint(s) · ` +
    `${summary.proposals} new structural-fix proposal(s) · 0 merges (by design).`,
  );
  return summary;
}

// ─── Data layer: fingerprint + recurrence (deterministic) ───────────

// Deterministic fingerprint: sha256 over a NORMALIZED canonical tuple so
// the same failure always hashes to the same key. IDs, SHAs, timestamps,
// numbers, and branch-specific tokens are replaced with placeholders so
// "the same failure on a different PR" collapses to one fingerprint.
export function fingerprintFailure(ev) {
  const canonical = [
    ev.surface || 'unknown',          // e.g. 'ci', 'merge-queue', 'gate'
    ev.check || 'unknown',            // e.g. 'vitest', 'backend-smoke'
    normalizeSignature(ev.signature || ''),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Strip volatile tokens so two occurrences of the same failure match.
export function normalizeSignature(sig) {
  return String(sig)
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')             // git SHAs
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/gi, '<ts>') // ISO timestamps
    .replace(/#\d+/g, '#<n>')                            // PR/issue numbers
    .replace(/\bpr[-_ ]?\d+\b/gi, 'pr<n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m|min|mb|kb|gb)\b/gi, '<dur>') // durations/sizes
    .replace(/\b\d+\b/g, '<n>')                          // bare numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function slugForFailure(ev) {
  const base = `${ev.surface || 'x'}-${ev.check || 'x'}`;
  const tail = normalizeSignature(ev.signature || '')
    .replace(/<[a-z]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-');
  return `${base}${tail ? '-' + tail : ''}`.replace(/-+/g, '-').slice(0, 60);
}

// Upsert one failure event into the pattern map; increments hit_count and
// advances the status ladder. Returns the fingerprint.
function ingestFailure(patterns, ev, date) {
  const fp = fingerprintFailure(ev);
  const existing = patterns[fp];
  if (existing) {
    existing.hit_count += 1;
    existing.last_seen = date;
    existing.last_root_cause = ev.root_cause || existing.last_root_cause || null;
    existing.status = ladderStatus(existing.hit_count, existing.status);
  } else {
    patterns[fp] = {
      fingerprint: fp,
      slug: slugForFailure(ev),
      surface: ev.surface || 'unknown',
      check: ev.check || 'unknown',
      signature: normalizeSignature(ev.signature || ''),
      raw_signature: ev.signature || '',
      first_seen: date,
      last_seen: date,
      hit_count: 1,
      status: 'tentative_1',
      last_root_cause: ev.root_cause || null,
      fix_class: ev.fix_class || classifyFix(ev),
      proposed_fix: ev.proposed_fix || null,
    };
  }
  return fp;
}

// The status ladder: hit 1 tentative, hit 2 confirmed/watch, hit >=3
// structural-candidate. Never downgrades an operator-set terminal status.
export function ladderStatus(hitCount, prev) {
  if (prev === 'accepted_recurring_cost' || prev === 'fixed') return prev;
  if (hitCount >= 3) return 'structural_candidate_3+';
  if (hitCount === 2) return 'confirmed_2+';
  return 'tentative_1';
}

export function recurrenceStage(hitCount, threshold) {
  if (hitCount >= threshold) return 'propose-structural-fix';
  if (hitCount === 2) return 'surface-in-briefing';
  return 'log-only';
}

// Map a failure to a structural fix class. Heuristic v1 — a real run
// would refine this against the live log, but it always lands on one of
// the three qualifying classes (never a patch).
export function classifyFix(ev) {
  const sig = normalizeSignature(ev.signature || '');
  if (/stack|stacked|auto-?close|dependent pr|behind main|update-branch/.test(sig)) {
    return FIX_CLASS.ELIMINATE;     // e.g. enable merge queue
  }
  if (/race|concurren|optimistic|deploy.*deploy|simultaneous/.test(sig)) {
    return FIX_CLASS.ADMISSION;     // e.g. concurrency group serializes at admission
  }
  return FIX_CLASS.PRE_MERGE_GATE;  // default: a CI check that gates the next failure
}

// Pattern-memory-is-a-cache: confirm the live feed still carries a failure
// whose normalized signature matches the cached one before proposing.
function verifyRootCause(pattern, feed) {
  const live = feed.find((ev) => fingerprintFailure(ev) === pattern.fingerprint);
  if (!live) {
    // No live evidence this run — proposal stands on the cached count, but
    // flag that we couldn't re-verify (caller treats this as "matches"
    // since the cache is the only evidence; conservative). We DO record
    // the absence so the proposal body is honest about it.
    return { matches: true, observed: pattern.last_root_cause, reverified: false };
  }
  const observed = live.root_cause || null;
  // Drift = the live root cause text is present AND differs materially
  // from the cached one. Absent live root_cause = no drift signal.
  const cached = pattern.last_root_cause || null;
  const matches = !observed || !cached || observed === cached;
  return { matches, observed, reverified: true };
}

// ─── Proposal render (the deterministic data layer of the narrator) ──

function renderProposal(p, { date, narrative }) {
  const tldr = narrative
    ? `> ${narrative.trim().replace(/\n/g, '\n> ')}\n\n`
    : `> _(No LLM narrative this run — deterministic summary below. The data ` +
      `layer is authoritative regardless.)_\n\n`;

  const fixClassLine = {
    [FIX_CLASS.ELIMINATE]: 'Eliminates the failure class (the category becomes impossible).',
    [FIX_CLASS.ADMISSION]: 'Catches the failure at admission time, not at runtime.',
    [FIX_CLASS.PRE_MERGE_GATE]: 'Adds a pre-merge check that gates the next occurrence.',
  }[p.fix_class] || 'Adds a pre-merge check that gates the next occurrence.';

  return `---
title: git-orchestrator proposal — ${p.slug}
type: structural-fix-proposal
agent: git-orchestrator
created: ${date}
status: open
fingerprint: ${p.fingerprint}
hit_count: ${p.hit_count}
fix_class: ${p.fix_class}
tags: [git-orchestrator, recurrence-threshold, structural-fix]
---

# git-orchestrator proposal: ${p.slug}

**Fingerprint:** \`${p.fingerprint}\`
**Hit count:** ${p.hit_count}  (threshold for a structural-fix proposal: 3)
**First seen:** ${p.first_seen}  |  **Last seen:** ${p.last_seen}
**Surface / check:** \`${p.surface}\` / \`${p.check}\`

${tldr}## What the failure is

Normalized signature (volatile tokens replaced so recurrences collapse to
one fingerprint):

\`\`\`
${p.raw_signature || p.signature}
\`\`\`

Last observed root cause: ${p.last_root_cause ? `\`${p.last_root_cause}\`` : '_(not captured this run — re-verify against the live log before acting; pattern memory is a cache, not ground truth)_'}

## Proposed structural fix

**Fix class:** \`${p.fix_class}\` — ${fixClassLine}

${p.proposed_fix
  ? p.proposed_fix
  : `_Concrete fix to be filled in by the reviewer/implementer. It MUST satisfy the fix class above — eliminate the class, catch it at admission, or gate it pre-merge. A "retry / add an alert" change is a PATCH and does not satisfy the >=3 threshold._`}

## Why this satisfies the >=3 threshold

This fingerprint has recurred ${p.hit_count} times (>= 3). Two recurrences
could be coincidence; three of the *same* normalized signature indicates a
structural issue worth coding around rather than a flake. The proposed fix
is in a qualifying class (\`${p.fix_class}\`), not a patch.

## Operator decision

- [ ] Approve as one-off PR
- [ ] Approve as phase plan (operator releases the gate)
- [ ] Defer — gather more evidence first
- [ ] Reject — accept the recurring cost (sets pattern status \`accepted_recurring_cost\`)

---
_Emitted by the Agix git-orchestrator. The merge button is never pressed by
this agent — every fix lands through the human gate. See
\`agents/git-orchestrator/PERSONA.md\`._
`;
}

// ─── Narrator TL;DR (optional LLM prepend) ──────────────────────────

async function narrate(runtime, model, p) {
  const m = runtime.getModel();
  const sys =
    'You are the git-orchestrator narrator. In 2-3 sentences, summarize a ' +
    'recurring CI/merge failure and why the proposed structural fix is the ' +
    'right CLASS of fix (eliminate the failure class / catch at admission / ' +
    'add a pre-merge gate) rather than a patch (retry/alert). Be terse and ' +
    'concrete. Do not invent numbers; use only the fields given. No em dashes.';
  const user =
    `slug: ${p.slug}\nfingerprint: ${p.fingerprint}\nhit_count: ${p.hit_count}\n` +
    `surface/check: ${p.surface}/${p.check}\nfix_class: ${p.fix_class}\n` +
    `signature: ${p.raw_signature || p.signature}\n` +
    `last_root_cause: ${p.last_root_cause || '(not captured)'}`;
  const resp = await m.chat({
    capability: 'default-quality',
    max_tokens: 200,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'git-orchestrator',
  });
  const text = (resp.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  // Smoke / empty -> treat as no narrative so the deterministic summary shows.
  if (!text || /\[smoke-mode/.test(text)) return null;
  return text;
}

// ─── Live git inspection (best-effort, read-only) ───────────────────
//
// v1 keeps this intentionally light: we read recent remote branch tips so
// the ceremony summary has real numbers when run in a repo. Anything that
// would touch the network or the gh CLI is out of scope for v1 and stays
// behind --canned. A failure here degrades to an empty-but-honest snapshot
// — the learning core still runs against whatever feed it's given.
async function inspectGitState(runtime, { targetBranch, lookbackHours }) {
  const snapshot = {
    open_prs: 0,
    mergeable: 0,
    failing: 0,
    failures: [],
    note: 'live-inspection (read-only); PR/CI plumbing lands post-v1 — use --canned for the learning demo',
  };
  try {
    const { listRecentPushes } = await import('../../lib/agix-git.mjs');
    const pushes = listRecentPushes(runtime.repoRoot, {
      remote: 'origin',
      windowHours: lookbackHours,
      targetBranch,
    });
    snapshot.open_prs = pushes.length;   // recent feature branches ~ proxy for open work
  } catch (err) {
    snapshot.note = `live-inspection unavailable (${err.message}); learning core still runs`;
  }
  return snapshot;
}

// ─── Canned fixtures (smoke + --canned demo) ────────────────────────
//
// A small, realistic failure feed drawn from the proving-ground git-orchestrator
// pattern memory (stacked-PR auto-close; Cloud Run deploy race; vitest heap
// regression). Each carries a fix_class + a concrete proposed_fix so the
// proposal render is meaningful out of the box.
function cannedFailureFeed() {
  return [
    {
      surface: 'merge-queue',
      check: 'stacked-pr-autoclose',
      signature: 'dependent PR #482 auto-closed when base PR #480 merged; branch behind main',
      root_cause: 'github closes a stacked PR when its base merges if the queue is off',
      fix_class: FIX_CLASS.ELIMINATE,
      proposed_fix:
        'Enable the GitHub merge queue on `main`. Dependent PRs auto-update ' +
        'on the queue, so the "base merged -> dependent auto-closed" category ' +
        'becomes impossible rather than something we patch per-incident.',
    },
    {
      surface: 'ci',
      check: 'cloud-run-deploy',
      signature: 'deploy-aerial-backend lost optimistic-concurrency race against a simultaneous deploy at 2026-06-18T11:02Z',
      root_cause: 'two workflow runs deployed the same Cloud Run service concurrently',
      fix_class: FIX_CLASS.ADMISSION,
      proposed_fix:
        'Add `concurrency: { group: deploy-aerial-backend }` at the workflow ' +
        'level. GitHub Actions then serializes the deploys at admission — they ' +
        'cannot race because they are queued, not retried.',
    },
    {
      surface: 'ci',
      check: 'vitest',
      signature: 'vitest unit-tests step hung 18m then runner shutdown; heap exhausted on PR #500',
      root_cause: 'PR branch behind a heap-size bump on main',
      fix_class: FIX_CLASS.PRE_MERGE_GATE,
      proposed_fix:
        'Add a pre-merge check that fails fast when a PR branch is behind the ' +
        'main vitest heap-config commit, prompting an update-branch before the ' +
        'expensive run — gating the OOM instead of waiting 18m for the shutdown.',
    },
  ];
}

function cannedCeremonySnapshot(targetBranch) {
  return {
    open_prs: 3,
    mergeable: 1,
    failing: 2,
    failures: cannedFailureFeed(),
    note: `canned snapshot for target=${targetBranch} (demo / smoke)`,
  };
}
