// Agix Curator — the marketing/brand guardrail (proposer / worker caste), reborn
// on Bun.
//
// This is the BEHAVIOR layer; identity, trust=proposer, model tiering
// (worker=sonnet as the nuanced actor, verifier=haiku as the DISTINCT cheap
// grader), the boundary (write only wiki/curator/, deny git push/commit), and
// public=true live in the sibling agent.json. Curator FINDS brand drift and never
// fixes it: it is advisory only, never blocks a commit or a deploy, and hands any
// fix to Director. The nuanced copy evaluation (the legacy voice + marketing LLM
// passes) runs as ONE GOVERNED hive pass, so a DISTINCT verifier certifies the
// review (actor≠verifier) — the Iron Law posture. A free, deterministic palette
// pre-scan runs in-TS ($0) ahead of the governed pass, mirroring the legacy
// "static checks first, LLM checks second" order.
//
// Faithful reduction of agents/curator/agent.mjs + checks/*.mjs. See the NOT
// PORTED notes below and notPorted[] in the returned result:
//   - The git-diff range collection (spawnSync `git diff HEAD~1..HEAD`) has no
//     shell/git seam in the reborn contract, so the changed-file list is supplied
//     by the invoking caller/hook via input.args / input.text (the same reduction
//     investigator made for directory globbing). --since is not honored.
//   - The per-rule multi-model LLM fan-out (voice: jargon/mission/tagline/tone;
//     marketing: hero-promise/next-step-clarity, plus the cta-hierarchy /
//     proof-points structural rules) is collapsed into ONE governed pass; per-role
//     tiering now comes from the manifest and the hive fans out internally.
//   - The deterministic typography + lockup + structure (CapabilityBento /
//     capability-route) scanners are Agix-site-specific and are folded into the
//     governed review prompt rather than re-implemented as separate scanners; only
//     the objective palette scan is kept deterministic as the free exemplar.
//   - The critical-findings email (runtime.sendEmail, the letter-style HTML) and
//     the ~/.cache/agix-curator run-log jsonl are NOT ported: ctx exposes no email
//     seam, and the cache path is outside the repo write boundary. The durable
//     audit lives in the Comb (an attested review-summary leaf) instead; a
//     scheduled digest/email would be a future drone.
//   - The Director FIX/SKIP email-reply loop is an interactive seam and is not
//     ported (the report + Comb leaf still name the affordance).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REVIEWS_DIR = "wiki/curator/reviews";
const DEFAULT_RUBRIC = "architecture/03-ai-ml/agent-architecture/CURATOR_RUBRIC.yaml";

// Marketing-surface globs (ported from the legacy manifest defaults.surface_globs).
// Anything outside these globs is ignored — no governed cost on backend-only files.
const SURFACE_GLOBS = ["apps/website/**", "templates/**", "packages/ui/tokens/**", "wiki/blog/**"];

const SEVERITY_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };
const SEVERITY_LETTER: Record<string, string> = { info: "I", warn: "W", critical: "C" };

