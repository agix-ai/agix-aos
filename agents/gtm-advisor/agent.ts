// Agix GTM Advisor — the launch-tiering + go-to-market gate above the dev loop,
// reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer →
// worker caste, model tiering worker=sonnet / verifier=haiku, the guard-bee
// boundary that writes only wiki/gtm-advisor/ and denies deploy/publish/push, and
// public=true) lives in the sibling agent.json, read by the Go engine.
//
// The launch-tiering CORE is deterministic and pure — it runs with no API key and
// no network, exactly as in the Node original:
//   assignTier(release)               → Tier 0-4 from the change shape.
//   tierMatchesBump(tier, bump)       → M1: the tier must match the version bump.
//   evaluateGtmReadiness(checklist)   → M2: positioning / pricing / messaging / enablement.
//   evaluateSalesSupportReadiness(cl) → M3: sales + support readiness.
//   checkLaunchSync(plan)             → M4: marketing fires on the release/GA calendar.
// The four gate VERDICTS (GO/RECYCLE/HOLD) — including the Tier 0/1 human co-sign
// routing — are computed deterministically here (the actor's proposal).
//
// The ONE unit of intelligence the Node agent had was the positioning/messaging
// draft (runtime.getModel().chat()). It is mapped to a single GOVERNED pass
// (ctx.hive.run): the Go swarm drafts the positioning AND certifies it through a
// DISTINCT verifier (actor≠verifier), so the launch record the agent writes to the
// Comb is attested, not self-graded. The deterministic verdicts stand with or
// without that draft — the narrator pattern is preserved.
//
// NOT PORTED (faithful reduction — flagged honestly, mirrors mentor's notes):
//   - The cursor `state` output (runtime.writeState('cursor', …)): the reborn
//     AgentContext exposes no state seam. The last-run summary is folded into the
//     dated report + the attested Comb launch leaf instead. The manifest still
//     DECLARES the state output as intent.
//   - The granular append-only audit-ledger stream (lib/agix-audit-ledger.mjs
//     emitted a separate `gate_decision` + `verdict` + `launch` entry, each with an
//     entry_id, via runtime.getLedger()). That Node substrate is reduced to ONE
//     attested Comb leaf (the launch record) certified by the governed run's
//     distinct verifier; the per-gate verdict rows still appear in the report.
//   - Non-behavioral telemetry hooks (runtime.recordDecision / recordFileWritten)
//     have no seam in the reborn context and are dropped.
//
// Spec / persona: agents/gtm-advisor/PERSONA.md
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REPORT_DIR = "wiki/gtm-advisor";

// The five launch tiers (T-shirt sizing) and the version bump each maps to.
// Tier 0 company-defining → Tier 4 technical update; "maps 1:1 to release type".
const BUMP_TO_TIERS: Record<string, ReadonlySet<number>> = {
  MAJOR: new Set([0, 1]),
  MINOR: new Set([2, 3]),
  PATCH: new Set([3, 4]),
};

// The three readiness checklists (RELEASE_GTM §2.3). Fixed dimension sets.
const GTM_READINESS_DIMENSIONS = ["positioning", "pricing", "messaging", "enablement"] as const;
const SALES_SUPPORT_DIMENSIONS = ["salesTraining", "supportRunbook", "faq", "escalationPath"] as const;

// Stage-Gate verdicts (LOOP_ENGINEERED_SDLC §2) — richer than pass/fail.
const VERDICT = { GO: "GO", KILL: "KILL", HOLD: "HOLD", RECYCLE: "RECYCLE" } as const;
type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

// ── Input shapes ─────────────────────────────────────────────────────────
interface Release {
  bump?: string;
  marketDefining?: boolean;
  majorLaunch?: boolean;
  marketExpansion?: boolean;
  cxUpdate?: boolean;
}
interface LaunchSyncPlan {
  releaseDate?: string;
  marketingDate?: string;
  embargoLiftDate?: string;
  toleranceDays?: number;
}
interface LaunchInput {
  launchId?: string;
  release: Release;
  gtmReadiness: Record<string, boolean>;
  salesSupport: Record<string, boolean>;
  launchSync: LaunchSyncPlan;
}

