// Agix Git Orchestrator — the git/merge-ceremony + cross-run learning bee
// (boundary / drone caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=boundary
// → drone, model tiering worker=sonnet / verifier=haiku, the guard-bee boundary,
// public=true) lives in the sibling agent.json, which the Go engine reads. The
// agent NEVER auto-merges and NEVER force-pushes: v1 returns merged=0 with no
// merge code path (a hard boundary, not a config knob).
//
// Two responsibilities fold into one run:
//   1. Mechanical git/merge ceremony (inspect-only): report what is mergeable /
//      failing. The merge button is the human gate's to press.
//   2. Cross-run learning: cluster gate/CI/merge failures by a DETERMINISTIC
//      fingerprint, track recurrence in durable state, and at
//      hit_count >= threshold (default 3) emit a structural-fix PROPOSAL under
//      wiki/git-orchestrator/proposals/. A structural fix must eliminate the
//      failure class, catch it at admission time, or add a pre-merge gate —
//      retry/alert is a patch and is rejected.
//
// The proposal follows the narrator pattern: the data layer (fingerprint, hit
// count, fix class, evidence) is computed DETERMINISTICALLY and is independently
// verifiable; the optional narrative TL;DR is now a GOVERNED hive pass
// (ctx.hive.run → queen decompose → workers → DISTINCT verifier), so even the
// prose is certified actor≠verifier and never alters the numbers.
//
// Pattern memory is a CACHE, not ground truth: before proposing for a cached
// fingerprint, the live evidence is re-verified against the cached signature; on
// divergence the pattern is amended and the proposal deferred.
//
// FAITHFUL-REDUCTION / NOT-PORTED:
//   • Live git/PR/CI inspection — the legacy `inspectGitState` imported
//     ../../lib/agix-git.mjs (a Node .mjs) and probed the gh CLI / network. ZERO
//     Node forbids the import, and PERSONA.md scopes live PR/CI plumbing out of
//     v1 anyway ("the learning core runs against whatever failure feed it is
//     given, which is the part worth shipping first"). Reduced to the built-in
//     canned failure feed. Flagged in notPorted[].
//   • node:crypto sha256 → Bun.CryptoHasher("sha256") — Bun-native, same digest,
//     so fingerprints are unchanged. Not a gap; an equivalent substitution.
//   • runtime.readState/writeState → durable JSON state files under the boundary
//     (wiki/git-orchestrator/state/) via ctx.readRepoFile / ctx.writeRepoFile,
//     plus an attested Comb leaf per emitted proposal (feed the hive).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const PROPOSALS_DIR = "wiki/git-orchestrator/proposals";
const STATE_DIR = "wiki/git-orchestrator/state";
const PATTERNS_STATE = `${STATE_DIR}/patterns.json`;
const CURSOR_STATE = `${STATE_DIR}/cursor.json`;

// Doctrine, not config: two recurrences could be coincidence; three of the same
// normalized fingerprint is structural (PERSONA.md). Overridable per-run via the
// --threshold flag for demos/tests.
const DEFAULT_THRESHOLD = 3;

// Fix-class taxonomy — the three things that qualify as a STRUCTURAL fix. A
// proposal that doesn't map to one of these is a patch and is rejected.
export const FIX_CLASS = {
  ELIMINATE: "eliminate-failure-class",
  ADMISSION: "catch-at-admission-time",
  PRE_MERGE_GATE: "add-pre-merge-gate",
} as const;

// ─── Types (the durable pattern-memory shape) ───────────────────────────────
export interface FailureEvent {
  surface?: string;
  check?: string;
  signature?: string;
  root_cause?: string | null;
  fix_class?: string;
  proposed_fix?: string | null;
}

export interface Pattern {
  fingerprint: string;
  slug: string;
  surface: string;
  check: string;
  signature: string;
  raw_signature: string;
  first_seen: string;
  last_seen: string;
  hit_count: number;
  status: string;
  last_root_cause: string | null;
  fix_class: string;
  proposed_fix: string | null;
}

