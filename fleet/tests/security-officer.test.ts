// Security Officer tests — HERMETIC ($0/offline, no Go binary, no key, no
// network). They load the real reborn agents/security-officer/agent.ts, run it
// against a MOCKED governed engine + in-memory Comb, and assert:
//   - the deterministic secret/dependency/config scan finds planted evidence;
//   - the narration runs GOVERNED (a DISTINCT verifier certifies — actor!=verifier);
//   - the audit report is CLASSIFICATION ONLY — the raw secret value never leaks;
//   - the audit summary is cached in the Comb, attested;
//   - smoke short-circuits to a single governed surface check;
//   - a clean scan ships a report WITHOUT spending a governed pass.
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
  return mkdtempSync(join(tmpdir(), "agix-secoff-"));
}

// A registered-verifier MemComb so the attested audit leaf actually attests
// (mirrors the Go roster).
function comb(): MemComb {
  return new MemComb({ roster: ["security-officer/worker/verifier-1"], trustFloor: 0.35 });
}

// A shaped-but-fake Anthropic key, built by concatenation so this test's OWN
// source carries no scannable secret literal (the Security Officer scans the repo,
// tests included).
const FAKE_ANTHROPIC_KEY = "sk-ant-" + "A".repeat(40);

describe("security-officer (proposer / worker)", () => {
  test("scans caller-supplied evidence, narrates GOVERNED, writes a value-free audit + caches it", async () => {
    const repo = tmpRepo();
    // A committed .env carrying a live-looking Anthropic key + KEY=VALUE config.
    await Bun.write(join(repo, ".env"), `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\nPORT=3000\n`);
    // A package.json with a wildcard dep + a floating range on a sensitive package.
    await Bun.write(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { axios: "*", jsonwebtoken: "^9.0.0" } }),
    );
    // A workflow granting the broadest token scope.
    await Bun.write(join(repo, ".github/workflows/ci.yml"), "name: ci\npermissions: write-all\njobs: {}\n");

    const engine = new MockEngine(
      () =>
        "The risk surface is dominated by a committed credential shape in the environment file; rotate it and move to a " +
        "secret manager. Dependency pins are loose, including on a security-sensitive package, which is a heuristic " +
        "supply-chain concern. The workflow also grants broad token scope. None of these are exploits, only posture findings.",
    );
    const c = comb();
    const { result } = await runAgent("security-officer", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { args: [".env", "package.json", ".github/workflows/ci.yml"], text: "", flags: {} },
    });

    expect(result.ok).toBe(true);
    // Governed: a DISTINCT verifier certified the narration (actor!=verifier).
    expect(result.verifier).toBe("security-officer/worker/verifier-1");
    expect(result.verifier).not.toBe("security-officer/queen/root");
    expect(result.narrated).toBe(true);
    // Findings: anthropic key (critical) + wildcard + floating + committed-env + broad-perms.
    expect(result.critical as number).toBeGreaterThanOrEqual(1);
    expect(result.findings as number).toBeGreaterThanOrEqual(4);
    expect(result.emailWorthy).toBe(true);
    // Exactly ONE governed unit ran (the narration), for this agent, at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("security-officer");

    // The report was written under the boundary (write=wiki/security-officer/).
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("Security Officer Audit");
    expect(doc).toContain("secrets.anthropic-key");
    expect(doc).toContain("config.workflow-broad-permissions");
    expect(doc).toContain("deps.wildcard-version");
    // CLASSIFICATION, NEVER CONTENT — the raw secret value must not leak into the report.
    expect(doc).not.toContain("A".repeat(40));
    expect(doc).not.toContain(FAKE_ANTHROPIC_KEY);

    // The audit summary was cached in the Comb, attested by the distinct verifier.
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("smoke short-circuits to a single governed surface check ($0, no report)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("security-officer", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: {},
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("security-officer/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });

  test("a clean scan ships a report and does NOT spend a governed pass", async () => {
    const repo = tmpRepo();
    // A pinned, non-sensitive dependency — nothing to flag.
    await Bun.write(join(repo, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }));

    const engine = new MockEngine();
    const { result } = await runAgent("security-officer", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: ["package.json"], text: "", flags: {} },
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toBe(0);
    expect(result.narrated).toBe(false);
    expect(result.verifier).toBeNull();
    // No governed unit spent on a clean run (the report still ships).
    expect(engine.calls.length).toBe(0);
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("No findings. Clean run.");
  });
});