// ── Pure core 1: launch-tier assignment ──────────────────────────────────
interface TierDecision {
  tier: number;
  bump: string;
  reason: string;
}
function assignTier(release: Release = {}): TierDecision {
  const bump = normalizeBump(release.bump);
  let tier: number;
  const reasons: string[] = [];
  if (release.marketDefining) { tier = 0; reasons.push("company-defining launch"); }
  else if (bump === "MAJOR" || release.majorLaunch) { tier = 1; reasons.push("major launch"); }
  else if (release.marketExpansion) { tier = 2; reasons.push("market-expansion launch"); }
  else if (bump === "MINOR" || release.cxUpdate) { tier = 3; reasons.push("customer-experience update"); }
  else { tier = 4; reasons.push("technical update"); }
  return { tier, bump, reason: reasons.join("; ") };
}

// ── Pure core 2: M1 tier ↔ bump consistency ──────────────────────────────
interface TierMatch {
  matches: boolean;
  tier: number;
  bump: string;
  allowedTiers?: number[];
  reason: string;
}
function tierMatchesBump(tier: number, bump: string | undefined): TierMatch {
  const b = normalizeBump(bump);
  const allowed = BUMP_TO_TIERS[b];
  if (!allowed) return { matches: false, tier, bump: b, reason: `unknown bump "${bump}"` };
  const matches = allowed.has(tier);
  const allowedTiers = [...allowed];
  return {
    matches, tier, bump: b, allowedTiers,
    reason: matches
      ? `Tier ${tier} matches a ${b} bump`
      : `Tier ${tier} does not match a ${b} bump (a ${b} must be Tier ${allowedTiers.join("/")}) — a ${b} cannot ship as a Tier-${tier} launch`,
  };
}

// ── Pure core 3: M2 GTM readiness ────────────────────────────────────────
interface Readiness {
  complete: boolean;
  missing: string[];
  present: string[];
  reason: string;
}
function evaluateGtmReadiness(checklist: Record<string, boolean> = {}): Readiness {
  const missing = GTM_READINESS_DIMENSIONS.filter((d) => !checklist[d]);
  return {
    complete: missing.length === 0,
    missing,
    present: GTM_READINESS_DIMENSIONS.filter((d) => checklist[d]),
    reason: missing.length === 0 ? "GTM readiness complete" : `GTM gaps: ${missing.join(", ")}`,
  };
}

// ── Pure core 4: M3 sales & support readiness ────────────────────────────
function evaluateSalesSupportReadiness(checklist: Record<string, boolean> = {}): Readiness {
  const missing = SALES_SUPPORT_DIMENSIONS.filter((d) => !checklist[d]);
  return {
    complete: missing.length === 0,
    missing,
    present: SALES_SUPPORT_DIMENSIONS.filter((d) => checklist[d]),
    reason: missing.length === 0 ? "sales + support readiness complete" : `sales/support gaps: ${missing.join(", ")}`,
  };
}

// ── Pure core 5: M4 launch-sync ──────────────────────────────────────────
// Marketing must fire on the release/GA calendar; the embargo lift is the
// coordinated moment. All supplied dates must agree within `toleranceDays`.
interface LaunchSync {
  synced: boolean;
  problems?: string[];
  reason: string;
}
function checkLaunchSync(plan: LaunchSyncPlan = {}): LaunchSync {
  const tolerance = numOr(plan.toleranceDays, 0);
  const release = parseDate(plan.releaseDate);
  const marketing = parseDate(plan.marketingDate);
  if (!release || !marketing) {
    return { synced: false, reason: "missing/unparseable release or marketing date" };
  }
  const problems: string[] = [];
  const marketingGap = dayGap(release, marketing);
  if (Math.abs(marketingGap) > tolerance) problems.push(`marketing date ${plan.marketingDate} is ${marketingGap}d off the release date ${plan.releaseDate}`);
  if (plan.embargoLiftDate) {
    const embargo = parseDate(plan.embargoLiftDate);
    if (!embargo) problems.push(`unparseable embargoLiftDate ${plan.embargoLiftDate}`);
    else if (Math.abs(dayGap(release, embargo)) > tolerance) problems.push(`embargo lift ${plan.embargoLiftDate} is ${dayGap(release, embargo)}d off the release date`);
  }
  return { synced: problems.length === 0, problems, reason: problems.length === 0 ? "marketing + embargo aligned to the release calendar" : problems.join("; ") };
}

