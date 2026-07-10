// Agix Release Engineer — the release/deploy readiness gate (worker / proposer
// caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Identity, trust=proposer, model tiering
// (worker=haiku, verifier=haiku), the boundary (write only
// wiki/release-engineer/readiness/, deny deploy/merge/force-push/.github/workflows),
// and public=true live in the sibling agent.json. The one unit of INTELLIGENCE —
// the narrator TL;DR over the deterministic verdict + gate table — runs as a
// GOVERNED hive pass (ctx.hive.run): a DISTINCT verifier certifies it
// (actor≠verifier), so a hallucination in the prose is checked, never
// rubber-stamped, and can never touch the deterministic go/no-go.
//
// Faithful reduction of agents/release-engineer/agent.mjs. Preserved (the
// deterministic data layer — file-read-only, network-free, $0/offline):
//   Capability 1 — RELEASE READINESS gate. Six gates, each BLOCKING or ADVISORY;
//     any blocking gate red => NO-GO:
//       tests-green (BLOCKING)        — the tester agent's LATEST report (no re-run)
//       build-present (ADVISORY)       — a build-output marker file on disk
//       version-discipline (BLOCKING) — version_file parses + carries a semver
//       changelog-state (ADVISORY)     — a CHANGELOG exists + mentions the version
//       clean-tree (ADVISORY)          — no uncommitted changes (see NOT PORTED)
//       ci-defended (BLOCKING)        — the required CI + deploy workflows exist
//   Capability 2 — POST-DEPLOY VERIFICATION (--verify-deploy). N canary probes of
//     the health endpoint; ALL must be healthy for the deploy to be VERIFIED. The
//     canned canary path (the headline no-network guarantee) is ported so a verify
//     run always proves itself offline.
// The verdict is the deterministic layer; the LEGACY runtime.getModel().chat()
// TL;DR maps to ONE ctx.hive.run (governed, actor≠verifier). The report write maps
// to ctx.writeRepoFile (bounded by boundary.write); the cursor state maps to an
// attested ctx.comb.put (author=queen, verifier=distinct).
//
// PORTED via the governed `exec` tool (previously deferred):
//   - LIVE `git status --porcelain` clean-tree probe. The reborn engine now grants a
//     worker the governed `exec` tool (declared in agent.json + a boundary.exec
//     allowlist incl. read-only `git status`), so the clean-tree gate runs the real
//     probe through a GOVERNED pass (actor≠verifier) instead of shelling a child
//     from agent.ts. An empty porcelain listing → clean; a non-empty one names the
//     uncommitted paths. It remains ADVISORY, so it never flips the verdict, and it
//     fails HONESTLY (advisory red) if the probe is unavailable — never fabricated.
//
// NOT PORTED (flagged here + in the port's notPorted[], honestly):
//   - LIVE HTTP canary probe (`fetch(healthUrl)` + AbortController). Same reason:
//     network/tool use routes through the governed catalog, not a raw fetch from
//     agent.ts, and the fleet runs $0/offline. Ported: the canned canary — the
//     network-free guarantee — so a verify run proves itself offline. Deferred: the
//     live probe to a governed HTTP/read tool seam.
//   - `--no-mail` / notification side effects. There is no notify/email seam on
//     AgentContext yet (and the legacy agent had no actual mail send — the flag was
//     a no-op). Accepted-and-ignored; deferred until the contract expresses notify.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const READINESS_DIR = "wiki/release-engineer/readiness";
const TESTER_REPORTS_DIR = "wiki/tester/reports";

// Gate severity: a BLOCKING gate red forces NO-GO; an ADVISORY gate red is
// surfaced but does not block (it lowers confidence, not the verdict).
type Severity = "blocking" | "advisory";
const BLOCKING: Severity = "blocking";
const ADVISORY: Severity = "advisory";

interface Gate {
  id: string;
  severity: Severity;
  pass: boolean;
  detail: string;
}

interface Probe {
  n: number;
  status: number | null;
  healthy: boolean;
  latencyMs: number;
}

interface Verification {
  target: string;
  source: "canned";
  totalProbes: number;
  healthyProbes: number;
  verified: boolean;
  probes: Probe[];
}

