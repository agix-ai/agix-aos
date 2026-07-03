// Agix Tester — agent logic. The code-tester for consistent quality.
//
// Invoked via `agix agent run tester` (which dispatches through
// lib/agix-runtime.mjs). Responsibilities, in one run:
//
//   1. Discover + run the repo's real test command (manifest default,
//      package.json "scripts.test", or `node --test test/`).
//   2. Parse pass/fail/skip counts + per-failure detail + duration.
//   3. Emit a NARRATOR-pattern report: a deterministic data layer
//      (counts/failures/durations) + a cheap LLM TL;DR prepend that
//      never touches the numbers. Written to wiki/tester/reports/<date>.md.
//   4. On failure, record each failing test for root-cause tracking
//      (readState/writeState) rather than proposing a fix blindly. The
//      Iron Law: no fix without identifying the root cause first.
//
// Trust level: proposer. Tester surfaces failures and proposes; it never
// edits source to make a test pass. Advisory in Phase 1 — never blocks a
// commit or a deploy. Promotion to a pre-merge gate happens after a clean
// calibration week.
//
// Flags:
//   --command "<cmd>"   Override the test command (e.g. "pnpm test").
//   --since <ref>       Annotate the report with the git range under test.
//   --no-narrate        Skip the LLM TL;DR; write the deterministic data only.
//   --dry-run           Run the suite + compose the report, print to stdout,
//                       write nothing, touch no state.
//   --date <YYYY-MM-DD> Override the date in the report filename.
//
// Persona / spec: agents/tester/PERSONA.md
// Discoveries lineage: wiki/research/agentic-discoveries-2026-06-18.md §1 (narrator), §6 (root-cause-before-fix)

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPORT_REL_DIR = 'wiki/tester/reports';
const ROOT_CAUSE_STATE = 'root-causes';

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const o = {
    command: typeof opts.command === 'string' ? opts.command : null,
    since: typeof opts.since === 'string' ? opts.since : null,
    noNarrate: Boolean(opts.noNarrate),
    dryRun: Boolean(opts.dryRun),
    date: opts.date || new Date().toISOString().slice(0, 10),
  };

  const NARRATOR_MODEL = defaults.narrator_model || 'claude-haiku-4-5';
  const TEST_TIMEOUT_MS = Number(defaults.test_timeout_ms ?? 300_000);

  // ── Smoke short-circuit ──────────────────────────────────────────
  // A real full test run is slow + may legitimately fail (that's the
  // whole point of the agent), so smoke must NOT depend on it. Instead:
  // exercise the model surface so the ledger path is verified, run the
  // suite parser against a canned tap stream (no child process), then
  // compose the report against the smoke write-root and return a
  // synthetic pass. Mirrors research/curator smoke convention.
  if (runtime.smoke) {
    const smokeModel = runtime.getModel();
    await smokeModel.chat({
      capability: 'cheap-classification',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'smoke' }],
      agent: 'tester',
    });

    const cannedTap = [
      'TAP version 13',
      'ok 1 - canned passing test',
      'not ok 2 - canned failing test',
      '  ---',
      '  duration_ms: 1.2',
      '  ...',
      '1..2',
      '# tests 2',
      '# pass 1',
      '# fail 1',
    ].join('\n');
    const results = parseTap(cannedTap, '');
    results.command = '(smoke — canned tap, no child process)';
    results.exitCode = 1;
    results.durationMs = 0;

    // Verify the report composition path end-to-end (deterministic data
    // layer only — narrator is exercised separately above).
    const report = composeReport({
      date: o.date,
      since: o.since,
      results,
      narrative: '_(smoke — narrator skipped)_',
      openRootCauses: [],
    });
    await runtime.writeRepoFile(`${REPORT_REL_DIR}/${o.date}.md`, report);

    console.log('[smoke] tester short-circuit · model + tap-parser + report composition verified');
    return { ran: false, passed: results.pass, failed: results.fail, smoke: true };
  }

  // ── 1. Discover + run the repo's real test command ───────────────
  const command = o.command || defaults.test_command || discoverTestCommand(runtime, defaults);
  console.log(`Tester — running: ${command}`);

  const started = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await runTestCommand(
    command, runtime.repoRoot, TEST_TIMEOUT_MS,
  );
  const durationMs = Date.now() - started;

  // ── 2. Parse pass/fail/skip counts + per-failure detail ──────────
  const results = parseTap(stdout, stderr);
  results.command = command;
  results.exitCode = exitCode;
  results.durationMs = durationMs;
  results.timedOut = timedOut;

  // A timed-out suite is itself a finding, not a silent pass.
  if (timedOut) {
    results.fail = Math.max(results.fail, 1);
    if (!results.failures.some(f => f.name === '(suite timeout)')) {
      results.failures.push({
        name: '(suite timeout)',
        detail: `Test command exceeded ${TEST_TIMEOUT_MS}ms and was killed. A hung suite is a failure.`,
      });
    }
  }

  console.log(
    `Result: ${results.pass} pass · ${results.fail} fail · ${results.skip} skip ` +
    `(exit ${exitCode}${timedOut ? ', TIMED OUT' : ''}, ${durationMs}ms)`,
  );

  // ── 3. Root-cause tracking (readState/writeState) ────────────────
  // On failure, record each failing test for root-cause tracking rather
  // than proposing a fix blindly. Each fingerprint carries first/last
  // seen + a hit count + a root_cause slot the operator (or a later,
  // root-cause-verified run) fills in. Resolved fingerprints (no longer
  // failing) are closed out. This is the persistent half of the Iron Law.
  let openRootCauses = [];
  if (!o.dryRun) {
    openRootCauses = await updateRootCauseState(runtime, results, o.date);
  } else {
    const existing = (await runtime.readState(ROOT_CAUSE_STATE, { failures: {} }))?.failures || {};
    openRootCauses = Object.values(existing).filter(r => r.status === 'open');
  }

  // ── 4. Narrator TL;DR (LLM, cheap, never authors the numbers) ────
  let narrative = '_(narrator skipped)_';
  if (!o.noNarrate) {
    try {
      narrative = await narrateTldr(runtime.getModel(), results, openRootCauses, NARRATOR_MODEL);
    } catch (err) {
      console.warn(`Narrator pass errored (continuing with deterministic data only): ${err.message}`);
      narrative = `_(narrator pass failed: ${escapeMd(err.message)} — deterministic data below is authoritative)_`;
    }
  }

  // ── 5. Compose + write the report ────────────────────────────────
  const report = composeReport({
    date: o.date,
    since: o.since,
    results,
    narrative,
    openRootCauses,
  });

  if (o.dryRun) {
    console.log('\n────────── TESTER REPORT (dry-run, not written) ──────────\n');
    console.log(report);
    return { ran: true, passed: results.pass, failed: results.fail, dryRun: true };
  }

  const reportRel = `${REPORT_REL_DIR}/${o.date}.md`;
  await runtime.writeRepoFile(reportRel, report);
  runtime.recordFileWritten?.(reportRel);
  console.log(`✓ Report written: ${reportRel}`);

  return {
    ran: true,
    passed: results.pass,
    failed: results.fail,
    skipped: results.skip,
    exitCode: results.exitCode,
    open_root_causes: openRootCauses.length,
  };
}