// ── Deterministic gate verdicts (M1–M4) ──────────────────────────────────
//
// The Node agent ran these through lib/agix-gate.mjs Gate objects (actor=gtm-advisor,
// verifiers=version-manager/release-manager). In the reborn contract the
// actor≠verifier CERTIFICATION is supplied by the governed run (ctx.hive.run), so
// this layer computes only the deterministic verdict logic (the actor's proposal).
// M1's Tier 0/1 human co-sign routing (buildTierGate's requiresHuman) is preserved:
// a matching Tier 0/1 is routed GO→HOLD, and any tier↔bump mismatch is a HOLD.
interface GateResult {
  gate: string;
  verdict: Verdict;
  reason: string;
  routedToHuman: boolean;
}
function evaluateGates(a: {
  tier: number;
  tierMatch: TierMatch;
  gtmReadiness: Readiness;
  salesSupport: Readiness;
  launchSync: LaunchSync;
}): { M1: GateResult; M2: GateResult; M3: GateResult; M4: GateResult } {
  const humanGated = a.tier === 0 || a.tier === 1;

  // M1 — tier ↔ bump. Mismatch → HOLD (escalate). Matching Tier 0/1 → GO routed to
  // HOLD (human co-sign). Matching Tier 2-4 → GO auto-clear.
  let m1: GateResult;
  if (!a.tierMatch.matches) {
    m1 = { gate: "M1-tier-assignment", verdict: VERDICT.HOLD, reason: a.tierMatch.reason, routedToHuman: humanGated };
  } else if (humanGated) {
    m1 = {
      gate: "M1-tier-assignment",
      verdict: VERDICT.HOLD,
      reason: `${a.tierMatch.reason} — Tier ${a.tier} launch requires human sign-off (requires human co-sign)`,
      routedToHuman: true,
    };
  } else {
    m1 = { gate: "M1-tier-assignment", verdict: VERDICT.GO, reason: a.tierMatch.reason, routedToHuman: false };
  }

  const m2: GateResult = a.gtmReadiness.complete
    ? { gate: "M2-gtm-readiness", verdict: VERDICT.GO, reason: a.gtmReadiness.reason, routedToHuman: false }
    : { gate: "M2-gtm-readiness", verdict: VERDICT.RECYCLE, reason: a.gtmReadiness.reason, routedToHuman: false };

  const m3: GateResult = a.salesSupport.complete
    ? { gate: "M3-sales-support", verdict: VERDICT.GO, reason: a.salesSupport.reason, routedToHuman: false }
    : { gate: "M3-sales-support", verdict: VERDICT.RECYCLE, reason: a.salesSupport.reason, routedToHuman: false };

  const m4: GateResult = a.launchSync.synced
    ? { gate: "M4-launch-sync", verdict: VERDICT.GO, reason: a.launchSync.reason, routedToHuman: false }
    : { gate: "M4-launch-sync", verdict: VERDICT.HOLD, reason: `launch off the calendar: ${a.launchSync.reason}`, routedToHuman: false };

  return { M1: m1, M2: m2, M3: m3, M4: m4 };
}

