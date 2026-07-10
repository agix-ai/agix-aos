// gtm-advisor (proposer / worker) — HERMETIC tests ($0/offline, no Go binary, no
// key, no network). They load the real reborn gtm-advisor (agents/gtm-advisor/
// agent.json + agent.ts), run it against a MOCKED governed engine + in-memory
// Comb, and assert:
//   - the launch decision runs GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the deterministic launch-tiering cores + gate verdicts are faithful (a MINOR
//     canned launch clears; a MAJOR is Tier 1 → M1 HOLD; a tier↔bump mismatch HOLDs);
//   - the dated report is written under the boundary (wiki/gtm-advisor/);
//   - the launch record is cached in the Comb, attested;
//   - smoke short-circuits to a single governed surface check.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-gtm-"));
}

// A registered-verifier MemComb so the launch leaf actually attests (mirrors the
// Go roster: the mock engine's distinct verifier is gtm-advisor/worker/verifier-1).
function comb(): MemComb {
  return new MemComb({ roster: ["gtm-advisor/worker/verifier-1"], trustFloor: 0.35 });
}

describe("gtm-advisor (proposer / worker) — launch-tiering + GTM gate", () => {
  test("the canned MINOR launch clears: Tier 3, all GO, governed + attested", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("gtm-advisor", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { args: [], text: "", flags: {} },
    });

    // Governed: a distinct verifier certified the launch record (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("gtm-advisor/worker/verifier-1");
    expect(result.queen).toBe("gtm-advisor/queen/root");
    expect(result.verifier).not.toBe(result.queen);
    // exactly one governed unit ran (the positioning draft), at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("gtm-advisor");

    // Deterministic cores: MINOR/cxUpdate → Tier 3, matches bump, all gates GO.
    expect(result.tier).toBe(3);
    expect(result.bump).toBe("MINOR");
    expect(result.tier_matches_bump).toBe(true);
    expect(result.overall).toBe("GO");
    expect(result.escalations).toEqual([]);
    expect(result.gate_verdicts).toEqual({ M1: "GO", M2: "GO", M3: "GO", M4: "GO" });

    // The dated report was written under the boundary (wiki/gtm-advisor/).
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(result.report as string).toMatch(/^wiki\/gtm-advisor\//);
    expect(doc).toContain("Tier 3");
    expect(doc).toContain("actor≠verifier");

    // The launch record was cached in the Comb, attested by the distinct verifier.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("a MAJOR launch is Tier 1 → M1 routes to a human co-sign (HOLD)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("gtm-advisor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: {
        args: [],
        text: "",
        flags: { launchJson: JSON.stringify({ release: { bump: "MAJOR" } }) },
      },
    });

    expect(result.ok).toBe(true); // still GOVERNED — the pass verified
    expect(result.verifier).toBe("gtm-advisor/worker/verifier-1");
    expect(result.tier).toBe(1);
    expect(result.bump).toBe("MAJOR");
    expect(result.tier_matches_bump).toBe(true); // Tier 1 IS a valid MAJOR tier…
    // …but a Tier 0/1 launch is a human co-sign: M1 GO is routed to HOLD.
    expect((result.gate_verdicts as Record<string, string>).M1).toBe("HOLD");
    expect(result.overall).toBe("HOLD");
    expect(result.escalations).toContain("M1-tier-assignment");
  });

  test("a tier↔bump MISMATCH (PATCH shipping as a company-defining Tier 0) HOLDs", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("gtm-advisor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: {
        args: [],
        text: "",
        flags: { launchJson: JSON.stringify({ release: { bump: "PATCH", marketDefining: true } }) },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe(0);
    expect(result.bump).toBe("PATCH");
    // Tier 0 is not a valid PATCH tier — the headline mismatch M1 catches.
    expect(result.tier_matches_bump).toBe(false);
    expect((result.gate_verdicts as Record<string, string>).M1).toBe("HOLD");
    expect(result.overall).toBe("HOLD");
    expect(result.escalations).toContain("M1-tier-assignment");
  });

  test("an off-calendar launch (M4) HOLDs when marketing drifts off the release date", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("gtm-advisor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: {
        args: [],
        text: "",
        flags: {
          launchJson: JSON.stringify({
            release: { bump: "MINOR", cxUpdate: true },
            launchSync: { releaseDate: "2026-07-17", marketingDate: "2026-07-24", toleranceDays: 0 },
          }),
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe(3);
    expect((result.gate_verdicts as Record<string, string>).M4).toBe("HOLD");
    expect(result.overall).toBe("HOLD");
    expect(result.escalations).toContain("M4-launch-sync");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const c = comb();
    const { result } = await runAgent("gtm-advisor", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      smoke: true,
      input: { args: [], text: "", flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("gtm-advisor/worker/verifier-1");
    // exactly one governed unit ran; no report, no launch leaf.
    expect(engine.calls.length).toBe(1);
    const stats = await c.stats();
    expect(stats.leaves).toBe(0);
  });
});
