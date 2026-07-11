// PR Reviewer tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Asserts the review core and its COMPOSITION with review-validator:
//   - the unified diff is parsed deterministically (real line numbers, test/risk flags)
//   - risk-path changes escalate BEFORE any inference is spent
//   - a finding outside the diff is out of scope and dropped
//   - majority vote across independent passes; single-pass findings do not survive
//   - a behavior change with no test touched yields a deterministic test-gap finding
//   - the handoff findings.json is exactly review-validator's input shape
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { parseDiff, preSignal, parsePass, inScope, voteFindings, type DiffFile } from "../../agents/pr-reviewer/agent.ts";
// Cross-check the handoff shape against the consumer's own parser.
import { screen as validatorScreen, type Finding as ValidatorFinding } from "../../agents/review-validator/agent.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-pr-reviewer-"));
const comb = () => new MemComb({ roster: ["pr-reviewer/worker/verifier-1"], trustFloor: 0.35 });

const DIFF = `diff --git a/src/order.ts b/src/order.ts
--- a/src/order.ts
+++ b/src/order.ts
@@ -10,3 +10,5 @@ export function total(items) {
   let sum = 0;
   for (const i of items) sum += i.price;
+  const tax = sum * rate;
+  return sum + tax;
 }
`;

const RISK_DIFF = `diff --git a/src/auth/token.ts b/src/auth/token.ts
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const secret = process.env.TOKEN;
`;

describe("parseDiff / preSignal — deterministic, model-free", () => {
  test("counts adds/removes and assigns real new-file line numbers", () => {
    const files = parseDiff(DIFF);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("src/order.ts");
    expect(files[0].added).toBe(2);
    // The two added lines are at new-file lines 12 and 13.
    expect(files[0].addedLines).toEqual([12, 13]);
    expect(files[0].isTest).toBe(false);
  });

  test("flags risk paths and behavior-without-test", () => {
    expect(preSignal(RISK_DIFF).touchesRisk).toBe(true);
    const s = preSignal(DIFF);
    expect(s.behaviorWithoutTest).toBe(true); // code changed, no test file touched
    expect(s.touchesRisk).toBe(false);
  });

  test("a diff that touches a test file is not behavior-without-test", () => {
    const withTest = DIFF + `diff --git a/src/order.test.ts b/src/order.test.ts
--- a/src/order.test.ts
+++ b/src/order.test.ts
@@ -1,1 +1,2 @@
 test("x", () => {});
+test("tax", () => {});
`;
    expect(preSignal(withTest).behaviorWithoutTest).toBe(false);
  });
});

describe("scope + vote", () => {
  const files: DiffFile[] = [{ path: "src/order.ts", added: 2, removed: 0, addedLines: [12, 13], isTest: false, isRisk: false }];

  test("inScope accepts a diff file and rejects an untouched one", () => {
    expect(inScope("src/order.ts:12", files)).toBe(true);
    expect(inScope("src/unrelated.ts:5", files)).toBe(false);
  });

  test("out-of-diff findings never enter the vote", () => {
    const passes = [
      [{ category: "bug", location: "src/order.ts:12", claim: "a" }, { category: "bug", location: "src/elsewhere.ts:9", claim: "b" }],
      [{ category: "bug", location: "src/order.ts:12", claim: "a" }],
      [{ category: "bug", location: "src/order.ts:12", claim: "a" }],
    ];
    const { survived, all } = voteFindings(passes, files);
    expect(survived.length).toBe(1);
    expect(survived[0].evidence).toBe("src/order.ts:12");
    // the elsewhere finding is absent entirely — dropped before voting
    expect(all.some((f) => f.evidence === "src/elsewhere.ts:9")).toBe(false);
  });

  test("a single-pass finding does not survive; a majority one does", () => {
    const passes = [
      [{ category: "bug", location: "src/order.ts:12", claim: "real" }, { category: "perf", location: "src/order.ts:13", claim: "lone" }],
      [{ category: "bug", location: "src/order.ts:12", claim: "real" }],
      [{ category: "bug", location: "src/order.ts:12", claim: "real" }],
    ];
    const { survived, all } = voteFindings(passes, files);
    expect(survived.map((f) => f.category)).toEqual(["bug"]);
    // the lone perf finding is REPORTED (all) but not survived — never silently dropped
    expect(all.find((f) => f.category === "perf")!.votes).toBe(1);
  });

  test("parsePass drops out-of-category and locationless lines", () => {
    const { findings } = parsePass("FINDING | bug | a.ts:1 | real\nFINDING | style | a.ts:2 | noise\nFINDING | bug | | no location\ngarbage");
    expect(findings.length).toBe(1);
    expect(findings[0].category).toBe("bug");
  });
});

describe("handoff shape composes with review-validator", () => {
  test("a survived finding is a valid review-validator Finding", () => {
    const files: DiffFile[] = [{ path: "a.ts", added: 1, removed: 0, addedLines: [1], isTest: false, isRisk: false }];
    const { survived } = voteFindings(
      [[{ category: "bug", location: "a.ts:1", claim: "x" }], [{ category: "bug", location: "a.ts:1", claim: "x" }]],
      files,
    );
    const f = survived[0] as ValidatorFinding;
    // review-validator.screen must accept it (novel, other-authored, in-vocabulary) → null = proceeds.
    expect(validatorScreen(f, "review-validator", new Set())).toBeNull();
    expect(f.author).toBe("pr-reviewer");
    expect(f.id).toBeTruthy();
  });
});

describe("pr-reviewer (proposer / worker)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("pr-reviewer", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("pr-reviewer/worker/verifier-1");
  });

  test("a risk-path diff escalates BEFORE any inference is spent", async () => {
    const engine = new MockEngine(() => "FINDING | bug | src/auth/token.ts:2 | leak");
    const repo = tmpRepo();
    await Bun.write(join(repo, "d.diff"), RISK_DIFF);
    const { result } = await runAgent("pr-reviewer", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { diff: "d.diff" } },
    });
    expect(result.escalated).toBe(true);
    expect(result.governedRuns).toBe(0);
    expect(engine.calls.length).toBe(0); // a maintainer's judgment, not a model's
  });

  test("runs N passes, writes a findings.json handoff, and never posts", async () => {
    const engine = new MockEngine(() => "FINDING | bug | src/order.ts:12 | tax uses an undefined `rate`\nESCALATE | no | mechanical");
    const repo = tmpRepo();
    await Bun.write(join(repo, "d.diff"), DIFF);
    const { result } = await runAgent("pr-reviewer", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { diff: "d.diff", passes: "3" } },
    });
    expect(result.governedRuns).toBe(3);
    expect(result.findings as number).toBeGreaterThanOrEqual(1);
    // The handoff is real JSON in review-validator's shape.
    const handoff = JSON.parse(readFileSync(join(repo, result.handoff as string), "utf8"));
    expect(Array.isArray(handoff)).toBe(true);
    expect(handoff[0].author).toBe("pr-reviewer");
    expect(handoff.some((f: ValidatorFinding) => f.category === "bug")).toBe(true);
    // behavior changed with no test → a deterministic test-gap finding is included
    expect(handoff.some((f: ValidatorFinding) => f.category === "test-gap")).toBe(true);
    expect(existsSync(join(repo, result.report as string))).toBe(true);
  });
});
