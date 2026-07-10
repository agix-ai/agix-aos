// Agix Context Warden — session-health advisor (worker / proposer caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer →
// worker caste, model tiering worker=haiku/verifier=sonnet, the boundary write=only
// wiki/context-warden/, deny git push/commit + agent.mjs, tools include a DRY-RUN
// notify capability — least privilege, no secret — public=true) lives in the sibling
// agent.json, which the Go engine reads.
//
// Thesis (CONTEXT_MANAGER_RESEARCH_AND_SPEC.md): hallucination is substantially a
// CONTEXT failure — models degrade before the window fills, driven by OBSERVABLE
// conditions — so a watcher can warn the human before the model loses the thread.
// The denominator is the model's EFFECTIVE length (NoLiMa/RULER), not the advertised
// window.
//
// Two layers (narrator pattern), preserved from the Node agent:
//   LEADING  (cheap, ALWAYS-ON, deterministic): occupancy vs effective length,
//     repetition, distractor/duplication density, growth velocity, a cheap
//     override-marker contradiction screen. Pure TS — NOT intelligence, so it stays
//     a local computation (analyzeContext), exactly as the unit-tested Node core did.
//   TRAILING (cost-gated): the LLM contradiction/clash check. This is the ONE unit of
//     intelligence, so it is delegated to the GOVERNED hive (ctx.hive.run → the Go
//     swarm; a DISTINCT verifier certifies — actor≠verifier). It fires ONLY when the
//     leading signals are hot (a green context short-circuits before any $ is spent —
//     the cost-discipline core truth), so a healthy audit runs zero governed passes.
//
// WIRED (parity closed now that the seams exist):
//   - The `notification` output (legacy kind: notification, channel: all, when:
//     degradation_risk_high). The notify seam now exists (ctx.notify — the
//     orchestration twin of the Go core/tool/email tool), so a COMPACT-tier audit
//     (the degradation_risk_high condition) pushes a critical alert carrying tier +
//     occupancy% + top flags. DRY-RUN by default (recorded, not sent — a $0/offline
//     run exercises the seam with no credential or network). AMBER and GREEN push
//     NOTHING: a healthy audit stays silent, preserving the zero-spend short-circuit.
//
// ROADMAP — NOT PORTED (flagged honestly; needs a seam the contract does not express):
//   - Autonomous mode (opt-in direct compaction/prune/offload on the WATCHED session).
//     A real actuator that MUTATES a live external session cannot be exercised
//     $0/offline and has no clean contract seam (the platform context ACTUATORS —
//     compaction/context-edit/memory — are not something the reborn runtime exposes,
//     and inventing a fake session-mutation seam would be dishonest). So this stays an
//     explicit roadmap item: it needs a runtime session-actuator seam that does not
//     exist and cannot be validated offline. This port is faithful to the legacy
//     DEFAULT (autonomous=false): the warden is a PROPOSER — it warns + recommends +
//     now ALERTS, but never acts on the session itself.
//   - The out-of-band live sidecar / per-call interceptor (an admission-hook-style
//     runtime interceptor). On-demand audit is ported; the interceptor is the
//     runtime-integration follow-on the Node agent already called out as unbuilt.
//   - Arbitrary ABSOLUTE session-file paths via --input. Reduced to a repo-relative
//     --input flag (bounded by boundary.read) + inline --text, since a worker reads
//     through the repo-root seam, not the raw fs.
//   - PLANNED-but-never-computed signals (critical-fact position / lost-in-the-middle,
//     grounding similarity) were documented-only in the Node agent too; not added here.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const AUDITS_DIR = "wiki/context-warden/audits";
const EFF_LENGTH_TABLE = "agents/context-warden/effective-length.json";
// Fallback when the effective-length table is unreadable — conservative (small
// effective length ⇒ warns sooner). UNDERCOUNTING occupancy is the unsafe direction
// for a watchdog, so bias toward warning.
const DEFAULT_TABLE: EffTable = { default: { effective: 8000, advertised: 128000 } };
// Bands as fractions of EFFECTIVE length (ported from manifest.yaml defaults).
const WARN_AT = 0.5; // amber
const COMPACT_AT = 0.8; // recommend compaction

interface EffEntry {
  effective: number;
  advertised: number;
}
interface EffTable {
  default: EffEntry;
  models?: Record<string, EffEntry>;
}

interface Analysis {
  modelId: string;
  tokens: number;
  effective: number;
  advertised: number;
  occupancyPct: number;
  advertisedPct: number;
  repetitionRate: number;
  distractorRatio: number;
  contradictionMarkers: number;
  growthVelocity: number | null;
  flags: string[];
  tier: "green" | "amber" | "compact";
  recommendations: string[];
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const date = isoDate();
  const modelId = typeof ctx.input.flags.model === "string" ? ctx.input.flags.model : (ctx.manifest.models?.worker?.[0] ?? "default");

