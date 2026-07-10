// Agix Tester — the code-tester quality guardrail (worker / proposer caste),
// reborn on Bun.
//
// This is the BEHAVIOR layer; identity, trust=proposer, model tiering
// (worker=haiku, verifier=sonnet — the cheap narrator, certified by a DISTINCT
// grader), the boundary (write only wiki/tester/, deny git push/commit), and
// public=true live in the sibling agent.json.
//
// The Tester follows the NARRATOR pattern: a DETERMINISTIC data layer (pass/fail
// counts, durations, per-failure detail, the root-cause tracker) computed by code
// from raw test output — the ground truth — with a cheap LLM TL;DR prepended that
// is FORBIDDEN from touching the numbers. In the reborn contract the narrator is
// run as a GOVERNED hive pass (ctx.hive.run), so a DISTINCT verifier certifies the
// prose (actor≠verifier) — the exact posture the legacy narrator's "use ONLY the
// numbers" system prompt tried to enforce by convention. The deterministic layer
// is authored entirely in TS and never comes from the model.
//
// Faithful reduction of agents/tester/agent.mjs:
//   PORTED — the TAP + node:test spec parser (verbatim, pure), the report
//     composition (deterministic data layer + TL;DR + failures + root-cause
//     tracker), the governed narrator pass, root-cause fingerprinting +
//     recurrence detection, and the --no-narrate / --dry-run / --since /
//     --command / --date flags.
//   PORTED via the governed `exec` tool (previously deferred):
//     1. Live suite EXECUTION. The legacy spawned the repo's real test command via
//        node:child_process. The reborn engine now grants a worker the governed
//        `exec` tool (declared in agent.json + a boundary.exec allowlist), so the
//        Tester runs the suite through a GOVERNED pass (actor≠verifier certifies
//        the run) instead of shelling a child straight from agent.ts — the boundary
//        + tool governance the contract exists to enforce stays intact. The pass
//        surfaces the command's raw stdout/stderr verbatim; the DETERMINISTIC TAP /
//        spec parser then runs over that output in TS, so the numbers are still
//        code-authored ground truth, never the model's. An explicit `--text` (raw
//        TAP) still overrides — the agent CONSUMES supplied output when given it.
//   NOT PORTED (flagged in notPorted[]):
//     2. The full open/resolved root-cause STATE lifecycle. The legacy tracked a
//        rich JSON state file (~/.cache/agix-tester/root-causes.json) with
//        open→resolved transitions, hit_count increments, first/last-seen, and a
//        root_cause slot. Durable failure memory now lives in the governed Comb:
//        each failing fingerprint is recorded as an attested leaf and recurrence is
//        detected by re-reading the Comb (mirroring investigator's symptom cache).
//        The resolved-closeout transition (a leaf can't be tombstoned from here) is
//        the piece that does not survive the reduction.
//     3. Regression EMAIL. The manifest carries an optional SMTP_APP_PASSWORD for a
//        Phase-2 "email on regression" wiring, but the legacy agent.mjs never sent
//        one (no sendEmail call), and the reborn contract has no sendEmail seam — so
//        there is nothing to port, only the config var is preserved for parity.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REPORTS_DIR = "wiki/tester/reports";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// ── Parsed shapes ────────────────────────────────────────────────────────
interface Failure {
  name: string;
  detail: string;
}
interface TestResults {
  pass: number;
  fail: number;
  skip: number;
  total: number;
  failures: Failure[];
  command?: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
}
interface OpenRootCause {
  name: string;
  first_seen: string;
  last_seen: string;
  hit_count: number | string;
  root_cause: string | null;
  recurring: boolean;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const date = flagStr(ctx, "date") || isoDate();

