// Agix PR Reviewer — finds, does not post (proposer / worker caste).
//
// WHERE IT SITS IN THE LOOP. pr-reviewer produces Findings in the EXACT shape
// review-validator consumes, so the pipeline composes without glue:
//
//   pr-reviewer (find)  →  review-validator (refute)  →  host-drone (post, at earned rung)
//
// It emits candidates; the validator kills the false positives; the drone posts only what
// survives, and only at the autonomy rung the pr-comment domain has earned. This agent holds
// no token and never touches the host.
//
// DESIGN, from the verified field brief (research/notes/2026-07-09-agentic-pr-review-loops-
// research.md):
//   • PARALLEL, NOT ITERATIVE. N independent single-shot passes + majority vote (Bugbot's
//     original design). No self-critique: CR-Bench shows Reflexion collapses signal-to-noise
//     on small models, and this fleet runs on qwen. Independent agreement is the suppressor.
//   • DETERMINISTIC PRE-SIGNAL FIRST (CodeRabbit runs analyzers before the model): the diff is
//     parsed in pure TS for risk paths, test coverage of the change, and size BEFORE any pass.
//     A behavior change with no test touched is a finding the code produces, needing no model.
//   • DETERMINISTIC INJECTION of the diff (Augment): the change under review is handed to the
//     model verbatim, not retrieved — a reviewer must see exactly what changed.
//   • ESCALATE ON AMBIGUITY (Pydantic): API-design / behavior / security changes ping a human
//     rather than being reviewed mechanically.
//   • SCOPED TO THE DIFF: a finding must cite a file+line the change actually touches. A claim
//     about untouched code is out of scope and dropped — reviewing the whole repo on every PR
//     is how a bot becomes noise.
//
// FAITHFUL-REDUCTION / NOT-PORTED:
//   • Live `gh pr diff` fetch — the crawler half. v1 reads a unified diff from a FILE (--diff),
//     exactly as git-orchestrator v1 reads a canned feed: the review core runs against whatever
//     diff it is given, which is the part worth shipping first. Flagged in notPorted[].
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REVIEW_DIR = "wiki/oss-steward/reviews";

/** Categories a pass may raise. style/formatting/typo are deliberately absent — the validator
 *  filters them, so raising them only adds noise upstream. */
export const REVIEW_CATEGORIES = new Set(["bug", "security", "performance", "test-gap", "correctness"]);

/** Paths whose change always warrants human taste (mirrors verifier-guard's risk classes). */
const RISK_PATH_RE = /(auth|secret|credential|token|password|billing|payment|migration|\.github\/workflows)/i;
const TEST_PATH_RE = /(\.test\.|_test\.|\/tests?\/|\/spec\/|\.spec\.)/i;

const DEFAULT_PASSES = 3;

/** One file's hunk in a unified diff, reduced to what review needs. */
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  /** Concrete added-line numbers, so a finding can be checked against the change. */
  addedLines: number[];
  isTest: boolean;
  isRisk: boolean;
}

export interface PreSignal {
  files: DiffFile[];
  totalAdded: number;
  totalRemoved: number;
  touchesRisk: boolean;
  touchesTests: boolean;
  /** A behavior change (non-test code touched) with no test touched anywhere. */
  behaviorWithoutTest: boolean;
  /** Large diffs need more scrutiny; surfaced, not gated. */
  large: boolean;
}

/** parseDiff reads a unified diff deterministically. It tracks the current file and the new-file
 *  line counter so each added line gets a real line number a finding can be checked against. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let newLine = 0;
  for (const line of (diff ?? "").split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (line.startsWith("diff --git")) {
      // start of a new file; the +++ line names it
      continue;
    }
    if (m) {
      const path = m[1].trim();
      cur = { path, added: 0, removed: 0, addedLines: [], isTest: TEST_PATH_RE.test(path), isRisk: RISK_PATH_RE.test(path) };
      files.push(cur);
      newLine = 0;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cur.added++;
      cur.addedLines.push(newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cur.removed++;
      // removed lines do not advance the new-file counter
    } else if (!line.startsWith("\\")) {
      newLine++; // context line
    }
  }
  return files;
}

/** preSignal computes what is checkable about the change without a model. */
export function preSignal(diff: string): PreSignal {
  const files = parseDiff(diff);
  const totalAdded = files.reduce((a, f) => a + f.added, 0);
  const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
  const touchesTests = files.some((f) => f.isTest);
  const touchesCode = files.some((f) => !f.isTest);
  return {
    files,
    totalAdded,
    totalRemoved,
    touchesRisk: files.some((f) => f.isRisk),
    touchesTests,
    behaviorWithoutTest: touchesCode && !touchesTests,
    large: totalAdded + totalRemoved > 400,
  };
}

