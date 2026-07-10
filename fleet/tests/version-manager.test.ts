// version-manager — HERMETIC port test ($0/offline, no Go binary, no key, no
// network). Loads the real reborn agent (agents/version-manager/agent.ts) against a
// MOCKED governed engine + in-memory Comb and asserts:
//   - the run is GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the deterministic four-gate version verdicts (V1 bump-correctness, V2
//     changelog, V3 deprecation-SLA, V4 artifact-identity), where the canned clean
//     MINOR lands on overall=GO;
//   - THE headline control: a breaking change (removed public API) declared as a
//     MINOR is caught — V1 routes to HOLD with breaking_hidden=true, escalated;
//   - a mislabeled non-breaking bump routes V1 to RECYCLE (no human escalation);
//   - a removal inside its deprecation window routes V3 to HOLD (escalated);
//   - a non-conformant changelog routes V2 to RECYCLE;
//   - the dated report is written under the boundary (wiki/version-manager/) and the
//     version_bump record is cached as an ATTESTED Comb leaf;
//   - smoke short-circuits to a single governed surface check.
//
// Mirrors fleet/tests/release-manager.test.ts (MockEngine + MemComb). Copyright 2026 Agix AI LLC. Apache-2.0.

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
  return mkdtempSync(join(tmpdir(), "agix-fleet-vermgr-"));
}

// A registered-verifier MemComb so the version_bump leaf actually attests (mirrors
// the Go roster; the mock engine's verifier is <agent>/worker/verifier-1).
function comb(): MemComb {
  return new MemComb({ roster: ["version-manager/worker/verifier-1"], trustFloor: 0.35 });
}

describe("version-manager (versioning-semantics gate / proposer)", () => {
  test("a clean canned MINOR runs governed, lands on overall=GO, attests the record", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: {},
    });

    // governed: a DISTINCT verifier certified the run.
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("version-manager/worker/verifier-1");
    expect(result.queen).toBe("version-manager/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // exactly one governed unit ran, at $0, for this agent (the narrator pass).
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("version-manager");
    expect((result.costUSD as number)).toBe(0);

    // the canned clean MINOR: V1=GO, V2=GO, V3=GO, V4=GO → overall GO, no escalations.
    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(verdicts["V1-bump-correctness"]).toBe("GO");
    expect(verdicts["V2-changelog"]).toBe("GO");
    expect(verdicts["V3-deprecation-sla"]).toBe("GO");
    expect(verdicts["V4-artifact-identity"]).toBe("GO");
    expect(result.overall).toBe("GO");
    expect(result.bump).toBe("MINOR");
    expect(result.declared).toBe("MINOR");
    expect(result.scheme).toBe("SemVer");
    expect(result.breaking_hidden).toBe(false);
    expect(result.changelog_valid).toBe(true);
    expect(result.deprecation_compliant).toBe(true);
    expect(result.artifact_identical).toBe(true);
    expect(result.escalations).toEqual([]);

    // the dated report was written under the boundary (wiki/version-manager/).
    expect(result.report).toBe("wiki/version-manager/" + new Date().toISOString().slice(0, 10) + ".md");
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("actor≠verifier");
    expect(doc).toContain("V1-bump-correctness");
    expect(doc).toContain("Version Semantics");

    // the version_bump record was cached as an ATTESTED Comb leaf.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("THE control: a breaking change (removed public API) declared as a MINOR is caught → V1=HOLD, breaking_hidden", async () => {
    const engine = new MockEngine();
    const changeSetJson = JSON.stringify({
      changeSet: { declared: "MINOR", removed: ["oldPublicApi"] },
    });
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { changeSetJson } },
    });

    expect(result.ok).toBe(true);
    const verdicts = result.gate_verdicts as Record<string, string>;
    // the diff warrants a MAJOR; declared MINOR → a MAJOR is masquerading as a MINOR.
    expect(result.bump).toBe("MAJOR");
    expect(result.declared).toBe("MINOR");
    expect(result.breaking_hidden).toBe(true);
    expect(verdicts["V1-bump-correctness"]).toBe("HOLD");
    // a HOLD is a human escalation; it dominates the overall verdict.
    expect(result.overall).toBe("HOLD");
    expect(result.escalations).toContain("V1-bump-correctness");
  });

  test("a mislabeled non-breaking bump routes V1 to RECYCLE (no human escalation)", async () => {
    const engine = new MockEngine();
    // declared MAJOR but the diff is only additive → warrants MINOR, disagrees, non-breaking.
    const changeSetJson = JSON.stringify({
      changeSet: { declared: "MAJOR", added: ["newHelperFn"] },
    });
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { changeSetJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(result.bump).toBe("MINOR");
    expect(result.breaking_hidden).toBe(false);
    expect(verdicts["V1-bump-correctness"]).toBe("RECYCLE");
    // RECYCLE is not a human escalation; the canned changelog/SLA/identity stay GO.
    expect(result.overall).toBe("RECYCLE");
    expect(result.escalations).toEqual([]);
  });

  test("a removal inside its deprecation window routes V3 to HOLD (escalated)", async () => {
    const engine = new MockEngine();
    // deprecated in 0.3.0, removed in 0.3.0 → 0 minor cycles < the 1-cycle policy.
    const changeSetJson = JSON.stringify({
      deprecations: [{ id: "hasty_removal", deprecatedInVersion: "0.3.0", removedInVersion: "0.3.0", notice: true }],
    });
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { changeSetJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(result.deprecation_compliant).toBe(false);
    expect(verdicts["V3-deprecation-sla"]).toBe("HOLD");
    expect(result.escalations).toContain("V3-deprecation-sla");
    expect(result.overall).toBe("HOLD");
  });

  test("a non-conformant changelog routes V2 to RECYCLE", async () => {
    const engine = new MockEngine();
    const changeSetJson = JSON.stringify({ changelogText: "just some freeform release notes, no sections" });
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { changeSetJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(result.changelog_valid).toBe(false);
    expect(verdicts["V2-changelog"]).toBe("RECYCLE");
    // V2 RECYCLE with everything else clean → overall RECYCLE, no escalation.
    expect(result.overall).toBe("RECYCLE");
    expect(result.escalations).toEqual([]);
  });

  test("a rebuild across rings routes V4 to HOLD (build-once/promote-many broken)", async () => {
    const engine = new MockEngine();
    const changeSetJson = JSON.stringify({ rings: { dev: "sha256:aaa", canary: "sha256:aaa", prod: "sha256:zzz" } });
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { flags: { changeSetJson } },
    });

    const verdicts = result.gate_verdicts as Record<string, string>;
    expect(result.artifact_identical).toBe(false);
    expect(verdicts["V4-artifact-identity"]).toBe("HOLD");
    expect(result.escalations).toContain("V4-artifact-identity");
    expect(result.overall).toBe("HOLD");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("version-manager", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: {},
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("version-manager/worker/verifier-1");
    // smoke does exactly one governed pass and nothing else.
    expect(engine.calls.length).toBe(1);
  });
});
