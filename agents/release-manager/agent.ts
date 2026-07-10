// Agix Release Manager — the release-train governance gate above the dev loop,
// reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer →
// worker caste, model tiering worker=haiku / verifier=haiku, the guard-bee
// boundary that writes only wiki/release-manager/ and denies deploy/merge/push,
// and public=true) lives in the sibling agent.json, read by the Go engine.
//
// The release-train CORES are deterministic and pure — they run with no API key
// and no network, exactly as in the Node original (agents/release-manager/agent.mjs):
//   computeReleaseTrain(cadence)       → freeze / code-freeze / RC / release dates.
//   checkFeatureFreeze(state)          → G1: no new scope past the freeze.
//   checkCodeFreeze(state)             → G2: RC = ship build; only blocker cherry-picks.
//   evaluateLaunchReadiness(checklist) → G3: the Google-LCE seven-part PRR checklist.
//   checkRollout(plan)                 → G4: canary %, bake time, abort criteria.
// The four gate VERDICTS (GO/RECYCLE/HOLD) — including G3's complete-PRR human
// co-sign routing (a complete checklist is GO→HOLD) and G4's outside-envelope
// escalation — are computed deterministically here (the actor's proposal).
//
// The ONE unit of intelligence the Node agent had was the OPTIONAL launch-
// readiness-review narrative (runtime.getModel().chat(), the narrator pattern). It
// maps to a single GOVERNED pass (ctx.hive.run): the Go swarm drafts the readiness
// TL;DR AND certifies it through a DISTINCT verifier (actor≠verifier), so the
// release record the agent writes to the Comb is attested, not self-graded. The
// deterministic verdicts stand with or without that narrative.
//
// NOT PORTED (faithful reduction — flagged honestly, mirrors the gtm-advisor port):
//   - The append-only audit-ledger STREAM (lib/agix-audit-ledger.mjs emitted a
//     separate `gate_decision` + `verdict` + `release` entry, each with an
//     entry_id, via runtime.getLedger()). That Node substrate is reduced to ONE
//     attested Comb leaf (the release record) certified by the governed run's
//     distinct verifier; the per-gate verdict rows still appear in the report.
//   - Release-success-rate + DORA computed FROM the ledger history
//     (lib/agix-dora.mjs computeDora / changeFailureRate). The reborn contract
//     exposes no ledger seam, so these ledger-derived metrics are not recomputed
//     here. The deterministic gate verdicts — the load-bearing decisions — stand
//     without them. Deferred until a governed ledger/metrics read seam exists.
//   - The cursor `state` output (runtime.writeState('cursor', …)): the reborn
//     AgentContext exposes no state seam. The last-run summary is folded into the
//     dated report + the attested Comb release leaf instead. The manifest still
//     DECLARES the state output as intent.
//   - Non-behavioral telemetry hooks (runtime.recordDecision / recordFileWritten)
//     have no seam in the reborn context and are dropped.
//
// Spec / persona: agents/release-manager/PERSONA.md
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REPORT_DIR = "wiki/release-manager";

// The seven-part Google launch-readiness (LCE / PRR) checklist. Fixed set — the
// launch-readiness gate requires every dimension to be present + green.
const LCE_DIMENSIONS = [
  "architecture", "capacity", "failureModes", "monitoring", "security", "dependencies", "rollback",
] as const;

// Stage-Gate verdicts (LOOP_ENGINEERED_SDLC §2) — richer than pass/fail.
const VERDICT = { GO: "GO", KILL: "KILL", HOLD: "HOLD", RECYCLE: "RECYCLE" } as const;
type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

