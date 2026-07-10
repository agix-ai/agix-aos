// CI Warden port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the reborn ci-warden agent (agent.json + agent.ts), runs it against a
// MOCKED governed engine + in-memory Comb, and asserts:
//   - it executes GOVERNED (a distinct verifier certifies the narrator TL;DR —
//     actor≠verifier), at $0, in exactly one governed pass;
//   - the network-free budget-exhaustion detector FIRES on the canned signature;
//   - the deterministic workflow cost-audit finds the cost anti-patterns;
//   - the report lands under the boundary (wiki/ci-warden/reports/) and the cursor
//     is persisted as an attested Comb leaf;
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
import { DryRunNotifier } from "../runtime/notify.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-ci-warden-"));
}

// A registered-verifier MemComb so the cursor write actually attests (mirrors the
// Go roster). The MockEngine certifies with <agent>/worker/verifier-1.
function comb(): MemComb {
  return new MemComb({ roster: ["ci-warden/worker/verifier-1"], trustFloor: 0.35 });
}

// A workflow with the cost anti-patterns the audit catches: no concurrency on a
// push+pull_request workflow (critical), push with no branch/path filter (warn,
// warn), two jobs with no timeout (warn).
const LEAKY_WORKFLOW = `name: CI
on:
  push:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;

describe("ci-warden (cost gate / proposer / worker)", () => {
  test("detects budget exhaustion, audits workflows, and narrates GOVERNED", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const notifier = new DryRunNotifier(() => {});
    await Bun.write(join(repo, ".github/workflows/ci.yml"), LEAKY_WORKFLOW);

    const { result } = await runAgent("ci-warden", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier,
      repoRoot: repo,
      input: { args: [], text: "", flags: {} },
    });

    // Governed: a DISTINCT verifier certified the narrator TL;DR (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("ci-warden/worker/verifier-1");
    expect(result.verifier).not.toBe("ci-warden/queen/root");
    // Exactly one governed unit ran (the TL;DR), at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("ci-warden");
    expect(result.costUSD).toBe(0);

    // Headline: the network-free detector FIRES on the canned 0-step signature.
    expect(result.budget_exhausted).toBe(true);
    expect(result.zero_step_failures).toBe(6);
    expect(result.total_runs_checked).toBe(7);
    expect(result.detector_source).toBe("canned");

    // On exhaustion the warden pushes a CRITICAL alert through the governed notify
    // seam (dry-run/queued by default). It was recorded, and `notified` reflects it.
    expect(result.notified).toBe(true);
    expect(notifier.notifications.length).toBe(1);
    expect(notifier.notifications[0].level).toBe("critical");
    expect(notifier.notifications[0].body).toContain("spending-limit-exhaustion signature");

    // Cost-audit found the anti-patterns (1 critical no-concurrency + 3 warn).
    expect(result.workflows_scanned).toBe(1);
    expect(result.findings).toBe(4);
    expect(result.critical).toBe(1);
    expect(result.warn).toBe(3);
    expect(result.estimated_monthly_savings_min).toBeGreaterThan(0);

    // The report landed under the boundary (wiki/ci-warden/reports/) with the
    // deterministic data layer and the governed TL;DR.
    expect(result.report).toBe(`wiki/ci-warden/reports/${new Date().toISOString().slice(0, 10)}.md`);
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("budget_exhausted: true");
    expect(doc).toContain("no-concurrency-control");
    expect(doc).toContain("EXHAUSTED");
    expect(doc).toContain("actor≠verifier");

    // The cursor persisted as an ATTESTED Comb leaf.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("with no workflow files, the detector still fires and the audit is clean", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("ci-warden", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(), // empty repo: no .github/workflows
      input: { args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.budget_exhausted).toBe(true);
    expect(result.workflows_scanned).toBe(0);
    expect(result.findings).toBe(0);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("ci-warden", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { args: [], text: "", flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("ci-warden/worker/verifier-1");
    // No cost-audit, no report, no delta — just the surface check.
    expect(engine.calls.length).toBe(1);
    expect(result.report).toBeUndefined();
  });
});
