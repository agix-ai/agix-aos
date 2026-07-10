// Refactor Surgeon tests — HERMETIC ($0/offline). Asserts the SHAPE:
//   - smoke short-circuits to a governed surface check;
//   - with no candidate the run is a clean no-op (refuses to guess);
//   - with a candidate it runs ONE governed apply pass and lands a change-note in
//     the sidecar. The write tool is wired (agent.json tools + boundary), so a LIVE
//     engine run mutates repo/<source> via that tool; the MockEngine executes no
//     tools, so this hermetic run performs no physical write — it certifies the
//     governed shape only.
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
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-refactor-surgeon-"));
const comb = () => new MemComb({ roster: ["refactor-surgeon/worker/verifier-1"], trustFloor: 0.35 });

describe("refactor-surgeon (proposer / worker)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const { result } = await runAgent("refactor-surgeon", {
      dir: AGENTS, engine: new MockEngine(), comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
  });

  test("no candidate is a clean no-op", async () => {
    const { result } = await runAgent("refactor-surgeon", {
      dir: AGENTS, engine: new MockEngine(), comb: comb(), repoRoot: tmpRepo(),
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-candidate");
  });

  test("a candidate runs one governed apply pass and lands a change-note", async () => {
    const repo = tmpRepo();
    const engine = new MockEngine();
    const { result } = await runAgent("refactor-surgeon", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { candidate: "Extract Subclass from OrderManager", id: "cand-3" } },
    });
    expect(result.ok).toBe(true);
    // applied = the governed pass certified the edit. On a LIVE engine run the worker
    // mutates repo/<source> through the write tool; the MockEngine executes no tools,
    // so this hermetic run makes no physical write — it asserts the governed shape.
    expect(result.applied).toBe(true);
    expect(result.candidate_id).toBe("cand-3");
    expect(existsSync(join(repo, result.change_note as string))).toBe(true);
    // exactly one governed pass ran (the single atomic apply).
    expect(engine.calls.length).toBe(1);
  });
});
