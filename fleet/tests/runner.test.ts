// The core runner tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// They load the real reference agents (mentor, investigator) and the fixture
// agents, run them against a MOCKED governed engine + in-memory Comb, and assert:
//   - every agent executes GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the runner's actor≠verifier tripwire refuses an ungoverned result;
//   - the public-only gate refuses a proprietary agent;
//   - the reference agents orchestrate correctly (modes, fire, the re-verifying
//     Comb symptom cache).

import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine, type EngineDriver, type GovernedResult, type HiveRunOptions } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");
const FIXTURES = join(import.meta.dir, "fixtures");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-fleet-"));
}

// A registered-verifier MemComb so writes actually attest (mirrors the Go roster).
function comb(): MemComb {
  return new MemComb({
    roster: ["mentor/worker/verifier-1", "investigator/worker/verifier-1", "probe/worker/verifier-1"],
    trustFloor: 0.35,
  });
}

describe("governed execution (the core guarantee)", () => {
  test("the probe fixture executes governed — a distinct verifier certifies", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("probe", {
      dir: FIXTURES,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { text: "hello hive" },
    });
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("probe/worker/verifier-1");
    expect(result.queen).toBe("probe/queen/root");
    expect(result.verifier).not.toBe(result.queen);
    // exactly one governed unit of work ran, at $0.
    expect(engine.calls.length).toBe(1);
  });

  test("the actor≠verifier tripwire refuses an ungoverned result", async () => {
    // An engine that collapses the verifier into the queen — the runner must reject.
    const ungoverned: EngineDriver = {
      async run(agent: string, task: string, _opts?: HiveRunOptions): Promise<GovernedResult> {
        return {
          agent,
          verified: true,
          verdict: { approved: true, by: `${agent}/queen/root`, notes: "self-graded" },
          answer: "trust me",
          queenActor: `${agent}/queen/root`,
          verifierActor: `${agent}/queen/root`, // <-- same as queen: NOT governed
          tools: [],
          unresolvedTools: [],
          boundary: [],
          cost: { usd: 0, inputTokens: 0, outputTokens: 0, bees: 1 },
          subtasks: [],
          degraded: [],
        };
      },
    };
    await expect(
      runAgent("probe", { dir: FIXTURES, engine: ungoverned, comb: comb(), repoRoot: tmpRepo(), input: { text: "x" } }),
    ).rejects.toThrow(/actor≠verifier/);
  });

  test("the public-only gate refuses a proprietary agent, allows a public one", async () => {
    const engine = new MockEngine();
    await expect(
      runAgent("proprietary", { dir: FIXTURES, engine, comb: comb(), repoRoot: tmpRepo(), publicOnly: true }),
    ).rejects.toThrow(/proprietary/);
    // ...and never ran a governed unit.
    expect(engine.calls.length).toBe(0);

    // the same runner runs the public probe.
    const ok = await runAgent("probe", { dir: FIXTURES, engine, comb: comb(), repoRoot: tmpRepo(), publicOnly: true });
    expect(ok.result.ok).toBe(true);
  });
});

describe("mentor (conductor / queen)", () => {
  test("goals mode runs a governed synthesis and feeds the Comb", async () => {
    const engine = new MockEngine();
    const c = comb();
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      input: { mode: "goals" },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("goals");
    expect(result.verifier).toBe("mentor/worker/verifier-1");
    // it ran a governed unit and wrote an attested strategy leaf.
    expect(engine.calls[0].agent).toBe("mentor");
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("plan mode fires a whitelisted agent when research is called for", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { mode: "plan", text: "competitive research on cheap-model swarms", args: [], flags: {} },
    });
    expect(result.ok).toBe(true);
    // two governed runs: the plan itself + the fired research sub-run.
    const agents = engine.calls.map((c) => c.agent);
    expect(agents).toContain("mentor");
    expect(agents).toContain("research");
    expect(result.fired).toBe("research/worker/verifier-1");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { mode: "goals" },
    });
    expect(result.smoke).toBe(true);
    expect(engine.calls.length).toBe(1);
  });
});

describe("investigator (proposer / worker)", () => {
  test("runs a governed four-phase pass, writes a diagnosis, caches the symptom", async () => {
    const engine = new MockEngine(
      () => "investigate: build red. analyze: config. hypothesize: 1) bad path. root cause: missing env var. confidence: high",
    );
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: "the build is red at 0 steps: missing ANTHROPIC_API_KEY" },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnosed).toBe(true);
    expect(result.root_cause_identified).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.verifier).toBe("investigator/worker/verifier-1");
    // the diagnosis file was written under the boundary (wiki/investigator/).
    const doc = await Bun.file(join(repo, result.diagnosis as string)).text();
    expect(doc).toContain("actor≠verifier");
    // the symptom was cached, attested.
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("a repeat of the same symptom is recognized as recurring (cache re-verified)", async () => {
    const engine = new MockEngine(() => "root cause: flaky. confidence: medium");
    const c = comb();
    const signal = "timeout after 30000 ms in worker 3";

    const first = await runAgent("investigator", { dir: AGENTS, engine, comb: c, repoRoot: tmpRepo(), input: { text: signal } });
    expect((first.result as { recurring: boolean }).recurring).toBe(false);

    const second = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      // Same symptom SHAPE, different specifics — digits normalize to the same
      // fingerprint, so the symptom cache recognizes it as recurring.
      input: { text: "timeout after 45000 ms in worker 7" },
    });
    expect((second.result as { recurring: boolean }).recurring).toBe(true);
  });
});
