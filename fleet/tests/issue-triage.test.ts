// Issue Triage tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn agent (agents/issue-triage/{agent.ts,agent.json}) against a
// MOCKED governed engine + in-memory Comb, and unit-tests the pure decision functions
// that carry the research doctrine:
//   - majority vote across INDEPENDENT passes (never self-reflection)
//   - deterministic pre-signal outranks the model
//   - out-of-vocabulary proposals are noise and are dropped
//   - sub-majority findings are SURFACED, never silently suppressed
//   - human-taste issues escalate BEFORE inference is spent
//   - dedupe against previously-triaged fingerprints
//   - at rung=shadow, zero host actions
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { preSignal, parsePass, majorityVote, fingerprint, type PassFinding } from "../../agents/issue-triage/agent.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-issue-triage-"));
const comb = () => new MemComb({ roster: ["issue-triage/worker/verifier-1"], trustFloor: 0.35 });

// A pass that votes bug/p1 and declines to escalate.
const BUG_PASS = "LABEL | bug | panic with a stack trace\nPRIORITY | p1 | crashes on fresh install\nESCALATE | no | mechanical";

describe("pure decision functions (the research doctrine)", () => {
  test("preSignal reads what is objectively checkable, without a model", () => {
    const s = preSignal({
      number: 1,
      title: "crash",
      body: "Steps to reproduce:\n1. run it\n\npanic: boom\ngoroutine 1 [running]:\nversion: 0.1.0",
    });
    expect(s.hasRepro).toBe(true);
    expect(s.hasStackTrace).toBe(true);
    expect(s.hasVersion).toBe(true);
    // Has repro AND a trace → not needs-repro.
    expect(s.impliedLabels).not.toContain("needs-repro");
    expect(s.needsHumanTaste).toBe(false);
  });

  test("preSignal implies needs-repro deterministically when there is no repro and no trace", () => {
    const s = preSignal({ number: 2, title: "it broke", body: "doesn't work" });
    expect(s.impliedLabels).toContain("needs-repro");
  });

  test("preSignal flags human-taste territory (API design / behavior / security)", () => {
    expect(preSignal({ number: 3, title: "API design question", body: "" }).needsHumanTaste).toBe(true);
    expect(preSignal({ number: 4, title: "x", body: "possible security vulnerability" }).needsHumanTaste).toBe(true);
    expect(preSignal({ number: 5, title: "typo", body: "small fix" }).needsHumanTaste).toBe(false);
  });

  test("fingerprint is stable and title-normalized (dedupe across runs)", () => {
    const a = fingerprint({ number: 7, title: "Crash  On   Run", body: "x" });
    const b = fingerprint({ number: 7, title: "crash on run", body: "totally different body" });
    expect(a).toBe(b); // same issue, normalized
    expect(a).not.toBe(fingerprint({ number: 8, title: "crash on run", body: "x" }));
  });

  test("parsePass drops out-of-vocabulary labels and malformed lines as noise", () => {
    const f = parsePass("LABEL | bug | real\nLABEL | wontfix-maybe | invented\nnonsense line\nPRIORITY | p9 | bad\nPRIORITY | p2 | ok");
    expect(f.map((x) => x.value)).toEqual(["bug", "p2"]);
  });

  test("majorityVote keeps agreement and SURFACES sub-majority findings (never suppresses)", () => {
    const passes: PassFinding[][] = [
      [{ kind: "LABEL", value: "bug", reason: "" }, { kind: "LABEL", value: "security", reason: "" }],
      [{ kind: "LABEL", value: "bug", reason: "" }],
      [{ kind: "LABEL", value: "bug", reason: "" }],
    ];
    const voted = majorityVote(passes);
    const bug = voted.find((v) => v.value === "bug")!;
    const sec = voted.find((v) => v.value === "security")!;
    expect(bug.majority).toBe(true);
    expect(bug.confidence).toBe(1);
    // The single-pass finding survives in the report as LOW CONFIDENCE — it is not deleted.
    expect(sec.majority).toBe(false);
    expect(sec.votes).toBe(1);
    expect(voted.some((v) => v.value === "security")).toBe(true);
  });

  test("majorityVote cannot be ballot-stuffed by one pass repeating itself", () => {
    const passes: PassFinding[][] = [
      [
        { kind: "LABEL", value: "bug", reason: "" },
        { kind: "LABEL", value: "bug", reason: "" },
        { kind: "LABEL", value: "bug", reason: "" },
      ],
      [{ kind: "LABEL", value: "enhancement", reason: "" }],
    ];
    const bug = majorityVote(passes).find((v) => v.value === "bug")!;
    expect(bug.votes).toBe(1); // one pass, one vote
    expect(bug.majority).toBe(false);
  });
});