  // ── Smoke: exercise BOTH surfaces the Node smoke contract exercised — the
  // deterministic analysis AND one $0 governed pass — then short-circuit. ────────
  if (ctx.smoke) {
    const a = analyzeContext("hello world ".repeat(50), null, modelId, DEFAULT_TABLE);
    const r = await ctx.hive.run("smoke: confirm the contradiction/clash trailing surface is live");
    ctx.log(`smoke short-circuit · analysis (tier=${a.tier}) + governed surface verified`, { verifier: r.verifierActor });
    return { ok: true, smoke: true, tier: a.tier, verifier: r.verifierActor };
  }

  // ── 1. Acquire the context/session to audit (inline --text, else a repo-relative
  //       --input file bounded by boundary.read). ────────────────────────────────
  const text = await acquireContext(ctx);
  if (!text) {
    ctx.log("no context to audit (pass one as --text or a repo-relative --input <file>)");
    return { ok: false, reason: "no-context" };
  }

  // ── 2. Load the refreshable effective-length table (DATA, never hard-coded). ────
  const table = await loadEffTable(ctx);

  // ── 3. LEADING signals — pure, deterministic, ALWAYS-ON (no model, no $). ───────
  const a = analyzeContext(text, null, modelId, table);

  // ── 4. TRAILING — the ONE governed unit, cost-gated to hot leading signals. A
  //       green context spends ZERO $ (the cost-discipline core truth). ───────────
  let trailing: string | null = null;
  let verifier: string | null = null;
  let queen: string | null = null;
  let verified = true; // a healthy (green) deterministic audit is authoritative on its own
  let costUSD = 0;
  if (a.tier !== "green") {
    const r = await ctx.hive.run(
      `Does the following context contain internal contradictions or a fact that is later overridden ` +
        `(a "context clash / poisoning" risk)? Answer in 2-3 lines, citing the conflict if any. ` +
        `A faithfulness flag means "verify", never "this is false".\n\n${text.slice(0, 12000)}`,
    );
    trailing = r.answer;
    verifier = r.verifierActor;
    queen = r.queenActor;
    verified = r.verified;
    costUSD = r.cost.usd;
  }

  // ── 4b. HIGH-RISK ALERT — the degradation_risk_high condition (compact tier)
  //       pushes a critical warning through the GOVERNED notify seam (ctx.notify, the
  //       orchestration twin of the Go core/tool/email tool). DRY-RUN by default
  //       (recorded, not sent) — a $0/offline run exercises the seam with no
  //       credential or network. AMBER (soft "approaching") and GREEN alert NOTHING:
  //       a healthy audit stays silent, preserving the zero-spend short-circuit. The
  //       body carries only SIGNALS + classifications (tier, occupancy%, flags), never
  //       raw session content — the warden never echoes sensitive context. Additive:
  //       the alert never fails the audit. ──────────────────────────────────────────
  let notified = false;
  if (a.tier === "compact") {
    const alertBody =
      `Session context is at ${Math.round(a.occupancyPct * 100)}% of ${a.modelId}'s EFFECTIVE length ` +
      `(${a.effective} tok reliable, not the advertised ${a.advertised}) — tier: compact. ` +
      `Flags: ${a.flags.join(", ") || "occupancy"}. This is the degradation zone: reliability drops before ` +
      `the window fills. Operator action: compact now — pin critical facts (decisions, open items, task ` +
      `spec) first, clear the oldest tool results, or switch to a fresh session. ${a.recommendations[0] ?? ""}`.trim();
    try {
      const r = await ctx.notify({
        channel: "context-alert",
        level: "critical",
        title: "Context degradation risk HIGH — time to compact / switch sessions",
        body: alertBody,
        to: "operator",
      });
      notified = r.sent || r.queued;
      ctx.log(`DEGRADATION-RISK-HIGH — alert ${r.sent ? "sent" : "queued"} (mode=${r.mode}); operator action: compact or switch sessions`);
    } catch (e) {
      ctx.log(`degradation alert skipped: ${(e as Error).message}`);
    }
  }

  // ── 5. Write the audit report (best-effort, bounded by boundary.write). A
  //       read-only runtime must not crash the audit — the verdict is in the return. ─
  const report = renderReport(date, a, trailing);
  let reportPath: string | null = `${AUDITS_DIR}/${date}.md`;
  try {
    await ctx.writeRepoFile(reportPath, report);
  } catch (e) {
    ctx.log(`audit write skipped: ${(e as Error).message}`);
    reportPath = null;
  }

