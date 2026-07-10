// Onboarding agent tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn onboarding agent (agents/onboarding/agent.ts + agent.json),
// runs it against a MOCKED governed engine + in-memory Comb, and asserts:
//   - the SOURCE-TREE baseline is enumerated via a GOVERNED glob discovery pass, then
//     the audit runs GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - both artifacts (baseline source page + foundation plan) are written under the
//     manifest boundary, with the load-bearing ARCHITECT markers preserved;
//   - the per-repo audit cursor is cached in the Comb, attested;
//   - the email digest (--send) is delivered through the notify seam as EXACTLY ONE
//     dry-run email (recorded, nothing sent), routed to the declared email surface;
//   - smoke short-circuits to a single governed surface check;
//   - the orient (SDLC phase) path GOes cleanly with no repo target;
//   - the citation gate (weaknessesHaveCitations) holds — ported adversarially from
//     the legacy eval/citation-gate.suite.mjs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { DryRunNotifier } from "../runtime/notify.ts";
import { weaknessesHaveCitations, parseSourceTree } from "../../agents/onboarding/agent.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-onboarding-"));
}

// A registered-verifier MemComb so cursor writes actually attest (mirrors the roster).
function comb(): MemComb {
  return new MemComb({ roster: ["onboarding/worker/verifier-1"], trustFloor: 0.35 });
}

describe("onboarding (proposer / worker)", () => {
  // A governed engine that answers the glob DISCOVERY pass with a real 2-file source
  // tree and every other (audit) pass with the synthesis prose. Mirrors the architect
  // discoverEngine harness.
  function auditEngine(files: string[] = [".client-repos/acme/app/api/db.ts", ".client-repos/acme/app/web/page.tsx"]): MockEngine {
    const auditAnswer =
      "1. Product baseline: a SaaS app. 2. Stack: Next.js + Postgres. " +
      "3. Weaknesses: P0-1 no tenant scoping (api/db.ts:42). " +
      "4. Scorecard: Auth + tenancy = Blocker. 5. Foundation Sprint must add row-level tenancy.";
    return new MockEngine((_agent, task) => (task.startsWith("DISCOVERY") ? JSON.stringify({ files }) : auditAnswer));
  }

  test("enumerates the source tree (governed glob), runs the audit, writes both artifacts, caches the cursor", async () => {
    const engine = auditEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { mode: "audit", args: [], text: "", flags: { client: "acme", repos: "https://github.com/acme/app.git", depth: "full" } },
    });

    // governed: verified, a distinct verifier certified it (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("audit");
    expect(result.client_slug).toBe("acme");
    expect(result.verifier).toBe("onboarding/worker/verifier-1");
    expect(result.queen).toBe("onboarding/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // TWO governed units ran at $0: the glob DISCOVERY pass, then the audit pass.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].task.startsWith("DISCOVERY")).toBe(true);
    expect(engine.calls[0].agent).toBe("onboarding");
    expect(engine.calls[1].task).toContain('Audit the "acme" codebase');
    // the audit was GROUNDED in the enumerated source tree.
    expect(engine.calls[1].task).toContain("SOURCE-TREE BASELINE (2 file(s)");
    expect(result.files_inventoried).toBe(2);

    // both artifacts landed under the boundary (wiki/sources + wiki/director/specs).
    const artifacts = result.artifacts as { source: string; spec: string };
    const baseline = await Bun.file(join(repo, artifacts.source)).text();
    const plan = await Bun.file(join(repo, artifacts.spec)).text();
    expect(artifacts.source).toContain("wiki/sources/");
    expect(artifacts.spec).toContain("wiki/director/specs/");
    expect(baseline).toContain("acme — Repo Evaluation");
    expect(baseline).toContain("actor≠verifier");
    expect(baseline).toContain("no tenant scoping"); // the governed synthesis body
    expect(baseline).toContain("Source files inventoried"); // the source-tree baseline row
    // no email was delivered — --send was not requested.
    expect(result.sent).toBe(false);
    expect(result.deliveryMode).toBe("none");
    // the foundation plan preserves the architect-annotatable markers.
    expect(plan).toContain("<!-- ARCHITECT:BEGIN -->");
    expect(plan).toContain("<!-- ARCHITECT:END -->");

    // the wiki log got a single-line append.
    const log = await Bun.file(join(repo, "wiki/log.md")).text();
    expect(log).toContain("onboarding: acme baseline drafted");

    // the per-repo cursor was cached in the Comb, attested.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("--send delivers the digest as EXACTLY ONE dry-run email (recorded, nothing sent)", async () => {
    const engine = auditEngine([".client-repos/acme/app/api/db.ts"]);
    const notifier = new DryRunNotifier(() => {}); // silent; we read .emails back
    const repo = tmpRepo();
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: repo,
      input: { mode: "audit", args: [], text: "", flags: { client: "acme", repos: "https://github.com/acme/app.git", send: true } },
    });

    // Delivery went through the notify seam, DRY-RUN: queued, recorded, NOT sent.
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.deliveryMode).toBe("dry-run");

    // EXACTLY ONE recorded email; no live send happened.
    expect(notifier.emails.length).toBe(1);
    const email = notifier.emails[0];
    expect(email.to).toBe("operator"); // the declared email output surface (mailDefaultTo)
    expect(email.subject).toContain("acme baseline");
    expect(email.body).toContain("no tenant scoping"); // carries the governed synthesis
    expect(email.body).toContain("wiki/sources/"); // links the baseline artifact
  });

  test("--send honors an explicit --to over the default email surface", async () => {
    const engine = auditEngine([".client-repos/acme/app/api/db.ts"]);
    const notifier = new DryRunNotifier(() => {});
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: tmpRepo(),
      input: { mode: "audit", args: [], text: "", flags: { client: "acme", repos: "https://github.com/acme/app.git", send: true, to: "founder@example.com" } },
    });
    expect(result.sent).toBe(false);
    expect(notifier.emails.length).toBe(1);
    expect(notifier.emails[0].to).toBe("founder@example.com");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      smoke: true,
      input: { mode: "audit", args: [], text: "", flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(engine.calls.length).toBe(1);
    // the smoke skeleton exercised the render + bounded-write path.
    const artifacts = result.artifacts as { source: string; spec: string };
    const skeleton = await Bun.file(join(repo, artifacts.source)).text();
    expect(skeleton).toContain("smoke-fake-client — Repo Evaluation");
  });

  test("orient (SDLC phase) with no repo target GOes cleanly", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { args: [], text: "", flags: { phase: "orient" } },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("orient");
    expect(result.verdict).toBe("GO");
    // orient with no target never ran a governed unit.
    expect(engine.calls.length).toBe(0);
  });

  test("audit refuses to run without a --client target", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("onboarding", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { mode: "audit", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing --client");
    // input validation precedes any governed pass — not even the discovery glob ran.
    expect(engine.calls.length).toBe(0);
  });
});

