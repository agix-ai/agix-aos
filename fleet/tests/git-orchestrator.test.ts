// git-orchestrator tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn agent (agents/git-orchestrator) and runs it against a
// MOCKED governed engine + in-memory Comb, asserting:
//   - it executes GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the self-learning core: a fingerprint that recurs to hit_count>=3 emits a
//     structural-fix PROPOSAL, below threshold emits nothing, and a fingerprint
//     already proposed is not re-proposed (don't-pester boundary);
//   - proposals land under the manifest boundary (wiki/git-orchestrator/) and are
//     fed to the Comb as an attested leaf;
//   - the hard invariant merged=0 (this agent never presses the merge button);
//   - the deterministic data layer (fingerprint stability + fix-class taxonomy).
//
// Mirrors fleet/tests/runner.test.ts. Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import {
  FIX_CLASS,
  fingerprintFailure,
  normalizeSignature,
  ladderStatus,
  recurrenceStage,
  classifyFix,
  cannedFailureFeed,
} from "../../agents/git-orchestrator/agent.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-git-orch-"));
}

// A registered-verifier MemComb so proposal leaves actually attest (mirrors the
// Go roster). The MockEngine certifies with `${agent}/worker/verifier-1`.
function comb(): MemComb {
  return new MemComb({ roster: ["git-orchestrator/worker/verifier-1"], trustFloor: 0.35 });
}

describe("git-orchestrator (boundary / drone)", () => {
  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("git-orchestrator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    // exactly one governed unit ran, at $0, with a DISTINCT verifier.
    expect(engine.calls.length).toBe(1);
    expect(result.verifier).toBe("git-orchestrator/worker/verifier-1");
    expect(result.merged).toBe(0);
  });

  test("a run over the failure feed at threshold=1 emits governed structural-fix proposals", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("git-orchestrator", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { flags: { threshold: "1" } },
    });

    expect(result.ok).toBe(true);
    // never merges — the hard boundary.
    expect(result.merged).toBe(0);
    // the 3-event canned feed → 3 fingerprints, all at/over threshold → 3 proposals.
    expect(result.fingerprints).toBe(3);
    expect(result.proposals).toBe(3);

    // every proposal ran a GOVERNED narration pass — a distinct verifier certified.
    expect(engine.calls.length).toBe(3);
    expect(engine.calls.every((x) => x.agent === "git-orchestrator")).toBe(true);
    expect(result.verifier).toBe("git-orchestrator/worker/verifier-1");
    expect(result.verifier).not.toBe("git-orchestrator/queen/root");

    // proposals landed UNDER the manifest boundary (wiki/git-orchestrator/).
    const paths = result.proposal_paths as string[];
    expect(paths.length).toBe(3);
    for (const p of paths) expect(p.startsWith("wiki/git-orchestrator/proposals/")).toBe(true);
    const body = await Bun.file(join(repo, paths[0])).text();
    expect(body).toContain("structural-fix-proposal");
    expect(body).toContain("fingerprint:");
    expect(body).toContain("The merge button is never pressed");

    // the proposals were fed to the Comb as ATTESTED leaves (author≠verifier).
    const stats = await c.stats();
    expect(stats.leaves).toBe(3);
    expect(stats.attested).toBe(3);
  });

  test("the recurrence rule: below threshold emits nothing; hit_count>=3 proposes; then it does not re-pester", async () => {
    const repo = tmpRepo(); // shared repo → durable state accumulates across runs
    const c = comb();

    // Run 1 + 2: each fingerprint seen once, then twice — below the default
    // threshold of 3, so nothing is proposed (log-only, then surface-in-briefing).
    for (let i = 0; i < 2; i++) {
      const engine = new MockEngine();
      const { result } = await runAgent("git-orchestrator", {
        dir: AGENTS,
        engine,
        comb: c,
        repoRoot: repo,
        input: { flags: {} },
      });
      expect(result.ok).toBe(true);
      expect(result.proposals).toBe(0);
      // no proposal ⇒ no governed narration pass this run.
      expect(engine.calls.length).toBe(0);
    }

    // Run 3: hit_count reaches 3 for every fingerprint → structural-fix proposals.
    const engine3 = new MockEngine();
    const third = await runAgent("git-orchestrator", {
      dir: AGENTS,
      engine: engine3,
      comb: c,
      repoRoot: repo,
      input: { flags: {} },
    });
    expect(third.result.proposals).toBe(3);
    expect(third.result.verifier).toBe("git-orchestrator/worker/verifier-1");
    expect(engine3.calls.length).toBe(3);

    // Run 4: same fingerprints, now already covered by an open proposal — the
    // don't-pester boundary means NO new proposals.
    const engine4 = new MockEngine();
    const fourth = await runAgent("git-orchestrator", {
      dir: AGENTS,
      engine: engine4,
      comb: c,
      repoRoot: repo,
      input: { flags: {} },
    });
    expect(fourth.result.proposals).toBe(0);
    expect(engine4.calls.length).toBe(0);
  });

  test("--dry-run computes proposals but writes nothing", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    const { result } = await runAgent("git-orchestrator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { flags: { threshold: "1", "dry-run": true } },
    });
    // it ran the governed narration passes but wrote no proposal files.
    expect(result.proposals).toBe(0);
    expect((result.proposal_paths as string[]).length).toBe(0);
    const wrote = await Bun.file(join(repo, "wiki/git-orchestrator/state/patterns.json")).exists();
    expect(wrote).toBe(false);
  });
});