// ── The agent run ─────────────────────────────────────────────────────────
export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const date = isoDate();

  // Smoke short-circuit: exercise the governed surface once ($0), no report, no
  // Comb write. Mirrors the Node smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the launch-tiering + positioning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  // ── 1. Resolve the launch input (a --launchJson flag / JSON text, else canned) ─
  const input = resolveInput(ctx);

  // ── 2. Deterministic cores (pure, no key, no network) ────────────────────
  const tierDecision = assignTier(input.release);
  const tierMatch = tierMatchesBump(tierDecision.tier, input.release.bump);
  const gtmReadiness = evaluateGtmReadiness(input.gtmReadiness);
  const salesSupport = evaluateSalesSupportReadiness(input.salesSupport);
  const launchSync = checkLaunchSync(input.launchSync);

  // ── 3. Deterministic gate verdicts + overall + escalations ───────────────
  const gates = evaluateGates({ tier: tierDecision.tier, tierMatch, gtmReadiness, salesSupport, launchSync });
  const gateList = [gates.M1, gates.M2, gates.M3, gates.M4];
  const overall = worstVerdict(gateList.map((g) => g.verdict));
  const escalated = gateList.filter((g) => g.verdict === VERDICT.HOLD).map((g) => g.gate);

  // ── 4. ONE governed pass: draft positioning AND certify (actor≠verifier) ──
  // This is the Node runtime.getModel().chat() call, now GOVERNED. The distinct
  // verifier it returns is what attests the launch record below.
  const r = await ctx.hive.run(
    `Draft crisp positioning for a Tier ${tierDecision.tier} launch (${tierDecision.reason}). ` +
      `Release: ${JSON.stringify(input.release)}. Two to three sentences: who it is for and the one ` +
      `durable value. Buyer language, no insider jargon. No em dashes.`,
  );
  const positioning = r.answer?.trim() ? r.answer.trim() : cannedPositioning(tierDecision);

  ctx.log(
    `Tier ${tierDecision.tier} · ${gateList.map((g) => `${g.gate.split("-")[0]}=${g.verdict}`).join(" ")} · overall=${overall}` +
      (escalated.length ? ` · escalate: ${escalated.join(", ")}` : ""),
    { verifier: r.verifierActor },
  );

  // ── 5. Write the dated report (bounded by boundary.write = wiki/gtm-advisor/) ─
  const relPath = `${REPORT_DIR}/${date}.md`;
  const report = composeReport({
    date, tierDecision, tierMatch, gtmReadiness, salesSupport, launchSync,
    positioning, gates: gateList, overall, escalated, verifier: r.verifierActor,
  });
  try {
    await ctx.writeRepoFile(relPath, report);
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── 6. The launch record — an attested Comb leaf certified by the distinct
  //       verifier (the reduction of the Node append-only `launch` ledger entry) ─
  const launchId = safeId(input.launchId || `gtm-${date.replace(/-/g, "")}`);
  await ctx.comb
    .put({
      id: `gtm-launch-${launchId}`,
      content:
        `gtm/launch ${date}: Tier ${tierDecision.tier} ${tierMatch.bump} overall=${overall} ` +
        `tier_matches_bump=${tierMatch.matches}${escalated.length ? ` escalate=${escalated.join(",")}` : ""} — ${positioning.slice(0, 300)}`,
      branch: "business", // TOGAF Business Architecture — GTM/launch strategy lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: overall === VERDICT.GO ? 0.8 : 0.6,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    overall,
    tier: tierDecision.tier,
    bump: tierMatch.bump,
    tier_matches_bump: tierMatch.matches,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(gateList.map((g) => [g.gate.split("-")[0], g.verdict])),
    verifier: r.verifierActor,
    queen: r.queenActor,
    report: relPath,
    costUSD: r.cost.usd,
  };
});

// ── input resolution ──────────────────────────────────────────────────────
function resolveInput(ctx: AgentContext): LaunchInput {
  const flag = ctx.input.flags.launchJson;
  const fromFlag = typeof flag === "string" && flag.trim() ? flag.trim() : "";
  const text = ctx.input.text?.trim() ?? "";
  const fromText = text.startsWith("{") ? text : "";
  const raw = fromFlag || fromText;
  if (raw) {
    try {
      return { ...cannedInput(), ...(JSON.parse(raw) as Partial<LaunchInput>) } as LaunchInput;
    } catch {
      /* fall through to canned */
    }
  }
  return cannedInput();
}

// A canned sample launch: a MINOR release correctly assigned Tier 3 with readiness
// complete + marketing on the calendar → a clean set of GO verdicts.
function cannedInput(): LaunchInput {
  return {
    launchId: "gtm-sample",
    release: { bump: "MINOR", cxUpdate: true },
    gtmReadiness: { positioning: true, pricing: true, messaging: true, enablement: true },
    salesSupport: { salesTraining: true, supportRunbook: true, faq: true, escalationPath: true },
    launchSync: { releaseDate: "2026-07-17", marketingDate: "2026-07-17", embargoLiftDate: "2026-07-17", toleranceDays: 0 },
  };
}

function cannedPositioning(tierDecision: TierDecision): string {
  return (
    `Tier ${tierDecision.tier} launch (${tierDecision.reason}). Positioning draft is produced by the governed ` +
    `hive; the tier decision + gate verdicts are deterministic and stand without it.`
  );
}

