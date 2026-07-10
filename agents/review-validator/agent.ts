// Agix Review Validator — the DISTINCT verifier between a proposal and the code host.
//
// WHY THIS IS THE MOST IMPORTANT AGENT IN THE PACK. The verified field brief
// (research/notes/2026-07-09-agentic-pr-review-loops-research.md) is unambiguous: what
// separates a reviewer maintainers trust from one they mute is not the finder, it is the
// SUPPRESSOR. Cursor Bugbot stacks three: a separate validator model, a category filter,
// and dedupe against findings posted in previous runs. Datadog reports the tuning law that
// makes this necessary — prompts tuned to catch true positives misclassify more false ones,
// and vice versa — so the finder should hunt and the validator should refute, and neither
// should try to do both. curl quantifies the cost of getting it wrong: AI-era security
// report confirmation collapsed from >15% to <5%, and one bad report burns hours of a
// maintainer's life.
//
// THE THREE STAGES, in order, cheapest first:
//   1. CATEGORY FILTER — drop whole classes nobody wants (compiler warnings, doc nits).
//      Deterministic, free, and it never sees a model.
//   2. DEDUPE vs previously-posted findings — this is also the follow-up-commit strategy:
//      a finding already posted must not be posted again when the branch moves.
//   3. VALIDATOR PASSES — several INDEPENDENT lenses (correctness, reproducibility,
//      duplication), each trying to REFUTE. A majority refutation kills the finding.
//
// PERSPECTIVE-DIVERSE, NOT REDUNDANT. Each lens judges one axis and is blind to the others.
// Three identical skeptics agree with each other; three different lenses catch failure modes
// redundancy cannot. And per CR-Bench, no lens ever critiques its own output — self-reflection
// collapses signal-to-noise on small models, and this fleet runs on local qwen.
//
// DEFAULT TO REFUTED. An uncertain finding is noise. Dropping a real finding costs one bug;
// posting a confident wrong one costs a maintainer's trust, which does not come back.
//
// actor != verifier IS ENFORCED HERE, not assumed: a proposal whose author is this agent is
// REFUSED outright. A self-certified finding is not certified.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const VALIDATION_DIR = "wiki/oss-steward/validation";
const STATE_DIR = "wiki/oss-steward/state";
const POSTED_STATE = `${STATE_DIR}/posted.json`;

/** The independent lenses. Each pass judges exactly one and is blind to the rest. */
export const LENSES = ["correctness", "reproducibility", "duplication"] as const;
export type Lens = (typeof LENSES)[number];

/** Finding categories the fleet never posts, whatever a finder says. Deterministic, free,
 *  and applied before any model runs (Bugbot filters "unwanted categories" the same way). */
export const FILTERED_CATEGORIES = new Set([
  "compiler-warning",
  "documentation-nit",
  "style",
  "formatting",
  "typo",
]);

export interface Finding {
  /** Stable identity for dedupe across runs: file+line+rule, or an issue/PR ref. */
  id: string;
  /** The agent that produced it. If it equals this agent, validation is refused. */
  author: string;
  category: string;
  claim: string;
  /** file:line or an issue link the claim rests on. */
  evidence?: string;
}

export interface LensVote {
  lens: Lens;
  refuted: boolean;
  confidence: number;
  reason: string;
}

export type Outcome = "upheld" | "refuted" | "filtered" | "duplicate" | "self-authored";

export interface Verdict {
  id: string;
  outcome: Outcome;
  /** Mean confidence across the lenses that voted. 0 when no lens ran. */
  confidence: number;
  votes: LensVote[];
  reason: string;
  /** True only when the finding may proceed to the host-drone. */
  validated: boolean;
}

/** parseVote reads one lens pass. A malformed line is a REFUTATION, not an abstention:
 *  a validator that cannot state its verdict has not upheld anything. */
export function parseVote(lens: Lens, text: string): LensVote {
  for (const raw of (text ?? "").split("\n")) {
    const p = raw.split("|").map((s) => s.trim());
    if (p.length < 3 || p[0].toUpperCase() !== "VERDICT") continue;
    const word = (p[1] ?? "").toLowerCase();
    if (word !== "refuted" && word !== "upheld") continue;
    const conf = Number(p[2]);
    return {
      lens,
      refuted: word === "refuted",
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
      reason: p[3] ?? "",
    };
  }
  return { lens, refuted: true, confidence: 0, reason: "no parsable verdict — treated as refuted" };
}

/** tally applies the majority-refutation rule. A finding survives only when FEWER THAN half
 *  the lenses refute it — ties kill, because uncertainty defaults to refuted. */
export function tally(votes: LensVote[]): { refuted: boolean; confidence: number } {
  if (votes.length === 0) return { refuted: true, confidence: 0 };
  const refutes = votes.filter((v) => v.refuted).length;
  const refuted = refutes * 2 >= votes.length; // ties kill
  const mean = votes.reduce((a, v) => a + v.confidence, 0) / votes.length;
  return { refuted, confidence: Number(mean.toFixed(3)) };
}

/** screen applies the two FREE stages before any inference is spent. Returns a terminal
 *  outcome when the finding is already decided, or null when it must go to the lenses. */