  // ── 6. Feed the hive — record the audit as an attested Comb leaf, but ONLY when a
  //       governed pass produced a DISTINCT verifier. A green audit has no verifier
  //       (no governed pass ran), so it grows no attested memory. Honest. ──────────
  if (verifier && queen && verifier !== queen) {
    await ctx.comb
      .put({
        content: `context-warden/${a.tier} ${date}: ${Math.round(a.occupancyPct * 100)}% of effective length (model ${a.modelId}), flags: ${a.flags.join(", ") || "none"} — ${(trailing ?? "").slice(0, 300)}`,
        branch: "knowledge", // TOGAF Knowledge Architecture — session-health knowledge
        author: queen,
        verifier,
        trust: a.tier === "compact" ? 0.8 : 0.6,
      })
      .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
  }

  // Proposer: warn + recommend, never act.
  ctx.log(`context-warden: ${a.tier} · ${Math.round(a.occupancyPct * 100)}% of effective length · flags: ${a.flags.join(", ") || "none"}`);
  for (const rec of a.recommendations) ctx.log(`  → ${rec}`);

  return {
    ok: verified,
    audited: true,
    tier: a.tier,
    occupancyPct: a.occupancyPct,
    flags: a.flags,
    recommendations: a.recommendations,
    trailingChecked: a.tier !== "green",
    verifier: verifier ?? null,
    reportPath,
    costUSD,
    // Proposer: the compact-tier degradation_risk_high warning was pushed through the
    // governed notify seam (dry-run by default). green/amber alert nothing.
    notified,
    // Honest, explicit roadmap: autonomous session-mutation (direct compaction/prune/
    // offload on the WATCHED session) needs a runtime session-actuator seam that does
    // not exist and cannot be validated $0/offline. The warden warns + recommends +
    // alerts; it never acts on the session itself.
    roadmap: ["autonomous-session-mutation"],
  };
});

// ── Input acquisition ──────────────────────────────────────────────────────────
async function acquireContext(ctx: AgentContext): Promise<string> {
  const text = ctx.input.text.trim();
  if (text) return text;
  const inputFlag = typeof ctx.input.flags.input === "string" ? ctx.input.flags.input : "";
  if (inputFlag) {
    const body = await ctx.readRepoFile(inputFlag);
    if (body) {
      ctx.log(`auditing context from --input`, { file: inputFlag });
      return body;
    }
    ctx.log(`--input file not found under repo root`, { file: inputFlag });
  }
  return "";
}

async function loadEffTable(ctx: AgentContext): Promise<EffTable> {
  const raw = await ctx.readRepoFile(EFF_LENGTH_TABLE);
  if (!raw) return DEFAULT_TABLE;
  try {
    const t = JSON.parse(raw) as EffTable;
    if (!t.default) t.default = DEFAULT_TABLE.default;
    return t;
  } catch {
    return DEFAULT_TABLE;
  }
}

// ─── LEADING signals — pure, deterministic, unit-testable (the testable core, ported
//     verbatim from agents/context-warden/agent.mjs analyzeContext). ──────────────
export function analyzeContext(text: string, turns: string[] | null, modelId: string, table: EffTable): Analysis {
  const eff = table.models?.[modelId] || table.default || { effective: 8000, advertised: 128000 };
  const tokens = estimateTokens(text);
  const occupancyPct = +(tokens / eff.effective).toFixed(3);
  const advertisedPct = +(tokens / eff.advertised).toFixed(3);

  const repetitionRate = ngramRepetition(text, 3);
  const distractorRatio = duplicateLineRatio(text);
  const contradictionMarkers = countContradictionMarkers(text);
  const growthVelocity = Array.isArray(turns) && turns.length > 1 ? Math.round(estimateTokens(turns.join("\n")) / turns.length) : null;

  const flags: string[] = [];
  if (occupancyPct >= COMPACT_AT) flags.push("over-effective-length"); // hard
  else if (occupancyPct >= WARN_AT) flags.push("approaching-effective-length"); // soft
  if (repetitionRate >= 0.5) flags.push("repetition-loop"); // "losing the thread"
  if (distractorRatio >= 0.3) flags.push("distractor-duplication");
  // Deterministic, ALWAYS-ON contradiction screen: a poisoned LOW-occupancy context
  // stays green and never reaches the cost-gated LLM check, yet superseded/contradictory
  // facts are THE destabilizer. Catch the common override markers cheaply here.
  if (contradictionMarkers > 0) flags.push("contradiction-suspected");
  if (growthVelocity && growthVelocity > eff.effective * 0.25) flags.push("high-growth-velocity");

  const hard = flags.some((f) => ["over-effective-length", "repetition-loop"].includes(f));
  const tier: Analysis["tier"] = hard || occupancyPct >= COMPACT_AT ? "compact" : flags.length || occupancyPct >= WARN_AT ? "amber" : "green";

  return {
    modelId,
    tokens,
    effective: eff.effective,
    advertised: eff.advertised,
    occupancyPct,
    advertisedPct,
    repetitionRate,
    distractorRatio,
    contradictionMarkers,
    growthVelocity,
    flags,
    tier,
    recommendations: recommend(flags, tier),
  };
}

