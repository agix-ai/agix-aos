// Tester port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn tester agent (agents/tester/agent.ts) and runs it against
// a MOCKED governed engine + in-memory Comb, asserting:
//   - the narrator runs GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the deterministic data layer (parsed counts, per-failure list, report) is
//     authored in TS and is correct;
//   - a failing fingerprint is recorded to the Comb, attested;
//   - a repeat of the same symptom shape is recognized as recurring;
//   - with NO --text, it RUNS the repo's test command through the governed `exec`
//     tool and parses the real output (the ported live-execution path);
//   - --dry-run composes without writing or touching the Comb;
//   - smoke short-circuits to a single governed surface check.
//
// Also ports the adversarial assertions of the legacy
// agents/tester/eval/tap-parse.suite.mjs (node script, run manually against
// the pre-reborn agent.mjs) directly against the reborn EXPORTED pure
// function `parseTap` from agents/tester/agent.ts — summary-counter parsing,
// the no-summary fallback line-count path, failure-name extraction, SKIP/TODO
// directive exclusion, a clean all-pass run, and stderr being read the same
// as stdout. Two further adversarial categories (bail-out, plan-vs-actual
// mismatch) were probed empirically and found unhandled by the reborn parser
// (and were never asserted by the legacy suite either) — recorded as
// `test.todo` gaps rather than fabricated as passing assertions.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { parseTap } from "../../agents/tester/agent.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-tester-"));
}

// A registered-verifier MemComb so the root-cause writes actually attest.
function comb(): MemComb {
  return new MemComb({ roster: ["tester/worker/verifier-1"], trustFloor: 0.35 });
}

const TAP_1PASS_1FAIL = [
  "TAP version 13",
  "ok 1 - alpha passes",
  "not ok 2 - beta fails",
  "  ---",
  "  error: expected 1 to equal 2",
  "  ...",
  "1..2",
  "# tests 2",
  "# pass 1",
  "# fail 1",
].join("\n");

// A governed engine that answers the exec suite-run pass (task starts with "Run the
// repository's test suite") with a fenced TAP block + EXIT, and the narrator pass
// with plain prose. Proves the tester runs the suite via exec and parses its output.
function execEngine(tapBlock: string, exitCode = 1): MockEngine {
  return new MockEngine((_agent, task) =>
    task.startsWith("Run the repository's test suite")
      ? "```\n" + tapBlock + "\n```\nEXIT: " + exitCode
      : "mock narrator TL;DR — 1 pass, 1 fail.",
  );
}

describe("tester (proposer / worker) — narrator-pattern quality guardrail", () => {
  test("no --text → RUNS the suite via the governed exec tool and parses real pass/fail", async () => {
    const engine = execEngine(TAP_1PASS_1FAIL, 1);
    const c = comb();
    const repo = tmpRepo(); // no package.json → default command `bun test`
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { args: [], flags: {} }, // NO text supplied → live execution path
    });

    // TWO governed passes: the exec suite-run (call 0), then the narrator (call 1).
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].task.startsWith("Run the repository's test suite")).toBe(true);
    expect(engine.calls[0].task).toContain("bun test"); // discovered default command

    // deterministic counts came from the REAL (mock-exec) output, TS-parsed.
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
    expect(result.outcome).toBe("fail");
    expect(result.verifier).toBe("tester/worker/verifier-1");

    // the report records the command it actually ran + the parsed failure.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("bun test");
    expect(doc).toContain("beta fails");
    expect(doc).toContain("| Fail | 1 |");

    // the failure was recorded to the Comb, attested by the distinct verifier.
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("discovers the test command from package.json scripts.test (declared package manager)", async () => {
    const engine = execEngine(TAP_1PASS_1FAIL, 1);
    const repo = tmpRepo();
    await Bun.write(join(repo, "package.json"), JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0", scripts: { test: "vitest" } }));
    await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [], flags: {} },
    });
    expect(engine.calls[0].task).toContain("pnpm test"); // derived from packageManager + scripts.test
  });

  test("--command overrides discovery for the exec run", async () => {
    const engine = execEngine(TAP_1PASS_1FAIL, 0);
    await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { args: [], flags: { command: "go test ./..." } },
    });
    expect(engine.calls[0].task).toContain("go test ./...");
  });

  test("narrates a test run GOVERNED, writes the report, records the failure attested", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: TAP_1PASS_1FAIL, args: [], flags: {} },
    });

    // governed: a DISTINCT verifier certified the narration (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("tester/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("tester");

    // deterministic data layer is TS-authored ground truth — the numbers are real.
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
    expect(result.outcome).toBe("fail");
    expect(result.open_root_causes).toBe(1);

    // the report was written under the boundary (wiki/tester/) and carries both
    // the labeled narrator TL;DR and the deterministic data.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("# Tester Report");
    expect(doc).toContain("## TL;DR");
    expect(doc).toContain("## Results (deterministic)");
    expect(doc).toContain("| Pass | 1 |");
    expect(doc).toContain("| Fail | 1 |");
    expect(doc).toContain("beta fails");

    // the failure was recorded to the Comb, attested by the distinct verifier.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("a repeat of the same symptom SHAPE is recognized as recurring (Comb re-verified)", async () => {
    const engine = new MockEngine();
    const c = comb();

    const first = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      input: { text: tapFail("timeout after 30000 ms in worker 3"), args: [], flags: {} },
    });
    expect(first.result.recurring).toBe(0);

    // same symptom shape, different specifics — digits normalize to one
    // fingerprint, so the second run sees it as recurring.
    const second = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      input: { text: tapFail("timeout after 45000 ms in worker 7"), args: [], flags: {} },
    });
    expect(second.result.recurring).toBe(1);
  });

  test("--dry-run composes the report but writes nothing and touches no Comb", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: TAP_1PASS_1FAIL, args: [], flags: { "dry-run": true } },
    });
    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    // no report file was written...
    expect(await Bun.file(join(repo, "wiki/tester/reports", `${new Date().toISOString().slice(0, 10)}.md`)).exists()).toBe(false);
    // ...and the Comb was left empty.
    const stats = await c.stats();
    expect(stats.leaves).toBe(0);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { args: [], flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("tester/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });
});

