// release-manager — HERMETIC port test ($0/offline, no Go binary, no key, no
// network). Loads the real reborn agent (agents/release-manager/agent.ts) against a
// MOCKED governed engine + in-memory Comb and asserts:
//   - the run is GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the deterministic four-gate train verdicts (G1 feature-freeze, G2 code-freeze/RC,
//     G3 launch-readiness, G4 rollout), including G3's complete-PRR human co-sign
//     (a clean train lands on overall=HOLD, escalated to G3);
//   - a PRR gap routes G3 to RECYCLE (no human escalation);
//   - a rollout outside its envelope routes G4 to HOLD (escalated);
//   - the dated report is written under the boundary (wiki/release-manager/) and the
//     release record is cached as an ATTESTED Comb leaf;
//   - smoke short-circuits to a single governed surface check.
//
// Mirrors fleet/tests/runner.test.ts (MockEngine + MemComb). Copyright 2026 Agix AI LLC. Apache-2.0.

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
  return mkdtempSync(join(tmpdir(), "agix-fleet-relmgr-"));
}

// A registered-verifier MemComb so the release-record leaf actually attests
// (mirrors the Go roster; the mock engine's verifier is <agent>/worker/verifier-1).
function comb(): MemComb {
  return new MemComb({ roster: ["release-manager/worker/verifier-1"], trustFloor: 0.35 });
}

describe("release-manager (release-train governance gate / proposer)", () => {
  test("a clean canned train runs governed, lands on G3=HOLD (human go/no-go), attests the record", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("release-manager", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: {},
    });

    // governed: a DISTINCT verifier certified the run.
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("release-manager/worker/verifier-1");
    expect(result.queen).toBe("release-manager/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // exactly one governed unit ran, at $0, for this agent (the narrator pass).
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("release-manager");

    // the canned clean train: G1=GO, G2=GO, G3=HOLD (complete PRR → human co-sign), G4=GO.
    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(verdicts["G1-feature-freeze"]).toBe("GO");
    expect(verdicts["G2-code-freeze-rc"]).toBe("GO");
    expect(verdicts["G3-launch-readiness"]).toBe("HOLD");
    expect(verdicts["G4-rollout"]).toBe("GO");
    expect(result.overall).toBe("HOLD");
    expect(result.prr_complete).toBe(true);
    expect(result.rc_is_ship_build).toBe(true);
    expect(result.rollout_within_envelope).toBe(true);
    expect(result.release_date).toBe("2026-07-17");
    expect(result.escalations).toEqual(["G3-launch-readiness"]);

    // the dated report was written under the boundary (wiki/release-manager/).
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("actor≠verifier");
    expect(doc).toContain("G3-launch-readiness");
    expect(doc).toContain("Release Train");

    // the release record was cached as an ATTESTED Comb leaf.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("a PRR gap routes G3 to RECYCLE with no human escalation", async () => {
    const engine = new MockEngine();
    const releaseJson = JSON.stringify({
      readiness: { architecture: true, capacity: true, failureModes: true, monitoring: true, security: false, dependencies: true, rollback: true },
    });
    const { result } = await runAgent("release-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { releaseJson } },
    });

    expect(result.ok).toBe(true);
    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(verdicts["G3-launch-readiness"]).toBe("RECYCLE");
    expect(result.prr_complete).toBe(false);
    // RECYCLE is not a human escalation; G1/G2/G4 stay clean, so overall = RECYCLE.
    expect(result.overall).toBe("RECYCLE");
    expect(result.escalations).toEqual([]);
  });

  test("a rollout outside its envelope routes G4 to HOLD (escalated)", async () => {
    const engine = new MockEngine();
    const releaseJson = JSON.stringify({
      // canary above the ceiling + bake below the minimum → outside the envelope.
      rollout: { canaryPercent: 25, bakeMinutes: 5, abortCriteriaMet: true, maxCanaryPercent: 5, minBakeMinutes: 30 },
    });
    const { result } = await runAgent("release-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { releaseJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(verdicts["G4-rollout"]).toBe("HOLD");
    expect(result.rollout_within_envelope).toBe(false);
    // both G3 (complete canned PRR) and G4 escalate.
    expect(result.escalations).toContain("G4-rollout");
    expect(result.overall).toBe("HOLD");
  });

  test("new scope after feature-freeze routes G1 to RECYCLE", async () => {
    const engine = new MockEngine();
    const releaseJson = JSON.stringify({
      featureFreeze: { frozen: true, newScopeAfterFreeze: ["AGX-999 shiny new tab"] },
    });
    const { result } = await runAgent("release-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { releaseJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(verdicts["G1-feature-freeze"]).toBe("RECYCLE");
    // G3 still HOLD (canned PRR complete), so the worst verdict is HOLD.
    expect(result.overall).toBe("HOLD");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("release-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: {},
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("release-manager/worker/verifier-1");
    // smoke does exactly one governed pass and nothing else.
    expect(engine.calls.length).toBe(1);
  });
});