  // ── Smoke short-circuit ──────────────────────────────────────────────
  // A real full test run is slow + may legitimately fail (that is the whole
  // point of the agent), so smoke must NOT depend on it. Instead: exercise the
  // governed surface once (so the ledger path is verified), run the parser
  // against a canned TAP stream (no subprocess), compose the report, write it to
  // the smoke write-root, and return a synthetic pass. Mirrors the Node smoke
  // convention + the mentor/investigator reborn smoke.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the tester narrator surface is live");
    const results = parseTap(CANNED_TAP, "");
    results.command = "(smoke — canned tap, no child process)";
    results.exitCode = 1;
    results.durationMs = 0;
    const report = composeReport({
      date,
      since: null,
      results,
      narrative: "_(smoke — narrator skipped)_",
      openRootCauses: [],
    });
    try {
      await ctx.writeRepoFile(`${REPORTS_DIR}/${date}.md`, report);
    } catch (e) {
      ctx.log(`smoke report write skipped: ${(e as Error).message}`);
    }
    ctx.log("smoke short-circuit · governed surface + tap-parser + report composition verified", {
      verifier: r.verifierActor,
    });
    return { ok: true, smoke: true, verifier: r.verifierActor, passed: results.pass, failed: results.fail };
  }

  // ── Flags (ported from the Node opts) ────────────────────────────────
  const explicitCommand = flagStr(ctx, "command");
  const since = flagStr(ctx, "since");
  const noNarrate = flagBool(ctx, "no-narrate") || flagBool(ctx, "noNarrate");
  const dryRun = flagBool(ctx, "dry-run") || flagBool(ctx, "dryRun");

  // ── 1. Acquire the test output (the deterministic ground truth) ──────
  // Two acquisition paths, both feeding the SAME deterministic parser:
  //   • --text: consume raw TAP / spec output supplied on the invocation (override).
  //   • otherwise: RUN the suite via the governed `exec` tool (a governed pass) and
  //     parse its raw stdout/stderr — the ported live-execution path.
  const supplied = ctx.input.text.trim();
  let results: TestResults;
  let execVerifier: string | null = null;

  if (supplied) {
    results = parseTap(supplied, "");
    results.command = explicitCommand || "(test output supplied to tester; suite not run by exec)";
    results.durationMs = Number(flagStr(ctx, "duration-ms")) || 0;
  } else {
    const command = explicitCommand || (await discoverTestCommand(ctx));
    ctx.log(`running the suite via the governed exec tool: ${command}`);
    const run = await runSuiteViaExec(ctx, command);
    execVerifier = run.verifier;
    results = parseTap(run.raw, "");
    results.command = command;
    results.exitCode = run.exitCode ?? (results.fail > 0 || run.timedOut ? 1 : 0);
    results.timedOut = run.timedOut;
    results.durationMs = Number(flagStr(ctx, "duration-ms")) || run.durationMs || 0;
    // A hung suite is a failure (ported from the legacy SIGKILL timeout handling).
    if (run.timedOut && !results.failures.some((f) => f.name === "(suite timeout)")) {
      results.failures.push({ name: "(suite timeout)", detail: "The test command exceeded its budget and was killed. A hung suite is a failure." });
      results.fail = Math.max(results.fail, results.failures.length);
      results.total = Math.max(results.total, results.pass + results.fail + results.skip);
    }
  }

  // ── 2. Report the parsed counts (deterministic ground truth) ─────────
  ctx.log(
    `parsed: ${results.pass} pass · ${results.fail} fail · ${results.skip} skip (${results.total} total)` +
      (execVerifier ? ` · suite run certified by ${execVerifier}` : ""),
  );

  // The outcome verdict is derived here, once, from the deterministic counts. A
  // zero-result run is NOT a pass — it is an inconclusive/error condition that must
  // fail closed (see computeOutcome). We surface the reason loudly so a zero-result
  // run is never mistaken for a clean suite.
  const outcome = computeOutcome(results);
  const ranNoTests = results.total === 0;
  if (ranNoTests) {
    ctx.log(
      `NO TESTS RAN — 0 results parsed from the suite output → outcome=error (NOT pass). ` +
        `Inconclusive: verify the test command actually executed and produced parseable output.`,
    );
  }

  // ── 3. Recurrence detection (pattern memory is a CACHE, not truth) ───
  // For each failing test, consult the Comb for a prior sighting of the same
  // fingerprint (digits normalized), exactly as investigator re-verifies a
  // cached symptom. A hit marks the failure recurring — a candidate for a
  // structural look, never a silent retry.
  const openRootCauses: OpenRootCause[] = [];
  for (const f of results.failures) {
    const fp = fingerprint(f.name);
    const prior = await ctx.comb.retrieve(fp, 1).catch(() => []);
    const recurring = prior.length > 0;
    openRootCauses.push({
      name: f.name,
      first_seen: date,
      last_seen: date,
      hit_count: recurring ? "≥2" : 1,
      root_cause: null,
      recurring,
    });
  }
  const recurringCount = openRootCauses.filter((r) => r.recurring).length;

  // ── 4. Narrator TL;DR — a GOVERNED pass (the getModel→hive mapping) ──
  // The narrator is the only intelligence call; every legacy
  // runtime.getModel().chat() maps here. --no-narrate skips it entirely and
  // ships the deterministic data alone (no governed pass, so no attestation).
  let narrative = "_(narrator skipped)_";
  let verifier: string | null = null;
  let queen: string | null = null;
  let verified = true;
  let costUSD = 0;

  if (!noNarrate) {
    try {
      const r = await ctx.hive.run(narratorTask(results, openRootCauses));
      narrative = r.answer.trim() || "_(narrator returned empty; deterministic data below is authoritative)_";
      verifier = r.verifierActor;
      queen = r.queenActor;
      verified = r.verified;
      costUSD = r.cost.usd;
    } catch (err) {
      ctx.log(`narrator pass errored (continuing with deterministic data only): ${(err as Error).message}`);
      narrative = `_(narrator pass failed: ${escapeMd((err as Error).message)} — deterministic data below is authoritative)_`;
      verified = false;
    }
  }

  // ── 5. Compose the report ────────────────────────────────────────────
  const report = composeReport({ date, since, results, narrative, openRootCauses });

  // --dry-run: compose + print, write nothing, touch no Comb (ported).
  if (dryRun) {
    ctx.log("dry-run · report composed, NOT written, Comb untouched");
    ctx.log(report);
    return {
      ok: verified && !ranNoTests, // fail closed: a suite that never ran is not ok
      dryRun: true,
      passed: results.pass,
      failed: results.fail,
      total: results.total,
      outcome,
      verifier,
      narrated: !noNarrate,
    };
  }

  // ── 6. Write the report (bounded by boundary.write = wiki/tester/) ───
  const reportRel = `${REPORTS_DIR}/${date}.md`;
  try {
    await ctx.writeRepoFile(reportRel, report);
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── 7. Record each failure to the Comb (durable failure memory) ──────
  // NOT-PORTED #2: this replaces the JSON state file. Each failing fingerprint
  // is recorded as a leaf, attested by the governed run's DISTINCT verifier
  // (actor≠verifier) when we narrated — un-attested provisional knowledge when
  // --no-narrate leaves no verifier to vouch. The Iron Law's root_cause slot is
  // carried as content and stays UNIDENTIFIED until a real investigation fills it.
  let recorded = 0;
  for (const rc of openRootCauses) {
    const fp = fingerprint(rc.name);
    const note = queen && verifier
      ? { author: queen, verifier, trust: 0.5 }
      : {}; // --no-narrate: no governed identity → provisional (un-attested) leaf
    const put = await ctx.comb
      .put({
        id: fp,
        content: `${fp} ${date}: FAILING (root cause: NOT YET IDENTIFIED)${rc.recurring ? " — recurring, structural look" : ""} — ${rc.name}`,
        branch: "software", // TOGAF Software Architecture — defects live here
        ...note,
      })
      .catch((e) => {
        ctx.log(`comb put skipped: ${(e as Error).message}`);
        return null;
      });
    if (put) recorded++;
  }

  ctx.log(`report written: ${reportRel}`, { verifier, failing: results.fail, recurring: recurringCount });

  return {
    ok: verified && !ranNoTests, // fail closed: a suite that never ran (total===0) is not ok
    ran: true,
    passed: results.pass,
    failed: results.fail,
    skipped: results.skip,
    total: results.total,
    outcome,
    open_root_causes: openRootCauses.length,
    recurring: recurringCount,
    recorded,
    narrated: !noNarrate,
    verifier,
    report: reportRel,
    costUSD,
  };
});

