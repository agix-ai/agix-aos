// Refactor Lead campaign tests — HERMETIC ($0/offline, no Go binary, no key, no
// network). Loads the real reborn refactor-lead (agents/refactor-lead/agent.ts +
// agent.json), runs it against a MOCKED governed engine + in-memory Comb, and
// asserts the CAMPAIGN ORCHESTRATION:
//   - smoke short-circuits to one governed planning-surface check;
//   - a real campaign FIRES the pack in the governed loop order (scout → branch →
//     surgeon → certify → commit), bounded by --max and worklist exhaustion;
//   - the two artifacts (campaign plan + before/after report) land under the
//     boundary, and campaign learnings attest to the Comb;
//   - a behavior-guard REFUSE reverts the candidate (never commits);
//   - the fire allowlist refuses a non-allowlisted agent.
//
// ctx.fire routes through the SAME MockEngine as ctx.hive.run, so
// `engine.calls.map(c => c.agent)` is the full governed-unit ledger (the lead's
// own planning pass shows up as "refactor-lead"; the fired bees by their name).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { FIRE_ALLOWLIST, assertFireable } from "../../agents/refactor-lead/agent.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-refactor-lead-"));
// Only the lead's own hive.run/comb.put attests (its verifier is on the roster);
// fired bees route through the same engine but never write to the Comb.
const comb = () => new MemComb({ roster: ["refactor-lead/worker/verifier-1"], trustFloor: 0.35 });

// A campaign-shaped MockEngine: the scout returns a ranked structural worklist,
// the behavior-guard APPROVEs, everything else is a generic governed answer.
function campaignEngine(): MockEngine {
  return new MockEngine((agent) => {
    if (agent === "smell-scout")
      return (
        "Ranked structural worklist:\n" +
        "1. Extract Class from PaymentProcessor (payments/processor.ts:12) — WMC -11\n" +
        "2. Split Class on OrderManager (orders/manager.ts:88) — Class-LOC -16\n" +
        "3. Introduce Parameter Object on charge() (payments/charge.ts:5) — params 6->1"
      );
    if (agent === "behavior-guard") return "APPROVE — behavior preserved, structure improved, no tangling.";
    if (agent === "refactor-lead") return "Metric target: bring the top hotspots to the AI-safe code-health floor; re-measure each step.";
    return `mock governed answer [${agent}]`;
  });
}

describe("refactor-lead (conductor / queen)", () => {
  test("smoke short-circuits to one governed planning-surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("refactor-lead", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
    // smoke exercised exactly one governed surface check (the lead's own pass).
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("refactor-lead");
  });

  test("a real campaign fires scout → surgeon → guard in order and lands both artifacts", async () => {
    const engine = campaignEngine();
    const repo = tmpRepo();
    const c = comb();
    const { result } = await runAgent("refactor-lead", {
      dir: AGENTS, engine, comb: c, repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { target: "the payments service" } },
    });

    // governed: verified, a distinct verifier certified the planning pass.
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("refactor-lead/worker/verifier-1");

    // The campaign fired the pack in the governed loop order. Filter out the
    // lead's OWN governed planning pass (hive.run → agent "refactor-lead").
    const firedSeq = engine.calls.map((call) => call.agent).filter((a) => a !== "refactor-lead");
    // baseline scout, then per-candidate: branch → surgeon → certify (→ commit).
    expect(firedSeq.slice(0, 4)).toEqual(["smell-scout", "git-orchestrator", "refactor-surgeon", "behavior-guard"]);
    // the find → apply → certify ordering holds across the whole run.
    const idx = (a: string) => firedSeq.indexOf(a);
    expect(idx("smell-scout")).toBeLessThan(idx("refactor-surgeon"));
    expect(idx("refactor-surgeon")).toBeLessThan(idx("behavior-guard"));

    // three candidates, all APPROVEd → all committed, none reverted.
    expect(result.iterations).toBe(3);
    expect(result.committed).toBe(3);
    expect(result.reverted).toBe(0);

    // result.fired records the pack the lead conducted.
    const firedResult = result.fired as string[];
    for (const bee of ["smell-scout", "refactor-surgeon", "behavior-guard", "git-orchestrator"]) {
      expect(firedResult).toContain(bee);
    }

    // both artifacts landed under the sidecar boundary (plans/refactor/).
    expect(existsSync(join(repo, result.campaign as string))).toBe(true);
    expect(existsSync(join(repo, result.report as string))).toBe(true);
    expect(result.campaign).toContain("plans/refactor/");
    expect(result.report).toContain("plans/refactor/");
    const report = await Bun.file(join(repo, result.report as string)).text();
    expect(report).toContain("committed: 3");
    expect(report).toContain("actor≠verifier");
    const plan = await Bun.file(join(repo, result.campaign as string)).text();
    expect(plan).toContain("Extract Class from PaymentProcessor"); // the scout's worklist landed in the plan

    // campaign learnings attested to the Comb (software branch).
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("--max bounds the campaign and a behavior-guard REFUSE reverts (never commits)", async () => {
    const engine = new MockEngine((agent) => {
      if (agent === "smell-scout")
        return (
          "1. Extract Class from GodService (svc/god.ts:3) — WMC -20\n" +
          "2. Split Class on Foo (svc/foo.ts:9) — Class-LOC -12"
        );
      if (agent === "behavior-guard") return "REFUSE — the diff tangles a behavior change into the refactor.";
      return `mock [${agent}]`;
    });
    const repo = tmpRepo();
    const { result } = await runAgent("refactor-lead", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { target: "svc", max: "1" } },
    });

    // --max=1 caps the loop at one candidate even though the worklist has two.
    expect(result.iterations).toBe(1);
    expect(result.committed).toBe(0);
    expect(result.reverted).toBe(1);
    // on REFUSE the campaign never fires the commit — the only git-orchestrator
    // call is the branch.
    const gitCalls = engine.calls.filter((call) => call.agent === "git-orchestrator");
    expect(gitCalls.length).toBe(1);
  });

  test("the fire allowlist refuses a non-allowlisted agent", () => {
    expect(FIRE_ALLOWLIST).toContain("refactor-surgeon");
    expect(FIRE_ALLOWLIST).toContain("git-orchestrator");
    expect(() => assertFireable("director")).toThrow(/allowlist/i);
    expect(() => assertFireable("smell-scout")).not.toThrow();
  });
});