// The citation gate, ported adversarially from agents/onboarding/eval/citation-gate.suite.mjs.
// Every claimed weakness must cite at least one {path, line}; an empty set is vacuously
// OK; one uncited weakness poisons the whole batch. Re-expressed against the reborn
// agent.ts export (weaknessesHaveCitations) — all seven legacy cases, 1:1.
describe("onboarding citation gate (ported from eval/citation-gate.suite.mjs)", () => {
  test("empty-ok: an empty weakness set is vacuously OK", () => {
    expect(weaknessesHaveCitations([])).toBe(true);
  });
  test("valid-citation: a single {path,line} citation passes", () => {
    expect(weaknessesHaveCitations([{ files: [{ path: "src/a.js", line: 12 }] }])).toBe(true);
  });
  test("multi-valid: multiple fully-cited weaknesses pass", () => {
    expect(weaknessesHaveCitations([{ files: [{ path: "a.js", line: 1 }] }, { files: [{ path: "b.js", line: 2 }] }])).toBe(true);
  });
  test("no-files-fails: a weakness with an empty files array fails", () => {
    expect(weaknessesHaveCitations([{ files: [] }])).toBe(false);
  });
  test("missing-line-fails: a citation without a line number fails", () => {
    expect(weaknessesHaveCitations([{ files: [{ path: "a.js" }] }])).toBe(false);
  });
  test("missing-files-fails: a weakness with no files key fails", () => {
    expect(weaknessesHaveCitations([{ title: "x" }])).toBe(false);
  });
  test("one-bad-poisons: one uncited weakness poisons the whole batch", () => {
    expect(weaknessesHaveCitations([{ files: [{ path: "a.js", line: 1 }] }, { files: [] }])).toBe(false);
  });
});

// The source-tree discovery parser — defensive against non-JSON, non-array, and
// out-of-boundary (invented) paths, so a stray path never leaks into the baseline.
describe("onboarding source-tree parse guard (parseSourceTree)", () => {
  test("extracts deduped in-boundary source paths from strict JSON", () => {
    const out = parseSourceTree(
      JSON.stringify({ files: [".client-repos/acme/api/db.ts", ".client-repos/acme/api/db.ts", ".client-repos/acme/web/page.tsx"] }),
    );
    expect(out).toEqual([".client-repos/acme/api/db.ts", ".client-repos/acme/web/page.tsx"]);
  });
  test("drops paths outside the client-repos boundary (no invented paths)", () => {
    const out = parseSourceTree(JSON.stringify({ files: ["/etc/passwd", "wiki/secret.md", ".client-repos/acme/ok.ts"] }));
    expect(out).toEqual([".client-repos/acme/ok.ts"]);
  });
  test("degrades to empty on non-JSON or a missing files array", () => {
    expect(parseSourceTree("sorry, no JSON here")).toEqual([]);
    expect(parseSourceTree(JSON.stringify({ notfiles: 1 }))).toEqual([]);
  });
});