export function screen(f: Finding, self: string, posted: Set<string>): Verdict | null {
  if (f.author === self) {
    return { id: f.id, outcome: "self-authored", confidence: 0, votes: [], validated: false,
      reason: "actor != verifier: this agent authored the finding and may not certify it" };
  }
  if (FILTERED_CATEGORIES.has(f.category)) {
    return { id: f.id, outcome: "filtered", confidence: 0, votes: [], validated: false,
      reason: `category "${f.category}" is never posted` };
  }
  if (posted.has(f.id)) {
    return { id: f.id, outcome: "duplicate", confidence: 0, votes: [], validated: false,
      reason: "already posted in a previous run" };
  }
  return null;
}

interface PostedState { [id: string]: { at: string } }

async function readPosted(ctx: AgentContext): Promise<Set<string>> {
  const raw = await ctx.readRepoFile(POSTED_STATE);
  if (!raw) return new Set();
  try {
    return new Set(Object.keys(JSON.parse(raw) as PostedState));
  } catch {
    ctx.log("posted-state unreadable; treating everything as new");
    return new Set();
  }
}

async function loadFindings(ctx: AgentContext): Promise<Finding[]> {
  const path = String(ctx.input.flags.findings ?? "").trim();
  if (!path) return [];
  const raw = await ctx.readRepoFile(path);
  if (!raw) throw new Error(`review-validator: findings file not found: ${path}`);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("review-validator: findings must be a JSON array");
  return parsed as Finding[];
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the governed validation surface is reachable");
    return { ok: true, smoke: true, verifier: r.verifierActor, validated: 0 };
  }

  const self = ctx.manifest.name;
  const posted = await readPosted(ctx);
  const findings = await loadFindings(ctx);

  const verdicts: Verdict[] = [];
  let governedRuns = 0;

  for (const f of findings) {
    // Stages 1 + 2 are free and deterministic. Never pay a model for a finding that a set
    // lookup can decide.
    const early = screen(f, self, posted);
    if (early) {
      verdicts.push(early);
      ctx.log(`${early.outcome}: ${f.id} — ${early.reason}`);
      continue;
    }

    // Stage 3: independent lenses, each blind to the others, each trying to refute.
    const votes = await Promise.all(
      LENSES.map(async (lens) => {
        const r = await ctx.hive.run(
          [
            `Try to REFUTE this finding through the ${lens} lens ONLY. Default to refuted if uncertain.`,
            ``,
            `claim:    ${f.claim}`,
            `category: ${f.category}`,
            `evidence: ${f.evidence ?? "(none cited)"}`,
            ``,
            `Judge only ${lens}. Do not reason about the other lenses.`,
          ].join("\n"),
        );
        return parseVote(lens, r.answer);
      }),
    );
    governedRuns += votes.length;

    const { refuted, confidence } = tally(votes);
    verdicts.push({
      id: f.id,
      outcome: refuted ? "refuted" : "upheld",
      confidence,
      votes,
      validated: !refuted,
      reason: refuted
        ? `${votes.filter((v) => v.refuted).length}/${votes.length} lenses refuted (ties kill)`
        : `${votes.filter((v) => !v.refuted).length}/${votes.length} lenses upheld`,
    });
  }

  // Record what we UPHELD, so the next run dedupes against it. Refuted findings are NOT
  // recorded: a refutation is not a posting, and re-examining one later is legitimate.
  const upheld = verdicts.filter((v) => v.validated);
  if (upheld.length) {
    const next: PostedState = {};
    for (const id of posted) next[id] = { at: "prior" };
    for (const v of upheld) next[v.id] = { at: new Date().toISOString() };
    await ctx.writeRepoFile(POSTED_STATE, JSON.stringify(next, null, 2));
  }

  const date = new Date().toISOString().slice(0, 10);
  const relPath = `${VALIDATION_DIR}/${date}-validation.md`;
  await ctx.writeRepoFile(relPath, render(date, verdicts));

  return {
    ok: true,
    smoke: false,
    // Only these may reach host-drone, and only at the rung their domain has earned.
    validated: upheld.length,
    refuted: verdicts.filter((v) => v.outcome === "refuted").length,
    filtered: verdicts.filter((v) => v.outcome === "filtered").length,
    duplicates: verdicts.filter((v) => v.outcome === "duplicate").length,
    selfAuthored: verdicts.filter((v) => v.outcome === "self-authored").length,
    governedRuns,
    report: relPath,
  };
});

function render(date: string, verdicts: Verdict[]): string {
  const lines = [
    `# Validation — ${date}`,
    ``,
    `Upheld: **${verdicts.filter((v) => v.validated).length}** · ` +
      `Refuted: **${verdicts.filter((v) => v.outcome === "refuted").length}** · ` +
      `Filtered: **${verdicts.filter((v) => v.outcome === "filtered").length}** · ` +
      `Duplicate: **${verdicts.filter((v) => v.outcome === "duplicate").length}**`,
    ``,
    `Each finding is judged by independent lenses (${LENSES.join(", ")}), each trying to`,
    `refute it. A majority refutation kills the finding, and ties kill: uncertainty defaults`,
    `to refuted. Only upheld findings may reach the code host, and only at the autonomy rung`,
    `their domain has earned.`,
    ``,
    `| finding | outcome | confidence | reason |`,
    `|---|---|---|---|`,
  ];
  for (const v of verdicts) {
    lines.push(`| \`${v.id}\` | ${v.outcome} | ${v.confidence} | ${v.reason} |`);
  }
  return lines.join("\n") + "\n";
}