// ── Input shapes ──────────────────────────────────────────────────────────
interface Cadence {
  anchorDate?: string;
  featureFreezeLeadDays?: number;
  codeFreezeLeadDays?: number;
  rcLeadDays?: number;
}
interface FeatureFreezeState {
  frozen?: boolean;
  newScopeAfterFreeze?: unknown[];
}
interface RcChange {
  id?: string;
  blocker?: boolean;
}
interface CodeFreezeState {
  rcChanges?: RcChange[];
}
interface RolloutPlan {
  canaryPercent?: number;
  bakeMinutes?: number;
  abortCriteriaMet?: boolean;
  maxCanaryPercent?: number;
  minBakeMinutes?: number;
}
interface ReleaseInput {
  releaseId?: string;
  cadence: Cadence;
  featureFreeze: FeatureFreezeState;
  codeFreeze: CodeFreezeState;
  readiness: Record<string, boolean>;
  rollout: RolloutPlan;
}

// ── Pure core 1: the release train (calendar / cadence) ─────────────────────
// Apple-train shape: anchor the release to a calendar; feature-freeze then
// code-freeze/RC lead it by fixed intervals; the RC is the ship build.
interface Train {
  valid: boolean;
  featureFreezeDate?: string;
  codeFreezeDate?: string;
  rcDate?: string;
  releaseDate?: string;
  reason: string;
}
export function computeReleaseTrain(cadence: Cadence = {}): Train {
  const anchor = parseDate(cadence.anchorDate);
  if (!anchor) return { valid: false, reason: `unparseable anchorDate: ${cadence.anchorDate}` };
  const featureFreezeLead = numOr(cadence.featureFreezeLeadDays, 14);
  const codeFreezeLead = numOr(cadence.codeFreezeLeadDays, 5);
  const rcLead = numOr(cadence.rcLeadDays, 3);
  const featureFreezeDate = isoDay(addDays(anchor, -featureFreezeLead));
  const codeFreezeDate = isoDay(addDays(anchor, -codeFreezeLead));
  const rcDate = isoDay(addDays(anchor, -rcLead));
  const releaseDate = isoDay(anchor);
  // The train is well-formed only when the milestones are monotonically ordered.
  const ordered =
    featureFreezeDate <= codeFreezeDate && codeFreezeDate <= rcDate && rcDate <= releaseDate;
  return {
    valid: ordered,
    featureFreezeDate,
    codeFreezeDate,
    rcDate,
    releaseDate,
    reason: ordered ? "train milestones ordered" : "lead intervals overlap — freeze after RC",
  };
}

// ── Pure core 2: G1 feature-freeze ──────────────────────────────────────────
// No new scope past the feature freeze. Any entry in newScopeAfterFreeze trips it.
interface FreezeResult {
  ok: boolean;
  verdict: Verdict;
  reason: string;
  added: string[];
}
export function checkFeatureFreeze(state: FeatureFreezeState = {}): FreezeResult {
  const frozen = state.frozen !== false; // default: the freeze is in effect
  const added = asList(state.newScopeAfterFreeze);
  if (!frozen) return { ok: true, verdict: VERDICT.GO, reason: "feature freeze not yet in effect", added: [] };
  if (added.length === 0) return { ok: true, verdict: VERDICT.GO, reason: "no new scope since feature freeze", added: [] };
  return {
    ok: false,
    verdict: VERDICT.RECYCLE,
    added,
    reason: `new scope added after feature freeze: ${added.join(", ")} — defer to the next train`,
  };
}

// ── Pure core 3: G2 code-freeze / RC ────────────────────────────────────────
// The RC is the ship build; only blocker cherry-picks are allowed in.
interface CodeFreezeResult {
  ok: boolean;
  verdict: Verdict;
  isShipBuild: boolean;
  reason: string;
  nonBlockers: string[];
}
export function checkCodeFreeze(state: CodeFreezeState = {}): CodeFreezeResult {
  const changes = Array.isArray(state.rcChanges) ? state.rcChanges : [];
  const nonBlockers = changes.filter((c) => !(c && c.blocker));
  if (nonBlockers.length === 0) {
    return {
      ok: true,
      verdict: VERDICT.GO,
      isShipBuild: true,
      reason: `RC is a clean ship build (${changes.length} blocker cherry-pick(s))`,
      nonBlockers: [],
    };
  }
  const ids = nonBlockers.map((c) => c.id ?? "(unknown)");
  return {
    ok: false,
    verdict: VERDICT.RECYCLE,
    isShipBuild: false,
    nonBlockers: ids,
    reason: `non-blocker change(s) in the RC: ${ids.join(", ")} — an RC only takes blocker cherry-picks`,
  };
}

