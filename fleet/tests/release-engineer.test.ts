// Release Engineer port tests — HERMETIC ($0/offline, no Go binary, no key, no
// network). Loads the real reborn agent (agents/release-engineer/agent.ts) and runs
// it against a MOCKED governed engine + in-memory Comb, asserting:
//   - the run executes GOVERNED (a DISTINCT verifier certifies — actor≠verifier);
//   - smoke short-circuits to a single governed surface check;
//   - the deterministic readiness gate computes GO on a healthy seeded repo and
//     NO-GO (fail-closed) on a bare repo, and writes a bounded readiness report;
//   - the clean-tree gate runs the real `git status --porcelain` through the
//     governed `exec` tool and reports clean vs dirty from its output;
//   - the cursor is persisted as attested Comb memory;
//   - --verify-deploy runs the canned canary (network-free) and folds VERIFIED in.
//
// Mirrors fleet/tests/runner.test.ts style — never touches that file. The one
// governed intelligence pass (the narrator TL;DR) is the only model call, and it
// runs through MockEngine at $0.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-release-engineer-"));
}

// A registered-verifier MemComb so the cursor write actually attests (mirrors the
// Go roster). The mock verifier actor for this agent is release-engineer/worker/verifier-1.
function comb(): MemComb {
  return new MemComb({ roster: ["release-engineer/worker/verifier-1"], trustFloor: 0.35 });
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Seed a repo that passes every BLOCKING gate (tests-green, version-discipline,
// ci-defended) plus the build-present + changelog advisory gates → verdict GO.
function seedHealthyRepo(): string {
  const root = tmpRepo();
  const write = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  write("package.json", JSON.stringify({ name: "agix", version: "1.2.3" }, null, 2));
  write("CHANGELOG.md", "# Changelog\n\n## 1.2.3\n\n- the release under test\n");
  write(".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n");
  write(".github/workflows/deploy-backend.yml", "name: Deploy Backend\non:\n  workflow_run:\n    workflows: [CI]\n");
  // latest tester report (today) — outcome pass, 0 failures.
  write(`wiki/tester/reports/${isoDate()}.md`, `---\ndate: ${isoDate()}\noutcome: pass\nresults:\n  fail: 0\n---\n\nall green\n`);
  // a build-output marker file (advisory build-present gate).
  write("apps/website/.next/BUILD_ID", "abc123\n");
  return root;
}

describe("release-engineer (proposer / worker) — port", () => {
  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("release-engineer", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "" },
    });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
    expect(result.verifier).toBe("release-engineer/worker/verifier-1");
    expect(engine.calls.length).toBe(1); // exactly one governed unit, at $0.
  });

  test("healthy repo → GO, governed narration, bounded report, attested cursor", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = seedHealthyRepo();
    const { result } = await runAgent("release-engineer", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: "" },
    });

    // Governed: a DISTINCT verifier certified the narration (actor≠verifier).
    expect(result.governed).toBe(true);
    expect(result.verifier).toBe("release-engineer/worker/verifier-1");
    expect(result.queen).toBe("release-engineer/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // The deterministic verdict: GO, no blocking gate red → ok (CI-gate semantics).
    expect(result.verdict).toBe("GO");
    expect(result.blocking_red).toBe(0);
    expect(result.ok).toBe(true);

    // two governed passes ran, both for THIS agent, at $0: the clean-tree
    // `git status` exec probe (inside the gate evaluation) and the narrator TL;DR.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].agent).toBe("release-engineer");
    expect(engine.calls[1].agent).toBe("release-engineer");
    expect(result.costUSD).toBe(0);

    // The readiness report was written under the boundary (wiki/release-engineer/readiness/).
    const reportPath = result.report as string;
    expect(reportPath.startsWith("wiki/release-engineer/readiness/")).toBe(true);
    const doc = await Bun.file(join(repo, reportPath)).text();
    expect(doc).toContain("✅ **GO**");
    expect(doc).toContain("actor≠verifier");
    expect(doc).toContain("`ci-defended`");

    // The cursor was persisted as ATTESTED Comb memory.
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("clean-tree gate runs `git status --porcelain` via the governed exec tool and reports clean vs dirty", async () => {
    // Script the governed engine: the clean-tree exec pass (task carries
    // `git status --porcelain`) returns a fenced porcelain listing + EXIT; every
    // other pass (the narrator) returns plain prose.
    const engineFor = (porcelain: string) =>
      new MockEngine((_agent, task) =>
        task.includes("git status --porcelain") ? "```\n" + porcelain + "\n```\nEXIT: 0" : "mock narrator TL;DR",
      );

    // Clean tree: empty porcelain → clean-tree passes.
    const cleanRepo = seedHealthyRepo();
    const clean = await runAgent("release-engineer", {
      dir: AGENTS,
      engine: engineFor(""),
      comb: comb(),
      repoRoot: cleanRepo,
      input: { text: "" },
    });
    expect(clean.result.verdict).toBe("GO"); // advisory gate never blocks
    const cleanDoc = await Bun.file(join(cleanRepo, clean.result.report as string)).text();
    expect(cleanDoc).toContain("working tree clean");

    // Dirty tree: two uncommitted paths → clean-tree fails (advisory, still GO).
    const dirtyRepo = seedHealthyRepo();
    const dirty = await runAgent("release-engineer", {
      dir: AGENTS,
      engine: engineFor(" M package.json\n?? new.txt"),
      comb: comb(),
      repoRoot: dirtyRepo,
      input: { text: "" },
    });
    expect(dirty.result.verdict).toBe("GO");
    expect(dirty.result.advisory_red).toBeGreaterThanOrEqual(1);
    const dirtyDoc = await Bun.file(join(dirtyRepo, dirty.result.report as string)).text();
    expect(dirtyDoc).toContain("working tree DIRTY: 2 uncommitted path(s)");
    expect(dirtyDoc).toContain("package.json");
  });

  test("bare repo → NO-GO (fail closed on the blocking gates), not ok", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("release-engineer", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(), // empty: no package.json, no workflows, no tester report
      input: { text: "" },
    });
    // A release engineer fails CLOSED — unknown is not "ready".
    expect(result.verdict).toBe("NO-GO");
    expect(result.blocking_red).toBeGreaterThanOrEqual(1);
    // Still a governed, successful run — but not an ok gate result (CI would block).
    expect(result.governed).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("--verify-deploy runs the canned canary (network-free) and folds VERIFIED in", async () => {
    const engine = new MockEngine();
    const repo = seedHealthyRepo();
    const { result } = await runAgent("release-engineer", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "", flags: { "verify-deploy": true, "target-url": "https://agix-ai.io" } },
    });
    expect(result.verify_deploy).toBe(true);
    expect(result.deploy_verified).toBe(true);
    // healthy gates + a VERIFIED canary → GO and ok.
    expect(result.verdict).toBe("GO");
    expect(result.ok).toBe(true);

    // The report carries the post-deploy canary section against the given target.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("Post-deploy verification (canary)");
    expect(doc).toContain("https://agix-ai.io/health");
    expect(doc).toContain("✅ **VERIFIED**");
  });
});
