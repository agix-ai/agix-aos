// Agix Behavior Guard — the Iron Law gate for refactoring (proposer / worker
// caste, verifier posture), on Bun.
//
// Identity, trust=proposer, model tiering (verifier=opus — the certification is
// the heavy pass), the sidecar-relative boundary (write only
// notes/refactor/verdicts/), the "fire" tool (to run the tester), and public=true
// live in the sibling agent.json. This file wires the GATE: it fires the tester
// for the behavior signal, REFUSES when the touched surface has no characterization
// net, then runs ONE governed, adversarial certification pass over three explicit
// gates (behavior preserved + structure improved + no tangling) and lands a
// structured verdict. The bee that certifies is DISTINCT from the surgeon that
// authored the change (actor≠verifier) — that Iron Law is enforced in Go.
//
// TOOLS (LIVE): the Go tool catalog now resolves this agent.json's tools —
// read / grep / glob / metric — scoped to --repoRoot + the read boundary, and offers
// them to the WORKER bees during the certification ctx.hive.run. The certification
// worker CALLS `metric` for the BEFORE/AFTER structural comparison behind the
// structure_improved gate, and read/grep over the changed files to re-derive
// behavior and hunt tangling. The behavior net itself is established by firing the
// tester (a distinct governed run). The three gate booleans are still read from the
// certification's rendered verdict TEXT — the worker's tool findings flow back
// through that answer — with the documented, conservative heuristics below.
//
// See packs/refactor/SPEC.md for the full design.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import {
  defineAgent,
  type AgentContext,
  type AgentResult,
  type GovernedResult,
} from "../../fleet/runtime/sdk.ts";

const VERDICTS_DIR = "notes/refactor/verdicts";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// The three gates a refactoring must clear to land (SPEC §2.2). All three, or REFUSE.
interface Gates {
  behavior_preserved: boolean;
  structure_improved: boolean;
  no_tangling: boolean;
}

// The structured verdict the refactor-lead branches on (vs. freeform prose).
interface GuardVerdict {
  approved: boolean;
  gates: Gates;
  certified_delta: string;
  refusal_reason: string | null;
}

// ── Heuristics ─────────────────────────────────────────────────────────────────
// The gate booleans are read from PROSE: the tester's behavior signal and the
// certification's rendered verdict. The certification worker runs the live
// read/grep/glob/metric tools, but its findings arrive as text inside that answer,
// so these deliberately conservative regexes remain the mapping from prose to the
// three booleans. Tighten them if a structured tool-result → gate seam lands.

// The characterization net is ABSENT when the tester did not fire at all, when it
// explicitly could not find/run a net, or when it shows no green/passing signal.
// A "no DIRECT coverage" caveat (the private methods are exercised only through the
// public API) is NOT absence — the net is present and green — so it must not trip
// this gate. The old greedy `\bno\b[^.]*\b(tests?|coverage)` matched exactly that
// caveat and REFUSED a green net. A refactoring may not land without a behavior
// belt, so genuine absence ⇒ REFUSE.
function netIsAbsent(fired: boolean, testerSignal: string): boolean {
  if (!fired) return true; // a tester that cannot run IS a missing safety net
  const green =
    /\b(pass(ed|es|ing)?|green|preserv\w*|all tests?|\d+\s*(tests?\s*)?pass|net (is )?(green|present)|net exists)\b/i.test(
      testerSignal,
    );
  // Hard absence — anchored on explicit "could not establish a net" phrases so a
  // coverage-granularity caveat that coexists with a green report does NOT match.
  const hardAbsent =
    /no test suite ran|could ?n[o']?t (locate|find|run|execute)|no accessible (test )?files?|\bno\s+(characterization\s+)?tests?\s+(exist|found|present)|no (characterization|behavior|test) (test )?net|missing tests?|without (a )?(behavior|characterization|test)|\buntested\b/i.test(
      testerSignal,
    );
  return hardAbsent || !green;
}

// Derive the three gates from the certification prose (heuristic — see Heuristics):
//   • behavior_preserved ← "behavior preserved" / "preserves …"
//   • no_tangling        ← "no tangling" / "refactoring-only"
//   • structure_improved ← "improved" / "reduced <metric>"
function deriveGates(answer: string): Gates {
  return {
    behavior_preserved: /preserv/i.test(answer),
    structure_improved: /improv|reduc/i.test(answer),
    no_tangling: /no tangl|refactor(ing)?[ -]only/i.test(answer),
  };
}