// ── Pure core 4: G3 launch-readiness (Google LCE / PRR) ─────────────────────
// The seven-part PRR checklist. Every dimension must be truthy (ready).
interface Readiness {
  complete: boolean;
  missing: string[];
  present: string[];
  reason: string;
}
export function evaluateLaunchReadiness(checklist: Record<string, boolean> = {}): Readiness {
  const missing = LCE_DIMENSIONS.filter((d) => !checklist[d]);
  return {
    complete: missing.length === 0,
    missing,
    present: LCE_DIMENSIONS.filter((d) => checklist[d]),
    reason:
      missing.length === 0
        ? "all seven PRR dimensions ready — route to human go/no-go"
        : `PRR gaps: ${missing.join(", ")} — close before the readiness review`,
  };
}

// ── Pure core 5: G4 rollout envelope ────────────────────────────────────────
// A staged rollout must stay inside the canary %, meet the bake time, and have
// its abort criteria armed. Outside the envelope → escalate.
interface Rollout {
  withinEnvelope: boolean;
  canaryPercent: number;
  bakeMinutes: number;
  abortArmed: boolean;
  problems: string[];
  reason: string;
}
export function checkRollout(plan: RolloutPlan = {}): Rollout {
  const maxCanary = numOr(plan.maxCanaryPercent, 5);
  const minBake = numOr(plan.minBakeMinutes, 30);
  const canary = numOr(plan.canaryPercent, maxCanary);
  const bake = numOr(plan.bakeMinutes, 0);
  const abortArmed = plan.abortCriteriaMet !== false;
  const problems: string[] = [];
  if (canary > maxCanary) problems.push(`canary ${canary}% exceeds the ${maxCanary}% ceiling`);
  if (bake < minBake) problems.push(`bake ${bake}m below the ${minBake}m minimum`);
  if (!abortArmed) problems.push("abort criteria not armed");
  return {
    withinEnvelope: problems.length === 0,
    canaryPercent: canary,
    bakeMinutes: bake,
    abortArmed,
    problems,
    reason: problems.length === 0 ? `canary ${canary}% · bake ${bake}m · abort armed` : problems.join("; "),
  };
}