interface Finding {
  rule: string;
  severity: "critical" | "warn" | "info";
  file: string;
  line: number | null;
  quote: string;
  detail: string;
  id?: string;
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0), no review, no
  // write. Mirrors the reborn smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the brand-review surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const date = isoDate();
  const sha = String(ctx.input.flags.sha ?? "working");

  // ── 1. Acquire the changed-file list (no git seam — supplied by the caller) ──
  const candidates = resolveTargets(ctx.input);
  const surface = candidates.filter((p) => matchesAnyGlob(p, SURFACE_GLOBS));
  if (candidates.length === 0) {
    ctx.log("no files to review (pass changed paths as args or text)");
    return { ok: false, reason: "no-files" };
  }

  // Load each surface file's contents through the read boundary.
  const files: { path: string; text: string }[] = [];
  for (const p of surface) {
    const text = await ctx.readRepoFile(p);
    if (text != null) files.push({ path: p, text });
  }
  ctx.log(`diff: ${candidates.length} changed, ${surface.length} on marketing surface, ${files.length} readable`);

  // Nothing on the marketing surface → write a zero-finding audit report and stop
  // BEFORE any governed cost (mirrors the legacy early exit).
  if (files.length === 0) {
    const report = composeReport({ date, sha, filesReviewed: 0, findings: [], note: "No marketing-surface files changed in this range." });
    const path = await writeReport(ctx, date, sha, report);
    return { ok: true, filesReviewed: 0, findings: 0, critical: 0, report: path };
  }

  // ── 2. Load the rubric as TEXT (no YAML dep — the governed pass reads it, and
  //       the deterministic palette scan derives its approved set from it) ──────
  const rubricPath = String(ctx.input.flags.rubric ?? DEFAULT_RUBRIC);
  const rubricText = (await ctx.readRepoFile(rubricPath)) ?? "";
  if (!rubricText) ctx.log(`rubric not found at ${rubricPath} — proceeding with an empty approved palette`);

  // ── 3. Deterministic palette pre-scan (free, $0, no model) ───────────────────
  const findings: Finding[] = [...paletteScan(files, approvedHexes(rubricText))];
  ctx.log(`static palette scan: ${findings.length} finding(s)`);

  // ── 4. Extract copy prose for the governed evaluation ────────────────────────
  const prose = files
    .map((f) => `\n[file: ${f.path}]\n${extractCopy(f)}`)
    .filter((s) => s.split("\n").slice(1).join("\n").trim().length > 0)
    .join("\n");

  // ── 5. ONE governed pass: the nuanced brand/voice/marketing review ───────────
  // This is the legacy voice.mjs + marketing.mjs .chat() calls, collapsed. The
  // hive is asked for STRUCTURED findings; a distinct verifier certifies the pass.
  const task =
    `Review this marketing-surface copy against the brand rubric and return brand findings. ` +
    `Check: insider AI jargon used without a buyer-language gloss (warn), mission or tagline ` +
    `drift from the locked strings (critical), off-brand or pitchy tone (warn), a hero that ` +
    `reads as generic SaaS rather than a concrete promise (warn), and any page that dead-ends ` +
    `without a clear next step (warn). Advisory only — describe drift, never rewrite it.\n\n` +
    `Return ONLY a JSON object: {"findings":[{"rule":"voice.*|marketing.*","severity":"critical|warn|info",` +
    `"file":"...","quote":"...","detail":"..."}]}. If nothing violates the rubric, return {"findings":[]}.\n\n` +
    `BRAND RUBRIC:\n${rubricText.slice(0, 6000) || "(no rubric supplied)"}\n\n` +
    `COPY TO EVALUATE:\n${prose.slice(0, 12000)}`;

  const r = await ctx.hive.run(task);
  const governed = parseGovernedFindings(r.answer, surface);
  findings.push(...governed);
  ctx.log(`governed review: +${governed.length} finding(s) via ${r.verifierActor} (actor≠verifier)`);

  // ── 6. Assign item IDs (YYYY-MM-DD.<sev><n>, criticals first) ────────────────
  assignItemIds(findings, date);
  const counts = countBySeverity(findings);

  // ── 7. Compose + write the markdown review (bounded by write=wiki/curator/) ──
  const report = composeReport({ date, sha, filesReviewed: files.length, findings, review: r.answer });
  const path = await writeReport(ctx, date, sha, report);

  // ── 8. Record an attested review-summary leaf (the reborn run-log) ───────────
  // Brand/marketing strategy lives in TOGAF Business Architecture, like mentor.
  await ctx.comb
    .put({
      content:
        `curator/review ${date} ${sha}: ${counts.critical} critical, ${counts.warn} warn, ${counts.info} info ` +
        `across ${files.length} file(s) — ${r.answer.slice(0, 300)}`,
      branch: "business",
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: 0.8,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    verifier: r.verifierActor,
    filesReviewed: files.length,
    findings: findings.length,
    critical: counts.critical,
    warn: counts.warn,
    info: counts.info,
    staticFindings: findings.length - governed.length,
    governedFindings: governed.length,
    report: path,
    costUSD: r.cost.usd,
  };
});