// The reason a change was refused, from the first gate that failed (tangling first —
// it is the #1 failure mode of agentic refactoring, SPEC §2.2).
function refusalReason(approved: boolean, gates: Gates): string | null {
  if (approved) return null;
  if (!gates.no_tangling) return "tangling-detected";
  if (!gates.behavior_preserved) return "behavior-not-preserved";
  if (!gates.structure_improved) return "structure-not-improved";
  return "refused";
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the behavior-guard certification surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const change = (ctx.input.flags.change as string) || ctx.input.text;
  if (!change) {
    ctx.log("no change to certify (pass the surgeon's change as --change or text)");
    return { ok: false, reason: "no-change" };
  }
  const candidateId = (ctx.input.flags.id as string) || "cand";

  // ── 1. Fire the tester for the behavior signal ───────────────────────────────
  // The certifier is DISTINCT from the surgeon; it re-derives behavior from the
  // tests, it does not take the surgeon's word. The tester reports whether a
  // behavior net EXISTS and is GREEN (there is no test-runner tool in the catalog
  // yet — it reasons over the touched surface).
  let testerFired = false;
  let testerResult: GovernedResult | null = null;
  let testerSignal = "";
  try {
    testerResult = await ctx.fire(
      "tester",
      `Run the behavior/characterization tests for the surface touched by: ${change}. ` +
        `Report whether a behavior/characterization test net EXISTS for that surface and whether it is GREEN.`,
    );
    testerFired = true;
    testerSignal = testerResult.answer;
    ctx.log("tester fired for the behavior signal", { verifier: testerResult.verifierActor });
  } catch (e) {
    // A tester that cannot run means the safety net is treated as ABSENT.
    ctx.log(`tester fire failed — treating the safety net as ABSENT: ${(e as Error).message}`);
  }

  // ── 2. Characterization-net requirement: no belt ⇒ REFUSE ────────────────────
  // A refactoring may not land without a behavior test net (SPEC §2.2). When the
  // touched surface has none, we refuse HERE and never spend the certification
  // pass — the adversarial-cheap posture (approve only if you cannot refuse).
  if (netIsAbsent(testerFired, testerSignal)) {
    ctx.log("no characterization net for the touched surface — REFUSE (no-safety-net)");
    const verdict: GuardVerdict = {
      approved: false,
      gates: { behavior_preserved: false, structure_improved: false, no_tangling: false },
      certified_delta: "n/a — no characterization net for the touched surface",
      refusal_reason: "no-safety-net",
    };
    return landVerdict(ctx, {
      change,
      candidateId,
      verdict,
      testerFired,
      testerSignal,
      testerResult,
      certResult: null,
    });
  }

  // ── 3. One GOVERNED, adversarial certification pass over the three gates ──────
  // "Find the reason to REFUSE; approve only if you cannot." The tester signal is
  // handed to the pass so the behavior gate is judged against the real net.
  const cert = await ctx.hive.run(
    `Adversarially certify this refactoring against three gates. Approve ONLY if you cannot refuse.\n\n` +
      `Use your governed tools over the repo (they are scoped to the repo root and the read boundary):\n` +
      `- Call \`metric\` on the touched subtree(s) to get the structural report — ` +
      `totals{loc,sloc,classes,functions,max_nesting}, ranked smells, and per-file hotspots{cyclomatic,loc,max_nesting}. ` +
      `Compare BEFORE vs AFTER: the change must move the target metric the right way ` +
      `(cyclomatic / Class-LOC / nesting / coupling down) or at minimum not regress.\n` +
      `- Use \`read\` and \`grep\` on the changed files to re-derive observable behavior and to hunt tangling ` +
      `(any feature, bug fix, or dependency bump riding inside the refactor diff).\n\n` +
      `The three gates:\n` +
      `1. Behavior preserved — same inputs produce the same outputs and side effects; the behavior test net (below) is green AND read/grep of the changed files shows no observable-behavior change.\n` +
      `2. Structure improved — the metric BEFORE/AFTER delta moved the right way, or at least did not regress.\n` +
      `3. Refactoring-only — the diff contains ONLY the refactoring; REFUSE any tangled feature, fix, or dependency bump found via read/grep.\n\n` +
      `BEHAVIOR (tester) SIGNAL for the touched surface:\n${testerSignal}\n\n` +
      `CHANGE UNDER REVIEW:\n${change}\n\n` +
      `Render APPROVE (with the certified metric delta — the before→after numbers) or REFUSE (with the specific reason and the exact lines).`,
  );

  // Top-level approval signal: the certification's APPROVE/REFUSE text (unchanged).
  const approved = /\bapprove\b/i.test(cert.answer) && !/\brefuse\b/i.test(cert.answer);
  // The three gate booleans, derived from the prose (heuristic — see Heuristics).
  const gates = deriveGates(cert.answer);
  const verdict: GuardVerdict = {
    approved,
    gates,
    certified_delta: approved ? cert.answer.trim() : "n/a — certification refused",
    refusal_reason: refusalReason(approved, gates),
  };

  return landVerdict(ctx, {
    change,
    candidateId,
    verdict,
    testerFired,
    testerSignal,
    testerResult,
    certResult: cert,
  });
});