// ─── Narrator task (the governed pass's input; persona lives in agent.json) ──
//
// The Go hive folds the manifest instructions (the narrator persona + the Iron
// Law) into every task envelope, so the task carries only the authoritative
// numbers + the ask, exactly like the legacy narrateTldr user message.
function narratorTask(results: TestResults, openRootCauses: OpenRootCause[]): string {
  const recurring = openRootCauses.filter((r) => r.recurring);
  return (
    `Test run summary (these numbers are authoritative — copy them, do not change them):\n` +
    `- command: ${results.command}\n` +
    `- exit code: ${results.exitCode ?? "n/a"}${results.timedOut ? " (TIMED OUT)" : ""}\n` +
    `- pass: ${results.pass}\n` +
    `- fail: ${results.fail}\n` +
    `- skip: ${results.skip}\n` +
    `- total: ${results.total}\n` +
    `- duration_ms: ${results.durationMs ?? 0}\n\n` +
    `Failing tests (${results.failures.length}):\n` +
    `${results.failures.length ? results.failures.map((f, i) => `${i + 1}. ${f.name}`).join("\n") : "(none)"}\n\n` +
    `Open failure fingerprints (${openRootCauses.length}):\n` +
    `${openRootCauses.length ? openRootCauses.map((r) => `- ${r.name} (hit ${r.hit_count}, root_cause: ${r.root_cause ?? "NOT YET IDENTIFIED"})`).join("\n") : "(none)"}\n` +
    `${recurring.length ? `\nRecurring (seen before): ${recurring.length}.` : ""}\n\n` +
    `Write the TL;DR.`
  );
}

