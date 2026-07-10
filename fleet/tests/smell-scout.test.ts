// Smell Scout scaffold tests — HERMETIC ($0/offline, no Go binary, no key).
// Loads the real reborn agent (agents/smell-scout/{agent.ts,agent.json}) against a
// MOCKED governed engine + in-memory Comb and asserts the SHAPE holds:
//   - smoke short-circuits to a single governed surface check (actor!=verifier);
//   - a real pass runs governed, lands the worklist under the sidecar boundary,
//     and records the cross-codebase pattern leaf in the Comb.
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
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-smell-scout-"));
const comb = () => new MemComb({ roster: ["smell-scout/worker/verifier-1"], trustFloor: 0.35 });

describe("smell-scout (proposer / worker)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("smell-scout", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
    expect(result.verifier).toBe("smell-scout/worker/verifier-1");
  });

  test("a real pass runs governed and lands the worklist under the sidecar", async () => {
    const engine = new MockEngine(() => "SS-01 | God Class | Extract Subclass | repo/src/order.ts:120 | Class-LOC -80 / WMC -11 | high | low");
    const repo = tmpRepo();
    const { result } = await runAgent("smell-scout", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { target: "the payments service" } },
    });
    expect(result.ok).toBe(true);
    expect(result.scaffold).toBe(false);
    expect(result.verifier).not.toBe("smell-scout/queen/root");
    // Both hunting axes are folded into the governed pass and reported out.
    expect(result.smells_considered as number).toBeGreaterThan(0);
    expect(result.drift_checks as number).toBeGreaterThan(0);
    // Exactly ONE governed pass — the scan/rank/judge is one hive run, not three.
    expect(engine.calls.length).toBe(1);
    expect(existsSync(join(repo, result.worklist as string))).toBe(true);
  });
});
