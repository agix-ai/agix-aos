// Review Validator tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// This agent decides what reaches a maintainer, so its bias must be provably toward silence:
//   - uncertainty defaults to REFUTED (an unparsable verdict is a refutation, ties kill)
//   - it refuses to certify work it authored (actor != verifier, enforced not assumed)
//   - the free stages (category filter, dedupe) run BEFORE any inference is spent
//   - only upheld findings are recorded as posted; refutations are not
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import {
  parseVote, tally, screen, LENSES, FILTERED_CATEGORIES,
  type Finding, type LensVote,
} from "../../agents/review-validator/agent.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-review-validator-"));
const comb = () => new MemComb({ roster: ["review-validator/worker/verifier-1"], trustFloor: 0.35 });

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "src/a.ts:12:null-deref",
  author: "pr-reviewer",
  category: "correctness",
  claim: "possible null dereference",
  evidence: "src/a.ts:12",
  ...over,
});

const UPHELD = "VERDICT | upheld | 0.9 | the cited line does dereference without a guard";
const REFUTED = "VERDICT | refuted | 0.8 | the caller guarantees non-null";

describe("parseVote — uncertainty is a refutation, never an abstention", () => {
  test("parses a well-formed verdict", () => {
    const v = parseVote("correctness", UPHELD);
    expect(v.refuted).toBe(false);
    expect(v.confidence).toBeCloseTo(0.9);
  });

  test("an unparsable answer is REFUTED, not skipped", () => {
    const v = parseVote("correctness", "I think maybe there could be a bug here?");
    expect(v.refuted).toBe(true);
    expect(v.confidence).toBe(0);
    expect(v.reason).toContain("treated as refuted");
  });

  test("confidence is clamped to [0,1]", () => {
    expect(parseVote("correctness", "VERDICT | upheld | 9.5 | x").confidence).toBe(1);
    expect(parseVote("correctness", "VERDICT | upheld | -3 | x").confidence).toBe(0);
    expect(parseVote("correctness", "VERDICT | upheld | banana | x").confidence).toBe(0);
  });
});

describe("tally — majority refutes, and TIES KILL", () => {
  const vote = (refuted: boolean, confidence = 0.5): LensVote =>
    ({ lens: "correctness", refuted, confidence, reason: "" });

  test("no votes at all is a refutation", () => {
    expect(tally([]).refuted).toBe(true);
  });

  test("a majority refutation kills the finding", () => {
    expect(tally([vote(true), vote(true), vote(false)]).refuted).toBe(true);
  });

  test("a minority refutation lets it through", () => {
    expect(tally([vote(true), vote(false), vote(false)]).refuted).toBe(false);
  });

  test("an even split KILLS — uncertainty defaults to refuted", () => {
    expect(tally([vote(true), vote(false)]).refuted).toBe(true);
  });

  test("confidence is the mean across lenses", () => {
    expect(tally([vote(false, 0.6), vote(false, 0.9)]).confidence).toBeCloseTo(0.75);
  });
});

describe("screen — the free stages, before any model runs", () => {
  const empty = new Set<string>();

  test("refuses to certify a finding it authored (actor != verifier)", () => {
    const v = screen(finding({ author: "review-validator" }), "review-validator", empty)!;
    expect(v.outcome).toBe("self-authored");
    expect(v.validated).toBe(false);
    expect(v.reason).toContain("may not certify");
  });

  test("drops filtered categories outright", () => {
    for (const cat of FILTERED_CATEGORIES) {
      const v = screen(finding({ category: cat }), "review-validator", empty)!;
      expect(v.outcome).toBe("filtered");
    }
  });

  test("drops a finding already posted in a previous run", () => {
    const v = screen(finding(), "review-validator", new Set(["src/a.ts:12:null-deref"]))!;
    expect(v.outcome).toBe("duplicate");
  });

  test("passes a novel, in-scope, other-authored finding through to the lenses", () => {
    expect(screen(finding(), "review-validator", empty)).toBeNull();
  });
});

describe("review-validator (distinct verifier)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("review-validator", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("review-validator/worker/verifier-1");
  });

  test("runs one pass PER LENS and upholds a finding all lenses accept", async () => {
    const engine = new MockEngine(() => UPHELD);
    const repo = tmpRepo();
    await Bun.write(join(repo, "f.json"), JSON.stringify([finding()]));
    const { result } = await runAgent("review-validator", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { findings: "f.json" } },
    });
    expect(result.validated).toBe(1);
    expect(result.governedRuns).toBe(LENSES.length);
    // Each pass names exactly one lens, and is told to ignore the others.
    const lensesSeen = LENSES.filter((l) => engine.calls.some((c) => c.task.includes(`${l} lens`)));
    expect(lensesSeen.length).toBe(LENSES.length);
  });

  test("a majority of refuting lenses kills the finding", async () => {
    let n = 0;
    const answers = [REFUTED, REFUTED, UPHELD];
    const engine = new MockEngine(() => answers[n++ % answers.length]);
    const repo = tmpRepo();
    await Bun.write(join(repo, "f.json"), JSON.stringify([finding()]));
    const { result } = await runAgent("review-validator", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { findings: "f.json" } },
    });
    expect(result.validated).toBe(0);
    expect(result.refuted).toBe(1);
  });

  test("the free stages spend ZERO inference", async () => {
    const engine = new MockEngine(() => UPHELD);
    const repo = tmpRepo();
    await Bun.write(join(repo, "f.json"), JSON.stringify([
      finding({ id: "a", category: "typo" }),                       // filtered
      finding({ id: "b", author: "review-validator" }),             // self-authored
    ]));
    const { result } = await runAgent("review-validator", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { findings: "f.json" } },
    });
    expect(result.filtered).toBe(1);
    expect(result.selfAuthored).toBe(1);
    expect(result.governedRuns).toBe(0);
    expect(engine.calls.length).toBe(0);
  });

  test("upheld findings are recorded and deduped on the next run; refuted ones are not", async () => {
    const repo = tmpRepo();
    await Bun.write(join(repo, "f.json"), JSON.stringify([finding()]));
    const opts = {
      dir: AGENTS, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { findings: "f.json" } },
    };
    const first = await runAgent("review-validator", { ...opts, engine: new MockEngine(() => UPHELD) });
    expect(first.result.validated).toBe(1);

    const second = await runAgent("review-validator", { ...opts, engine: new MockEngine(() => UPHELD) });
    expect(second.result.duplicates).toBe(1);
    expect(second.result.validated).toBe(0);
    expect(second.result.governedRuns).toBe(0); // dedupe is free

    const report = readFileSync(join(repo, second.result.report as string), "utf8");
    expect(report).toContain("duplicate");
    expect(existsSync(join(repo, "wiki/oss-steward/state/posted.json"))).toBe(true);
  });

  test("a refuted finding is NOT recorded as posted (re-examining it later is legitimate)", async () => {
    const repo = tmpRepo();
    await Bun.write(join(repo, "f.json"), JSON.stringify([finding()]));
    const opts = {
      dir: AGENTS, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { findings: "f.json" } },
    };
    const first = await runAgent("review-validator", { ...opts, engine: new MockEngine(() => REFUTED) });
    expect(first.result.refuted).toBe(1);
    // Second run must re-examine it, not treat it as already posted.
    const second = await runAgent("review-validator", { ...opts, engine: new MockEngine(() => UPHELD) });
    expect(second.result.duplicates).toBe(0);
    expect(second.result.validated).toBe(1);
  });
});