// ─── Live suite execution via the governed `exec` tool ───────────────────────
//
// One GOVERNED pass whose worker holds the `exec` tool (declared in agent.json +
// bounded by boundary.exec). It runs the repo's test command and surfaces the raw
// stdout/stderr verbatim; the deterministic parser downstream owns interpretation,
// so the counts stay code-authored, never the model's. A DISTINCT verifier
// certifies the run (actor≠verifier), the same governance every other pass carries.
async function runSuiteViaExec(
  ctx: AgentContext,
  command: string,
): Promise<{ raw: string; exitCode: number | null; timedOut: boolean; durationMs: number; verifier: string }> {
  const task =
    `Run the repository's test suite and capture its output. Use the exec tool to run EXACTLY this command ` +
    `from the repo root:\n\n    ${command}\n\n` +
    `Then return ONLY the command's combined stdout+stderr, verbatim, inside a single fenced code block, ` +
    `followed by a final line: EXIT: <exit code>. Do not summarize, interpret, or add commentary — the raw ` +
    `output is parsed downstream by a deterministic TAP/spec reader.`;
  const r = await ctx.hive.run(task);
  const parsed = extractExecOutput(r.answer);
  return { ...parsed, durationMs: 0, verifier: r.verifierActor };
}

// Discover the repo's test command: --command wins, else package.json scripts.test
// (via the bounded read seam), else `bun test` (the reborn fleet default). Mirrors
// the legacy discoverTestCommand minus the `node --test` fallback (Node is retired).
async function discoverTestCommand(ctx: AgentContext): Promise<string> {
  const pkgRaw = await ctx.readRepoFile("package.json").catch(() => null);
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: { test?: string }; packageManager?: string };
      if (pkg?.scripts?.test) {
        const pm = (pkg.packageManager || "").split("@")[0] || "npm";
        return `${pm} test`;
      }
    } catch {
      /* fall through to the default */
    }
  }
  return "bun test";
}