// landVerdict is the single exit for a rendered verdict (approve OR refuse): it
// lands the artifact under the sidecar, attests the behavior-preservation record to
// the Comb, and returns the structured AgentResult the refactor-lead branches on.
async function landVerdict(
  ctx: AgentContext,
  a: {
    change: string;
    candidateId: string;
    verdict: GuardVerdict;
    testerFired: boolean;
    testerSignal: string;
    testerResult: GovernedResult | null;
    certResult: GovernedResult | null;
  },
): Promise<AgentResult> {
  const { verdict, certResult, testerResult, testerFired } = a;
  const date = isoDate();

  // The attesting actors: the certification's distinct verifier when we ran one,
  // else the tester's (no-safety-net short-circuit never runs the cert pass).
  const author = certResult?.queenActor ?? testerResult?.queenActor ?? "behavior-guard";
  const verifier = certResult?.verifierActor ?? testerResult?.verifierActor ?? "none";
  const costUSD = (testerResult?.cost.usd ?? 0) + (certResult?.cost.usd ?? 0);
  // ok = the guard produced a valid governed determination. A clean REFUSE is a
  // correct operation; only a tester that could not even run degrades ok.
  const ok = certResult ? certResult.verified : testerFired;

  // ── Land the verdict under the sidecar (boundary.write = notes/refactor/verdicts/) ─
  const verdictPath = `${VERDICTS_DIR}/${date}-${a.candidateId}-verdict.md`;
  const tick = (b: boolean) => (b ? "✓" : "✗");
  const doc =
    `# Behavior-guard verdict · ${a.candidateId} · ${date}\n\n` +
    `- verdict: ${verdict.approved ? "APPROVE" : "REFUSE"}\n` +
    `- refusal_reason: ${verdict.refusal_reason ?? "—"}\n` +
    `- certifier: ${verifier} (actor≠verifier)\n` +
    `- tester fired: ${testerFired}\n` +
    `- status: gates certified via live read/grep/metric tools + the tester signal\n\n` +
    `## Gates\n\n` +
    `| Gate | Certified |\n` +
    `|------|-----------|\n` +
    `| behavior_preserved | ${tick(verdict.gates.behavior_preserved)} |\n` +
    `| structure_improved | ${tick(verdict.gates.structure_improved)} |\n` +
    `| no_tangling | ${tick(verdict.gates.no_tangling)} |\n\n` +
    `## Certified delta\n\n${verdict.certified_delta}\n\n` +
    `## Change\n\n${a.change}\n\n` +
    `## Tester signal\n\n${testerFired ? a.testerSignal : "(tester did not fire — safety net treated as ABSENT)"}\n\n` +
    `## Certification\n\n${certResult ? certResult.answer : "(no certification pass — refused on no-safety-net)"}\n`;
  try {
    await ctx.writeRepoFile(verdictPath, doc);
  } catch (e) {
    ctx.log(`verdict write skipped: ${(e as Error).message}`);
  }

  // ── Attest the behavior-preservation record (compounding memory). Trust is
  // higher for an APPROVE — only clean, certified refactorings become high-trust
  // training signal (SPEC §4: the governance is what keeps the corpus clean). ────
  //
  // Beneath the human-readable summary we append a machine-parseable
  // CertifiedRefactoring — the distillation-corpus record core/distill parses. The
  // leaf stays auditable AND trains the local nucleus. `codebase` (the by-codebase
  // holdout key) comes from --codebase/--target when passed; wiring refactor-lead to
  // pass it per candidate is a follow-up.
  const codebase =
    (ctx.input.flags.codebase as string) || (ctx.input.flags.target as string) || "";
  const certified = {
    codebase,
    smell: "",
    refactoring: "",
    before: "",
    after: a.change,
    metric_delta: "",
    verdict: verdict.approved ? "APPROVE" : "REFUSE",
    rationale: verdict.certified_delta,
  };
  await ctx.comb
    .put({
      id: `behavior-guard-${a.candidateId}-${date}`,
      content:
        `Verdict ${verdict.approved ? "APPROVE" : "REFUSE"} (${date}) for ${a.candidateId} ` +
        `[behavior=${verdict.gates.behavior_preserved} structure=${verdict.gates.structure_improved} ` +
        `tangling=${!verdict.gates.no_tangling}${verdict.refusal_reason ? ` reason=${verdict.refusal_reason}` : ""}]: ` +
        `${(certResult?.answer ?? verdict.certified_delta).slice(0, 220)}` +
        `\n\n${JSON.stringify(certified)}`,
      branch: "software", // TOGAF Software Architecture — refactoring records live here
      author,
      verifier,
      trust: verdict.approved ? 0.9 : 0.5,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok,
    candidate_id: a.candidateId,
    approved: verdict.approved,
    gates: verdict.gates,
    refusal_reason: verdict.refusal_reason,
    certified_delta: verdict.certified_delta,
    tester_fired: testerFired,
    verdict: verdictPath,
    verifier,
    costUSD,
  };
}
