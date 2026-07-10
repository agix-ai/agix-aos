// Agix Smell Scout — the structural refactoring scout of the refactoring pack
// (proposer / worker caste), on Bun.
//
// Identity, trust=proposer, model tiering (worker=haiku scan, queen=sonnet rank,
// verifier=opus judge), the sidecar-relative boundary (read repo/, write only
// plans/refactor/), and public=true live in the sibling agent.json. This file
// drives the SHAPE of the three-pass scout (scan -> rank -> judge) as ONE governed
// hive pass and lands one artifact: a ranked STRUCTURAL worklist.
//
// The scout hunts on TWO axes, both deliberately biased away from cosmetics:
//   1. STRUCTURAL SMELLS — the high-level decompositions coding agents are worst
//      at, where the empirical Class-LOC/WMC payoff actually lives (SPEC §2.1).
//   2. DRIFT — a known-good pattern applied in one place and skipped in the
//      adjacent place; the asymmetry between a principle and its enforcement.
//      (Distilled from the SOLID native-AI audit note, 2026-07-07.)
//
// Comb recall seeds the scan with what structural smells + fixes recurred on OTHER
// codebases (the compounding seam), and the certified worklist is written back as
// a cross-codebase pattern leaf on the `software` branch.
//
// See packs/refactor/SPEC.md for the full design and the empirical grounding.
//
// TOOL SEAM (LIVE, commit 9e029a9): the governed Go catalog now exposes bounded,
// boundary-scoped tools that resolve from this agent.json `tools` list and are
// offered to WORKER bees inside ctx.hive.run. This file does NOT call them; it
// FRAMES the task so the workers forage through them:
//   • metric — the structural spine: one JSON report (Class-LOC/WMC/cyclomatic/
//     nesting/fan-in-out) → ranked smell→refactoring worklist over repo/.
//   • walk / read / grep — confirm each metric candidate and pin the exact
//     file:line at the source.
//   • grep — also drives the DRIFT rubric: cross-file "applied here, skipped next
//     door" comparisons across SIBLING modules that the per-file metric cannot see.
// Read-only: the scout never edits source (no `write` tool); the worklist lands
// via ctx.writeRepoFile, bounded independently to plans/refactor/.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const WORKLIST_DIR = "plans/refactor";

// ── The structural moat: each smell mapped to the HIGH-LEVEL refactoring that
// removes it, plus the metric signal that flags it. This is the taxonomy the
// scout hunts by — deliberately structural, never a rename. Predicted-delta
// anchors come from the empirical record (SPEC §2.1, Table 7): Extract Subclass
// ≈ Class-LOC −87.5 / WMC −11.5; Split Class ≈ Class-LOC −16 / WMC −4.
interface StructuralSmell {
  smell: string;
  signal: string; // the bad metric that flags it
  refactoring: string; // the high-level fix
}

const STRUCTURAL_SMELLS: readonly StructuralSmell[] = [
  {
    smell: "God / Large Class",
    signal: "high WMC, many responsibilities, high Class-LOC",
    refactoring: "Extract Class / Extract Subclass / Split Class",
  },
  {
    smell: "Long Method / high cyclomatic / deep nesting",
    signal: "cyclomatic complexity high, nesting depth > 3, method-LOC high",
    refactoring: "Extract Method / decompose conditional",
  },
  {
    smell: "Feature Envy / inappropriate intimacy",
    signal: "a method reaches into another class's data more than its own",
    refactoring: "Move Method / Move Field",
  },
  {
    smell: "Primitive Obsession / long parameter list",
    signal: "params > 4, primitive clumps passed together repeatedly",
    refactoring: "Introduce Parameter Object",
  },
  {
    smell: "Duplicated blocks across files",
    signal: "the same block/expression recurs across modules",
    refactoring: "Extract Method / Pull Up",
  },
  {
    smell: "Cyclic dependency / tight coupling",
    signal: "high fan-in + fan-out, an import cycle between modules",
    refactoring: "break the cycle / introduce a seam",
  },
];

// ── The DRIFT rubric. The core lesson of the SOLID audit: almost no failure was
// ignorance of the right pattern — each was a good pattern applied in one place
// and SKIPPED in the adjacent place (the abstraction built then routed around,
// the invariant asserted in prose not in code). That asymmetry is a structural
// smell too, and it is exactly what a cross-file scout can see that a single-file
// linter cannot. Each check is one line, keyed to the audited principle.
interface DriftCheck {
  id: string;
  name: string;
  check: string;
}