/** A finding — the SAME shape review-validator consumes (id/author/category/claim/evidence),
 *  so the two agents compose with no adapter. */
export interface Finding {
  id: string;
  author: string;
  category: string;
  claim: string;
  evidence?: string;
}

interface PassFinding { category: string; location: string; claim: string; escalate?: boolean }

/** parsePass reads one pass. Out-of-category lines are dropped as noise; a FINDING must cite a
 *  location, or it cannot be checked against the diff. */
export function parsePass(text: string): { findings: PassFinding[]; escalate: boolean } {
  const findings: PassFinding[] = [];
  let escalate = false;
  for (const raw of (text ?? "").split("\n")) {
    const p = raw.split("|").map((s) => s.trim());
    if (p.length < 2) continue;
    const kind = p[0].toUpperCase();
    if (kind === "ESCALATE") {
      if ((p[1] ?? "").toLowerCase() === "yes") escalate = true;
      continue;
    }
    if (kind !== "FINDING" || p.length < 4) continue;
    const category = (p[1] ?? "").toLowerCase();
    if (!REVIEW_CATEGORIES.has(category)) continue; // filtered/unknown → noise
    const location = p[2] ?? "";
    if (!location) continue;
    findings.push({ category, location, claim: p[3] ?? "" });
  }
  return { findings, escalate };
}

/** A finding is IN SCOPE only if its cited file is one the diff actually touches. Reviewing
 *  code the change did not modify is how a bot drowns a PR in noise. */
export function inScope(location: string, files: DiffFile[]): boolean {
  const file = location.split(":")[0].trim();
  return files.some((f) => f.path === file || f.path.endsWith("/" + file) || file.endsWith(f.path));
}

/** voteFindings tallies findings across N independent passes by (category, location). A finding
 *  raised by only one pass is LOW CONFIDENCE and is dropped from the posted set but recorded in
 *  the report — never silently deleted. Majority survives to the validator. */
