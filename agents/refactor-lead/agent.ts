// Agix Refactor Lead — the conductor of a metric-guided refactoring campaign
// (conductor / queen caste), on Bun.
//
// Identity, trust=conductor, model tiering (queen=opus planning,
// verifier=sonnet), the sidecar-relative boundary (write only plans/refactor/ +
// notes/refactor/), the "fire" tool (to conduct the scout, surgeon,
// behavior-guard, tester, git-orchestrator), and public=true live in the sibling
// agent.json. This file conducts the campaign loop: a governed planning pass sets
// the metric target, the scout supplies a ranked worklist, then per candidate the
// lead FIRES git-orchestrator (branch) -> refactor-surgeon -> behavior-guard, and
// on APPROVE fires git-orchestrator (commit). It writes the campaign plan + the
// before/after report and pushes campaign learnings to the Comb (the compounding
// seam — every campaign makes the NEXT drop-in stronger).
//
// See packs/refactor/SPEC.md for the full design.
//
// TOOL SEAM (landed, 9e029a9): the Go fs + metric tools are live, so the fired
// sub-bees now physically forage and act — the surgeon mutates repo/ via the write
// tool, the scout + guard measure via the metric tool. The ONE step still gated is
// git: git-orchestrator carries the exec tool but its allowlist DENIES
// push/merge/deploy (inspect-only by policy), so the branch/commit ceremony is a
// brief pending the COMMIT-AUTHORITY decision (autonomous commit via a scoped git
// grant under the human's identity vs. the human commits vs. open a PR). Those
// steps are marked `TODO(commit-authority)`; the before/after metric read is
// `TODO(flesh-out)` (wire the metric tool's report into the loop, not just the
// scout's text). The ORCHESTRATION is real.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult, type GovernedResult } from "../../fleet/runtime/sdk.ts";

const CAMPAIGN_DIR = "plans/refactor";

// The bees this conductor is allowed to fire (the allowlist the lead enforces
// before every ctx.fire). Kept explicit so the campaign's blast radius is legible.
export const FIRE_ALLOWLIST = ["smell-scout", "refactor-surgeon", "behavior-guard", "tester", "git-orchestrator"] as const;
type Fireable = (typeof FIRE_ALLOWLIST)[number];