describe("issue-triage (proposer / worker)", () => {
  test("smoke short-circuits to one governed surface check (actor!=verifier)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("issue-triage", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
    expect(result.verifier).toBe("issue-triage/worker/verifier-1");
  });

  test("runs N independent passes per issue and lands a proposal; takes ZERO host actions at shadow", async () => {
    const engine = new MockEngine(() => BUG_PASS);
    const repo = tmpRepo();
    const { result } = await runAgent("issue-triage", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { passes: "3" } },
    });

    expect(result.ok).toBe(true);
    expect(result.rung).toBe("shadow");
    // The load-bearing safety property: nothing was done to the code host.
    expect(result.actions_taken).toBe(0);

    // The builtin feed has 3 issues; #102 is human-taste and escalates BEFORE inference,
    // so only 2 issues consume passes → 2 * 3 = 6 governed runs.
    expect(result.governedRuns).toBe(6);
    expect(result.escalated as number).toBeGreaterThanOrEqual(1);

    const proposal = join(repo, result.proposal as string);
    expect(existsSync(proposal)).toBe(true);
    const text = readFileSync(proposal, "utf8");
    expect(text).toContain("Rung: `shadow`");
    expect(text).toContain("Generated by an AI agent"); // AI disclosure (curl's rule)
    expect(text).toContain("ESCALATED to a human"); // #102 API-design issue
  });

  test("escalates a human-taste issue WITHOUT spending any inference on it", async () => {
    const engine = new MockEngine(() => BUG_PASS);
    const repo = tmpRepo();
    const feed = join(repo, "feed.json");
    await Bun.write(feed, JSON.stringify([
      { number: 55, title: "Change default behavior of the autonomy gate", body: "this is a breaking change" },
    ]));
    const { result } = await runAgent("issue-triage", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { feed: "feed.json", passes: "3" } },
    });
    expect(result.escalated).toBe(1);
    // A maintainer's hour is scarce: we did not burn a single model call to decide this.
    expect(result.governedRuns).toBe(0);
    expect(engine.calls.length).toBe(0);
  });

  test("dedupes against previously-triaged fingerprints on a second run", async () => {
    const engine = new MockEngine(() => BUG_PASS);
    const repo = tmpRepo();
    const opts = {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { passes: "1" } },
    };
    const first = await runAgent("issue-triage", opts);
    expect(first.result.deduped).toBe(0);
    expect(first.result.triaged as number).toBeGreaterThan(0);

    const second = await runAgent("issue-triage", { ...opts, engine: new MockEngine(() => BUG_PASS) });
    // Everything the first run recorded is skipped the second time.
    expect(second.result.deduped as number).toBeGreaterThan(0);
    expect(second.result.triaged).toBe(0);
  });

  test("no consensus across passes escalates rather than picking a winner", async () => {
    // Each pass votes a DIFFERENT label → nothing reaches majority with 3 passes.
    let n = 0;
    const answers = ["LABEL | bug | a", "LABEL | enhancement | b", "LABEL | question | c"];
    const engine = new MockEngine(() => answers[n++ % answers.length]);
    const repo = tmpRepo();
    await Bun.write(join(repo, "feed.json"), JSON.stringify([
      { number: 77, title: "Something ambiguous happens", body: "Steps to reproduce: run it. panic: x\n at foo" },
    ]));
    const { result } = await runAgent("issue-triage", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { feed: "feed.json", passes: "3" } },
    });
    expect(result.escalated).toBe(1);
    const text = readFileSync(join(repo, result.proposal as string), "utf8");
    expect(text).toContain("no finding reached majority");
  });
});