const DRIFT_CHECKS: readonly DriftCheck[] = [
  {
    id: "D1",
    name: "fail-open default",
    check:
      "a default / unconfigured / error branch that PERMITS where its siblings deny — audit the direction of every default; absence of config should fail closed.",
  },
  {
    id: "D2",
    name: "unreachable fail-loud",
    check:
      "a throw-on-unknown primitive with no completeness test proving every live input reaches it — a caught throw silently meters $0 for the un-covered input.",
  },
  {
    id: "D3",
    name: "remembered vs structural guard",
    check:
      "a required guard (tenant / orgId / auth) enforced by a remembered if-check in one path but a type/proxy in another — encode the closed state so a caller cannot forget it.",
  },
  {
    id: "D4",
    name: "boundary derived from input",
    check:
      "a scope / tenant / identity derived from request input in one path where the adjacent path derives it from the verified principal server-side.",
  },
  {
    id: "D5",
    name: "partition-key omission",
    check:
      "a scope predicate present in get/delete/update but MISSING from one sibling (e.g. list()) of the same operation set — three of four is not enforced.",
  },
  {
    id: "D6",
    name: "actor==verifier reachable",
    check:
      "a producer that can reach a publish / approve / commit capability the type system withholds from its siblings — separation of actor and verifier must be structural.",
  },
  {
    id: "D7",
    name: "cast instead of parse",
    check:
      "a value `as`-cast straight onto a DB / enum / model at one boundary where the adjacent boundary runtime-validates it (turns a 400 into a 500 or a silent mis-scope).",
  },
  {
    id: "D8",
    name: "duplicated invariant",
    check:
      "a safety-relevant constant / policy / cost-math single-sourced in one place and copy-pasted — and quietly diverged — in the adjacent place.",
  },
  {
    id: "D9",
    name: "routed-around abstraction",
    check:
      "a helper built to enforce an invariant that some callers bypass with a hand-rolled copy — the abstraction rots into a trap when a new field is added to it alone.",
  },
  {
    id: "D10",
    name: "asymmetric failure handling",
    check:
      "one module instruments and bounds the failure + timeout path; the adjacent sibling handles only success — no deadline on the awaited call, or error rendered as empty.",
  },
];

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// The documented candidate schema — printed into the artifact header so a human or
// the surgeon can read the worklist as a contract, not prose.
const CANDIDATE_SCHEMA = [
  "candidate_id      — stable id, e.g. SS-01",
  "smell             — the STRUCTURAL_SMELL taxon (or DRIFT check id) it removes",
  "refactoring_type  — the high-level refactoring: Extract Class/Subclass, Split Class, Move Method, Introduce Parameter Object, break-the-cycle, ...",
  "target            — file:line the smell is pinned to (REQUIRED; no line -> not listed)",
  "predicted_delta   — expected structural-metric improvement: Class-LOC Δ / WMC Δ / cyclomatic Δ (negative = better)",
  "confidence        — high | medium | low that the delta lands",
  "risk              — behavior-preservation risk of applying it as ONE atomic, refactoring-only commit",
].join("\n");

function renderSmellMenu(): string {
  return STRUCTURAL_SMELLS.map((s) => `- ${s.smell} (${s.signal}) -> ${s.refactoring}`).join("\n");
}