// ── Deterministic gate verdicts (G1–G4) ─────────────────────────────────────
//
// The Node agent ran these through lib/agix-gate.mjs Gate objects (actor=the dev
// fleet / release-engineer, verifier=release-manager). In the reborn contract the
// actor≠verifier CERTIFICATION is supplied by the governed run (ctx.hive.run), so
// this layer computes only the deterministic verdict logic (the actor's proposal).
// G3's requiresHuman routing (composeGate('release', { requiresHuman: true })) is
// preserved: a complete PRR is GO→HOLD (the human issues the real go/no-go), and a
// rollout outside its envelope (G4) is a HOLD.
interface GateResult {
  gate: string;
  verdict: Verdict;
  reason: string;
  routedToHuman: boolean;
}
function evaluateGates(a: {
  freeze: FreezeResult;
  codeFreeze: CodeFreezeResult;
  readiness: Readiness;
  rollout: Rollout;
}): { G1: GateResult; G2: GateResult; G3: GateResult; G4: GateResult } {
  // G1 — feature-freeze. GO (no new scope) or RECYCLE (scope added after freeze).
  const g1: GateResult = { gate: "G1-feature-freeze", verdict: a.freeze.verdict, reason: a.freeze.reason, routedToHuman: false };

  // G2 — code-freeze / RC. GO (clean ship build) or RECYCLE (a non-blocker change).
  const g2: GateResult = { gate: "G2-code-freeze-rc", verdict: a.codeFreeze.verdict, reason: a.codeFreeze.reason, routedToHuman: false };

  // G3 — launch-readiness. A complete PRR is GO, which requiresHuman routes to HOLD
  // (the human issues the real go/no-go). Gaps → RECYCLE (close before the review).
  const g3: GateResult = a.readiness.complete
    ? {
        gate: "G3-launch-readiness",
        verdict: VERDICT.HOLD,
        reason: `${a.readiness.reason} — requires human go/no-go (G3 human co-sign)`,
        routedToHuman: true,
      }
    : { gate: "G3-launch-readiness", verdict: VERDICT.RECYCLE, reason: a.readiness.reason, routedToHuman: false };

  // G4 — rollout. Inside the canary/bake/abort envelope → GO; outside → HOLD (escalate).
  const g4: GateResult = a.rollout.withinEnvelope
    ? { gate: "G4-rollout", verdict: VERDICT.GO, reason: a.rollout.reason, routedToHuman: false }
    : { gate: "G4-rollout", verdict: VERDICT.HOLD, reason: `rollout outside envelope: ${a.rollout.reason}`, routedToHuman: true };

  return { G1: g1, G2: g2, G3: g3, G4: g4 };
}

// ── The agent run ───────────────────────────────────────────────────────────
export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const date = isoDate();

  // Smoke short-circuit: exercise the governed surface once ($0), no report, no
  // Comb write. Mirrors the Node smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the release-train launch-readiness surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  // ── 1. Resolve the release input (a --releaseJson flag / JSON text, else canned) ─
  const input = resolveInput(ctx);

  // ── 2. Deterministic cores (pure, no key, no network) ─────────────────────
  const train = computeReleaseTrain(input.cadence);
  const freeze = checkFeatureFreeze(input.featureFreeze);
  const codeFreeze = checkCodeFreeze(input.codeFreeze);
  const readiness = evaluateLaunchReadiness(input.readiness);
  const rollout = checkRollout(input.rollout);

  // ── 3. Deterministic gate verdicts + overall + escalations ────────────────
  const gates = evaluateGates({ freeze, codeFreeze, readiness, rollout });
  const gateList = [gates.G1, gates.G2, gates.G3, gates.G4];
  const overall = worstVerdict(gateList.map((g) => g.verdict));
  const escalated = gateList.filter((g) => g.verdict === VERDICT.HOLD).map((g) => g.gate);

  // ── 4. ONE governed pass: narrate the readiness review AND certify (actor≠verifier) ─
  // This is the Node runtime.getModel().chat() narrator, now GOVERNED. The distinct
  // verifier it returns is what attests the release record below.
  const summary = [
    `Overall release verdict: ${overall}.`,
    `Launch-readiness: ${readiness.complete ? "complete" : `gaps in ${readiness.missing.join(", ")}`}.`,
    escalated.length ? `Escalated to human: ${escalated.join(", ")}.` : "No human escalations.",
  ].join("\n");
  const r = await ctx.hive.run(
    `You are a release manager. In at most four sentences, state the go/no-go posture, the single most ` +
      `important readiness gap (if any), and whether a human go/no-go is required. Use ONLY the data given, ` +
      `never invent a figure. No em dashes.\n\nDATA:\n${summary}`,
  );
  const narrative = r.answer?.trim() ? r.answer.trim() : cannedNarrative(overall, readiness);

  ctx.log(
    `Gates · ${gateList.map((g) => `${g.gate.split("-")[0]}=${g.verdict}`).join(" ")} · overall=${overall}` +
      (escalated.length ? ` · escalate: ${escalated.join(", ")}` : ""),
    { verifier: r.verifierActor },
  );

  // ── 5. Write the dated report (bounded by boundary.write = wiki/release-manager/) ─
  const relPath = `${REPORT_DIR}/${date}.md`;
  const report = composeReport({
    date, train, freeze, codeFreeze, readiness, rollout,
    gates: gateList, overall, escalated, narrative, verifier: r.verifierActor,
  });
  try {
    await ctx.writeRepoFile(relPath, report);
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── 6. The release record — an attested Comb leaf certified by the distinct
  //       verifier (the reduction of the Node append-only `release` ledger entry) ─
  const releaseId = safeId(input.releaseId || `rel-${date.replace(/-/g, "")}`);
  await ctx.comb
    .put({
      id: `release-record-${releaseId}`,
      content:
        `release/train ${date}: overall=${overall} release_date=${train.releaseDate ?? "n/a"} ` +
        `rc_ship_build=${codeFreeze.isShipBuild} prr_complete=${readiness.complete} ` +
        `rollout_in_envelope=${rollout.withinEnvelope}` +
        `${escalated.length ? ` escalate=${escalated.join(",")}` : ""} — ${narrative.slice(0, 300)}`,
      branch: "software", // TOGAF Software Architecture — release/delivery gate lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: overall === VERDICT.GO ? 0.8 : 0.6,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    overall,
    release_date: train.releaseDate ?? null,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(gateList.map((g) => [g.gate, g.verdict])),
    prr_complete: readiness.complete,
    rc_is_ship_build: codeFreeze.isShipBuild,
    rollout_within_envelope: rollout.withinEnvelope,
    verifier: r.verifierActor,
    queen: r.queenActor,
    report: relPath,
    costUSD: r.cost.usd,
  };
});