// ─── Test command discovery ──────────────────────────────────────────

// Resolve which command runs the repo's tests. Manifest default wins
// (it's the operator-blessed command); otherwise read package.json's
// `scripts.test`; otherwise fall back to node's built-in test runner.
function discoverTestCommand(runtime, defaults) {
  if (defaults.test_command) return defaults.test_command;
  try {
    const pkg = JSON.parse(readFileSync(runtime.resolveRepoPath('package.json'), 'utf8'));
    if (pkg?.scripts?.test) {
      // Prefer the package manager the repo declares.
      const pm = (pkg.packageManager || '').split('@')[0] || 'npm';
      return `${pm} test`;
    }
  } catch { /* fall through */ }
  return 'node --test test/';
}

// ─── Test command execution ──────────────────────────────────────────

function runTestCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    // Run through the shell so manifest commands like "pnpm test" or
    // "node --test test/" work verbatim.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code == null ? 1 : code, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += `\n[spawn error] ${err.message}`;
      resolve({ stdout, stderr, exitCode: 127, timedOut });
    });
  });
}

// ─── Test output parsing (TAP + node:test spec reporter) ─────────────
//
// We parse two formats so the agent works against whatever the repo's
// test command emits:
//
//   1. Classic TAP — summary `# pass N` / `# fail N` / `# tests N`, and
//      `not ok N - <name>` lines for failures (with an optional indented
//      YAML detail block). Emitted by `--test-reporter=tap`, many CI runners.
//   2. node:test "spec" reporter (Node's default when stdout is not a
//      pipe to a TAP consumer) — summary lines prefixed with `ℹ` (e.g.
//      `ℹ pass 5`, `ℹ fail 0`, `ℹ tests 5`) and per-test marks `✔`/`✖`
//      (`not ok` equivalent: `✖`). Failures are also surfaced.
//
// Summary counters win when present; otherwise we count per-test marks.