// The allowlist gate. A non-allowlisted agent is a PROGRAMMING error, so this
// throws (loud) rather than skipping silently — the campaign's blast radius is a
// contract, not a suggestion.
export function assertFireable(agent: string): asserts agent is Fireable {
  if (!(FIRE_ALLOWLIST as readonly string[]).includes(agent)) {
    throw new Error(`refactor-lead: refusing to fire "${agent}" — not on the campaign allowlist (${FIRE_ALLOWLIST.join(", ")})`);
  }
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// --max caps the campaign iterations (string flag -> int, default 3, clamped >0).
function parseMax(flags: Record<string, string | boolean>): number {
  const raw = flags.max;
  if (raw === undefined || raw === true) return 3;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

// Derive the ranked candidate list from the scout's answer. For now the answer
// text IS the worklist (a structured worklist schema is TODO(flesh-out)); take
// numbered/bulleted lines when present, else every non-empty line.
function parseWorklist(answer: string): string[] {
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
  const listed = lines
    .filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, "").trim())
    .filter(Boolean);
  return listed.length ? listed : lines;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the refactor-lead planning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor, canFire: FIRE_ALLOWLIST });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const target = (ctx.input.flags.target as string) || ctx.input.text || "the target codebase under repo/";
  const goal = (ctx.input.flags.goal as string) || "bring the worst structural hotspots to a healthy floor (Class-LOC + WMC down)";
  const max = parseMax(ctx.input.flags);

  // fired-agent ledger + running governed cost (the campaign's legible spend).
  const fired: string[] = [];
  let costUSD = 0;

  // A bounded, guarded fire: enforce the allowlist (throws on a non-allowlisted
  // agent — a programming error), then wrap the governed call so ONE bee failing
  // logs + continues rather than crashing the whole campaign.
  const fire = async (agent: string, task: string): Promise<GovernedResult | null> => {
    assertFireable(agent);
    try {
      const r = await ctx.fire(agent, task);
      if (!fired.includes(agent)) fired.push(agent);
      costUSD += r.cost.usd;
      return r;
    } catch (e) {
      ctx.log(`fire ${agent} failed — continuing campaign`, { error: (e as Error).message });
      return null;
    }
  };

  // ── 1. Governed planning pass — set the metric target + strategy. This is the
  //       lead's OWN hive.run; its distinct verifier attests the Comb leaf below.
  const plan = await ctx.hive.run(
    `Plan a metric-guided refactoring campaign for ${target}.\n\n` +
      `Target: ${goal}.\n` +
      `Emphasis: HIGH-LEVEL structural refactorings (Extract Class/Subclass, Split Class, Move Method, ` +
      `Introduce Parameter Object) — the ones with the largest structural-metric payoff — not cosmetic renames.\n\n` +
      `Ground the metric target in the metric tool's structural report over repo/ (Class-LOC / WMC / ` +
      `cyclomatic / coupling); state how it is measured and the certify-or-revert gate. The scout supplies the ` +
      `ranked worklist; you sequence ONE atomic refactoring per branch and stop when the target is met, the ` +
      `worklist is exhausted, or the budget (max ${max}) is spent.`,
  );
  costUSD += plan.cost.usd;

  // ── 2. Baseline — fire the scout for the ranked structural worklist. ────────
  const scout = await fire(
    "smell-scout",
    `Baseline scan of ${target}. Produce a ranked structural worklist (highest impact-per-risk first), each ` +
      `candidate cited to file:line with a predicted metric delta. Surface HIGH-LEVEL structural candidates ` +
      `(God/Large Class, Long Method, Feature Envy, Primitive Obsession), never a pile of renames.`,
  );
  const worklist = scout ? parseWorklist(scout.answer) : [];

  // ── 3. The campaign loop — one atomic refactoring per iteration, bounded by
  //       --max AND by worklist exhaustion. ───────────────────────────────────
  const budget = Math.min(max, worklist.length);
  const attempts: { candidate: string; verdict: "committed" | "reverted" | "failed" }[] = [];
  let committed = 0;
  let reverted = 0;

  for (let i = 0; i < budget; i++) {
    const candidate = worklist[i];

    // branch — one refactoring-only branch per candidate.
    // TODO(commit-authority): git-orchestrator is inspect-only (exec allowlist
    // denies push/merge/deploy), so this is a brief until commit-authority is set.
    await fire("git-orchestrator", `branch: cut ONE refactoring-only branch for candidate #${i + 1}: ${candidate}`);

    // refactor — the surgeon applies ONE behavior-preserving structural transform,
    // mutating repo/ via the write tool (live on a real run).
    const surgery = await fire("refactor-surgeon", `Apply ONE behavior-preserving structural refactoring for: ${candidate}`);
    if (!surgery) {
      attempts.push({ candidate, verdict: "failed" });
      continue;
    }

    // certify — the behavior-guard is the adversarial gate (behavior preserved +
    // structure improved + no tangling). It approves only when it cannot refuse.
    const guard = await fire(
      "behavior-guard",
      `Certify the change for candidate: ${candidate}. Behavior preserved + structure improved + no tangling? ` +
        `Answer APPROVE or REFUSE with reasons.\n\nCHANGE:\n${surgery.answer.slice(0, 400)}`,
    );
    if (!guard) {
      attempts.push({ candidate, verdict: "failed" });
      continue;
    }

    const approved = /\bAPPROVE\b/i.test(guard.answer) && !/\bREFUSE\b/i.test(guard.answer);
    if (!approved) {
      // REFUSE → revert + drop the candidate (re-scoping is TODO(flesh-out)).
      // TODO(commit-authority): the revert is a brief until git-orchestrator may act.
      reverted++;
      attempts.push({ candidate, verdict: "reverted" });
      ctx.log("behavior-guard REFUSED — candidate reverted", { candidate });
      continue;
    }

    // commit — an atomic, human-voiced, refactoring-only commit; then re-measure.
    // TODO(commit-authority): git-orchestrator is inspect-only; TODO(flesh-out):
    // re-measure via the metric tool and feed the delta back into the loop.
    await fire("git-orchestrator", `commit: atomic, human-voiced, refactoring-only commit for candidate #${i + 1}: ${candidate}`);
    committed++;
    attempts.push({ candidate, verdict: "committed" });
  }

  const iterations = attempts.length;

  // ── 4. Land the two artifacts under the sidecar (siblings of repo/, never
  //       inside it) — the campaign plan + the before/after report. ───────────
  const date = isoDate();
  const planPath = `${CAMPAIGN_DIR}/${date}-campaign.md`;
  const reportPath = `${CAMPAIGN_DIR}/${date}-report.md`;

  const planDoc =
    `# Refactoring campaign · ${date}\n\n` +
    `- target: ${target}\n` +
    `- goal: ${goal}\n` +
    `- budget (--max): ${max}\n` +
    `- verifier: ${plan.verifierActor} (actor≠verifier)\n` +
    `- conducts (fire allowlist): ${FIRE_ALLOWLIST.join(", ")}\n\n` +
    `## Metric target + strategy\n\n${plan.answer}\n\n` +
    `## Ranked worklist (from smell-scout)\n\n` +
    (worklist.length ? worklist.map((c, i) => `${i + 1}. ${c}`).join("\n") : "_(scout returned no candidates)_") +
    `\n`;

  const reportDoc =
    `# Refactoring campaign · before/after report · ${date}\n\n` +
    `- target: ${target}\n` +
    `- verifier: ${plan.verifierActor} (actor≠verifier)\n` +
    `- candidates attempted: ${iterations}\n` +
    `- committed: ${committed}\n` +
    `- reverted: ${reverted}\n` +
    `- fired: ${fired.join(", ") || "(none)"}\n\n` +
    `## Per-candidate verdicts\n\n` +
    (attempts.length
      ? `| # | candidate | verdict |\n|--:|-----------|---------|\n` +
        attempts.map((a, i) => `| ${i + 1} | ${a.candidate.replace(/\|/g, "\\|")} | ${a.verdict} |`).join("\n")
      : "_(no candidates processed)_") +
    `\n\n> Re-measured before/after structural metrics per step are TODO(flesh-out): ` +
    `the metric tool is live (9e029a9); wire its report into the loop so the delta ` +
    `certifies each step. Commit ceremony is gated on commit-authority.\n`;

  for (const [rel, content] of [
    [planPath, planDoc],
    [reportPath, reportDoc],
  ] as const) {
    try {
      await ctx.writeRepoFile(rel, content);
    } catch (e) {
      ctx.log(`artifact write skipped: ${(e as Error).message}`, { path: rel });
    }
  }

  // ── 5. Compounding seam — push campaign learnings to the Comb (software
  //       branch), attested by the planning pass's DISTINCT verifier. Every
  //       campaign makes the NEXT drop-in stronger (the moat). ────────────────
  await ctx.comb
    .put({
      id: `refactor-lead-campaign-${date}`,
      content:
        `Campaign ${date} on ${target}: ${iterations} candidates attempted, ${committed} committed, ` +
        `${reverted} reverted. Goal: ${goal}. Worklist head: ${worklist.slice(0, 3).join(" | ") || "(empty)"}.`,
      branch: "software",
      author: plan.queenActor,
      verifier: plan.verifierActor,
      trust: committed > 0 ? 0.7 : 0.5,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: plan.verified,
    campaign: planPath,
    report: reportPath,
    iterations,
    committed,
    reverted,
    fired,
    fire_allowlist: [...FIRE_ALLOWLIST],
    verifier: plan.verifierActor,
    costUSD,
  };
});