// ── input resolution ────────────────────────────────────────────────────────
function resolveInput(ctx: AgentContext): ReleaseInput {
  const flag = ctx.input.flags.releaseJson;
  const fromFlag = typeof flag === "string" && flag.trim() ? flag.trim() : "";
  const text = ctx.input.text?.trim() ?? "";
  const fromText = text.startsWith("{") ? text : "";
  const raw = fromFlag || fromText;
  if (raw) {
    try {
      return { ...cannedInput(), ...(JSON.parse(raw) as Partial<ReleaseInput>) } as ReleaseInput;
    } catch {
      /* fall through to canned */
    }
  }
  return cannedInput();
}

// A canned sample release train (clean — RC is a ship build, PRR complete, rollout
// in-envelope) so smoke/default is a faithful, no-network demonstration. The canned
// run lands on G3=HOLD because a complete PRR is a human go/no-go.
function cannedInput(): ReleaseInput {
  return {
    releaseId: "rel-sample",
    cadence: { anchorDate: "2026-07-17", featureFreezeLeadDays: 14, codeFreezeLeadDays: 5, rcLeadDays: 3 },
    featureFreeze: { frozen: true, newScopeAfterFreeze: [] },
    codeFreeze: { rcChanges: [{ id: "canary-timeout-fix", blocker: true }] },
    readiness: { architecture: true, capacity: true, failureModes: true, monitoring: true, security: true, dependencies: true, rollback: true },
    rollout: { canaryPercent: 5, bakeMinutes: 60, abortCriteriaMet: true, maxCanaryPercent: 5, minBakeMinutes: 30 },
  };
}

function cannedNarrative(overall: Verdict, readiness: Readiness): string {
  return (
    `Overall release posture is ${overall}. ${readiness.complete ? "The PRR checklist is complete, so a human go/no-go is required." : `Close the PRR gaps (${readiness.missing.join(", ")}) before the readiness review.`} ` +
    `Deterministic gate verdicts are the source of truth; this narrative rides on top.`
  );
}

