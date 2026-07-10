// Agix Issue Triage — the OSS-steward pack's first worker (proposer / worker caste),
// and the vertical slice that proves the whole loop.
//
// THE LOOP (spec: wiki/director/specs/2026-07-09-oss-steward-fleet-spec.md, corrected
// against the verified field brief research/notes/2026-07-09-agentic-pr-review-loops-
// research.md):
//
//   pre-signal → N parallel single-shot passes → majority vote → dedupe → confidence
//   → escalate-or-propose → (host-drone acts, only at the earned rung) → attest
//
// WHY PARALLEL AND NOT ITERATIVE. The obvious design is propose→self-critique→revise.
// CR-Bench (arXiv 2603.11078) measured it: Reflexion raises recall but collapses signal
// integrity, and SMALL models suffer worst — GPT-5-mini's signal-to-noise fell to 0.91,
// below 1.0, i.e. MORE NOISE THAN SIGNAL (vs 2.89 single-shot). This fleet runs on a
// local qwen nucleus, a small model. So we spend cheap local inference on N INDEPENDENT
// single-shot passes and keep only what a majority of them agree on (Cursor Bugbot's
// original eight-pass majority vote), instead of letting one pass talk itself into
// something. Parallelism is qwen's strength; iteration is its failure mode.
//
// DETERMINISTIC SIGNAL FIRST. Everything objectively checkable about an issue (does it
// have repro steps, a version, a stack trace; is its fingerprint already triaged) is
// computed in pure TS BEFORE any model runs, and outranks the model (CodeRabbit runs
// 30+ analyzers before prompting). A deterministic finding is free and cannot hallucinate.
//
// NEVER SILENTLY SUPPRESS. Every proposal carries a confidence (the vote fraction).
// Sub-majority findings are reported as low-confidence, not deleted (Datadog): hiding a
// finding hides the error rate.
//
// ESCALATE, DON'T CONFIDENTLY APPROVE. API-design/behavior/security issues ping a human
// (Pydantic's anti-backlash guardrail). One low-quality automated report can burn hours
// of a maintainer's life (curl: security-report confirmation collapsed >15% → <5%).
//
// AUTONOMY. This agent NEVER touches the code host. It emits a proposal; the host-drone
// applies it, and only at the rung the `issue-label` domain has earned (core/autonomy;
// every domain starts at Shadow). At Shadow the proposal is a file and nothing more.
//
// FAITHFUL-REDUCTION / NOT-PORTED:
//   • Live `gh issue list` ingestion — the crawler half. v1 reads a FEED (a JSON file of
//     issues, --feed) exactly as git-orchestrator v1 reads a canned failure feed: the
//     triage core is the part worth shipping first, and it runs against whatever feed it
//     is given. Flagged in notPorted[].
//   • Applying labels — belongs to host-drone (the sole GH_TOKEN holder), not here.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const TRIAGE_DIR = "wiki/oss-steward/triage";
const STATE_DIR = "wiki/oss-steward/state";
const TRIAGED_STATE = `${STATE_DIR}/triaged.json`;

/** The only labels a pass may propose. A proposal outside the vocabulary is dropped —
 *  a model inventing `wontfix-maybe` is noise, not a finding. */
export const LABEL_VOCAB = new Set([
  "bug", "enhancement", "question", "documentation",
  "duplicate", "needs-repro", "good-first-issue", "security",
]);

export const PRIORITY_VOCAB = new Set(["p0", "p1", "p2", "p3"]);

/** Default number of independent passes. Odd, so a majority always exists. */
const DEFAULT_PASSES = 3;

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels?: string[];
}

/** A deterministic, un-hallucinatable read of an issue. Computed before any model runs;
 *  the model may not contradict it. */
export interface PreSignal {
  hasRepro: boolean;
  hasVersion: boolean;
  hasStackTrace: boolean;
  bodyLength: number;
  /** Stable fingerprint for dedupe across runs. */
  fingerprint: string;
  /** Deterministic labels the signal alone justifies (no model needed). */
  impliedLabels: string[];
  /** True when the issue names something only a human should rule on. */
  needsHumanTaste: boolean;
}