// ─── R5 — a suite that never RAN must not report `outcome: pass` ──────────────
// Under a real (non-mock) run the governed exec can return nothing (the suite did
// not execute / echoed the prompt), so the deterministic parser sees ZERO results.
// total===0 must yield a non-pass outcome (error/inconclusive) and fail closed — a
// CI gate keying on `outcome: pass` would otherwise ship broken code. A suite that
// genuinely ran and passed (total>0, 0 fail) must still report `pass`.
describe("tester (R5) — zero-result runs never read as pass", () => {
  const TAP_ALLPASS = [
    "TAP version 13",
    "ok 1 - a",
    "ok 2 - b",
    "ok 3 - c",
    "1..3",
    "# tests 3",
    "# pass 3",
    "# fail 0",
  ].join("\n");

  test("a suite that produced ZERO results is outcome=error and NOT ok (fail closed)", async () => {
    // The governed exec pass returns output with no parseable test results — the
    // real-run hazard: the suite never actually ran, so total === 0.
    const engine = new MockEngine((_agent, task) =>
      task.startsWith("Run the repository's test suite")
        ? "```\n(the suite did not run — no output captured)\n```\nEXIT: 0"
        : "mock narrator TL;DR.",
    );
    const repo = tmpRepo();
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [], flags: {} },
    });

    expect(result.total).toBe(0);
    expect(result.outcome).not.toBe("pass"); // the core R5 guarantee
    expect(result.outcome).toBe("error");
    expect(result.ok).toBe(false); // fail closed → non-zero CLI exit for a CI gate

    // the written report must not read as a clean pass either.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("outcome: error");
    expect(doc).toContain("No tests ran (inconclusive)");
    expect(doc).not.toContain("outcome: pass");
  });

  test("a suite that GENUINELY ran and passed still reports outcome=pass (no false negative)", async () => {
    const engine = execEngine(TAP_ALLPASS, 0);
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { args: [], flags: {} },
    });
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.outcome).toBe("pass"); // a real 0-failure run is still a pass
    expect(result.ok).toBe(true);
  });
});