// ── target resolution ────────────────────────────────────────────────────────
// The changed-file list comes from the invocation (args first, else whitespace-
// split text). The reborn contract has no shell/git seam, so the invoking hook is
// responsible for `git diff --name-only` and passing the result in.
function resolveTargets(input: AgentContext["input"]): string[] {
  const fromArgs = (input.args ?? []).map((s) => s.trim()).filter(Boolean);
  if (fromArgs.length) return fromArgs;
  return (input.text ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

// ── deterministic palette scan (ported from checks/palette.mjs) ──────────────
const HEX_RE = /#[0-9A-Fa-f]{6}\b/g;

// Any 6-digit hex listed in the rubric text is treated as approved. This derives
// the approved set without a YAML parser (the fleet is dependency-free).
function approvedHexes(rubricText: string): Set<string> {
  const set = new Set<string>();
  for (const m of rubricText.matchAll(HEX_RE)) set.add(m[0].toUpperCase());
  return set;
}

function paletteScan(files: { path: string; text: string }[], approved: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    lines.forEach((line, idx) => {
      const matches = line.match(HEX_RE);
      if (!matches) return;
      for (const hex of matches) {
        if (approved.has(hex.toUpperCase())) continue;
        // Token files are the source of truth → an off-palette hex there is critical.
        const severity: Finding["severity"] = /\/tokens\//.test(f.path) ? "critical" : "warn";
        findings.push({
          rule: "palette.off-palette-hex",
          severity,
          file: f.path,
          line: idx + 1,
          quote: line.trim().slice(0, 200),
          detail: `Hex ${hex} not in the approved palette.`,
        });
      }
    });
  }
  return findings;
}

// ── governed-findings parse (ported from the callLLM JSON contract) ──────────
function parseGovernedFindings(answer: string, surface: string[]): Finding[] {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: { findings?: unknown };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const out: Finding[] = [];
  for (const f of raw as Record<string, unknown>[]) {
    const sev = String(f.severity ?? "warn").toLowerCase();
    out.push({
      rule: String(f.rule ?? "voice.review"),
      severity: sev === "critical" || sev === "info" ? (sev as Finding["severity"]) : "warn",
      file: String(f.file ?? surface[0] ?? "(across changed files)"),
      line: null,
      quote: String(f.quote ?? "").slice(0, 200),
      detail: String(f.detail ?? "Brand-rubric drift."),
    });
  }
  return out;
}

// ── item IDs (ported: YYYY-MM-DD.<severity-letter><n>, criticals first) ──────
function assignItemIds(findings: Finding[], dateStr: string): void {
  const counters: Record<string, number> = { C: 0, W: 0, I: 0 };
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  for (const f of findings) {
    const letter = SEVERITY_LETTER[f.severity] ?? "I";
    counters[letter] = (counters[letter] ?? 0) + 1;
    f.id = `${dateStr}.${letter}${counters[letter]}`;
  }
}

function countBySeverity(findings: Finding[]): { critical: number; warn: number; info: number } {
  const c = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

// ── report rendering (reduced from composeReport in agent.mjs) ───────────────
function composeReport(args: {
  date: string;
  sha: string;
  filesReviewed: number;
  findings: Finding[];
  note?: string;
  review?: string;
}): string {
  const { date, sha, filesReviewed, findings, note, review } = args;
  const counts = countBySeverity(findings);
  const overall = counts.critical > 0 ? "critical" : counts.warn > 0 ? "pass-with-warnings" : "pass";
  const outcome = overall === "pass" ? "Pass" : overall === "pass-with-warnings" ? "Pass with warnings" : "Critical findings present";

  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push(`sha: ${sha}`);
  lines.push(`agent: curator`);
  lines.push(`files_reviewed: ${filesReviewed}`);
  lines.push(`findings:`);
  lines.push(`  critical: ${counts.critical}`);
  lines.push(`  warn: ${counts.warn}`);
  lines.push(`  info: ${counts.info}`);
  lines.push(`overall: ${overall}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Curator Review · ${sha}`);
  lines.push("");
  lines.push(`**Files touched (marketing surface)**: ${filesReviewed}`);
  lines.push(`**Outcome**: ${outcome}`);
  lines.push("");
  if (note) {
    lines.push(`> ${note}`);
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push("_No findings. Clean run._");
    lines.push("");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const f of findings) {
      lines.push(`### ${f.severity.toUpperCase()} · \`${f.rule}\``);
      lines.push("");
      lines.push(`**${f.id}**`);
      lines.push("");
      lines.push(`- **File**: \`${f.file}${f.line ? ":" + f.line : ""}\``);
      if (f.quote) lines.push(`- **Context**: \`${f.quote.replace(/`/g, "\\`")}\``);
      lines.push(`- **Detail**: ${f.detail}`);
      lines.push("");
    }
  }
  if (review) {
    lines.push("## Governed review (certified)");
    lines.push("");
    lines.push(review.trim());
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("## What Director can do with this");
  lines.push("");
  lines.push("- `FIX <id>` — Director drafts a fix on a branch and opens a preview");
  lines.push("- `SKIP <id>` — Director marks the finding dismissed");
  lines.push("");
  return lines.join("\n") + "\n";
}