export function voteFindings(passes: PassFinding[][], files: DiffFile[]): { survived: Finding[]; all: (Finding & { votes: number; passes: number })[] } {
  const n = passes.length;
  const need = Math.floor(n / 2) + 1;
  const tally = new Map<string, { f: PassFinding; votes: number }>();
  for (const pass of passes) {
    const seen = new Set<string>();
    for (const f of pass) {
      if (!inScope(f.location, files)) continue; // out-of-diff → dropped before it can vote
      const key = `${f.category}:${f.location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = tally.get(key);
      if (cur) cur.votes++;
      else tally.set(key, { f, votes: 1 });
    }
  }
  const all = [...tally.values()]
    .map(({ f, votes }) => ({
      id: `${f.location}:${f.category}`,
      author: "pr-reviewer",
      category: f.category,
      claim: f.claim,
      evidence: f.location,
      votes,
      passes: n,
    }))
    .sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  const survived: Finding[] = all
    .filter((f) => f.votes >= need)
    .map(({ votes, passes, ...f }) => f);
  return { survived, all };
}

async function loadDiff(ctx: AgentContext): Promise<string> {
  const path = String(ctx.input.flags.diff ?? "").trim();
  if (!path) throw new Error("pr-reviewer: --diff <unified-diff-file> is required in v1");
  const raw = await ctx.readRepoFile(path);
  if (raw === null) throw new Error(`pr-reviewer: diff not found: ${path}`);
  return raw;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the governed pr-review surface is reachable");
    return { ok: true, smoke: true, verifier: r.verifierActor, findings: 0 };
  }

  const passes = Math.max(1, Number(ctx.input.flags.passes ?? DEFAULT_PASSES) || DEFAULT_PASSES);
  const diff = await loadDiff(ctx);
  const sig = preSignal(diff);

  // Escalate BEFORE spending inference on a change that is not ours to review mechanically.
  if (sig.touchesRisk) {
    const relPath = `${REVIEW_DIR}/${new Date().toISOString().slice(0, 10)}-review.md`;
    await ctx.writeRepoFile(relPath, renderEscalation(sig));
    return {
      ok: true, smoke: false, escalated: true, findings: 0, governedRuns: 0,
      reason: "touches a risk path (auth/secrets/billing/migrations/workflows) — human review required",
      report: relPath,
      notPorted: ["live `gh pr diff` fetch (v1 reads a diff file)"],
    };
  }

  // N independent single-shot passes over the deterministically-injected diff.
  const task = [
    `Review this pull request diff. Deterministic signal (authoritative):`,
    `  files changed: ${sig.files.length}   +${sig.totalAdded}/-${sig.totalRemoved}`,
    `  touches tests: ${sig.touchesTests}   behavior changed without a test: ${sig.behaviorWithoutTest}`,
    ``,
    `Cite file:line from the diff for every finding. Do not review code the diff does not touch.`,
    ``,
    diff,
  ].join("\n");

  const results = await Promise.all(
    Array.from({ length: passes }, (_, i) =>
      ctx.hive.run(`${task}\n\n(independent pass ${i + 1} of ${passes}; do not revise or self-critique)`),
    ),
  );
  const parsed = results.map((r) => parsePass(r.answer));
  const escalate = parsed.filter((p) => p.escalate).length * 2 >= passes; // majority escalate

  const { survived, all } = voteFindings(parsed.map((p) => p.findings), sig.files);

  // A deterministic finding the code produces without a model: behavior changed, no test touched.
  const findings = [...survived];
  if (sig.behaviorWithoutTest && !findings.some((f) => f.category === "test-gap")) {
    const f = sig.files.find((x) => !x.isTest)!;
    findings.push({
      id: `${f.path}:test-gap`, author: "pr-reviewer", category: "test-gap",
      claim: "behavior changed but no test file was touched in this PR", evidence: f.path,
    });
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportPath = `${REVIEW_DIR}/${date}-review.md`;
  const findingsPath = `${REVIEW_DIR}/${date}-findings.json`;
  await ctx.writeRepoFile(reportPath, renderReview(date, sig, all, escalate, passes));
  // The findings file is the HANDOFF to review-validator — its exact input shape.
  await ctx.writeRepoFile(findingsPath, JSON.stringify(findings, null, 2));

  return {
    ok: true,
    smoke: false,
    escalated: escalate,
    // Candidates for the validator — NOT posted. host-drone posts survivors at the earned rung.
    findings: findings.length,
    considered: all.length,
    governedRuns: results.length,
    handoff: findingsPath,
    report: reportPath,
    notPorted: ["live `gh pr diff` fetch (v1 reads a diff file)"],
  };
});

function renderEscalation(sig: PreSignal): string {
  const risk = sig.files.filter((f) => f.isRisk).map((f) => f.path);
  return [
    `# PR review — ESCALATED`,
    ``,
    `This change touches risk paths and is not reviewed mechanically. A human maintainer must`,
    `review it. Risk-bearing files:`,
    ``,
    ...risk.map((p) => `- \`${p}\``),
    ``,
    `_No automated findings were produced. (Generated by \`pr-reviewer\`, an AI agent.)_`,
  ].join("\n") + "\n";
}

function renderReview(
  date: string, sig: PreSignal,
  all: (Finding & { votes: number; passes: number })[], escalate: boolean, passes: number,
): string {
  const lines = [
    `# PR review — ${date}`,
    ``,
    `Files: ${sig.files.length} · +${sig.totalAdded}/-${sig.totalRemoved} · ` +
      `tests touched: ${sig.touchesTests} · large: ${sig.large}`,
    ``,
    `${passes} independent passes; a finding survives to the validator only by majority vote.`,
    escalate ? `\n**A majority of passes voted to escalate to a human.**\n` : ``,
    `Findings are CANDIDATES. review-validator refutes false positives; host-drone posts only`,
    `survivors, and only at the rung the pr-comment domain has earned. (Generated by an AI agent.)`,
    ``,
    `| category | location | votes | claim |`,
    `|---|---|---|---|`,
  ];
  for (const f of all) {
    lines.push(`| ${f.category} | \`${f.evidence}\` | ${f.votes}/${f.passes} | ${f.claim} |`);
  }
  return lines.join("\n") + "\n";
}