// ─── R4 — --repoRoot scopes the tool workspace; a bad root fails loud ─────────
// runAgent honors an explicit repoRoot (the sidecar) and NEVER silently falls back
// to CWD. The CLI-side wiring (cmdRun now threads --repoRoot via runFlags) is locked
// in cli-parse.test.ts; this proves the seam it feeds.
describe("tester (R4) — repoRoot scopes the run and fails loud when missing", () => {
  test("an explicit repoRoot scopes the write to THAT dir, not CWD", async () => {
    const engine = execEngine(TAP_1PASS_1FAIL, 1);
    const repo = tmpRepo(); // a fresh dir that is NOT the process CWD
    // Pin a far-future report date so the CWD-leak assertion below is HERMETIC: the
    // report path is wiki/tester/reports/<date>.md, and the real working tree (which
    // IS process.cwd() under `bun test`) legitimately contains a report for TODAY —
    // isoDate() would collide with it and the "did not leak to CWD" check would fail
    // on real repo content, not a real leak. A date no real run will ever write keeps
    // the test measuring only what it means to: scoping to repoRoot vs escaping to CWD.
    const date = "2099-01-01";
    const { result } = await runAgent("tester", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [], flags: { date } },
    });
    // the report landed UNDER the supplied repoRoot...
    expect(await Bun.file(join(repo, result.report as string)).exists()).toBe(true);
    // ...and did NOT leak into the current working directory (the R4 hazard).
    expect(await Bun.file(join(process.cwd(), result.report as string)).exists()).toBe(false);
  });

  test("a supplied repoRoot that does not exist FAILS LOUD (never falls back to CWD)", async () => {
    const missing = join(tmpdir(), `agix-nope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await expect(
      runAgent("tester", {
        dir: AGENTS,
        engine: new MockEngine(),
        comb: comb(),
        repoRoot: missing,
        input: { args: [], flags: {} },
      }),
    ).rejects.toThrow(/repoRoot/);
  });
});

// ─── Ported from agents/tester/eval/tap-parse.suite.mjs ──────────────────────
// The legacy suite exercised `parseTap` (then in agent.mjs) as a standalone
// pure function via 6 hand-rolled adversarial cases. The reborn agent.ts
// exports the identical function, so these are re-expressed as direct,
// hermetic unit assertions against it — no engine, no Comb, no runAgent.
describe("parseTap — ported adversarial assertions (tap-parse.suite.mjs)", () => {
  test("summary-counters: `# pass/# fail/# skip/# tests` are read verbatim", () => {
    const r = parseTap("# pass 3\n# fail 1\n# skip 0\n# tests 4", "");
    expect(r.pass).toBe(3);
    expect(r.fail).toBe(1);
    expect(r.total).toBe(4);
  });

  test("fallback-count: with no summary counters, raw `ok`/`not ok` lines are counted", () => {
    const r = parseTap("ok 1 - a\nok 2 - b\nnot ok 3 - c", "");
    expect(r.pass).toBe(2);
    expect(r.fail).toBe(1);
  });

  test("extracts-failure-name: `not ok N - <name>` captures the name verbatim", () => {
    const r = parseTap("not ok 1 - login should redirect", "");
    expect(r.failures.some((f) => f.name === "login should redirect")).toBe(true);
  });

  // A `# SKIP` directive excludes the line from the failures DETAIL list.
  // Summary counters are present so the no-counter fallback path (which counts
  // raw `not ok` lines and is SKIP-blind) doesn't confound this assertion —
  // that fallback's blindness is a separate, known edge (ported comment from
  // the legacy case).
  test("skip-excluded-from-detail: a `# SKIP` directive is excluded from failures", () => {
    const r = parseTap("# pass 0\n# fail 0\nnot ok 1 - flaky thing # SKIP env", "");
    expect(r.failures.length).toBe(0);
  });

  test("clean-pass: an all-passing summary reports zero failures", () => {
    const r = parseTap("# pass 5\n# fail 0\n# tests 5", "");
    expect(r.fail).toBe(0);
    expect(r.pass).toBe(5);
  });

  test("reads-stderr-too: summary counters on stderr are read the same as stdout", () => {
    const r = parseTap("", "# pass 1\n# fail 0\n# tests 1");
    expect(r.pass).toBe(1);
  });
});

// ─── Extended edge cases (named in the port brief, not literal legacy cases) ──
// TODO-directive exclusion and malformed-line tolerance are real, verified
// behaviors of the reborn parser — asserted as real tests. Bail-out and
// plan-vs-actual mismatch were probed empirically against the reborn
// `parseTap` and found UNHANDLED (confirmed below in commented-out probes);
// the legacy suite never asserted them either, so nothing regressed — they
// are flagged as `test.todo` gaps per the "don't fabricate" instruction
// rather than edited into agent.ts (out of scope: tests-only change).
describe("parseTap — extended edge cases (malformed lines / TODO directive)", () => {
  test("a `# TODO` directive is excluded from the failures list, same as `# SKIP`", () => {
    const r = parseTap("# pass 0\n# fail 0\nnot ok 1 - some pending feature # TODO not implemented", "");
    expect(r.failures.length).toBe(0);
  });

  test("malformed / garbage lines interleaved with real TAP lines are ignored, not mis-counted", () => {
    const r = parseTap(
      "garbage garbage\n???not a tap line at all???\nok 1 - a\nnot ok 2 - b\n#!@$ random\n",
      "",
    );
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    expect(r.failures.some((f) => f.name === "b")).toBe(true);
  });

  // GAP — empirically verified: parseTap("ok 1 - a\nBail out! boom", "") returns
  // { pass: 1, fail: 0, total: 1, failures: [] }. "Bail out!" matches none of
  // the summary/`not ok`/spec-fail regexes, so an aborted suite is silently
  // reported as a clean 1-pass run instead of being surfaced as a failure.
  // Not present in the legacy tap-parse.suite.mjs either (no bail-out case).
  test.todo(
    "bail-out: a `Bail out!` line mid-run should be surfaced as a failure, not silently dropped " +
      "(gap: parseTap has no Bail-out handling; verified empirically, not a port regression)",
  );

  // GAP — empirically verified: parseTap("1..5\nok 1 - a\nok 2 - b", "") returns
  // { pass: 2, fail: 0, total: 2, failures: [] } — the `1..N` plan line is never
  // read, so a suite that declares 5 tests but only emits 2 result lines shows
  // no mismatch signal (3 tests silently vanish rather than counting as missing/failed).
  // Not present in the legacy tap-parse.suite.mjs either (no plan-line case).
  test.todo(
    "plan-vs-actual mismatch: a `1..N` plan line with fewer emitted results than N should be flagged " +
      "(gap: parseTap never reads the plan line; verified empirically, not a port regression)",
  );
});

// Build a minimal TAP stream with a single named failure.
function tapFail(name: string): string {
  return [
    "TAP version 13",
    `not ok 1 - ${name}`,
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 1",
  ].join("\n");
}