type PatternMap = Record<string, Pattern>;
interface Cursor {
  last_run_at?: string;
  last_proposal_fingerprints?: string[];
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// ─── Data layer: fingerprint + recurrence (deterministic) ───────────────────

// Deterministic fingerprint: sha256 over a NORMALIZED canonical tuple so the same
// failure always hashes to the same key. IDs, SHAs, timestamps, numbers, and
// branch-specific tokens are placeholder-normalized so "the same failure on a
// different PR" collapses to one fingerprint. Bun.CryptoHasher keeps the exact
// legacy digest without a node:crypto import.
export function fingerprintFailure(ev: FailureEvent): string {
  const canonical = [
    ev.surface || "unknown",
    ev.check || "unknown",
    normalizeSignature(ev.signature || ""),
  ].join("|");
  const h = new Bun.CryptoHasher("sha256");
  h.update(canonical);
  return h.digest("hex").slice(0, 16);
}

// Strip volatile tokens so two occurrences of the same failure match.
export function normalizeSignature(sig: string): string {
  return String(sig)
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>") // git SHAs
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/gi, "<ts>") // ISO timestamps
    .replace(/#\d+/g, "#<n>") // PR/issue numbers
    .replace(/\bpr[-_ ]?\d+\b/gi, "pr<n>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m|min|mb|kb|gb)\b/gi, "<dur>") // durations/sizes
    .replace(/\b\d+\b/g, "<n>") // bare numbers
    .replace(/\s+/g, " ")
    .trim();
}

function slugForFailure(ev: FailureEvent): string {
  const base = `${ev.surface || "x"}-${ev.check || "x"}`;
  const tail = normalizeSignature(ev.signature || "")
    .replace(/<[a-z]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return `${base}${tail ? "-" + tail : ""}`.replace(/-+/g, "-").slice(0, 60);
}

// Upsert one failure event into the pattern map; increments hit_count and advances
// the status ladder. Returns the fingerprint.
export function ingestFailure(patterns: PatternMap, ev: FailureEvent, date: string): string {
  const fp = fingerprintFailure(ev);
  const existing = patterns[fp];
  if (existing) {
    existing.hit_count += 1;
    existing.last_seen = date;
    existing.last_root_cause = ev.root_cause ?? existing.last_root_cause ?? null;
    existing.status = ladderStatus(existing.hit_count, existing.status);
  } else {
    patterns[fp] = {
      fingerprint: fp,
      slug: slugForFailure(ev),
      surface: ev.surface || "unknown",
      check: ev.check || "unknown",
      signature: normalizeSignature(ev.signature || ""),
      raw_signature: ev.signature || "",
      first_seen: date,
      last_seen: date,
      hit_count: 1,
      status: "tentative_1",
      last_root_cause: ev.root_cause ?? null,
      fix_class: ev.fix_class || classifyFix(ev),
      proposed_fix: ev.proposed_fix ?? null,
    };
  }
  return fp;
}

// The status ladder: hit 1 tentative, hit 2 confirmed/watch, hit >=3
// structural-candidate. Never downgrades an operator-set terminal status.
export function ladderStatus(hitCount: number, prev: string): string {
  if (prev === "accepted_recurring_cost" || prev === "fixed") return prev;
  if (hitCount >= 3) return "structural_candidate_3+";
  if (hitCount === 2) return "confirmed_2+";
  return "tentative_1";
}

export function recurrenceStage(hitCount: number, threshold: number): string {
  if (hitCount >= threshold) return "propose-structural-fix";
  if (hitCount === 2) return "surface-in-briefing";
  return "log-only";
}

// Map a failure to a structural fix class. Heuristic v1 — always lands on one of
// the three qualifying classes (never a patch).
export function classifyFix(ev: FailureEvent): string {
  const sig = normalizeSignature(ev.signature || "");
  if (/stack|stacked|auto-?close|dependent pr|behind main|update-branch/.test(sig)) {
    return FIX_CLASS.ELIMINATE;
  }
  if (/race|concurren|optimistic|deploy.*deploy|simultaneous/.test(sig)) {
    return FIX_CLASS.ADMISSION;
  }
  return FIX_CLASS.PRE_MERGE_GATE;
}

// Pattern-memory-is-a-cache: confirm the live feed still carries a failure whose
// normalized signature matches the cached one before proposing.
export function verifyRootCause(
  pattern: Pattern,
  feed: FailureEvent[],
): { matches: boolean; observed: string | null; reverified: boolean } {
  const live = feed.find((ev) => fingerprintFailure(ev) === pattern.fingerprint);
  if (!live) {
    // No live evidence this run — the cache is the only evidence (conservative:
    // treat as a match), but record that we could not re-verify.
    return { matches: true, observed: pattern.last_root_cause, reverified: false };
  }
  const observed = live.root_cause ?? null;
  const cached = pattern.last_root_cause ?? null;
  const matches = !observed || !cached || observed === cached;
  return { matches, observed, reverified: true };
}

// ─── Proposal render (the deterministic data layer of the narrator) ─────────

export function renderProposal(p: Pattern, opts: { date: string; narrative: string | null }): string {
  const { date, narrative } = opts;
  const tldr = narrative
    ? `> ${narrative.trim().replace(/\n/g, "\n> ")}\n\n`
    : `> _(No LLM narrative this run — deterministic summary below. The data ` +
      `layer is authoritative regardless.)_\n\n`;

  const fixClassLine =
    (
      {
        [FIX_CLASS.ELIMINATE]: "Eliminates the failure class (the category becomes impossible).",
        [FIX_CLASS.ADMISSION]: "Catches the failure at admission time, not at runtime.",
        [FIX_CLASS.PRE_MERGE_GATE]: "Adds a pre-merge check that gates the next occurrence.",
      } as Record<string, string>
    )[p.fix_class] || "Adds a pre-merge check that gates the next occurrence.";

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

Last observed root cause: ${p.last_root_cause ? `\`${p.last_root_cause}\`` : "_(not captured this run — re-verify against the live log before acting; pattern memory is a cache, not ground truth)_"}

## Proposed structural fix

**Fix class:** \`${p.fix_class}\` — ${fixClassLine}

${
  p.proposed_fix
    ? p.proposed_fix
    : `_Concrete fix to be filled in by the reviewer/implementer. It MUST satisfy the fix class above — eliminate the class, catch it at admission, or gate it pre-merge. A "retry / add an alert" change is a PATCH and does not satisfy the >=3 threshold._`
}

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

// ─── Canned fixtures (the v1 failure feed; live inspection not ported) ───────
//
// A small, realistic failure feed (stacked-PR auto-close; Cloud Run deploy race;
// vitest heap regression). Each carries a fix_class + a concrete proposed_fix so
// the proposal render is meaningful out of the box.
export function cannedFailureFeed(): FailureEvent[] {
  return [
    {
      surface: "merge-queue",
      check: "stacked-pr-autoclose",
      signature: "dependent PR #482 auto-closed when base PR #480 merged; branch behind main",
      root_cause: "github closes a stacked PR when its base merges if the queue is off",
      fix_class: FIX_CLASS.ELIMINATE,
      proposed_fix:
        "Enable the GitHub merge queue on `main`. Dependent PRs auto-update on " +
        "the queue, so the \"base merged -> dependent auto-closed\" category " +
        "becomes impossible rather than something we patch per-incident.",
    },
    {
      surface: "ci",
      check: "cloud-run-deploy",
      signature:
        "deploy-aerial-backend lost optimistic-concurrency race against a simultaneous deploy at 2026-06-18T11:02Z",
      root_cause: "two workflow runs deployed the same Cloud Run service concurrently",
      fix_class: FIX_CLASS.ADMISSION,
      proposed_fix:
        "Add `concurrency: { group: deploy-aerial-backend }` at the workflow " +
        "level. GitHub Actions then serializes the deploys at admission — they " +
        "cannot race because they are queued, not retried.",
    },
    {
      surface: "ci",
      check: "vitest",
      signature: "vitest unit-tests step hung 18m then runner shutdown; heap exhausted on PR #500",
      root_cause: "PR branch behind a heap-size bump on main",
      fix_class: FIX_CLASS.PRE_MERGE_GATE,
      proposed_fix:
        "Add a pre-merge check that fails fast when a PR branch is behind the " +
        "main vitest heap-config commit, prompting an update-branch before the " +
        "expensive run — gating the OOM instead of waiting 18m for the shutdown.",
    },
  ];
}

function cannedCeremonySnapshot(targetBranch: string) {
  return {
    open_prs: 3,
    mergeable: 1,
    failing: 2,
    failures: cannedFailureFeed(),
    note: `canned snapshot for target=${targetBranch} (v1 inspect-only; live PR/CI plumbing not ported)`,
  };
}

// ─── State round-trip (durable JSON files under the boundary) ────────────────

async function readJSON<T>(ctx: AgentContext, rel: string, fallback: T): Promise<T> {
  const raw = await ctx.readRepoFile(rel);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const flags = ctx.input.flags;
  const threshold = Number(flags.threshold ?? DEFAULT_THRESHOLD) || DEFAULT_THRESHOLD;
  const date = typeof flags.date === "string" ? flags.date : isoDate();
  const reset = Boolean(flags.reset);
  const dryRun = Boolean(flags["dry-run"] ?? flags.dryRun);
  const TARGET_BRANCH = "main";

  // ── Smoke short-circuit ───────────────────────────────────────────────────
  // One $0 governed pass (the narrator surface), then exercise the deterministic
  // learning core in-memory (canned feed → fingerprints → forced recurrence →
  // proposal render) with NO disk side effects. Mirrors the Node smoke contract
  // ("exercise the surfaces"), reborn-style (no writes in smoke).
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the git-orchestrator narrator surface is live");
    const feed = cannedFailureFeed();
    const patterns: PatternMap = {};
    for (const ev of feed) ingestFailure(patterns, ev, date);
    const fp = Object.keys(patterns)[0];
    patterns[fp].hit_count = threshold; // force the render path
    const body = renderProposal(patterns[fp], { date, narrative: null });
    ctx.log("smoke short-circuit · governed surface + deterministic core verified", {
      verifier: r.verifierActor,
      fingerprints: Object.keys(patterns).length,
      rendered: body.length,
    });
    return {
      ok: true,
      smoke: true,
      verifier: r.verifierActor,
      fingerprints: Object.keys(patterns).length,
      proposals: 1,
      merged: 0,
    };
  }

  // ── 1. Mechanical ceremony — inspect-only summary (never presses merge) ────
  // Live inspection is not ported (Node dep + gh/network, v1-out-of-scope); the
  // ceremony reports the canned snapshot so the shape is honest.
  const ceremony = cannedCeremonySnapshot(TARGET_BRANCH);
  ctx.log(
    `ceremony (inspect-only) · target=${TARGET_BRANCH} · ${ceremony.open_prs} open PR(s) · ` +
      `${ceremony.mergeable} mergeable · ${ceremony.failing} failing CI · merge button is the human gate's`,
  );

  // ── 2. Load pattern memory + cursor ───────────────────────────────────────
  const state = reset
    ? { patterns: {} as PatternMap }
    : await readJSON<{ patterns: PatternMap }>(ctx, PATTERNS_STATE, { patterns: {} });
  const patterns: PatternMap = state && state.patterns ? state.patterns : {};
  const cursor = reset ? ({} as Cursor) : await readJSON<Cursor>(ctx, CURSOR_STATE, {});
  const alreadyProposed = new Set(cursor.last_proposal_fingerprints ?? []);

  // ── 3. Gather + ingest this run's failures (data layer) ───────────────────
  const feed = ceremony.failures;
  const touched = new Set<string>();
  for (const ev of feed) touched.add(ingestFailure(patterns, ev, date));

  // ── 4. Decide what crosses the recurrence threshold ───────────────────────
  const toPropose: Pattern[] = [];
  for (const fp of touched) {
    const p = patterns[fp];
    const stage = recurrenceStage(p.hit_count, threshold);
    ctx.log(`  · ${p.slug} · hit_count=${p.hit_count} · status=${p.status} · stage=${stage}`);
    if (p.hit_count < threshold) continue; // not yet structural
    if (p.status === "accepted_recurring_cost") continue; // operator opted out
    if (alreadyProposed.has(fp)) continue; // don't pester twice (boundary)

    // Pattern-memory-is-a-cache: re-verify the live root cause before proposing.
    const v = verifyRootCause(p, feed);
    if (!v.matches) {
      p.last_root_cause = v.observed;
      p.status = "amended_cache_drift";
      ctx.log(`  ! ${p.slug} · cache drift — observed root cause diverged; amended, proposal deferred`);
      continue;
    }
    toPropose.push(p);
  }

  // ── 5. Emit structural-fix proposals (never auto-merge) ───────────────────
  const proposalFingerprints: string[] = [];
  const writtenProposals: string[] = [];
  let verifier: string | null = null;
  let allVerified = true;

  for (const p of toPropose) {
    // The narrator TL;DR is now a GOVERNED hive pass (actor≠verifier certifies).
    // Its answer prepends the deterministic data layer; the numbers are untouched.
    const r = await ctx.hive.run(
      `In 2-3 terse sentences, summarize this recurring CI/merge failure and why the proposed fix is the ` +
        `right CLASS of fix (eliminate the failure class / catch at admission / add a pre-merge gate) rather ` +
        `than a patch (retry/alert). Use ONLY these fields; invent no numbers. No em dashes.\n\n` +
        `slug: ${p.slug}\nfingerprint: ${p.fingerprint}\nhit_count: ${p.hit_count}\n` +
        `surface/check: ${p.surface}/${p.check}\nfix_class: ${p.fix_class}\n` +
        `signature: ${p.raw_signature || p.signature}\nlast_root_cause: ${p.last_root_cause ?? "(not captured)"}`,
    );
    verifier = r.verifierActor;
    allVerified = allVerified && r.verified;
    const narrative = r.answer && !/\[smoke-mode/.test(r.answer) ? r.answer : null;
    const body = renderProposal(p, { date, narrative });
    const relPath = `${PROPOSALS_DIR}/${date}-${p.slug}.md`;

    if (dryRun) {
      ctx.log(`proposal (dry-run, not written): ${relPath}`);
    } else {
      try {
        await ctx.writeRepoFile(relPath, body);
        writtenProposals.push(relPath);
        ctx.log(`structural-fix proposal written: ${relPath}`, { verifier: r.verifierActor });
      } catch (e) {
        ctx.log(`proposal write skipped: ${(e as Error).message}`);
      }
      // Feed the hive: record the proposal as an attested Comb leaf (author =
      // the run's queen, verifier = the run's DISTINCT verifier).
      await ctx.comb
        .put({
          id: `git-orchestrator/${p.fingerprint}`,
          content: `git-orchestrator ${date}: recurring ${p.surface}/${p.check} (hit ${p.hit_count}) → ${p.fix_class}: ${(narrative ?? p.proposed_fix ?? p.slug).slice(0, 300)}`,
          branch: "software", // TOGAF Software Architecture — the build/merge pipeline
          author: r.queenActor,
          verifier: r.verifierActor,
          trust: 0.8,
        })
        .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
    }
    p.status = "proposal_open";
    proposalFingerprints.push(p.fingerprint);
  }

  // ── 6. Persist pattern memory + cursor (durable state under the boundary) ──
  if (!dryRun) {
    try {
      await ctx.writeRepoFile(PATTERNS_STATE, JSON.stringify({ patterns }, null, 2));
      await ctx.writeRepoFile(
        CURSOR_STATE,
        JSON.stringify(
          {
            last_run_at: new Date().toISOString(),
            last_proposal_fingerprints: [...alreadyProposed, ...proposalFingerprints],
          },
          null,
          2,
        ),
      );
    } catch (e) {
      ctx.log(`state persist skipped: ${(e as Error).message}`);
    }
  }

  const fingerprints = Object.keys(patterns).length;
  ctx.log(
    `done · ${fingerprints} tracked fingerprint(s) · ${writtenProposals.length} new structural-fix proposal(s) · ` +
      `0 merges (by design)`,
  );
  return {
    ok: allVerified,
    merged: 0, // v1 never merges (hard boundary)
    fingerprints,
    failures_ingested: feed.length,
    proposals: writtenProposals.length,
    proposal_paths: writtenProposals,
    verifier,
  };
});
