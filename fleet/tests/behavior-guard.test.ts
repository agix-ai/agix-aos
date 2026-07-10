// Behavior Guard tests — HERMETIC ($0/offline). Asserts the GATE:
//   - smoke short-circuits to a governed surface check;
//   - no change is a clean no-op;
//   - a change fires the tester, runs the governed certification, derives the three
//     gates, renders APPROVE, and lands a verdict artifact;
//   - a certification that says REFUSE (with a green net) is detected as a refusal;
//   - a touched surface with NO characterization net is REFUSED "no-safety-net"
//     BEFORE the (expensive) certification pass ever runs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-behavior-guard-"));
const comb = () => new MemComb({ roster: ["behavior-guard/worker/verifier-1"], trustFloor: 0.35 });

describe("behavior-guard (verifier posture)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine: new MockEngine(), comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
  });

  test("no change is a clean no-op", async () => {
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine: new MockEngine(), comb: comb(), repoRoot: tmpRepo(),
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-change");
  });

  test("a change fires the tester, certifies the three gates, and lands a verdict", async () => {
    // The single-arg answer is returned for BOTH the tester fire and the cert pass:
    // "behavior preserved" reads as a green net, and APPROVE certifies.
    const engine = new MockEngine(() => "APPROVE — behavior preserved, WMC -4, refactoring-only.");
    const repo = tmpRepo();
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { change: "Extract Subclass; tests green", id: "cand-3" } },
    });
    expect(result.ok).toBe(true);
    expect(result.approved).toBe(true);
    // The tester was actually fired for the behavior signal.
    expect(result.tester_fired).toBe(true);
    expect(engine.calls.some((c) => c.agent === "tester")).toBe(true);
    // The structured verdict carries all three gates.
    expect(Object.keys(result.gates as object).sort()).toEqual([
      "behavior_preserved", "no_tangling", "structure_improved",
    ]);
    // The certification task instructs the governed worker to call the metric tool
    // for the BEFORE/AFTER structural comparison behind the structure_improved gate.
    const certCall = engine.calls.find((c) => c.agent === "behavior-guard");
    expect(certCall?.task).toContain("metric");
    // The verdict artifact landed under the sidecar boundary.
    expect(existsSync(join(repo, result.verdict as string))).toBe(true);
  });

  test("a refusal is detected from the certification (net green, but tangled)", async () => {
    // Tester reports a GREEN net; the certification still REFUSES (tangling), so the
    // refusal comes from the cert pass, not from the no-safety-net short-circuit.
    const engine = new MockEngine((agent) =>
      agent === "tester"
        ? "Characterization tests are green; 14 passing on the touched surface."
        : "REFUSE — the diff smuggles a feature; behavior changed at line 42.",
    );
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(),
      input: { mode: "", args: [], text: "", flags: { change: "Extract Subclass + new endpoint", id: "cand-4" } },
    });
    expect(result.approved).toBe(false);
    expect(result.tester_fired).toBe(true);
    // It reached the certification pass (not short-circuited on no-safety-net).
    expect(result.refusal_reason).not.toBe("no-safety-net");
    expect(engine.calls.some((c) => c.agent === "behavior-guard")).toBe(true);
  });

  test("no characterization net ⇒ REFUSE 'no-safety-net' before the cert pass runs", async () => {
    // Tester reports there is no behavior net for the touched surface.
    const engine = new MockEngine((agent) =>
      agent === "tester"
        ? "No characterization tests found for the touched surface; there is no behavior net."
        : "APPROVE — behavior preserved, refactoring-only.",
    );
    const repo = tmpRepo();
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { change: "Extract Subclass on an untested surface", id: "cand-5" } },
    });
    expect(result.approved).toBe(false);
    expect(result.refusal_reason).toBe("no-safety-net");
    // The tester DID fire (it reported "no tests"); the guard did not take its word.
    expect(result.tester_fired).toBe(true);
    expect(engine.calls.some((c) => c.agent === "tester")).toBe(true);
    // The expensive certification pass was NEVER run (adversarial-cheap posture).
    expect(engine.calls.some((c) => c.agent === "behavior-guard")).toBe(false);
    // A refusal verdict still landed.
    expect(existsSync(join(repo, result.verdict as string))).toBe(true);
  });

  test("APPROVE attests a structured CertifiedRefactoring for the distillation corpus", async () => {
    // Beneath the human-readable summary, the leaf carries a machine-parseable
    // CertifiedRefactoring (core/distill parses it into a rich training example).
    const engine = new MockEngine(() => "APPROVE — behavior preserved, WMC -4, refactoring-only.");
    const c = comb();
    const { result } = await runAgent("behavior-guard", {
      dir: AGENTS, engine, comb: c, repoRoot: tmpRepo(),
      input: {
        mode: "", args: [], text: "",
        flags: { change: "Extract Subclass BillingCalculator", id: "cand-6", codebase: "widgetco" },
      },
    });
    expect(result.approved).toBe(true);
    const leaves = await c.retrieve("Extract Subclass", 5, false);
    const leaf = leaves.find((l) => l.content.includes('"verdict":"APPROVE"'));
    expect(leaf).toBeDefined();
    expect(leaf!.content).toContain('"codebase":"widgetco"');
    expect(leaf!.content).toContain("Extract Subclass BillingCalculator");
  });
});