describe("git-orchestrator deterministic data layer (pure)", () => {
  test("the fingerprint is stable across volatile tokens (same failure on a different PR collapses)", () => {
    const a = fingerprintFailure({
      surface: "ci",
      check: "vitest",
      signature: "vitest hung 18m then shutdown; heap exhausted on PR #500 at 2026-06-18T11:02Z",
    });
    const b = fingerprintFailure({
      surface: "ci",
      check: "vitest",
      signature: "vitest hung 42m then shutdown; heap exhausted on PR #781 at 2026-07-01T09:14Z",
    });
    expect(a).toBe(b);
    // a different surface is a different fingerprint.
    const other = fingerprintFailure({ surface: "merge-queue", check: "vitest", signature: "heap exhausted" });
    expect(other).not.toBe(a);
  });

  test("normalizeSignature strips SHAs, timestamps, PR numbers, durations, and bare numbers", () => {
    const n = normalizeSignature("PR #500 failed at 2026-06-18T11:02Z after 18m on a1b2c3d4 (3 retries)");
    expect(n).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(n).not.toContain("#500");
    expect(n).toContain("#<n>");
  });

  test("the fix-class taxonomy always lands on a structural class, never a patch", () => {
    expect(classifyFix({ signature: "dependent PR auto-closed; branch behind main" })).toBe(FIX_CLASS.ELIMINATE);
    expect(classifyFix({ signature: "lost optimistic-concurrency race against a simultaneous deploy" })).toBe(
      FIX_CLASS.ADMISSION,
    );
    expect(classifyFix({ signature: "some other unclassified failure" })).toBe(FIX_CLASS.PRE_MERGE_GATE);
    // every canned event classifies to one of the three qualifying classes.
    const classes = new Set(Object.values(FIX_CLASS));
    for (const ev of cannedFailureFeed()) expect(classes.has((ev.fix_class ?? classifyFix(ev)) as string)).toBe(true);
  });

  test("the status ladder and recurrence stage encode the 1/2/3+ rule", () => {
    expect(ladderStatus(1, "tentative_1")).toBe("tentative_1");
    expect(ladderStatus(2, "tentative_1")).toBe("confirmed_2+");
    expect(ladderStatus(3, "confirmed_2+")).toBe("structural_candidate_3+");
    // a terminal operator status is never downgraded.
    expect(ladderStatus(9, "accepted_recurring_cost")).toBe("accepted_recurring_cost");
    expect(recurrenceStage(1, 3)).toBe("log-only");
    expect(recurrenceStage(2, 3)).toBe("surface-in-briefing");
    expect(recurrenceStage(3, 3)).toBe("propose-structural-fix");
  });
});