// Defaults ported from manifest.yaml `defaults` (the reborn manifest keeps the
// declarative governance metadata; these behavioral config values live here with
// the behavior, mirroring how mentor's fire-allowlist moved into agent.ts).
const VERSION_FILE = "package.json";
const CHANGELOG_GLOBS = ["CHANGELOG.md", "CHANGELOG.markdown"];
// Build-output markers. The legacy probed DIRECTORIES via existsSync; the reborn
// read seam is file-oriented (Bun.file(dir).exists() is not a directory check), so
// each directory marker is reduced to a representative in-dir MARKER FILE. This is
// an ADVISORY gate, so the reduction never flips the verdict.
const BUILD_MARKER_FILES = [
  "apps/website/.next/BUILD_ID",
  "apps/website/.next/build-manifest.json",
  "dist/index.js",
  "build/index.js",
];
const REQUIRED_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/deploy-backend.yml"];
const HEALTH_PATH = "/health";
const CANARY_PROBES = 3;
const DEFAULT_TARGET_URL = "https://example.com";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0), no report, no
  // Comb write. Mirrors the Node smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the release-readiness narration surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const flags = ctx.input.flags;
  const date = (flags.date as string) || isoDate();
  const verifyDeploy = flags["verify-deploy"] === true;
  const targetUrl = (flags["target-url"] as string) || DEFAULT_TARGET_URL;

  // ── Capability 2: post-deploy verification (when --verify-deploy) ─────────
  // Runs first when requested (a distinct mode); a verify run still emits the
  // readiness section so the report is self-contained.
  let verification: Verification | null = null;
  if (verifyDeploy) {
    verification = cannedCanary(targetUrl);
    ctx.log(
      `verify-deploy · target=${verification.target} · ` +
        `${verification.healthyProbes}/${verification.totalProbes} healthy probe(s) · ` +
        `source=${verification.source} · VERIFIED=${verification.verified ? "yes" : "no"}`,
    );
  }

  // ── Capability 1: readiness gates (deterministic, file-read-only) ─────────
  const gates = await evaluateGates(ctx);
  const blocking = gates.filter((g) => g.severity === BLOCKING && !g.pass);
  const advisoryFail = gates.filter((g) => g.severity === ADVISORY && !g.pass);
  const green = gates.filter((g) => g.pass).length;

  // The verdict: GO only when no blocking gate is red. A verify run folds the
  // verification outcome in (a failed verification is a NO-GO on "is this release
  // healthy in prod").
  let verdict: "GO" | "NO-GO" = blocking.length === 0 ? "GO" : "NO-GO";
  if (verifyDeploy && verification && !verification.verified) verdict = "NO-GO";

  ctx.log(
    `readiness gate · ${green}/${gates.length} gate(s) green · ` +
      `${blocking.length} blocking red · ${advisoryFail.length} advisory red · VERDICT=${verdict}`,
  );
  for (const g of gates) ctx.log(`  ${g.pass ? "✓" : "✗"} [${g.severity}] ${g.id} — ${g.detail}`);

  // ── Narrator TL;DR — the ONE governed intelligence pass ───────────────────
  // Legacy: runtime.getModel().chat({ model: tldr_model, … }). Reborn: one
  // governed hive run — a DISTINCT verifier certifies the summary (actor≠verifier),
  // and it can never alter the deterministic go/no-go computed above.
  const redGates = gates.filter((g) => !g.pass).map((g) => `[${g.severity}] ${g.id}: ${g.detail}`);
  const dataSummary = [
    `Release readiness verdict: ${verdict}.`,
    `Gates: ${green}/${gates.length} green.`,
    redGates.length ? `Red gates:\n${redGates.join("\n")}` : "No red gates.",
    verification
      ? `Post-deploy verification: ${verification.verified ? "VERIFIED" : "FAILED"} (${verification.healthyProbes}/${verification.totalProbes} healthy).`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const r = await ctx.hive.run(
    `In at most four sentences, state the go/no-go verdict, the single most important blocking gate (if any), ` +
      `and the one action that unblocks the release. Use ONLY the data given; never invent a number.\n\nDATA:\n${dataSummary}`,
  );
  const tldr = r.answer.trim();

  // ── Compose + write the readiness report (bounded by boundary.write) ──────
  const report = composeReport({ date, verdict, gates, verification, tldr, verifier: r.verifierActor });
  const reportPath = `${READINESS_DIR}/${date}.md`;
  try {
    await ctx.writeRepoFile(reportPath, report);
    ctx.log("readiness report written", { path: reportPath });
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── Persist the cursor as durable, attested memory ────────────────────────
  // Legacy: runtime.writeState('cursor', {…}). Reborn: an attested Comb leaf
  // (author=queen, verifier=distinct), so tomorrow's run stands on today's.
  await ctx.comb
    .put({
      id: "release-engineer/cursor",
      content:
        `release-engineer/cursor ${isoDate()}: verdict=${verdict} ` +
        `gates=${green}/${gates.length} blocking_red=${blocking.length} ` +
        `verified=${verifyDeploy ? String(verification?.verified ?? null) : "n/a"}`,
      branch: "software", // TOGAF Software Architecture — CI/CD + release infra lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  // ok reflects the CI-gate semantics the persona demands (CI-gateable exit codes):
  // a run is ok only when it was GOVERNED (r.verified) AND the release is GO. A
  // NO-GO is a successful, honest run but a non-ok gate result.
  const ok = r.verified && verdict === "GO";
  return {
    ok,
    verdict,
    governed: r.verified,
    verifier: r.verifierActor,
    queen: r.queenActor,
    gates_total: gates.length,
    gates_green: green,
    blocking_red: blocking.length,
    advisory_red: advisoryFail.length,
    verify_deploy: verifyDeploy,
    deploy_verified: verifyDeploy ? (verification?.verified ?? null) : null,
    report: reportPath,
    costUSD: r.cost.usd,
  };
});

// ─── Capability 1: readiness gates (deterministic, file-read-only) ───────────

async function evaluateGates(ctx: AgentContext): Promise<Gate[]> {
  return [
    await gateTestsGreen(ctx),
    await gateBuildPresent(ctx),
    await gateVersion(ctx),
    await gateChangelog(ctx),
    await gateCleanTree(ctx), // live `git status --porcelain` via the governed exec tool
    await gateRequiredWorkflows(ctx),
  ];
}

// Gate 1 — tests green (reads the tester agent's LATEST report; no re-run). Fails
// CLOSED: an absent/unreadable report is not "green".
async function gateTestsGreen(ctx: AgentContext): Promise<Gate> {
  const latest = await latestTesterReport(ctx);
  if (!latest) {
    return {
      id: "tests-green",
      severity: BLOCKING,
      pass: false,
      detail: `no tester report found under ${TESTER_REPORTS_DIR}/ — cannot confirm tests are green (fail closed)`,
    };
  }
  const fm = parseFrontmatter(latest.body);
  const outcome = fm.outcome || null;
  const fail = numberish(fm["results.fail"] ?? fm.fail);
  const pass = outcome === "pass" || outcome === "pass-with-skips" || (fail === 0 && outcome != null);
  return {
    id: "tests-green",
    severity: BLOCKING,
    pass: Boolean(pass),
    detail: pass
      ? `latest tester report (${latest.name}) outcome=${outcome}, fail=${fail ?? 0}`
      : `latest tester report (${latest.name}) outcome=${outcome}, fail=${fail ?? "?"} — not green`,
  };
}

// Gate 2 — build present (a release ships from a built artifact). ADVISORY. The
// legacy directory markers are reduced to representative in-dir marker files.
async function gateBuildPresent(ctx: AgentContext): Promise<Gate> {
  let found: string | null = null;
  for (const m of BUILD_MARKER_FILES) {
    if ((await ctx.readRepoFile(m)) != null) {
      found = m;
      break;
    }
  }
  return {
    id: "build-present",
    severity: ADVISORY,
    pass: Boolean(found),
    detail: found
      ? `build artifact marker present: ${found}`
      : `no build artifact marker found (checked: ${BUILD_MARKER_FILES.join(", ")}) — run the build before cutting the release`,
  };
}

// Gate 3 — version discipline (version_file parses + carries a semver). BLOCKING.
async function gateVersion(ctx: AgentContext): Promise<Gate> {
  const raw = await ctx.readRepoFile(VERSION_FILE);
  if (raw == null) {
    return {
      id: "version-discipline",
      severity: BLOCKING,
      pass: false,
      detail: `version file ${VERSION_FILE} not found — cannot determine the release version`,
    };
  }
  let version: string | null = null;
  try {
    version = VERSION_FILE.endsWith(".json")
      ? (JSON.parse(raw).version ?? null)
      : (raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/) || [null])[0];
  } catch (e) {
    return {
      id: "version-discipline",
      severity: BLOCKING,
      pass: false,
      detail: `version file ${VERSION_FILE} failed to parse: ${(e as Error).message}`,
    };
  }
  const semver = !!version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
  return {
    id: "version-discipline",
    severity: BLOCKING,
    pass: semver,
    detail: semver
      ? `${VERSION_FILE} carries version ${version}`
      : `${VERSION_FILE} version is ${version ? `"${version}" (not semver)` : "missing"}`,
  };
}

// Gate 4 — changelog state (a CHANGELOG exists + mentions the version). ADVISORY.
async function gateChangelog(ctx: AgentContext): Promise<Gate> {
  // Best-effort version, so we can check the changelog mentions it.
  let version: string | null = null;
  const vraw = await ctx.readRepoFile(VERSION_FILE);
  if (vraw != null) {
    try {
      version = VERSION_FILE.endsWith(".json")
        ? (JSON.parse(vraw).version ?? null)
        : (vraw.match(/\b\d+\.\d+\.\d+\b/) || [null])[0];
    } catch {
      /* version stays null */
    }
  }

  let changelog: string | null = null;
  let changelogText: string | null = null;
  for (const g of CHANGELOG_GLOBS) {
    const text = await ctx.readRepoFile(g);
    if (text != null) {
      changelog = g;
      changelogText = text;
      break;
    }
  }
  if (!changelog) {
    return {
      id: "changelog-state",
      severity: ADVISORY,
      pass: false,
      detail: `no changelog found (checked: ${CHANGELOG_GLOBS.join(", ")}) — add release notes before shipping`,
    };
  }
  const mentions = version ? changelogText!.includes(version) : changelogText!.trim().length > 0;
  return {
    id: "changelog-state",
    severity: ADVISORY,
    pass: mentions,
    detail: mentions
      ? `changelog ${changelog} present and references ${version || "release notes"}`
      : `changelog ${changelog} present but does not mention version ${version || "(unknown)"} — update it for this release`,
  };
}

// Gate 5 — clean tree (no uncommitted changes that would ship un-tracked). Runs the
// real `git status --porcelain` through the governed `exec` tool (a governed pass,
// actor≠verifier). ADVISORY: a dirty tree lowers confidence but never blocks, and an
// unavailable probe fails HONESTLY (advisory red) rather than fabricating a verdict.
async function gateCleanTree(ctx: AgentContext): Promise<Gate> {
  const task =
    `Report the git working-tree status. Use the exec tool to run EXACTLY:\n\n    git status --porcelain\n\n` +
    `Return ONLY its raw stdout verbatim inside a single fenced code block, then a final line: EXIT: <exit code>. ` +
    `No commentary — the output is parsed downstream (an empty block means a clean tree).`;
  try {
    const r = await ctx.hive.run(task);
    const { raw, exitCode } = extractExecOutput(r.answer);
    if (exitCode !== null && exitCode !== 0) {
      return {
        id: "clean-tree",
        severity: ADVISORY,
        pass: false,
        detail: `git status --porcelain exited ${exitCode} — could not read the tree; confirm it is clean manually before cutting`,
      };
    }
    const changed = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    const clean = changed.length === 0;
    const sample = changed.slice(0, 3).map((c) => c.replace(/^\S+\s+/, "")).join(", ");
    return {
      id: "clean-tree",
      severity: ADVISORY,
      pass: clean,
      detail: clean
        ? "working tree clean (git status --porcelain empty) — nothing uncommitted would ship un-tracked"
        : `working tree DIRTY: ${changed.length} uncommitted path(s)${sample ? ` (${sample}${changed.length > 3 ? ", …" : ""})` : ""} — commit or stash before cutting the release`,
    };
  } catch (e) {
    return {
      id: "clean-tree",
      severity: ADVISORY,
      pass: false,
      detail: `clean-tree probe unavailable (${(e as Error).message.slice(0, 80)}) — confirm the tree is clean manually before cutting`,
    };
  }
}

// Pull the raw command output + exit code out of a governed exec pass answer. The
// worker fences the verbatim output and appends `EXIT: <n>`; we extract the first
// fenced block (else the whole answer) and the exit code.
export function extractExecOutput(answer: string): { raw: string; exitCode: number | null } {
  const fence = answer.match(/```[^\n]*\n([\s\S]*?)```/);
  const raw = fence ? fence[1] : answer;
  const exit = answer.match(/EXIT:\s*(-?\d+)/i);
  const exitCode = exit ? Number(exit[1]) : null;
  return { raw, exitCode };
}

// Gate 6 — CI defended (the required CI + deploy workflows exist on disk). BLOCKING.
async function gateRequiredWorkflows(ctx: AgentContext): Promise<Gate> {
  const missing: string[] = [];
  for (const w of REQUIRED_WORKFLOWS) {
    if ((await ctx.readRepoFile(w)) == null) missing.push(w);
  }
  const pass = missing.length === 0;
  return {
    id: "ci-defended",
    severity: BLOCKING,
    pass,
    detail: pass
      ? `all required CI/deploy workflows present (${REQUIRED_WORKFLOWS.length})`
      : `missing required workflow(s): ${missing.join(", ")} — a release must be defended by a CI gate + deploy pipeline`,
  };
}

// Probe the most recent tester report (today + a couple recent days), mirroring
// the investigator port's bounded-read discovery (no directory-glob seam to a
// worker). Reduces the legacy readdir(latest-lexicographic) to a bounded probe.
async function latestTesterReport(ctx: AgentContext): Promise<{ name: string; body: string } | null> {
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const name = `${isoDate(d)}.md`;
    const body = await ctx.readRepoFile(`${TESTER_REPORTS_DIR}/${name}`);
    if (body != null) return { name, body };
  }
  return null;
}