function renderDriftMenu(): string {
  return DRIFT_CHECKS.map((d) => `- [${d.id}] ${d.name}: ${d.check}`).join("\n");
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the structural-scout reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const target = (ctx.input.flags.target as string) || ctx.input.text || "the target codebase under repo/";

  // ── Compounding seam (read side): what structural smells + fixes recurred on
  // OTHER codebases the hive has refactored? Seed THIS scan with them so the scout
  // gets stronger every codebase it touches. The recall is best-effort — a cold
  // Comb (first codebase) simply returns nothing. Guarded so a KM outage never
  // blocks the scan.
  let priors: string[] = [];
  try {
    const recalled = await ctx.comb.retrieve("recurring structural smells and refactorings across codebases", 5);
    priors = recalled.map((l) => l.content).filter(Boolean);
    if (priors.length) ctx.log("seeded scan with cross-codebase priors", { count: priors.length });
  } catch (e) {
    ctx.log(`comb recall skipped: ${(e as Error).message}`);
  }
  const priorsBlock = priors.length
    ? `\n\nPRIORS — structural smells + fixes that RECURRED on other codebases this hive has refactored. ` +
      `Weight these first; if this codebase shows the same shape, that is high-signal:\n- ${priors.join("\n- ")}`
    : `\n\nPRIORS: none recalled — this is a cold scan (treat as codebase #1; every certified candidate seeds the next).`;

  // ── One GOVERNED scan -> rank -> judge pass. The task FRAMES the governed
  // worker to forage through the LIVE tools (metric = structural spine; walk/read/
  // grep = confirm + pin file:line; grep = cross-file DRIFT), then synthesize the
  // ranked worklist a distinct verifier certifies. This agent never calls a tool;
  // it shapes the brief and hands it to the hive.
  const task =
    `Scan ${target} (rooted at repo/) for HIGH-LEVEL structural refactoring opportunities and return a RANKED worklist. ` +
    `Hunt STRUCTURE and DRIFT, deliberately over cosmetics — if the worklist is all renames or type changes, you have FAILED. ` +
    `The moat is deliberate: coding agents over-index on low-level cleanup and under-perform at structural decomposition, ` +
    `yet that decomposition is where the measurable Class-LOC / WMC payoff lives (Extract Subclass alone ≈ Class-LOC -87 / WMC -11).\n\n` +
    `You have LIVE governed tools, boundary-scoped to repo/. Forage — do not guess:\n` +
    `- metric {"path":"repo/"} — the STRUCTURAL SPINE. Returns JSON: ` +
    `{files_analyzed, totals{loc,sloc,classes,functions,max_nesting}, ` +
    `smells[]{kind, refactoring, path, unit, metric, value}, hotspots[]{path,cyclomatic,loc,max_nesting,classes}}. ` +
    `Call it FIRST over repo/ (and again on a hot subtree to refine). Its ranked smells[] (kind -> mapped refactoring, with unit + metric + value) ` +
    `IS your candidate worklist; hotspots[] rank where structure is worst. Build the ranking on these real numbers, not intuition.\n` +
    `- walk {"path":"repo/subtree"} — enumerate a subtree to see how a hotspot's siblings are laid out.\n` +
    `- read {"path":"repo/rel/file"} — read a candidate's file to CONFIRM the smell is genuinely structural (not a rename in disguise) and to pin the exact line.\n` +
    `- grep {"pattern":"regex","path":"opt","glob":"opt"} — RE2 search returning path:line:text; use it to pin file:line for every candidate and to run the DRIFT rubric below.\n\n` +
    `AXIS 1 — STRUCTURAL SMELL taxonomy (each smell -> the refactoring that removes it). Map every metric smell.kind onto this taxonomy so the worklist reads in refactoring terms:\n${renderSmellMenu()}\n\n` +
    `AXIS 2 — DRIFT rubric — the metric tool is per-file and CANNOT see these; they are cross-file, so drive each one with grep across SIBLING modules ` +
    `(a known-good pattern applied in one place and SKIPPED in the adjacent place; grep the enforcing pattern, then grep its siblings for the omission):\n${renderDriftMenu()}` +
    priorsBlock +
    `\n\nWork three cost-ordered passes folded into one synthesis: (1) SCAN — call metric over repo/ for the ranked smell->refactoring spine, ` +
    `then walk/read/grep to CONFIRM each candidate and pin it to file:line with its bad metric, and grep sibling modules for each DRIFT check; ` +
    `(2) RANK — order by expected structural-metric improvement per unit of risk (anchored to the metric report's value), high-impact-low-risk first; ` +
    `(3) JUDGE — a distinct grader drops anything that is a rename in disguise, is not behavior-preserving in principle, ` +
    `or cannot land as ONE atomic refactoring-only commit.\n\n` +
    `Return AT MOST 25 candidates, each as a row of this schema:\n${CANDIDATE_SCHEMA}\n\n` +
    `Citation discipline is load-bearing: EVERY candidate must cite at least one file:line you actually read/grepped. If you cannot pin it to a line, do not list it. ` +
    `Never assert a metric delta you cannot tie to the code the metric tool measured.`;

  const r = await ctx.hive.run(task);

  // ── Land the worklist artifact under the sidecar (target repo/ stays pristine) ─
  const worklistPath = `${WORKLIST_DIR}/${isoDate()}-worklist.md`;
  const doc =
    `# Structural refactoring worklist · ${isoDate()}\n\n` +
    `- target: ${target}\n` +
    `- verifier: ${r.verifierActor} (actor≠verifier — the FIND is certified, not rubber-stamped)\n` +
    `- emphasis: HIGH-LEVEL structural + drift (the moat), deliberately NOT cosmetic renames\n` +
    `- axes considered: ${STRUCTURAL_SMELLS.length} structural smells · ${DRIFT_CHECKS.length} drift checks\n` +
    `- priors seeded from Comb: ${priors.length}\n\n` +
    `## Candidate schema\n\nEach ranked candidate below is a row of:\n\n\`\`\`\n${CANDIDATE_SCHEMA}\n\`\`\`\n\n` +
    `## Structural smell taxonomy used\n\n${renderSmellMenu()}\n\n` +
    `## Drift rubric used\n\n${renderDriftMenu()}\n\n` +
    (priors.length ? `## Cross-codebase priors seeded\n\n- ${priors.join("\n- ")}\n\n` : "") +
    `## Ranked candidates\n\n${r.answer}\n`;
  try {
    await ctx.writeRepoFile(worklistPath, doc);
  } catch (e) {
    ctx.log(`worklist write skipped: ${(e as Error).message}`);
  }

  // ── Compounding seam (write side): record the structural patterns as an
  // attested leaf so the NEXT codebase's scan recalls them. Branch = software
  // (TOGAF Software Architecture — structural refactorings live here). ──────────
  await ctx.comb
    .put({
      id: `smell-scout-${isoDate()}`,
      content:
        `Structural worklist (${isoDate()}) for ${target} — ${STRUCTURAL_SMELLS.length} smell taxa + ` +
        `${DRIFT_CHECKS.length} drift checks: ${r.answer.slice(0, 280)}`,
      branch: "software",
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: 0.6,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    scaffold: false,
    worklist: worklistPath,
    smells_considered: STRUCTURAL_SMELLS.length,
    drift_checks: DRIFT_CHECKS.length,
    verifier: r.verifierActor,
    costUSD: r.cost.usd,
  };
});