const REPRO_RE = /\b(steps? to reproduce|reproduc|repro:)/i;
const VERSION_RE = /\b(v?\d+\.\d+\.\d+|version\s*[:=]|agix-core \d)/i;
const STACK_RE = /(\n\s+at\s+\S+|Traceback \(most recent call last\)|panic:|goroutine \d+)/;
// Judgment-heavy territory: API shape, behavior change, security. Pydantic's rule —
// escalate rather than confidently approve.
const HUMAN_TASTE_RE = /\b(api design|breaking change|behavio[u]?r change|deprecat|security|vulnerab|CVE-|threat model)\b/i;

/** fingerprint is a deterministic, normalized digest of the issue's identity. Used to
 *  dedupe against previously-triaged issues (Bugbot dedupes against prior runs — which
 *  is also how follow-up edits are handled). */
export function fingerprint(issue: Issue): string {
  const norm = `${issue.number}|${issue.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const h = new Bun.CryptoHasher("sha256");
  h.update(norm);
  return h.digest("hex").slice(0, 16);
}

/** preSignal computes everything checkable without a model. Free, deterministic, and it
 *  outranks the model's judgment. */
export function preSignal(issue: Issue): PreSignal {
  const body = issue.body ?? "";
  const hasRepro = REPRO_RE.test(body);
  const hasVersion = VERSION_RE.test(body);
  const hasStackTrace = STACK_RE.test(body);
  const implied: string[] = [];
  // A bug report with no reproduction path is objectively not actionable yet. This needs
  // no model: it is a property of the text.
  if (!hasRepro && !hasStackTrace) implied.push("needs-repro");
  return {
    hasRepro,
    hasVersion,
    hasStackTrace,
    bodyLength: body.length,
    fingerprint: fingerprint(issue),
    impliedLabels: implied,
    needsHumanTaste: HUMAN_TASTE_RE.test(`${issue.title}\n${body}`),
  };
}

export interface PassFinding {
  kind: "LABEL" | "PRIORITY" | "DUPLICATE" | "ESCALATE";
  value: string;
  reason: string;
}

/** parsePass reads one pass's pipe-delimited output. Malformed lines are skipped (a pass
 *  that rambles contributes nothing rather than corrupting the vote). */
export function parsePass(text: string): PassFinding[] {
  const out: PassFinding[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;
    const kind = parts[0].toUpperCase();
    if (kind !== "LABEL" && kind !== "PRIORITY" && kind !== "DUPLICATE" && kind !== "ESCALATE") continue;
    const value = (parts[1] ?? "").toLowerCase();
    if (!value) continue;
    if (kind === "LABEL" && !LABEL_VOCAB.has(value)) continue;      // outside vocab → noise
    if (kind === "PRIORITY" && !PRIORITY_VOCAB.has(value)) continue;
    out.push({ kind: kind as PassFinding["kind"], value, reason: parts[2] ?? "" });
  }
  return out;
}

export interface VotedFinding {
  kind: PassFinding["kind"];
  value: string;
  votes: number;
  passes: number;
  /** votes/passes — surfaced, never used to silently drop. */
  confidence: number;
  majority: boolean;
  reason: string;
}

/** majorityVote tallies findings across N independent passes. A finding carried by only
 *  one pass is LOW CONFIDENCE, not deleted (Datadog: never silently suppress). The
 *  `majority` flag is what the proposal acts on; the rest are reported for the human.
 *
 *  This is the FP suppressor that replaces self-reflection: independent agreement, not
 *  self-critique. */
export function majorityVote(passes: PassFinding[][]): VotedFinding[] {
  const n = passes.length;
  const need = Math.floor(n / 2) + 1;
  const tally = new Map<string, { f: PassFinding; votes: number }>();
  for (const pass of passes) {
    // A single pass repeating a finding must not stuff the ballot.
    const seen = new Set<string>();
    for (const f of pass) {
      const key = `${f.kind}:${f.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = tally.get(key);
      if (cur) cur.votes++;
      else tally.set(key, { f, votes: 1 });
    }
  }
  return [...tally.values()]
    .map(({ f, votes }) => ({
      kind: f.kind,
      value: f.value,
      votes,
      passes: n,
      confidence: n ? votes / n : 0,
      majority: votes >= need,
      reason: f.reason,
    }))
    .sort((a, b) => b.votes - a.votes || a.value.localeCompare(b.value));
}

interface TriagedState {
  [fingerprint: string]: { issue: number; at: string; labels: string[] };
}

