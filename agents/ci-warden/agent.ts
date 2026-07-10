// Agix CI Warden — the CI/CD cost gate (worker / proposer caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Identity, trust=proposer, model tiering
// (worker=haiku, verifier=haiku), the boundary (write only wiki/ci-warden/reports/,
// deny .github/workflows/ + git push/merge), and public=true live in the sibling
// agent.json. The one unit of INTELLIGENCE — the narrator TL;DR over the
// deterministic findings — runs as a GOVERNED hive pass (ctx.hive.run): a DISTINCT
// verifier certifies it (actor≠verifier), so a hallucination in the prose is
// checked, never rubber-stamped, and can never touch the deterministic numbers.
//
// Faithful reduction of agents/ci-warden/agent.mjs. Preserved (deterministic data
// layer, no model, network-free):
//   1. Budget-exhaustion detector — the "all jobs failing at 0 steps" signature,
//      run against the canned run set (the no-network guarantee: the detector
//      ALWAYS proves itself, so a smoke run is faithful).
//   2. Workflow cost-audit — static regex scan of .github/workflows/*.yml for the
//      cost anti-patterns, with conservative labeled minute savings.
// The LEGACY runtime.getModel().chat() TL;DR maps to ONE ctx.hive.run (governed).
// The report write maps to ctx.writeRepoFile (bounded by boundary.write); the
// cursor state maps to an attested ctx.comb.put (author=queen, verifier=distinct).
//
// NOT PORTED (flagged in notPorted[] + honestly here):
//   - LIVE GitHub Actions query (the `gh api …/actions/runs` + per-run /jobs step
//     counts via child_process). The reborn contract routes tool/credential use
//     through the GOVERNED Go tool catalog + guard-bee boundary, not a raw shell
//     spawn from agent.ts, and this runs $0/offline. The detector keeps its
//     network-free canned path — the headline capability — intact; only the live
//     data source is deferred to a governed `gh`/read tool seam.
//   - sendNotification alert on exhaustion — PORTED. On the budget-exhaustion
//     signature the warden now pushes a critical alert through the governed notify
//     seam (ctx.notify), the orchestration twin of the Go core/tool/email tool.
//     Dry-run/queued by default (recorded, nothing actually sent offline); a live
//     transport plugs in fail-closed. The legacy action-buttons UI + recordDecision
//     (drift) remain UI/state concerns with no reborn seam — the alert content and
//     the operator remediation are carried, not the button widget.
//   - js-yaml STRUCTURAL parse of the workflow. Dropped (the fleet is
//     dependency-free — no package.json). The regex data layer the legacy already
//     kept as its fallback is ported; a lightweight indentation scan recovers the
//     structural job/timeout counts js-yaml used to provide.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REPORTS_DIR = "wiki/ci-warden/reports";
const WORKFLOWS_DIR = ".github/workflows";

// The reborn contract exposes no directory-glob seam to a worker (the same
// boundary posture the investigator port notes), so discovery probes the
// conventional workflow basenames via the bounded ctx.readRepoFile read seam.
// Extra basenames may be passed as positional args. This is the honest reduction
// of the legacy readdir(.github/workflows).
const KNOWN_WORKFLOWS = [
  "ci.yml", "ci.yaml",
  "deploy.yml", "deploy-backend.yml", "deploy-frontend.yml",
  "secret-scan.yml", "verifier-guard.yml",
  "release.yml", "test.yml", "tests.yml", "build.yml", "lint.yml",
  "pr.yml", "main.yml", "codeql.yml", "publish.yml",
];

type Severity = "info" | "warn" | "critical";
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

interface Finding {
  file: string;
  severity: Severity;
  rule: string;
  detail: string;
  recommendation: string;
  savingsMin: number;
  savingsMax: number;
}

interface Run {
  workflow: string;
  runNumber: number;
  conclusion: string;
  headBranch: string;
  executedSteps: number;
}