export function parseTap(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const lines = text.split('\n');

  let pass = null, fail = null, skip = null, total = null;
  const failures = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Summary counters — TAP (`#`) or spec reporter (`ℹ`). Strip a
    // leading marker + whitespace, then match the keyword.
    const sum = line.replace(/^[#ℹ]\s*/, '');
    if (sum !== line) {
      const mPass = sum.match(/^pass\s+(\d+)/);
      if (mPass) { pass = Number(mPass[1]); continue; }
      const mFail = sum.match(/^fail\s+(\d+)/);
      if (mFail) { fail = Number(mFail[1]); continue; }
      const mSkip = sum.match(/^(?:skipped|skip)\s+(\d+)/);
      if (mSkip) { skip = Number(mSkip[1]); continue; }
      const mTotal = sum.match(/^tests\s+(\d+)/);
      if (mTotal) { total = Number(mTotal[1]); continue; }
    }

    // TAP failure: `not ok N - <name>`. The next indented YAML block
    // (if any) carries the failure detail.
    const mNotOk = line.match(/^not ok\s+\d+\s*-?\s*(.*)$/);
    if (mNotOk) {
      const name = (mNotOk[1] || '(unnamed)').trim();
      if (/#\s*(SKIP|TODO)\b/i.test(name)) continue;  // not a failure
      const detail = collectYamlDetail(lines, i + 1);
      failures.push({ name: stripDirective(name), detail, fmt: 'tap' });
    }

    // Spec-reporter failure: `✖ <name> (<duration>)`. The reporter also
    // emits a `✖ failing tests:` rollup header before the failure recap
    // block — that's not a test, so drop it (and anything without a
    // trailing duration, which is how real test marks always end).
    const mSpecFail = line.match(/^\s*[✖✗]\s+(.*)$/);
    if (mSpecFail) {
      const raw = (mSpecFail[1] || '').trim();
      const hasDuration = /\([\d.]+\s*m?s\)\s*$/.test(raw);
      const isRollup = /^failing tests:?$/i.test(raw);
      if (raw && hasDuration && !isRollup) {
        const name = raw.replace(/\s*\([\d.]+\s*m?s\)\s*$/, '').trim();
        if (name) failures.push({ name, detail: '', fmt: 'spec' });
      }
    }
  }

  // De-dupe failures by name (a test can show in both a mark and a TAP
  // line if mixed output ever occurs); prefer the entry with detail.
  const byName = new Map();
  for (const f of failures) {
    const prev = byName.get(f.name);
    if (!prev || (!prev.detail && f.detail)) byName.set(f.name, f);
  }
  const dedupedFailures = [...byName.values()].map(({ name, detail }) => ({ name, detail }));

  // Fallback counting if summary counters were absent: count per-test
  // marks across both formats.
  if (pass === null && fail === null) {
    let okCount = 0, notOkCount = 0;
    for (const line of lines) {
      if (/^ok\s+\d+/.test(line) || /^\s*[✔✓]\s/.test(line)) okCount++;
      else if (/^not ok\s+\d+/.test(line) || /^\s*[✖✗]\s/.test(line)) notOkCount++;
    }
    pass = okCount;
    fail = notOkCount;
  }

  pass = pass ?? 0;
  fail = fail ?? dedupedFailures.length;
  skip = skip ?? 0;
  total = total ?? (pass + fail + skip);

  return { pass, fail, skip, total, failures: dedupedFailures };
}

function stripDirective(name) {
  return name.replace(/\s*#\s*(SKIP|TODO).*$/i, '').trim();
}

// Pull the human-readable failure message out of the TAP YAML block that
// follows a `not ok` line. Bounded to ~12 lines so a giant stack trace
// doesn't bloat the report — the report points at the failure; the full
// log is the source of truth.
function collectYamlDetail(lines, start) {
  if (lines[start] === undefined || !/^\s+---\s*$/.test(lines[start])) return '';
  const out = [];
  for (let i = start + 1; i < lines.length && out.length < 12; i++) {
    if (/^\s+\.\.\.\s*$/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out.join(' · ').slice(0, 600);
}

// ─── Root-cause state ────────────────────────────────────────────────
//
// State shape: { failures: { <fingerprint>: { name, status, first_seen,
// last_seen, hit_count, root_cause } } }. A fingerprint is the test name
// (stable across runs); the body tracks recurrence + the root-cause slot.
// Currently-failing tests are upserted as `open`; previously-open
// fingerprints that no longer fail are closed `resolved`.

async function updateRootCauseState(runtime, results, dateStr) {
  const state = (await runtime.readState(ROOT_CAUSE_STATE, null)) || { failures: {} };
  if (!state.failures) state.failures = {};

  const failingNow = new Set(results.failures.map(f => fingerprint(f.name)));

  // Upsert current failures.
  for (const f of results.failures) {
    const fp = fingerprint(f.name);
    const prior = state.failures[fp];
    if (prior && prior.status === 'open') {
      prior.last_seen = dateStr;
      prior.hit_count = (prior.hit_count || 1) + 1;
      prior.latest_detail = f.detail || prior.latest_detail || '';
    } else {
      state.failures[fp] = {
        name: f.name,
        status: 'open',
        first_seen: dateStr,
        last_seen: dateStr,
        hit_count: 1,
        latest_detail: f.detail || '',
        // The Iron Law slot: a fix is only proposed once this is filled
        // by a root-cause-verified investigation, never inferred from
        // the failure symptom alone.
        root_cause: null,
      };
    }
  }

  // Close out fingerprints that are no longer failing.
  for (const [fp, rec] of Object.entries(state.failures)) {
    if (rec.status === 'open' && !failingNow.has(fp)) {
      rec.status = 'resolved';
      rec.resolved_on = dateStr;
    }
  }

  await runtime.writeState(ROOT_CAUSE_STATE, state);

  return Object.values(state.failures).filter(r => r.status === 'open');
}

function fingerprint(name) {
  // Normalize for a stable key: lowercase, collapse whitespace, drop
  // run-specific numerics so the same logical test maps to one fingerprint.
  return String(name)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Narrator TL;DR (LLM) ────────────────────────────────────────────
//
// The narrator pattern's LLM half: a short prose summary + anomaly
// callouts ABOVE the deterministic data. It is handed the numbers; it
// must never invent or alter them. Cheap model — the value is the
// summary, not reasoning.

async function narrateTldr(model, results, openRootCauses, modelId) {
  const sys = `You are the Tester agent's narrator. You write a SHORT TL;DR that sits above a deterministic test-results data table. Hard rules:

- Use ONLY the numbers given to you. Never invent, round, or alter a count, duration, or test name.
- 2-4 sentences. State the headline (pass/fail), then the single most important thing the operator should know.
- If there are failures, name the discipline: the failures are SURFACED for root-cause investigation, not auto-fixed. Do not propose a code fix — that violates the Iron Law (no fix without identifying the root cause first).
- If a failure has been open across multiple runs (hit_count > 1), call that out as a recurring failure worth a structural look.
- Voice: direct, builder-to-builder. No em dashes. No filler. No "crucial/robust/comprehensive".
- Output plain prose only. No headings, no markdown table, no preamble like "Here is".`;

  const recurring = openRootCauses.filter(r => (r.hit_count || 1) > 1);
  const user = `Test run summary (these numbers are authoritative — copy them, do not change them):
- command: ${results.command}
- exit code: ${results.exitCode}${results.timedOut ? ' (TIMED OUT)' : ''}
- pass: ${results.pass}
- fail: ${results.fail}
- skip: ${results.skip}
- total: ${results.total}
- duration_ms: ${results.durationMs}

Failing tests (${results.failures.length}):
${results.failures.length ? results.failures.map((f, i) => `${i + 1}. ${f.name}`).join('\n') : '(none)'}

Open failure fingerprints across runs (${openRootCauses.length}):
${openRootCauses.length ? openRootCauses.map(r => `- ${r.name} (seen ${r.hit_count}x since ${r.first_seen}, root_cause: ${r.root_cause || 'NOT YET IDENTIFIED'})`).join('\n') : '(none)'}
${recurring.length ? `\nRecurring (hit_count > 1): ${recurring.length}.` : ''}

Write the TL;DR.`;

  const resp = await model.chat({
    capability: 'cheap-classification',
    model: modelId,
    max_tokens: 400,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'tester',
  });
  const text = (resp.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
  return text || '_(narrator returned empty; deterministic data below is authoritative)_';
}

// ─── Report composition (deterministic data layer) ───────────────────

function composeReport({ date, since, results, narrative, openRootCauses }) {
  const outcome = results.fail > 0 ? 'fail' : (results.skip > 0 ? 'pass-with-skips' : 'pass');
  const icon = results.fail > 0 ? '🔴' : '✅';

  const lines = [];
  // Frontmatter — machine-scannable, mirrors curator/research convention.
  lines.push('---');
  lines.push(`date: ${date}`);
  lines.push('agent: tester');
  lines.push(`command: ${jsonScalar(results.command)}`);
  if (since) lines.push(`since: ${since}`);
  lines.push(`exit_code: ${results.exitCode}`);
  lines.push('results:');
  lines.push(`  pass: ${results.pass}`);
  lines.push(`  fail: ${results.fail}`);
  lines.push(`  skip: ${results.skip}`);
  lines.push(`  total: ${results.total}`);
  lines.push(`duration_ms: ${results.durationMs}`);
  if (results.timedOut) lines.push('timed_out: true');
  lines.push(`outcome: ${outcome}`);
  lines.push(`open_root_causes: ${openRootCauses.length}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Tester Report · ${date}`);
  lines.push('');

  // ── Narrator TL;DR (LLM half — clearly labeled, never the source of truth) ──
  lines.push('## TL;DR');
  lines.push('');
  lines.push(narrative || '_(none)_');
  lines.push('');

  // ── Deterministic data layer (the ground truth) ──
  lines.push('## Results (deterministic)');
  lines.push('');
  lines.push(`**Outcome**: ${icon} ${outcomeLabel(outcome)}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Command | \`${escapeCell(results.command)}\` |`);
  lines.push(`| Exit code | ${results.exitCode}${results.timedOut ? ' (timed out)' : ''} |`);
  lines.push(`| Pass | ${results.pass} |`);
  lines.push(`| Fail | ${results.fail} |`);
  lines.push(`| Skip | ${results.skip} |`);
  lines.push(`| Total | ${results.total} |`);
  lines.push(`| Duration | ${results.durationMs} ms |`);
  lines.push('');

  // ── Failures ──
  if (results.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    let n = 0;
    for (const f of results.failures) {
      n++;
      lines.push(`### ${n}. \`${escapeCell(f.name)}\``);
      lines.push('');
      if (f.detail) lines.push(`- **Detail**: ${escapeMd(f.detail)}`);
      lines.push('- **Status**: surfaced for root-cause investigation (not auto-fixed)');
      lines.push('');
    }
  }

  // ── Root-cause tracker ──
  if (openRootCauses.length > 0) {
    lines.push('## Open root-cause tracker');
    lines.push('');
    lines.push('> Iron Law: no fix lands until a root cause is identified here. These');
    lines.push('> fingerprints are SURFACED, not patched. A recurring failure');
    lines.push('> (hit_count ≥ 3) is a candidate for a structural fix, not a retry.');
    lines.push('');
    lines.push('| Test | First seen | Last seen | Hits | Root cause |');
    lines.push('|---|---|---|---|---|');
    for (const r of openRootCauses) {
      lines.push(
        `| \`${escapeCell(r.name)}\` | ${r.first_seen} | ${r.last_seen} | ${r.hit_count} | ${r.root_cause ? escapeCell(r.root_cause) : '_not yet identified_'} |`,
      );
    }
    lines.push('');
  }

  // ── Footer ──
  lines.push('---');
  lines.push('');
  lines.push('_Tester is advisory (Phase 1): it reports and proposes, it never edits source to make a test pass. ' +
    'To act on a failure, identify the root cause first, then route the fix through the normal review flow._');
  lines.push('');

  return lines.join('\n');
}

function outcomeLabel(outcome) {
  if (outcome === 'pass') return 'Pass';
  if (outcome === 'pass-with-skips') return 'Pass (with skips)';
  return 'Failing tests present';
}

// ─── Small helpers ───────────────────────────────────────────────────

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/`/g, '\\`');
}
function escapeMd(s) {
  return String(s).replace(/[*_`|]/g, c => '\\' + c);
}
function jsonScalar(s) {
  const str = String(s);
  return /[:#&*?{}[\],]/.test(str) ? JSON.stringify(str) : str;
}
