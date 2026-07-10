// Agix Refactor Surgeon — the bee that applies ONE behavior-preserving structural
// refactoring to the target (proposer / worker caste), on Bun.
//
// Identity, trust=proposer, model tiering, the sidecar-relative boundary (write
// repo/ CODE only + notes/refactor/; deny the agentic-footprint paths inside
// repo/), the governed tools (read/grep/glob/write), and public=true live in the
// sibling agent.json. This file FRAMES THE TASK — one atomic, refactoring-only,
// behavior-preserving edit — and the governed hive's WORKER bees carry it out with
// the tools: read/grep/glob to learn the repo's exact style, then WRITE the changed
// source via the `write` tool (scoped to repo/ by the guard-bee boundary).
//
// TOOL SEAM (landed, commit 9e029a9): the concrete governed read/grep/glob/write
// tools now RESOLVE from agent.json `tools`, scoped to --repoRoot + the boundary,
// and are offered to the workers during ctx.hive.run. The physical source mutation
// therefore happens INSIDE the governed run on a live engine — not from this file.
// The MockEngine used in `bun test` ignores the task text and executes no tools, so
// a mock run performs no physical write: it verifies the governed SHAPE only.
//
// The change-note (below) is the sidecar artifact and is separate from the source
// edit: this file writes it via ctx.writeRepoFile into notes/refactor/, never inside
// repo/.
//
// See packs/refactor/SPEC.md for the full design.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const CHANGES_DIR = "notes/refactor";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the refactor-surgeon reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const candidate = (ctx.input.flags.candidate as string) || ctx.input.text;
  if (!candidate) {
    ctx.log("no candidate (pass one worklist candidate as --candidate or text)");
    return { ok: false, reason: "no-candidate" };
  }
  const candidateId = (ctx.input.flags.id as string) || "cand";

  // ── One GOVERNED apply-the-edit pass ────────────────────────────────────────
  // The task frames the work; the workers do it with the wired tools — read/grep/
  // glob to learn the repo's exact style, then the `write` tool to mutate repo/
  // (bounded to repo/ CODE, agentic paths denied, by the guard-bee boundary in Go).
  // On a live engine the physical write happens here, inside the run; the MockEngine
  // executes no tools, so a hermetic run mutates nothing and certifies the shape.
  const r = await ctx.hive.run(
    `APPLY exactly this ONE behavior-preserving structural refactoring to the target under repo/, and nothing else ` +
      `(no feature, no fix, no tangling):\n\n${candidate}\n\n` +
      `Work in two moves:\n` +
      `1. LEARN THE STYLE — before you touch anything, read the target file and its neighbors with the read/grep/glob ` +
      `tools. Match this repo's naming, comment density (usually sparse), import order, and error handling EXACTLY; the ` +
      `diff must read as if the senior engineer who owns this code wrote it.\n` +
      `2. WRITE THE CHANGE — apply the smallest edit that removes the smell and write the changed file(s) back with the ` +
      `write tool. ONE refactoring only: change internal structure, preserve observable behavior (same inputs -> same ` +
      `outputs and side effects). If it is a signature refactoring (e.g. Introduce Parameter Object), update every caller ` +
      `in the SAME atomic change. NO tangling — nothing else in the diff; if you notice a bug, note it for the ` +
      `investigator, do not fix it here.\n\n` +
      `CODE ONLY. Zero agentic footprint inside repo/: never write CLAUDE.md / AGENTS.md / .claude/ / .agix/ or any agent ` +
      `note there; no AI-slop comments, no narrating the obvious, no "comprehensive/robust" filler, no emoji.\n\n` +
      `Then state precisely which files and lines changed, confirm observable behavior is preserved, and what a ` +
      `characterization test should pin.`,
  );

  // ── Land the change-note under the sidecar (never inside repo/) ────────────
  // The sidecar artifact — separate from the source edit, which the write tool
  // applied inside the governed run above.
  const notePath = `${CHANGES_DIR}/${isoDate()}-${candidateId}-change.md`;
  const doc =
    `# Refactoring change · ${candidateId} · ${isoDate()}\n\n` +
    `- verifier: ${r.verifierActor} (actor≠verifier)\n` +
    `- discipline: one refactoring, behavior-preserving, no tangling, seasoned-human authorship\n` +
    `- applied: ${r.verified} — source mutated via the write tool during the governed run (mock run = no physical write)\n\n` +
    `## Candidate\n\n${candidate}\n\n## Applied refactoring\n\n${r.answer}\n`;
  try {
    await ctx.writeRepoFile(notePath, doc);
  } catch (e) {
    ctx.log(`change-note write skipped: ${(e as Error).message}`);
  }

  return {
    ok: r.verified,
    candidate_id: candidateId,
    change_note: notePath,
    // applied = the governed pass certified the edit. On a live engine the worker
    // mutated repo/<source> via the write tool; the mock executes no tools.
    applied: r.verified,
    note: "physical source mutation happens via the write tool during the governed run on a live engine; the mock run performs no write",
    verifier: r.verifierActor,
    costUSD: r.cost.usd,
  };
});