// ─── Ported 1:1 from agents/git-orchestrator/eval/recurrence-ladder.suite.mjs ──
// The legacy suite (`node agents/git-orchestrator/eval/recurrence-ladder.suite.mjs`)
// asserted 17 cases against the recurrence-detection core exported from the Node
// agent.mjs. All 17 exported functions it exercised (normalizeSignature,
// fingerprintFailure, ladderStatus, recurrenceStage, classifyFix) carried over to
// the reborn agent.ts unchanged, so every case reproduces honestly — no test.todo
// gaps. Legacy case ids kept in the test names for direct traceability back to the
// .mjs `cases` array. No agent behavior asserted here beyond what agent.ts already
// exports; this block is pure-function-only and fully hermetic ($0/offline).
describe("git-orchestrator recurrence-ladder (ported from eval/recurrence-ladder.suite.mjs)", () => {
  describe("normalizeSignature — strips volatile tokens so recurrences match", () => {
    test("normalize-sha: two different git SHAs normalize to the same signature", () => {
      expect(normalizeSignature("failed at a1b2c3d4e5f deploy")).toBe(
        normalizeSignature("failed at 9f8e7d6c5b4 deploy"),
      );
    });

    test("normalize-ts: two different ISO timestamps normalize to the same signature", () => {
      expect(normalizeSignature("error 2026-06-18T12:00:00Z x")).toBe(
        normalizeSignature("error 2026-01-02T03:04:05Z x"),
      );
    });

    test("normalize-prnum: two different PR numbers normalize to the same signature", () => {
      expect(normalizeSignature("PR #123 behind main")).toBe(normalizeSignature("PR #999 behind main"));
    });

    test("normalize-keeps-meaning: unrelated failures stay distinct after normalization", () => {
      expect(normalizeSignature("vitest OOM heap")).not.toBe(normalizeSignature("backend smoke 500"));
    });
  });

  describe("fingerprintFailure — same class collapses, different surface diverges", () => {
    test("fp-stable: volatile-only diff (durations/PR#) still fingerprints identically", () => {
      const a = fingerprintFailure({ surface: "ci", check: "vitest", signature: "timeout after 18 min #501" });
      const b = fingerprintFailure({ surface: "ci", check: "vitest", signature: "timeout after 22 min #777" });
      expect(a).toBe(b);
    });

    test("fp-distinct-surface: identical signature on a different surface fingerprints differently", () => {
      const a = fingerprintFailure({ surface: "ci", check: "vitest", signature: "x" });
      const b = fingerprintFailure({ surface: "merge-queue", check: "vitest", signature: "x" });
      expect(a).not.toBe(b);
    });
  });

  describe("ladderStatus — the 1 → 2 → 3+ ladder, and terminal-status protection", () => {
    test("ladder-1: hit_count=1 from tentative_1 stays tentative_1", () => {
      expect(ladderStatus(1, "tentative_1")).toBe("tentative_1");
    });

    test("ladder-2: hit_count=2 escalates to confirmed_2+", () => {
      expect(ladderStatus(2, "tentative_1")).toBe("confirmed_2+");
    });

    test("ladder-3: hit_count=3 escalates to structural_candidate_3+", () => {
      expect(ladderStatus(3, "confirmed_2+")).toBe("structural_candidate_3+");
    });

    test("ladder-keeps-accepted: an operator-set accepted_recurring_cost status is never downgraded", () => {
      expect(ladderStatus(9, "accepted_recurring_cost")).toBe("accepted_recurring_cost");
    });

    test("ladder-keeps-fixed: an operator-set fixed status is never downgraded", () => {
      expect(ladderStatus(9, "fixed")).toBe("fixed");
    });
  });

  describe("recurrenceStage — <2 log-only, ==2 surface, >=threshold propose", () => {
    test("stage-1: hit_count=1 at threshold=3 is log-only", () => {
      expect(recurrenceStage(1, 3)).toBe("log-only");
    });

    test("stage-2: hit_count=2 at threshold=3 surfaces in the briefing", () => {
      expect(recurrenceStage(2, 3)).toBe("surface-in-briefing");
    });

    test("stage-3: hit_count=3 at threshold=3 proposes a structural fix", () => {
      expect(recurrenceStage(3, 3)).toBe("propose-structural-fix");
    });
  });

  describe("classifyFix — always one of the 3 structural classes, never a patch", () => {
    test("fix-stack→eliminate: stacked-PR / behind-main signatures classify as ELIMINATE", () => {
      expect(classifyFix({ signature: "stacked PR auto-close behind main" })).toBe(FIX_CLASS.ELIMINATE);
    });

    test("fix-race→admission: concurrency/race signatures classify as ADMISSION", () => {
      expect(classifyFix({ signature: "optimistic concurrency deploy race" })).toBe(FIX_CLASS.ADMISSION);
    });

    test("fix-default→gate: an unrecognized signature falls back to PRE_MERGE_GATE (never unclassified)", () => {
      expect(classifyFix({ signature: "some other failure" })).toBe(FIX_CLASS.PRE_MERGE_GATE);
    });
  });

  // No-auto-merge / dry-run discipline: the legacy .mjs suite tested ONLY the pure
  // recurrence core above (normalizeSignature/fingerprintFailure/ladderStatus/
  // recurrenceStage/classifyFix) — it carried no assertions on merge behavior or
  // --dry-run. That discipline (merged=0 hard invariant; --dry-run computes but
  // writes nothing) is already exercised end-to-end in the
  // "git-orchestrator (boundary / drone)" describe block above, so nothing here
  // needs a test.todo — there is no legacy assertion left unreproduced.
});