// ── report ─────────────────────────────────────────────────────────────────
function composeReport(a: {
  date: string;
  tierDecision: TierDecision;
  tierMatch: TierMatch;
  gtmReadiness: Readiness;
  salesSupport: Readiness;
  launchSync: LaunchSync;
  positioning: string;
  gates: GateResult[];
  overall: Verdict;
  escalated: string[];
  verifier: string;
}): string {
  const icon: Record<string, string> = { GO: "✅", RECYCLE: "🔁", HOLD: "⏸️", KILL: "🔴" };
  const L: string[] = [];
  L.push("---");
  L.push(`date: ${a.date}`);
  L.push("agent: gtm-advisor");
  L.push(`overall: ${a.overall}`);
  L.push(`tier: ${a.tierDecision.tier}`);
  L.push(`bump: ${a.tierMatch.bump}`);
  L.push(`tier_matches_bump: ${a.tierMatch.matches}`);
  L.push(`escalations: ${a.escalated.length}`);
  L.push(`verifier: ${a.verifier}`);
  L.push("---");
  L.push("");
  L.push(`# Launch GTM — ${icon[a.overall] || ""} ${a.overall} · Tier ${a.tierDecision.tier} · ${a.date}`);
  L.push("");
  L.push(`> verifier: \`${a.verifier}\` (actor≠verifier — the governed run certified this launch record)`);
  L.push("");
  L.push("## Tier decision (M1)");
  L.push("");
  L.push(`- Assigned: **Tier ${a.tierDecision.tier}** — ${a.tierDecision.reason}`);
  L.push(`- Version bump: **${a.tierMatch.bump}** · ${a.tierMatch.matches ? "✅ tier matches bump" : `⏸️ ${a.tierMatch.reason}`}`);
  L.push("");
  L.push("## Positioning (draft)");
  L.push("");
  L.push(`> ${String(a.positioning).replace(/\n+/g, "\n> ")}`);
  L.push("");
  L.push("## Gate verdicts");
  L.push("");
  L.push("| Gate | Verdict | Reason |");
  L.push("|---|---|---|");
  for (const g of a.gates) {
    L.push(`| \`${g.gate}\` | ${icon[g.verdict] || ""} ${g.verdict} | ${escapeCell(g.reason || "")} |`);
  }
  L.push("");
  L.push("## Readiness checklists");
  L.push("");
  L.push(`**GTM (M2):** ${a.gtmReadiness.complete ? "✅ complete" : `🔁 gaps: ${a.gtmReadiness.missing.join(", ")}`}`);
  for (const d of GTM_READINESS_DIMENSIONS) L.push(`- ${a.gtmReadiness.present.includes(d) ? "✅" : "⬜"} ${d}`);
  L.push("");
  L.push(`**Sales & Support (M3):** ${a.salesSupport.complete ? "✅ complete" : `🔁 gaps: ${a.salesSupport.missing.join(", ")}`}`);
  for (const d of SALES_SUPPORT_DIMENSIONS) L.push(`- ${a.salesSupport.present.includes(d) ? "✅" : "⬜"} ${d}`);
  L.push("");
  L.push(`**Launch-sync (M4):** ${a.launchSync.synced ? "✅ aligned to the release calendar" : `⏸️ ${a.launchSync.reason}`}`);
  L.push("");
  if (a.escalated.length) {
    L.push("## ⏸️ Escalations to human");
    L.push("");
    for (const g of a.gates) {
      if (g.verdict === VERDICT.HOLD) L.push(`- **\`${g.gate}\`** — ${g.reason}${g.routedToHuman ? " _(human co-sign)_" : ""}`);
    }
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push(
    "_Emitted by the Agix **gtm-advisor** (proposer trust; verifier that the launch tier matches the version bump). " +
      "A Tier 0/1 launch + public positioning is a human co-sign. The launch record is an attested Comb leaf. " +
      "See `agents/gtm-advisor/PERSONA.md`._",
  );
  L.push("");
  return L.join("\n") + "\n";
}

// ── helpers ─────────────────────────────────────────────────────────────────
function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function normalizeBump(v: string | undefined): string {
  const s = String(v || "").toUpperCase();
  return ["PATCH", "MINOR", "MAJOR"].includes(s) ? s : "PATCH";
}
function numOr(v: number | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function parseDate(v: string | undefined): Date | null {
  const t = Date.parse(v ?? "");
  return Number.isFinite(t) ? new Date(t) : null;
}
function dayGap(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
const VERDICT_RANK: Record<string, number> = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts: Verdict[]): Verdict {
  let worst: Verdict = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v: string): string {
  return String(v).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128) || "gtm-unknown";
}
function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