// Deterministic contradiction screen — counts OVERRIDE/supersede markers that signal a
// fact was later changed (the "context clash/poisoning" pattern). A cheap leading proxy
// for the cost-gated LLM contradiction check; never a substitute for it.
function countContradictionMarkers(s: string): number {
  const re = /\b(supersed(?:e|es|ed|ing)|rotated to|migrated to|updated to|changed to|corrected to|revised to|no longer\b|actually,? it'?s|scratch that|disregard the (?:above|previous)|overrid(?:e|es|den)|now (?:set to|uses|points to)|was .{1,40}? now)\b/gi;
  return (String(s).match(re) || []).length;
}

function estimateTokens(s: string): number {
  // chars/token varies: English prose ~4, code/JSON ~3, CJK ~1. UNDERCOUNTING is the
  // unsafe direction for a watchdog (it under-warns), so bias conservative + handle
  // dense content.
  s = s || "";
  if (!s) return 0;
  const cjk = (s.match(/[　-鿿가-힯豈-﫿]/g) || []).length; // ~1 token/char
  const rest = s.length - cjk;
  const punct = (s.match(/[{}[\]<>;:=,"'`/\\|]/g) || []).length;
  const dense = rest > 0 && punct / rest > 0.05; // JSON/code/markup → denser tokenization
  const divisor = dense ? 3.0 : 3.6; // conservative vs the naive 4
  return Math.ceil(rest / divisor) + cjk;
}

function ngramRepetition(s: string, n: number): number {
  const toks = String(s).toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length < n * 2) return 0;
  const grams: string[] = [];
  for (let i = 0; i + n <= toks.length; i++) grams.push(toks.slice(i, i + n).join(" "));
  return +(1 - new Set(grams).size / grams.length).toFixed(3);
}

function duplicateLineRatio(s: string): number {
  const lines = String(s)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 8);
  if (lines.length < 4) return 0;
  return +(1 - new Set(lines).size / lines.length).toFixed(3);
}

function recommend(flags: string[], tier: string): string[] {
  const r: string[] = [];
  if (flags.includes("over-effective-length") || tier === "compact")
    r.push("Compact: pin critical facts (decisions, open items, task spec) first, then clear oldest tool results — compact early, before the window fills.");
  if (flags.includes("approaching-effective-length"))
    r.push("Approaching effective length — prepare to compact; flag any single tool output that is a large fraction of the window.");
  if (flags.includes("repetition-loop"))
    r.push('Repetition detected (a "losing the thread" signal) — re-anchor the task + key constraints to the END of the context, or spawn a fresh sub-agent.');
  if (flags.includes("distractor-duplication"))
    r.push("High duplication/distractors — prune duplicates and low-relevance tool results; re-rank rather than append.");
  if (flags.includes("high-growth-velocity"))
    r.push("Context growing fast — offload bulky outputs to the memory tier and keep references (just-in-time retrieval).");
  if (flags.includes("contradiction-suspected"))
    r.push("Possible superseded/contradictory facts (override markers detected) — the empirically biggest reliability risk. Verify which value is CURRENT and pin the authoritative one; consider the LLM contradiction check.");
  if (!r.length) r.push("Healthy — context occupancy and hygiene are within reliable bounds.");
  return r;
}

function renderReport(date: string, a: Analysis, trailing: string | null): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const badge = a.tier === "green" ? "green" : a.tier === "amber" ? "amber" : "compact";
  const lines = [
    `# Context Warden audit — ${date}`,
    "",
    `**Tier: ${badge}** · ${a.tokens} tokens ≈ **${pct(a.occupancyPct)} of effective length** (${a.effective}, model ${a.modelId}) · ${pct(a.advertisedPct)} of advertised`,
    "",
    "## Leading signals",
    "",
    `| signal | value |`,
    `|---|---|`,
    `| occupancy (of effective length) | ${pct(a.occupancyPct)} |`,
    `| repetition rate | ${pct(a.repetitionRate)} |`,
    `| duplication/distractor ratio | ${pct(a.distractorRatio)} |`,
    `| growth velocity | ${a.growthVelocity ?? "n/a"} tok/turn |`,
    `| flags | ${a.flags.join(", ") || "none"} |`,
    "",
    "## Recommendations (proposer — not auto-applied)",
    "",
    ...a.recommendations.map((r) => `- ${r}`),
    "",
  ];
  if (trailing) {
    lines.push(
      "## Trailing check — contradiction/clash (cost-gated, governed)",
      "",
      `> faithfulness flags mean "verify", not "false".`,
      "",
      trailing,
      "",
    );
  }
  return lines.join("\n");
}