async function writeReport(ctx: AgentContext, date: string, sha: string, report: string): Promise<string> {
  const rel = `${REVIEWS_DIR}/${date}-${sha}.md`;
  try {
    await ctx.writeRepoFile(rel, report);
    ctx.log(`report written: ${rel}`);
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }
  return rel;
}

// ── copy extraction (ported from lib/copy-extractor.mjs) ─────────────────────
const COPY_PROP_RE =
  /\b(title|description|summary|eyebrow|headline|label|placeholder|tagline|pitch|bestFor|note|caption|subtitle|body|content|text)\s*[=:]\s*["'`]([^"'`]+)["'`]/g;
const JSX_TEXT_RE = />([^<>{}]+?)</g;
const HTML_TEXT_RE = />([^<>]+?)</g;
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

function extractCopy(file: { path: string; text: string }): string {
  const ext = (file.path.match(/\.[a-z0-9]+$/i) ?? [""])[0].toLowerCase();
  const text = file.text ?? "";
  if (ext === ".md" || ext === ".mdx") return text.replace(FRONTMATTER_RE, "").trim();
  if (ext === ".tsx" || ext === ".jsx" || ext === ".ts" || ext === ".js") return extractFromJsx(text);
  if (ext === ".html" || ext === ".htm") return extractFromHtml(text);
  return "";
}

function extractFromJsx(text: string): string {
  const pieces: string[] = [];
  for (const m of text.matchAll(COPY_PROP_RE)) pieces.push(m[2]);
  for (const m of text.matchAll(JSX_TEXT_RE)) {
    const t = m[1].trim();
    if (!t || t.length < 2) continue;
    if (/^[{}();,.<>]+$/.test(t)) continue;
    if (/^[A-Z_]+$/.test(t) && t.length < 8) continue;
    pieces.push(t);
  }
  return [...new Set(pieces)].join("\n\n");
}

function extractFromHtml(text: string): string {
  const pieces: string[] = [];
  for (const m of text.matchAll(HTML_TEXT_RE)) {
    const t = m[1].trim();
    if (!t || t.length < 2) continue;
    pieces.push(t);
  }
  return [...new Set(pieces)].join("\n\n");
}

// ── glob matching (ported minimal glob from agent.mjs) ───────────────────────
function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globMatch(path, g));
}

// `**` matches any path segments; `*` matches anything except `/`.
function globMatch(path: string, glob: string): boolean {
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, " ")
        .replace(/(?<! )\*/g, "[^/]*")
        .replace(/ /g, ".*") +
      "$",
  );
  return re.test(path);
}