async function readState(ctx: AgentContext): Promise<TriagedState> {
  const raw = await ctx.readRepoFile(TRIAGED_STATE);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TriagedState;
  } catch {
    ctx.log("triaged state unreadable; starting fresh");
    return {};
  }
}

/** The canned feed — the honest v1 stand-in for live `gh issue list` (see the
 *  FAITHFUL-REDUCTION note). Deterministic, so tests and $0 runs are reproducible. */
const BUILTIN_FEED: Issue[] = [
  {
    number: 101,
    title: "Crash on `agix agent run` with no provider configured",
    body: "Steps to reproduce:\n1. fresh install\n2. run `agix agent run mentor`\n\npanic: runtime error: invalid memory address\n\ngoroutine 1 [running]:\nversion: 0.1.0",
  },
  {
    number: 102,
    title: "Should the autonomy ladder expose a per-domain API design for third parties?",
    body: "I think the API design here is a breaking change for anyone embedding the gate. Worth discussing before v1.",
  },
  { number: 103, title: "Typo in README install section", body: "The tap name is wrong in one spot." },
];

async function loadFeed(ctx: AgentContext): Promise<Issue[]> {
  const path = String(ctx.input.flags.feed ?? "").trim();
  if (!path) return BUILTIN_FEED;
  const raw = await ctx.readRepoFile(path);
  if (!raw) throw new Error(`issue-triage: feed not found: ${path}`);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("issue-triage: feed must be a JSON array of issues");
  return parsed as Issue[];
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke: exercise exactly one governed surface and prove actor≠verifier holds.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the governed triage surface is reachable");
    return { ok: true, smoke: true, verifier: r.verifierActor, triaged: 0 };
  }

  const passes = Math.max(1, Number(ctx.input.flags.passes ?? DEFAULT_PASSES) || DEFAULT_PASSES);
  // The rung the `issue-label` domain has earned (core/autonomy). SHADOW is the safe
  // default and the only rung this agent ever assumes: it proposes to a file, never acts.
  const rung = String(ctx.input.flags.rung ?? "shadow").toLowerCase();

  const issues = await loadFeed(ctx);
  const state = await readState(ctx);

  const proposals: Record<string, unknown>[] = [];
  let escalated = 0;
  let deduped = 0;
  let governedRuns = 0;

  for (const issue of issues) {
    const sig = preSignal(issue);

    // ── dedupe against previously-triaged fingerprints (also the follow-up-edit path).
    if (state[sig.fingerprint]) {
      deduped++;
      ctx.log(`#${issue.number} already triaged (fingerprint ${sig.fingerprint}) — skipping`);
      continue;
    }

    // ── escalate BEFORE spending inference: a human-taste issue is not ours to label.
    if (sig.needsHumanTaste) {
      escalated++;
      proposals.push({
        issue: issue.number,
        title: issue.title,
        escalate: true,
        reason: "touches API design / behavior change / security — human taste required",
        preSignal: sig,
        findings: [],
      });
      continue;
    }

    // ── N INDEPENDENT single-shot passes. No pass sees another's output; none critiques
    //    itself. Randomized framing per pass so they do not collapse into one opinion.
    const task = [
      `Triage this open-source issue. Deterministic signal (authoritative, do not contradict):`,
      `  reproduction steps present: ${sig.hasRepro}`,
      `  stack trace present: ${sig.hasStackTrace}`,
      `  version present: ${sig.hasVersion}`,
      ``,
      `Issue #${issue.number}: ${issue.title}`,
      ``,
      issue.body,
    ].join("\n");

    const results = await Promise.all(
      Array.from({ length: passes }, (_, i) =>
        ctx.hive.run(`${task}\n\n(independent pass ${i + 1} of ${passes}; do not revise, do not self-critique)`),
      ),
    );
    governedRuns += results.length;

    const voted = majorityVote(results.map((r) => parsePass(r.answer)));

    // The deterministic pre-signal's implied labels are added at full confidence: they
    // are facts about the text, not judgments, so they do not need a vote.
    for (const l of sig.impliedLabels) {
      if (!voted.some((v) => v.kind === "LABEL" && v.value === l)) {
        voted.push({ kind: "LABEL", value: l, votes: passes, passes, confidence: 1, majority: true, reason: "deterministic: no repro steps and no stack trace" });
      }
    }

    const wantsEscalate = voted.some((v) => v.kind === "ESCALATE" && v.value === "yes" && v.majority);
    const majorityLabels = voted.filter((v) => v.kind === "LABEL" && v.majority);
    // No majority on anything → the passes disagreed. Disagreement IS the signal:
    // escalate rather than pick a winner.
    const noConsensus = majorityLabels.length === 0;

    if (wantsEscalate || noConsensus) escalated++;

    proposals.push({
      issue: issue.number,
      title: issue.title,
      escalate: wantsEscalate || noConsensus,
      reason: wantsEscalate ? "a majority of passes voted to escalate" : noConsensus ? "no finding reached majority across independent passes" : "",
      preSignal: sig,
      // EVERY finding is reported, majority or not (never silently suppress).
      findings: voted,
    });
  }

  // ── the proposal artifact. At SHADOW this file IS the entire action.
  const date = new Date().toISOString().slice(0, 10);
  const relPath = `${TRIAGE_DIR}/${date}-triage.md`;
  const body = renderProposal({ date, rung, passes, proposals, deduped, escalated });
  await ctx.writeRepoFile(relPath, body);

  // Record the fingerprints we triaged so the next run dedupes against them.
  const nextState: TriagedState = { ...state };
  for (const p of proposals) {
    const sig = p.preSignal as PreSignal;
    nextState[sig.fingerprint] = {
      issue: p.issue as number,
      at: new Date().toISOString(),
      labels: (p.findings as VotedFinding[]).filter((f) => f.kind === "LABEL" && f.majority).map((f) => f.value),
    };
  }
  await ctx.writeRepoFile(TRIAGED_STATE, JSON.stringify(nextState, null, 2));

  // ── attest. The verdict here is JUDGMENT-ONLY (prose reasoning over an issue, no
  // external oracle), so per core/comb/attest.go it lands pending-cosign and never
  // reaches the weights un-vouched. That is the anti-collapse filter working as designed:
  // triage becomes training data only once a human (or a host-API oracle) confirms it.
  await ctx.comb
    .put({
      content: body,
      branch: "oss",
      author: `${ctx.manifest.name}/queen/root`,
      verifier: `${ctx.manifest.name}/worker/verifier-1`,
      trust: 0, // judgment-only → below floor by construction → pending cosign
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: true,
    smoke: false,
    rung,
    passes,
    // At any rung below `act`, this agent takes ZERO host actions. It never has a token.
    actions_taken: 0,
    proposal: relPath,
    triaged: proposals.length,
    deduped,
    escalated,
    governedRuns,
    notPorted: ["live `gh issue list` ingestion (v1 reads a feed)", "label application (host-drone owns the token)"],
  };
});