// Pull the raw command output + exit code out of a governed exec pass answer. The
// worker fences the verbatim output and appends `EXIT: <n>`; we extract the first
// fenced block (else fall back to the whole answer) and the exit code, so the
// deterministic parser sees exactly what the command emitted.
export function extractExecOutput(answer: string): { raw: string; exitCode: number | null; timedOut: boolean } {
  const fence = answer.match(/```[^\n]*\n([\s\S]*?)```/);
  const raw = fence ? fence[1] : answer;
  const exit = answer.match(/EXIT:\s*(-?\d+)/i);
  const exitCode = exit ? Number(exit[1]) : null;
  const timedOut = /\b(timed?\s?out|sigkill|killed after)\b/i.test(answer);
  return { raw, exitCode, timedOut };
}

// ─── Test output parsing (TAP + node:test spec reporter) — ported verbatim ──
//
// We parse two formats so the agent works against whatever the repo's test
// command emits:
//   1. Classic TAP — `# pass N` / `# fail N` / `# tests N` summary and
//      `not ok N - <name>` failure lines (with an optional indented YAML block).
//   2. node:test "spec" reporter — `ℹ pass N` summary lines and `✔`/`✖` marks.
// Summary counters win when present; otherwise per-test marks are counted.
export function parseTap(stdout: string, stderr: string): TestResults {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const lines = text.split("\n");

  let pass: number | null = null;
  let fail: number | null = null;
  let skip: number | null = null;
  let total: number | null = null;
  const failures: (Failure & { fmt?: string })[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Summary counters — TAP (`#`) or spec reporter (`ℹ`).
    const sum = line.replace(/^[#ℹ]\s*/, "");
    if (sum !== line) {
      const mPass = sum.match(/^pass\s+(\d+)/);
      if (mPass) {
        pass = Number(mPass[1]);
        continue;
      }
      const mFail = sum.match(/^fail\s+(\d+)/);
      if (mFail) {
        fail = Number(mFail[1]);
        continue;
      }
      const mSkip = sum.match(/^(?:skipped|skip)\s+(\d+)/);
      if (mSkip) {
        skip = Number(mSkip[1]);
        continue;
      }
      const mTotal = sum.match(/^tests\s+(\d+)/);
      if (mTotal) {
        total = Number(mTotal[1]);
        continue;
      }
    }

    // TAP failure: `not ok N - <name>`.
    const mNotOk = line.match(/^not ok\s+\d+\s*-?\s*(.*)$/);
    if (mNotOk) {
      const name = (mNotOk[1] || "(unnamed)").trim();
      if (/#\s*(SKIP|TODO)\b/i.test(name)) continue; // not a failure
      const detail = collectYamlDetail(lines, i + 1);
      failures.push({ name: stripDirective(name), detail, fmt: "tap" });
    }

    // Spec-reporter failure: `✖ <name> (<duration>)`.
    const mSpecFail = line.match(/^\s*[✖✗]\s+(.*)$/);
    if (mSpecFail) {
      const raw = (mSpecFail[1] || "").trim();
      const hasDuration = /\([\d.]+\s*m?s\)\s*$/.test(raw);
      const isRollup = /^failing tests:?$/i.test(raw);
      if (raw && hasDuration && !isRollup) {
        const name = raw.replace(/\s*\([\d.]+\s*m?s\)\s*$/, "").trim();
        if (name) failures.push({ name, detail: "", fmt: "spec" });
      }
    }
  }

  // De-dupe failures by name; prefer the entry with detail.
  const byName = new Map<string, Failure & { fmt?: string }>();
  for (const f of failures) {
    const prev = byName.get(f.name);
    if (!prev || (!prev.detail && f.detail)) byName.set(f.name, f);
  }
  const dedupedFailures: Failure[] = [...byName.values()].map(({ name, detail }) => ({ name, detail }));

  // Fallback counting if summary counters were absent.
  if (pass === null && fail === null) {
    let okCount = 0;
    let notOkCount = 0;
    for (const line of lines) {
      if (/^ok\s+\d+/.test(line) || /^\s*[✔✓]\s/.test(line)) okCount++;
      else if (/^not ok\s+\d+/.test(line) || /^\s*[✖✗]\s/.test(line)) notOkCount++;
    }
    pass = okCount;
    fail = notOkCount;
  }

  const passN = pass ?? 0;
  const failN = fail ?? dedupedFailures.length;
  const skipN = skip ?? 0;
  const totalN = total ?? passN + failN + skipN;

  return { pass: passN, fail: failN, skip: skipN, total: totalN, failures: dedupedFailures };
}

function stripDirective(name: string): string {
  return name.replace(/\s*#\s*(SKIP|TODO).*$/i, "").trim();
}

// Pull the human-readable failure message out of the TAP YAML block. Bounded to
// ~12 lines so a giant stack trace does not bloat the report.
function collectYamlDetail(lines: string[], start: number): string {
  if (lines[start] === undefined || !/^\s+---\s*$/.test(lines[start])) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && out.length < 12; i++) {
    if (/^\s+\.\.\.\s*$/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out.join(" · ").slice(0, 600);
}

// ─── Root-cause fingerprint (stable key, digits normalized) ──────────────
function fingerprint(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Report composition (deterministic data layer) — ported ──────────────
function composeReport(args: {
  date: string;
  since: string | null;
  results: TestResults;
  narrative: string;
  openRootCauses: OpenRootCause[];
}): string {
  const { date, since, results, narrative, openRootCauses } = args;
  const outcome = computeOutcome(results);
  const icon = outcome === "pass" || outcome === "pass-with-skips" ? "✅" : "🔴";

  const lines: string[] = [];
  // Frontmatter — machine-scannable, mirrors curator/research convention.
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push("agent: tester");
  lines.push(`command: ${jsonScalar(results.command ?? "")}`);
  if (since) lines.push(`since: ${since}`);
  if (results.exitCode !== undefined) lines.push(`exit_code: ${results.exitCode}`);
  lines.push("results:");
  lines.push(`  pass: ${results.pass}`);
  lines.push(`  fail: ${results.fail}`);
  lines.push(`  skip: ${results.skip}`);
  lines.push(`  total: ${results.total}`);
  lines.push(`duration_ms: ${results.durationMs ?? 0}`);
  if (results.timedOut) lines.push("timed_out: true");
  lines.push(`outcome: ${outcome}`);
  lines.push(`open_root_causes: ${openRootCauses.length}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Tester Report · ${date}`);
  lines.push("");

  // ── Narrator TL;DR (LLM half — labeled, never the source of truth) ──
  lines.push("## TL;DR");
  lines.push("");
  lines.push(narrative || "_(none)_");
  lines.push("");

  // ── Deterministic data layer (the ground truth) ──
  lines.push("## Results (deterministic)");
  lines.push("");
  lines.push(`**Outcome**: ${icon} ${outcomeLabel(outcome)}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Command | \`${escapeCell(results.command ?? "")}\` |`);
  if (results.exitCode !== undefined) {
    lines.push(`| Exit code | ${results.exitCode}${results.timedOut ? " (timed out)" : ""} |`);
  }
  lines.push(`| Pass | ${results.pass} |`);
  lines.push(`| Fail | ${results.fail} |`);
  lines.push(`| Skip | ${results.skip} |`);
  lines.push(`| Total | ${results.total} |`);
  lines.push(`| Duration | ${results.durationMs ?? 0} ms |`);
  lines.push("");

  // ── Failures ──
  if (results.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    let n = 0;
    for (const f of results.failures) {
      n++;
      lines.push(`### ${n}. \`${escapeCell(f.name)}\``);
      lines.push("");
      if (f.detail) lines.push(`- **Detail**: ${escapeMd(f.detail)}`);
      lines.push("- **Status**: surfaced for root-cause investigation (not auto-fixed)");
      lines.push("");
    }
  }

  // ── Root-cause tracker ──
  if (openRootCauses.length > 0) {
    lines.push("## Open root-cause tracker");
    lines.push("");
    lines.push("> Iron Law: no fix lands until a root cause is identified here. These");
    lines.push("> fingerprints are SURFACED, not patched. A recurring failure is a");
    lines.push("> candidate for a structural fix, not a retry.");
    lines.push("");
    lines.push("| Test | First seen | Last seen | Hits | Root cause |");
    lines.push("|---|---|---|---|---|");
    for (const r of openRootCauses) {
      lines.push(
        `| \`${escapeCell(r.name)}\` | ${r.first_seen} | ${r.last_seen} | ${r.hit_count} | ${r.root_cause ? escapeCell(r.root_cause) : "_not yet identified_"} |`,
      );
    }
    lines.push("");
  }

  // ── Footer ──
  lines.push("---");
  lines.push("");
  lines.push(
    "_Tester is advisory (Phase 1): it reports and proposes, it never edits source to make a test pass. " +
      "To act on a failure, identify the root cause first, then route the fix through the normal review flow._",
  );
  lines.push("");

  return lines.join("\n");
}

// The outcome verdict — the single machine-scannable signal a CI gate keys on.
// A suite that produced ZERO test results did NOT pass: no test actually ran, which
// is an error/inconclusive condition (a misconfigured command, an empty suite, or a
// governed exec that returned nothing), NOT success. Reporting it as `pass` would let
// a gate ship broken code. This is deliberately DISTINCT from a real run that
// genuinely passed with 0 failures — that has total > 0. Fail closed.
type Outcome = "pass" | "pass-with-skips" | "fail" | "error";
function computeOutcome(results: TestResults): Outcome {
  if (results.total === 0) return "error"; // no tests ran → inconclusive, never pass
  if (results.fail > 0) return "fail";
  if (results.skip > 0) return "pass-with-skips";
  return "pass";
}

function outcomeLabel(outcome: string): string {
  if (outcome === "pass") return "Pass";
  if (outcome === "pass-with-skips") return "Pass (with skips)";
  if (outcome === "error") return "No tests ran (inconclusive)";
  return "Failing tests present";
}

// ─── Small helpers ───────────────────────────────────────────────────────
function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/`/g, "\\`");
}
function escapeMd(s: string): string {
  return String(s).replace(/[*_`|]/g, (c) => "\\" + c);
}
function jsonScalar(s: string): string {
  const str = String(s);
  return /[:#&*?{}[\],]/.test(str) ? JSON.stringify(str) : str;
}

function flagStr(ctx: AgentContext, key: string): string {
  const v = ctx.input.flags[key];
  return typeof v === "string" ? v : "";
}
function flagBool(ctx: AgentContext, key: string): boolean {
  return ctx.input.flags[key] === true || ctx.input.flags[key] === "true";
}

// The smoke canned TAP stream — a fixed 1-pass/1-fail sample so the parser and
// report path are exercised end-to-end with no subprocess.
const CANNED_TAP = [
  "TAP version 13",
  "ok 1 - canned passing test",
  "not ok 2 - canned failing test",
  "  ---",
  "  duration_ms: 1.2",
  "  ...",
  "1..2",
  "# tests 2",
  "# pass 1",
  "# fail 1",
].join("\n");