// ── report ───────────────────────────────────────────────────────────────────
function composeReport(a: {
  date: string;
  train: Train;
  freeze: FreezeResult;
  codeFreeze: CodeFreezeResult;
  readiness: Readiness;
  rollout: Rollout;
  gates: GateResult[];
  overall: Verdict;
  escalated: string[];
  narrative: string;
  verifier: string;
}): string {
  const icon: Record<string, string> = { GO: "✅", RECYCLE: "🔁", HOLD: "⏸️", KILL: "🔴" };
  const L: string[] = [];
  L.push("---");
  L.push(`date: ${a.date}`);
  L.push("agent: release-manager");
  L.push(`overall: ${a.overall}`);
  L.push(`release_date: ${a.train.releaseDate ?? "n/a"}`);
  L.push(`prr_complete: ${a.readiness.complete}`);
  L.push(`rc_is_ship_build: ${a.codeFreeze.isShipBuild}`);
  L.push(`rollout_within_envelope: ${a.rollout.withinEnvelope}`);
  L.push(`escalations: ${a.escalated.length}`);
  L.push(`verifier: ${a.verifier}`);
  L.push("---");
  L.push("");
  L.push(`# Release Train — ${icon[a.overall] || ""} ${a.overall} · ${a.date}`);
  L.push("");
  L.push(`> verifier: \`${a.verifier}\` (actor≠verifier — the governed run certified this release record)`);
  L.push("");
  L.push("## Readiness review (TL;DR)");
  L.push("");
  L.push(`> ${String(a.narrative).replace(/\n+/g, "\n> ")}`);
  L.push("");
  L.push("_(Narrative summary — governed pass, certified by a distinct verifier. The deterministic gate table below is the source of truth.)_");
  L.push("");
  L.push("## Calendar");
  L.push("");
  if (a.train.valid) {
    L.push(`- Feature freeze: **${a.train.featureFreezeDate}**`);
    L.push(`- Code freeze: **${a.train.codeFreezeDate}**`);
    L.push(`- RC (ship build): **${a.train.rcDate}**`);
    L.push(`- Release: **${a.train.releaseDate}**`);
  } else {
    L.push(`- ⚠️ Train not well-formed: ${a.train.reason}`);
  }
  L.push("");
  L.push("## Gate verdicts");
  L.push("");
  L.push("| Gate | Verdict | Reason |");
  L.push("|---|---|---|");
  for (const g of a.gates) {
    L.push(`| \`${g.gate}\` | ${icon[g.verdict] || ""} ${g.verdict} | ${escapeCell(g.reason || "")} |`);
  }
  L.push("");
  L.push("## Launch-readiness (PRR / Google-LCE)");
  L.push("");
  for (const d of LCE_DIMENSIONS) {
    L.push(`- ${a.readiness.present.includes(d) ? "✅" : "⬜"} ${d}`);
  }
  L.push("");
  L.push("## Rollout");
  L.push("");
  L.push(`- ${a.rollout.withinEnvelope ? "✅" : "⏸️"} ${a.rollout.reason}`);
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
    "_Emitted by the Agix **release-manager** (proposer trust; verifier that the dev fleet built something " +
      "launch-ready). It plans + gates the release train; it never deploys — release-engineer + the CI/CD " +
      "pipeline own the plumbing. G3 launch-readiness is a human go/no-go. The release record is an attested " +
      "Comb leaf. See `agents/release-manager/PERSONA.md`._",
  );
  L.push("");
  return L.join("\n") + "\n";
}

// ── helpers ───────────────────────────────────────────────────────────────────
function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => x != null && x !== "").map((x) => String(x)) : [];
}
function numOr(v: number | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function parseDate(v: string | undefined): Date | null {
  const t = Date.parse(v ?? "");
  return Number.isFinite(t) ? new Date(t) : null;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const VERDICT_RANK: Record<string, number> = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts: Verdict[]): Verdict {
  let worst: Verdict = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v: string): string {
  return String(v).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128) || "rel-unknown";
}
function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