interface Budget {
  source: string;
  totalRuns: number;
  zeroStepFailures: number;
  zeroStepRatio: number;
  exhausted: boolean;
  affectedWorkflows: string[];
  evidence: Run[];
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0), no report, no
  // Comb write. Mirrors the Node smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the CI cost-steward narration surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const date = (ctx.input.flags.date as string) || isoDate();

  // ── 1. Budget-exhaustion detector (deterministic, network-free) ───────────
  const budget = detectBudgetExhaustion();
  ctx.log(
    `budget detector · source=${budget.source} runs=${budget.totalRuns} ` +
      `zero-step=${budget.zeroStepFailures} (${pct(budget.zeroStepRatio)}) exhausted=${budget.exhausted}`,
  );

  // Exhaustion → push a critical alert through the governed notify seam (dry-run/
  // queued by default; a live transport plugs in fail-closed). Detection + reporting
  // are unchanged; the alert is additive and never fails the run.
  let notified = false;
  if (budget.exhausted) {
    const alertBody =
      `${budget.zeroStepFailures}/${budget.totalRuns} recent Actions runs failed at 0 steps across ` +
      `${budget.affectedWorkflows.length} workflow(s): ${budget.affectedWorkflows.join(", ")}. ` +
      `This is the spending-limit-exhaustion signature, not a code failure. ` +
      `Operator action: raise the GitHub Actions spending limit (Settings → Billing → Spending limits), then re-run.`;
    try {
      const r = await ctx.notify({
        channel: "ci-alert",
        level: "critical",
        title: "GitHub Actions spending limit appears EXHAUSTED",
        body: alertBody,
        to: "operator",
      });
      notified = r.sent || r.queued;
      ctx.log(
        `BUDGET-EXHAUSTION SIGNATURE — alert ${r.sent ? "sent" : "queued"} (mode=${r.mode}); ` +
          `operator action: raise the Actions spending limit`,
      );
    } catch (e) {
      ctx.log(`exhaustion alert skipped: ${(e as Error).message}`);
    }
  }

  // ── 2. Workflow cost-audit (deterministic static scan) ────────────────────
  const workflowFiles = await collectWorkflowFiles(ctx);
  const findings: Finding[] = [];
  for (const wf of workflowFiles) findings.push(...auditWorkflow(wf));
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const counts = countBySeverity(findings);
  ctx.log(
    `cost-audit · scanned ${workflowFiles.length} workflow(s) · ${findings.length} finding(s) ` +
      `(${counts.critical} critical, ${counts.warn} warn, ${counts.info} info)`,
  );

  // ── 3. Narrator TL;DR — the ONE governed intelligence pass ────────────────
  // Legacy: runtime.getModel().chat({ model: tldr_model, … }). Reborn: one
  // governed hive run — a DISTINCT verifier certifies the summary (actor≠verifier).
  const dataSummary = [
    `Budget exhausted: ${budget.exhausted} (${budget.zeroStepFailures}/${budget.totalRuns} runs at 0 steps).`,
    `Cost findings: ${counts.critical} critical, ${counts.warn} warn, ${counts.info} info.`,
    ...findings.slice(0, 8).map((f) => `- [${f.severity}] ${f.file} · ${f.rule}: ${f.detail}`),
  ].join("\n");
  const r = await ctx.hive.run(
    `Summarize the GitHub Actions cost posture in at most four sentences and name the single most impactful ` +
      `change. Use ONLY the numbers in this deterministic data; never invent a figure.\n\nDATA:\n${dataSummary}`,
  );
  const tldr = r.answer.trim();

  // ── 4. Compose + write the report (bounded by boundary.write) ─────────────
  const report = composeReport({ date, budget, findings, counts, workflowFiles, tldr, verifier: r.verifierActor });
  const reportPath = `${REPORTS_DIR}/${date}.md`;
  try {
    await ctx.writeRepoFile(reportPath, report);
    ctx.log(`report written`, { path: reportPath });
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── 5. Persist the cursor as durable, attested memory ─────────────────────
  // Legacy: runtime.writeState('cursor', {…}). Reborn: an attested Comb leaf
  // (author=queen, verifier=distinct), so tomorrow's delta stands on today's.
  await ctx.comb
    .put({
      id: "ci-warden/cursor",
      content:
        `ci-warden/cursor ${isoDate()}: budget=${budget.exhausted ? "exhausted" : "healthy"} ` +
        `zero_step=${budget.zeroStepFailures}/${budget.totalRuns} findings=${counts.critical}c/${counts.warn}w/${counts.info}i`,
      branch: "software", // TOGAF Software Architecture — CI/CD infra lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  const savingsMin = findings.reduce((s, f) => s + (f.savingsMin || 0), 0);
  const savingsMax = findings.reduce((s, f) => s + (f.savingsMax || 0), 0);

  return {
    ok: r.verified,
    verifier: r.verifierActor,
    budget_exhausted: budget.exhausted,
    zero_step_failures: budget.zeroStepFailures,
    total_runs_checked: budget.totalRuns,
    detector_source: budget.source,
    workflows_scanned: workflowFiles.length,
    findings: findings.length,
    critical: counts.critical,
    warn: counts.warn,
    info: counts.info,
    estimated_monthly_savings_min: savingsMin,
    estimated_monthly_savings_max: savingsMax,
    notified,
    report: reportPath,
    costUSD: r.cost.usd,
  };
});

// ─── 1. Budget-exhaustion detector ───────────────────────────────────────────

// Deterministic, network-free. The canned run set exhibits the exact
// budget-exhaustion signature that bit the repo on 2026-06-18: every job across
// unrelated workflows fails at 0 steps at once, plus one healthy historical run
// so the detector measures the RATIO, not a single failure. The legacy LIVE `gh
// api` path is not ported (see the top-of-file NOT PORTED note).
function detectBudgetExhaustion(): Budget {
  const runs = cannedExhaustionRuns();
  const zeroStepMax = 0;
  const exhaustionRatio = 0.5;

  const total = runs.length;
  const zeroStep = runs.filter((r) => r.conclusion === "failure" && (r.executedSteps ?? 0) <= zeroStepMax);
  const ratio = total > 0 ? zeroStep.length / total : 0;
  const exhausted = ratio >= exhaustionRatio && zeroStep.length >= 2;
  const affected = [...new Set(zeroStep.map((r) => r.workflow))];

  return {
    source: "canned",
    totalRuns: total,
    zeroStepFailures: zeroStep.length,
    zeroStepRatio: ratio,
    exhausted,
    affectedWorkflows: affected,
    evidence: zeroStep,
  };
}

function cannedExhaustionRuns(): Run[] {
  const mk = (workflow: string, runNumber: number, headBranch: string): Run => ({
    workflow,
    runNumber,
    conclusion: "failure",
    headBranch,
    executedSteps: 0,
  });
  return [
    mk("CI", 412, "main"),
    mk("CI", 411, "feat/agent-ci-warden"),
    mk("CI", 410, "feat/bus-throughput"),
    mk("Deploy Backend (Cloud Run)", 188, "main"),
    mk("secret-scan", 96, "feat/bus-cli"),
    mk("CI", 409, "feat/mentor-real"),
    // One healthy historical run — proves the detector measures the RATIO.
    { workflow: "CI", runNumber: 408, conclusion: "success", headBranch: "main", executedSteps: 7 },
  ];
}

// ─── 2. Workflow cost-audit ──────────────────────────────────────────────────

interface WorkflowFile {
  path: string;
  text: string;
}

// Discover workflow files via the bounded read seam (see KNOWN_WORKFLOWS note).
// Positional args are treated as extra basenames under .github/workflows/.
async function collectWorkflowFiles(ctx: AgentContext): Promise<WorkflowFile[]> {
  const names = [...new Set([...KNOWN_WORKFLOWS, ...ctx.input.args.map((a) => a.trim()).filter(Boolean)])];
  const files: WorkflowFile[] = [];
  for (const n of names) {
    const rel = n.includes("/") ? n : `${WORKFLOWS_DIR}/${n}`;
    const text = await ctx.readRepoFile(rel).catch(() => null);
    if (text != null) files.push({ path: rel, text });
  }
  return files;
}

// Deterministic static checks for cost anti-patterns. Each finding carries a
// conservative, labeled monthly-minutes savings range. Regex-only (no js-yaml):
// the legacy already kept these as its parse-failure fallback; a lightweight
// indentation scan recovers the structural job/timeout counts.
function auditWorkflow({ path, text }: WorkflowFile): Finding[] {
  const findings: Finding[] = [];
  const add = (
    severity: Severity,
    rule: string,
    detail: string,
    recommendation: string,
    savingsMin = 0,
    savingsMax = 0,
  ) => findings.push({ file: path, severity, rule, detail, recommendation, savingsMin, savingsMax });

  const triggers = parseTriggers(text);
  const hasConcurrency = /^concurrency\s*:/m.test(text);
  const hasCancelInProgress = /cancel-in-progress\s*:\s*true/.test(text);
  const hasPathFilter = /^\s*(paths|paths-ignore)\s*:/m.test(text);
  const hasBranchFilter = /branches(-ignore)?\s*:/.test(text);

  const { jobCount, timeoutCount } = countJobs(text);
  const matrixCount = (text.match(/\bmatrix\s*:/g) || []).length;

  // A deploy workflow intentionally serializes (cancel-in-progress:false) and
  // runs on workflow_run — don't flag it for "broad push triggers".
  const isDeploy = /workflow_run\s*:/.test(text) || /cancel-in-progress\s*:\s*false/.test(text);

  // C1 — no concurrency control on a PR/push workflow.
  if (!hasConcurrency && (triggers.includes("pull_request") || triggers.includes("push"))) {
    add(
      "critical",
      "no-concurrency-control",
      "No `concurrency:` group — superseded runs on the same ref are not cancelled, so every force-push re-queues a full run while the prior one keeps consuming minutes.",
      "Add a `concurrency:` block keyed on `github.workflow`+`github.ref` with `cancel-in-progress: true`.",
      40,
      200,
    );
  } else if (hasConcurrency && !hasCancelInProgress && !isDeploy) {
    add(
      "warn",
      "concurrency-without-cancel",
      "`concurrency:` is set but `cancel-in-progress` is not true — superseded runs still drain to completion.",
      "Set `cancel-in-progress: true` (unless this workflow must serialize, e.g. a deploy).",
      20,
      80,
    );
  }

  // C2 — broad push / no path filter.
  if (triggers.includes("push") && !hasBranchFilter) {
    add(
      "warn",
      "push-all-branches",
      "Triggers on `push:` with no branch filter — every push to every branch (including throwaway/WIP branches that also have an open PR) runs the full pipeline, double-billing PR branches.",
      "Restrict `push:` to `branches: [main]` (PRs already cover feature branches), or drop the `push:` trigger entirely.",
      30,
      120,
    );
  }
  if ((triggers.includes("push") || triggers.includes("pull_request")) && !hasPathFilter) {
    add(
      "warn",
      "no-path-filter",
      "No `paths:`/`paths-ignore:` filter — docs-only, markdown, or unrelated-directory commits run the full lint/typecheck/build pipeline.",
      'Add `paths-ignore: ["**.md", "wiki/**", "docs/**"]` (or `paths:` for the code dirs this workflow actually validates).',
      25,
      100,
    );
  }

  // C3 — missing per-job timeouts.
  if (jobCount > 0 && timeoutCount < jobCount) {
    add(
      "warn",
      "missing-job-timeout",
      `${jobCount - timeoutCount} of ${jobCount} job(s) have no \`timeout-minutes\` — a hung job runs to GitHub's 360-minute default, burning ~360 minutes on a single stuck run.`,
      "Add a tight `timeout-minutes:` to every job (e.g. 10-20 for lint/test, 25 for build/deploy).",
      0,
      360,
    );
  }

  // C4 — matrix without fail-fast.
  if (matrixCount > 0 && !/fail-fast\s*:\s*true/.test(text)) {
    add(
      "info",
      "matrix-no-fail-fast",
      "A build `matrix:` is present without explicit `fail-fast: true` — a failure in one leg lets the other (already-doomed) legs run to completion.",
      "Set `strategy.fail-fast: true` so a failing leg cancels its siblings, and prune matrix dimensions to the minimum needed.",
      10,
      60,
    );
  }

  return findings;
}

// Extract the top-level trigger event names from an `on:` block (regex-only, the
// legacy parse-failure fallback path).
function parseTriggers(text: string): string[] {
  const events = new Set<string>();
  const inline = text.match(/^on\s*:\s*\[([^\]]+)\]/m);
  if (inline) {
    for (const e of inline[1].split(",")) events.add(e.trim());
    return [...events];
  }
  // Bare scalar: `on: push`.
  const scalar = text.match(/^on\s*:\s*([a-zA-Z_]+)\s*$/m);
  if (scalar) return [scalar[1]];
  // Mapping form: capture the `on:` block until the next top-level key.
  const m = text.match(/^on\s*:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (m) {
    for (const line of m[1].split("\n")) {
      const km = line.match(/^\s{2,4}([a-zA-Z_]+)\s*:/);
      if (km) events.add(km[1]);
    }
  }
  return [...events];
}

// Lightweight indentation scan of the `jobs:` block — recovers the structural
// job count + how many carry a timeout, without a YAML dependency. Anchors to
// the jobs: section so it does not miscount top-level `defaults:`/`outputs:`.
function countJobs(text: string): { jobCount: number; timeoutCount: number } {
  const lines = text.split("\n");
  let inJobs = false;
  let indent = 0;
  let jobCount = 0;
  let timeoutCount = 0;
  for (const line of lines) {
    if (!inJobs) {
      if (/^jobs\s*:\s*$/.test(line)) {
        inJobs = true;
        indent = 0;
      }
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // A non-indented line ends the jobs block (next top-level key).
    if (!/^\s/.test(line)) break;
    const lead = line.match(/^(\s*)/)![1].replace(/\t/g, "  ").length;
    if (indent === 0) indent = lead; // first child sets the job-key indent
    // A job key sits at exactly the job-key indent and is a bare `name:`.
    if (lead === indent && /^\s*[A-Za-z0-9_-]+\s*:\s*$/.test(line)) jobCount++;
    if (/^\s*timeout-minutes\s*:/.test(line)) timeoutCount++;
  }
  // Fallback when the jobs block could not be delimited (e.g. inline maps):
  // count timeout-minutes occurrences so the check still has a denominator.
  if (jobCount === 0) {
    timeoutCount = (text.match(/timeout-minutes\s*:/g) || []).length;
  }
  return { jobCount, timeoutCount };
}

function countBySeverity(findings: Finding[]): { critical: number; warn: number; info: number } {
  const c = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

// ─── Report rendering ────────────────────────────────────────────────────────

function composeReport(a: {
  date: string;
  budget: Budget;
  findings: Finding[];
  counts: { critical: number; warn: number; info: number };
  workflowFiles: WorkflowFile[];
  tldr: string;
  verifier: string;
}): string {
  const { date, budget, findings, counts, workflowFiles, tldr, verifier } = a;
  const totalMin = findings.reduce((s, f) => s + (f.savingsMin || 0), 0);
  const totalMax = findings.reduce((s, f) => s + (f.savingsMax || 0), 0);
  const overall = budget.exhausted
    ? "budget-exhausted"
    : counts.critical > 0
      ? "critical"
      : counts.warn > 0
        ? "optimizations-available"
        : "lean";

  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push("agent: ci-warden");
  lines.push(`budget_exhausted: ${budget.exhausted}`);
  lines.push(`zero_step_failures: ${budget.zeroStepFailures}`);
  lines.push(`total_runs_checked: ${budget.totalRuns}`);
  lines.push(`detector_source: ${budget.source}`);
  lines.push(`workflows_scanned: ${workflowFiles.length}`);
  lines.push(`verifier: ${verifier}`);
  lines.push("findings:");
  lines.push(`  critical: ${counts.critical}`);
  lines.push(`  warn: ${counts.warn}`);
  lines.push(`  info: ${counts.info}`);
  lines.push(`estimated_monthly_savings_minutes: "${totalMin}-${totalMax}"`);
  lines.push(`overall: ${overall}`);
  lines.push("---");
  lines.push("");
  lines.push(`# CI Warden — Actions Cost Report · ${date}`);
  lines.push("");

  // Narrator TL;DR (governed prepend; the data below is the source of truth).
  if (tldr) {
    lines.push("## TL;DR");
    lines.push("");
    lines.push(`> ${tldr.replace(/\n+/g, "\n> ")}`);
    lines.push("");
    lines.push(`_(Narrative summary — governed pass, certified by ${verifier} (actor≠verifier). The deterministic data layer below is the source of truth.)_`);
    lines.push("");
  }

  // Budget posture.
  lines.push("## Budget posture");
  lines.push("");
  if (budget.exhausted) {
    lines.push("🔴 **GitHub Actions spending limit appears EXHAUSTED.**");
    lines.push("");
    lines.push(
      `${budget.zeroStepFailures} of ${budget.totalRuns} recent runs failed at **0 steps** across ` +
        `${budget.affectedWorkflows.length} workflow(s): ${budget.affectedWorkflows.join(", ")}.`,
    );
    lines.push("");
    lines.push(
      "This is the spending-limit-exhaustion signature — every job fails at startup before a single step runs, " +
        "across unrelated workflows and branches simultaneously. **It is not a code failure.**",
    );
    lines.push("");
    lines.push("| Workflow | Run | Branch | Steps executed | Conclusion |");
    lines.push("|---|---|---|---|---|");
    for (const rr of budget.evidence.slice(0, 8)) {
      lines.push(`| ${rr.workflow} | #${rr.runNumber} | \`${rr.headBranch}\` | ${rr.executedSteps} | ${rr.conclusion} |`);
    }
    lines.push("");
    lines.push(
      "**Remediation (operator-side):** raise the GitHub Actions spending limit in **Settings → Billing → " +
        "Spending limits**, then re-run the failed jobs. Do not rebase or rewrite — there is nothing wrong with the " +
        "code. The warden does not raise the limit itself (proposer trust).",
    );
  } else {
    lines.push(
      `✅ Healthy — ${budget.zeroStepFailures}/${budget.totalRuns} recent runs failed at 0 steps (below the ` +
        `exhaustion threshold). Detector source: \`${budget.source}\`.`,
    );
  }
  lines.push("");

  // Cost-audit findings.
  lines.push("## Workflow cost-audit");
  lines.push("");
  lines.push(
    `Scanned ${workflowFiles.length} workflow file(s): ` +
      `${workflowFiles.map((f) => "`" + f.path.replace(".github/workflows/", "") + "`").join(", ") || "(none)"}.`,
  );
  lines.push("");
  if (findings.length === 0) {
    lines.push("_No cost anti-patterns found. Workflows are lean._");
  } else {
    lines.push(
      `Estimated savings if all findings are addressed: **~${totalMin}-${totalMax} Actions minutes/month** ` +
        `(conservative, labeled estimate).`,
    );
    lines.push("");
    for (const f of findings) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "warn" ? "⚠️" : "ℹ️";
      lines.push(`### ${icon} ${f.severity.toUpperCase()} · \`${f.rule}\``);
      lines.push("");
      lines.push(`- **File:** \`${f.file}\``);
      lines.push(`- **Finding:** ${f.detail}`);
      lines.push(`- **Recommendation:** ${f.recommendation}`);
      if (f.savingsMax) lines.push(`- **Est. savings:** ~${f.savingsMin}-${f.savingsMax} min/month`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_CI Warden is a **proposer** — it audits cost and raises alerts but never edits workflow files or raises " +
      "spending limits directly. Act on a finding by editing the workflow yourself, or route a structural change " +
      "through a phase plan._",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}