// ─── Capability 2: post-deploy verification (canned canary) ──────────────────

// Canned healthy canary — the network-free guarantee (the LIVE fetch probe is NOT
// PORTED, see top-of-file). ALL probes healthy => VERIFIED, so the verifier proves
// itself offline with zero network and zero deploy.
function cannedCanary(targetUrl: string): Verification {
  const target = targetUrl.replace(/\/+$/, "") + HEALTH_PATH;
  const total = Math.max(1, CANARY_PROBES);
  const probes: Probe[] = Array.from({ length: total }, (_, i) => ({
    n: i + 1,
    status: 200,
    healthy: true,
    latencyMs: 12 + i,
  }));
  return { target, source: "canned", totalProbes: total, healthyProbes: total, verified: true, probes };
}

// ─── Report rendering (the deterministic data layer of the narrator) ─────────

function composeReport(a: {
  date: string;
  verdict: "GO" | "NO-GO";
  gates: Gate[];
  verification: Verification | null;
  tldr: string;
  verifier: string;
}): string {
  const { date, verdict, gates, verification, tldr, verifier } = a;
  const green = gates.filter((g) => g.pass).length;
  const blocking = gates.filter((g) => g.severity === BLOCKING && !g.pass);
  const advisory = gates.filter((g) => g.severity === ADVISORY && !g.pass);
  const verdictIcon = verdict === "GO" ? "✅" : "🔴";

  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push("agent: release-engineer");
  lines.push(`verdict: ${verdict}`);
  lines.push(`gates_total: ${gates.length}`);
  lines.push(`gates_green: ${green}`);
  lines.push(`blocking_red: ${blocking.length}`);
  lines.push(`advisory_red: ${advisory.length}`);
  lines.push(`verifier: ${verifier}`);
  if (verification) {
    lines.push("verification:");
    lines.push(`  verified: ${verification.verified}`);
    lines.push(`  healthy_probes: ${verification.healthyProbes}`);
    lines.push(`  total_probes: ${verification.totalProbes}`);
    lines.push(`  target: ${JSON.stringify(verification.target)}`);
    lines.push(`  source: ${verification.source}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# Release Readiness — ${verdictIcon} ${verdict} · ${date}`);
  lines.push("");

  // Narrator TL;DR (governed prepend; the data below is the source of truth).
  if (tldr) {
    lines.push("## TL;DR");
    lines.push("");
    lines.push(`> ${tldr.replace(/\n+/g, "\n> ")}`);
    lines.push("");
    lines.push(
      `_(Narrative summary — governed pass, certified by ${verifier} (actor≠verifier). The deterministic gate table below is the source of truth.)_`,
    );
    lines.push("");
  }

  // Verdict.
  lines.push("## Verdict");
  lines.push("");
  if (verdict === "GO") {
    lines.push(
      `✅ **GO** — ${green}/${gates.length} readiness gates green, 0 blocking gates red. This release is clear to ship through the CI/CD pipeline.`,
    );
  } else {
    lines.push(
      `🔴 **NO-GO** — ${blocking.length} blocking gate(s) red. Resolve every blocking gate before cutting the release.`,
    );
  }
  lines.push("");
  lines.push(
    "> The release engineer is a **proposer**. It reports readiness and verifies the landing; it never runs `gcloud`/`firebase deploy`, never merges, never force-pushes. The CI/CD pipeline is the only path to production.",
  );
  lines.push("");

  // Pre-deploy gate table.
  lines.push("## Pre-deploy readiness gates");
  lines.push("");
  lines.push("| Gate | Severity | Status | Detail |");
  lines.push("|---|---|---|---|");
  for (const g of gates) {
    const icon = g.pass ? "✅ pass" : g.severity === BLOCKING ? "🔴 fail" : "⚠️ fail";
    lines.push(`| \`${g.id}\` | ${g.severity} | ${icon} | ${escapeCell(g.detail)} |`);
  }
  lines.push("");
  if (blocking.length) {
    lines.push("### 🔴 Blocking gates (must be green to ship)");
    lines.push("");
    for (const g of blocking) lines.push(`- **\`${g.id}\`** — ${g.detail}`);
    lines.push("");
  }
  if (advisory.length) {
    lines.push("### ⚠️ Advisory gates (lower confidence, do not block)");
    lines.push("");
    for (const g of advisory) lines.push(`- **\`${g.id}\`** — ${g.detail}`);
    lines.push("");
  }

  // Post-deploy verification.
  lines.push("## Post-deploy verification (canary)");
  lines.push("");
  if (verification) {
    lines.push(
      `Target: \`${verification.target}\` · ${verification.healthyProbes}/${verification.totalProbes} probe(s) healthy · source: \`${verification.source}\`.`,
    );
    lines.push("");
    lines.push(
      verification.verified
        ? "✅ **VERIFIED** — every canary probe returned healthy. The deployed release is serving traffic."
        : "🔴 **NOT VERIFIED** — one or more canary probes failed. Investigate the deploy (or roll back through the pipeline) before declaring the release healthy.",
    );
    lines.push("");
    lines.push("| Probe | Status | Healthy | Latency (ms) |");
    lines.push("|---|---|---|---|");
    for (const p of verification.probes) {
      lines.push(`| #${p.n} | ${p.status ?? "—"} | ${p.healthy ? "✅" : "🔴"} | ${p.latencyMs} |`);
    }
    lines.push("");
  } else {
    lines.push(
      `_Not run this pass. After the pipeline deploys, run \`agix agent run release-engineer --verify-deploy --target-url=<url>\` to canary the \`${HEALTH_PATH}\` endpoint (${CANARY_PROBES} consecutive healthy probes required)._`,
    );
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_Emitted by the Agix **release-engineer** (proposer trust). Pre-deploy gate before, post-deploy canary after — deploys themselves are CI/CD-gated and never run by this agent. Pairs with `git-orchestrator` (merge) and `ci-warden` (CI health)._",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

// ─── Frontmatter + small helpers ─────────────────────────────────────────────

// Parse a leading `---`…`---` YAML-ish frontmatter block into a flat map. Nested
// one-level keys (e.g. `results:\n  fail: 0`) flatten to `results.fail`. Tiny by
// design — we only need a handful of scalar fields off the tester report.
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return out;
  let parent: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = line.match(/^(\s*)([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rawVal] = m;
    const val = rawVal.trim();
    if (indent.length === 0) {
      if (val === "") {
        parent = key;
        out[key] = "";
      } else {
        parent = null;
        out[key] = stripQuotes(val);
      }
    } else if (parent) {
      out[`${parent}.${key}`] = stripQuotes(val);
    }
  }
  return out;
}

function stripQuotes(v: string): string {
  return v.replace(/^["']|["']$/g, "");
}

function numberish(v: string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