function renderProposal(a: {
  date: string;
  rung: string;
  passes: number;
  proposals: Record<string, unknown>[];
  deduped: number;
  escalated: number;
}): string {
  const lines: string[] = [
    `# Issue triage proposal — ${a.date}`,
    ``,
    `> **Rung: \`${a.rung}\`.** At \`shadow\` this document is the entire action: no label was`,
    `> applied, no comment posted. The host-drone applies a proposal only at the rung the`,
    `> \`issue-label\` domain has earned.`,
    ``,
    `Independent passes per issue: **${a.passes}** (majority vote; no self-reflection).`,
    `Deduped against prior triage: **${a.deduped}**. Escalated to a human: **${a.escalated}**.`,
    ``,
    `Generated by an AI agent (\`issue-triage\`). Findings below carry the fraction of`,
    `independent passes that agreed. Sub-majority findings are shown, not hidden.`,
    ``,
  ];
  for (const p of a.proposals) {
    const findings = (p.findings ?? []) as VotedFinding[];
    lines.push(`## #${p.issue} — ${p.title}`, ``);
    if (p.escalate) lines.push(`**ESCALATED to a human.** ${p.reason}`, ``);
    if (findings.length === 0) {
      lines.push(`_No findings._`, ``);
      continue;
    }
    lines.push(`| finding | value | confidence | majority | reason |`, `|---|---|---|---|---|`);
    for (const f of findings) {
      lines.push(`| ${f.kind} | \`${f.value}\` | ${f.votes}/${f.passes} (${Math.round(f.confidence * 100)}%) | ${f.majority ? "yes" : "no"} | ${f.reason} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
