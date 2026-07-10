// Agix Security Officer — the white-hat security posture reviewer (proposer /
// worker caste), reborn on Bun.
//
// This is the BEHAVIOR layer; identity, trust=proposer, model tiering
// (worker=sonnet as the narrator actor, verifier=haiku as the DISTINCT cheap
// grader), the boundary (write only wiki/security-officer/, deny git push/commit),
// and public=true live in the sibling agent.json. The Security Officer FINDS risk
// and never fixes it: it is advisory only, never blocks a commit or a deploy, and
// never edits source. The deterministic secret + dependency + config checks are
// the free ($0), offline, value-free DATA LAYER and run in-TS; the narrator TL;DR
// runs as ONE GOVERNED hive pass so a DISTINCT verifier certifies the prose
// (actor!=verifier) — the Iron Law posture — while the deterministic findings
// remain authoritative even if the narration fails.
//
// HARD INVARIANTS (mirror the soul block in manifest.yaml / PERSONA.md):
//   - Read-only. The ONLY thing written is the agent's own audit report under
//     wiki/security-officer/ (via ctx.writeRepoFile, bounded by boundary.write).
//   - Classification, never content. A finding carries a rule + severity + file +
//     a value-free shape/fingerprint, never a raw secret value.
//   - No network during the scan. The dependency check reads manifests; it does
//     not fetch advisories. The narrator pass is the only intelligence call and it
//     is best-effort (a governed failure degrades to an "unavailable" slot).
//
// Faithful reduction of agents/security-officer/agent.mjs + checks/*.mjs. NOT
// PORTED (also surfaced in the returned result and to the caller):
//   - The full working-tree directory WALK (collectFiles / walk / walkManifests
//     over the scan_roots) has no directory-glob READ seam in the reborn contract:
//     ctx exposes readRepoFile(known path), not a recursive reader (the same
//     reduction curator + investigator made). The scan-target list is supplied by
//     the caller via input.args / input.text; absent an explicit list a default set
//     of conventional high-signal security paths (repo-root package.json, the .env
//     family, common workflow files) is probed for a scheduled scan. A real fleet
//     wires a Go-catalog glob/read tool and restores the full walk.
//   - The narrator's raw runtime.getModel().chat() (capability default-quality)
//     becomes ONE governed ctx.hive.run over a classification-only digest — the
//     hive fans out internally and a distinct verifier certifies it. Graceful
//     degradation is preserved: on a governed failure the narrative slot is marked
//     unavailable and the deterministic report still ships.
//   - The ~/.cache/agix-security-officer run-log jsonl is NOT ported: it is outside
//     the repo write boundary and ctx exposes no cacheDir seam. The durable run
//     history lives in the Comb instead (an attested audit-summary leaf).
//   - The critical-findings email (runtime.sendEmail; Phase 2, and disabled in the
//     Node agent too) is NOT ported: ctx exposes no email seam. The "would-email"
//     signal is surfaced in the return + log; a scheduled digest is a future drone.
//   - --dry-run (compose + print, do not write) is honored via input.flags.dryRun.
//   - Deeper CI/IaC + STRIDE/OWASP narrative (job-level permissions, pinned action
//     SHAs, OIDC posture) stays future work, folded into the governed prompt where
//     relevant rather than re-implemented as new scanners.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult, type GovernedResult } from "../../fleet/runtime/sdk.ts";

const AUDITS_DIR = "wiki/security-officer/audits";
const NARRATOR_MODEL = "claude-sonnet-4-6";

// Per-file cap — a multi-MB bundle is noise and a cost sink; static-source files
// of interest are far smaller.
const MAX_FILE_BYTES = 512 * 1024;

// Default scan targets for a scheduled run (no directory-glob seam — see the
// NOT-PORTED note). Conventional high-signal security paths only.
const DEFAULT_SCAN_CANDIDATES = [
  "package.json",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/release.yml",
  ".github/workflows/build.yml",
  ".github/workflows/test.yml",
];

const SEVERITY_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };
const SEVERITY_LETTER: Record<string, string> = { info: "I", warn: "W", critical: "C" };

type Severity = "critical" | "warn" | "info";

interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number | null;
  quote: string;
  detail: string;
  id?: string;
}

interface SrcFile {
  path: string;
  text: string;
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // ── Smoke short-circuit ──────────────────────────────────────────────────
  // Exercise the deterministic scanner on the agent's own file (bounded, $0) AND
  // the governed surface once. No report write, no email. Mirrors the reborn smoke
  // contract ("exercise the surfaces") and the Node smoke's model-free scan.
  if (ctx.smoke) {
    const selfFiles: SrcFile[] = [];
    const selfText = await ctx.readRepoFile("agents/security-officer/agent.ts").catch(() => null);
    if (selfText) selfFiles.push({ path: "agents/security-officer/agent.ts", text: selfText });
    const probe = [...runSecretChecks(selfFiles), ...runConfigChecks(selfFiles)];
    const r = await ctx.hive.run("smoke: confirm the security-posture reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor, findings: probe.length });
    return { ok: true, smoke: true, verifier: r.verifierActor, findings: probe.length };
  }

  const date = isoDate();
  const dryRun = Boolean(ctx.input.flags.dryRun ?? ctx.input.flags["dry-run"]);

  // ── 1. Acquire scan targets + read them through the boundary ─────────────
  const targets = resolveTargets(ctx.input);
  const usingDefaults = targets === DEFAULT_SCAN_CANDIDATES;
  const files: SrcFile[] = [];
  for (const p of targets) {
    const text = await ctx.readRepoFile(p).catch(() => null);
    if (text == null) continue;
    if (text.length > MAX_FILE_BYTES) continue; // size-capped, read-only
    files.push({ path: p, text });
  }
  ctx.log(
    `scan: ${targets.length} target(s)${usingDefaults ? " (default set)" : " (caller-supplied)"}, ${files.length} readable`,
  );

  // ── 2. Run every deterministic check (offline, $0, value-free) ───────────
  const manifests = files.filter((f) => baseName(f.path) === "package.json");
  const findings: Finding[] = [
    ...runSecretChecks(files),
    ...runDependencyChecks(manifests),
    ...runConfigChecks(files),
  ];

  // ── 3. Grade + assign stable item IDs (criticals first → C1 is worst) ────
  assignItemIds(findings, date);
  const counts = countBySeverity(findings);
  ctx.log(`deterministic checks: ${counts.critical} critical · ${counts.warn} warn · ${counts.info} info`);

  // ── 4. Narrator TL;DR — ONE governed pass over a classification-only digest.
  //       Only when there is something to narrate; a governed failure degrades to
  //       an "unavailable" slot (the deterministic report still ships). ──────────
  let narrative: { available: boolean; text?: string; reason?: string; model?: string };
  let governed: GovernedResult | null = null;
  if (findings.length === 0) {
    narrative = { available: false, reason: "clean run — no findings to narrate." };
  } else {
    try {
      governed = await ctx.hive.run(buildNarratorTask(date, counts, findings));
      narrative = { available: true, text: governed.answer.trim(), model: NARRATOR_MODEL };
      ctx.log(`governed narration certified by ${governed.verifierActor} (actor!=verifier)`);
    } catch (e) {
      narrative = {
        available: false,
        reason: `governed narrator unavailable (${(e as Error).message}); the deterministic findings below are authoritative.`,
      };
    }
  }

  // ── 5. Compose the narrator-pattern report ───────────────────────────────
  const report = composeReport({ date, scanTargets: targets, filesScanned: files.length, findings, narrative });

  const reportRel = `${AUDITS_DIR}/${date}.md`;
  let wrote = false;
  if (dryRun) {
    ctx.log("dry-run — report composed, not written");
  } else {
    try {
      await ctx.writeRepoFile(reportRel, report);
      wrote = true;
      ctx.log(`audit report written: ${reportRel}`);
    } catch (e) {
      ctx.log(`report write skipped: ${(e as Error).message}`);
    }
  }

  // ── 6. Record an attested audit-summary leaf (the reborn run-log) ─────────
  // Only when a governed pass certified the run (a distinct verifier is required to
  // attest). Software architecture — repo security posture lives here.
  if (governed) {
    await ctx.comb
      .put({
        content:
          `security-officer/audit ${date}: ${counts.critical} critical, ${counts.warn} warn, ${counts.info} info ` +
          `across ${files.length} file(s) — ${governed.answer.slice(0, 300)}`,
        branch: "software",
        author: governed.queenActor,
        verifier: governed.verifierActor,
        trust: counts.critical > 0 ? 0.9 : 0.7,
      })
      .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
  }

  // ── 7. Advisory email signal (Phase 2 — never blocks; no email seam) ─────
  const emailWorthy = findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.critical);
  if (emailWorthy) {
    ctx.log(`(note) ${counts.critical} critical finding(s) — Phase 2 would email the operator; email seam not wired, report-only.`);
  }

  return {
    ok: governed ? governed.verified : true,
    verifier: governed?.verifierActor ?? null,
    filesScanned: files.length,
    findings: findings.length,
    critical: counts.critical,
    warn: counts.warn,
    info: counts.info,
    narrated: narrative.available,
    emailWorthy,
    report: dryRun ? null : reportRel,
    wrote,
    costUSD: governed?.cost.usd ?? 0,
  };
});

// ── target resolution ──────────────────────────────────────────────────────
// The scan-target list comes from the invocation (args first, else whitespace-
// split text). The reborn contract has no directory-glob read seam, so the
// invoking hook supplies changed/candidate paths; absent any, a default set of
// conventional high-signal security paths is scanned.
function resolveTargets(input: AgentContext["input"]): string[] {
  const fromArgs = (input.args ?? []).map((s) => s.trim()).filter(Boolean);
  if (fromArgs.length) return fromArgs;
  const fromText = (input.text ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (fromText.length) return fromText;
  return DEFAULT_SCAN_CANDIDATES;
}

function baseName(p: string): string {
  return p.split("/").pop() || "";
}

// ─── Secrets scan (ported from checks/secrets.mjs) ──────────────────────────
// Classification only: a finding NEVER carries the matched value — only the rule,
// the location, and a value-free shape + non-reversible fingerprint.

const SECRET_PATTERNS: { rule: string; severity: Severity; classification: string; re: RegExp }[] = [
  { rule: "secrets.pem-private-key", severity: "critical", classification: "PEM private-key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { rule: "secrets.anthropic-key", severity: "critical", classification: "Anthropic API key (sk-ant-)", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "secrets.openai-key", severity: "critical", classification: "OpenAI-style API key (sk- / sk-proj-)", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { rule: "secrets.aws-access-key", severity: "critical", classification: "AWS access-key ID (AKIA)", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "secrets.github-token", severity: "critical", classification: "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { rule: "secrets.google-api-key", severity: "critical", classification: "Google API key (AIza)", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "secrets.jwt", severity: "critical", classification: "JSON Web Token (three base64url segments)", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    rule: "secrets.generic-assignment",
    severity: "warn",
    classification: 'secret-shaped assignment (key/secret/token/password = "<literal>")',
    re: /\b(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*["'`][A-Za-z0-9/+_\-]{16,}["'`]/gi,
  },
  { rule: "secrets.long-hex", severity: "info", classification: "long bare hex blob (heuristic — may be a hash/checksum, not a secret)", re: /\b[0-9a-f]{40,}\b/g },
];

// Lines that strongly indicate an EXAMPLE / placeholder, not a live secret.
const PLACEHOLDER_HINTS = /\b(example|placeholder|your[_-]?key|changeme|xxxx+|dummy|sample|redacted|<[^>]+>|\.\.\.)\b/i;

// Short, deterministic, NON-reversible fingerprint of a matched value (8 hex of a
// sha256) — correlates the same finding across runs WITHOUT exposing the value.
// Bun.CryptoHasher is Bun-native (no node:crypto import).
function redactedFingerprint(matchText: string): string {
  return new Bun.CryptoHasher("sha256").update(String(matchText)).digest("hex").slice(0, 8);
}

function runSecretChecks(files: SrcFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!f.text) continue;
    const isExampleFile = /(\.example$|\.sample$|\.dist$|README|\.md$)/i.test(f.path);
    const lines = f.text.split("\n");
    lines.forEach((line, idx) => {
      for (const pat of SECRET_PATTERNS) {
        pat.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.re.exec(line)) !== null) {
          const value = m[0];
          let severity: Severity = pat.severity;
          const looksPlaceholder = PLACEHOLDER_HINTS.test(line);
          if (looksPlaceholder || isExampleFile) {
            severity = severity === "critical" ? "warn" : "info";
          }
          findings.push({
            rule: pat.rule,
            severity,
            file: f.path,
            line: idx + 1,
            // `quote` is a SHAPE description, NEVER the matched value.
            quote: `[${pat.classification}] · fingerprint ${redactedFingerprint(value)} · ${value.length} chars`,
            detail:
              `${pat.classification} detected at ${f.path}:${idx + 1}. ` +
              `Reported as classification + redacted fingerprint only (value withheld). ` +
              (looksPlaceholder || isExampleFile
                ? "Surrounding context looks like an example/placeholder — demoted; verify it is not a live credential. "
                : "Verify this is not a committed live credential; rotate immediately if it is. ") +
              `Hardening: move secrets to a secret manager / env var, add the path to the secret-scan ignore set only if it is a verified fixture, and confirm the pre-commit/CI secret scan covers this shape.`,
          });
        }
      }
    });
  }
  return findings;
}

// ─── Dependency-surface scan (ported from checks/dependencies.mjs) ──────────
// HEURISTIC, offline: reads the pre-read package.json contents, never the network.

const SENSITIVE_PACKAGE_HINTS =
  /(auth|crypto|jsonwebtoken|jwt|bcrypt|passport|oauth|axios|node-fetch|got|request|exec|shell|serialize|yaml|lodash|googleapis|aws-sdk|@aws-sdk|firebase|nodemailer)/i;

const HIGH_COUNT_THRESHOLD = 40;

function classifyRange(spec: unknown): "wildcard" | "git-or-url" | "floating" | "pinned" | "other" {
  if (typeof spec !== "string") return "other";
  if (spec === "*" || spec === "latest" || spec === "") return "wildcard";
  if (/^(git\+|github:|file:|link:|https?:|git:)/i.test(spec)) return "git-or-url";
  if (/^[\^~]/.test(spec) || /\.x$/.test(spec) || spec.includes(" - ") || spec.includes("||")) return "floating";
  return "pinned";
}

function runDependencyChecks(manifests: SrcFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const man of manifests) {
    let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try {
      pkg = JSON.parse(man.text);
    } catch {
      continue; // invalid JSON — skip
    }
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};
    const directCount = Object.keys(deps).length + Object.keys(devDeps).length;

    const inspect = (block: Record<string, unknown>, blockName: string) => {
      for (const [name, spec] of Object.entries(block)) {
        const kind = classifyRange(spec);
        const sensitive = SENSITIVE_PACKAGE_HINTS.test(name);
        if (kind === "wildcard") {
          findings.push({
            rule: "deps.wildcard-version",
            severity: "warn",
            file: man.path,
            line: null,
            quote: `${name} (${blockName})`,
            detail: `HEURISTIC: "${name}" has no version pin ("${String(spec)}"). A wildcard/latest spec installs whatever the registry serves at install time — no lockfile-independent provenance. Hardening: pin to an exact version and rely on the committed lockfile.`,
          });
        } else if (kind === "git-or-url") {
          findings.push({
            rule: "deps.git-or-url-dependency",
            severity: "warn",
            file: man.path,
            line: null,
            quote: `${name} → ${String(spec)} (${blockName})`,
            detail: `HEURISTIC: "${name}" is sourced from a git/url spec rather than the registry. This bypasses registry-side provenance and can dodge supply-chain scanners. Hardening: prefer a registry version, or vendor + lockfile-pin if a fork is genuinely required, and document why.`,
          });
        } else if (kind === "floating" && sensitive) {
          findings.push({
            rule: "deps.floating-range",
            severity: "warn",
            file: man.path,
            line: null,
            quote: `${name}@${String(spec)} (${blockName})`,
            detail: `HEURISTIC: security-sensitive package "${name}" uses a floating range ("${String(spec)}"). A compromised minor/patch in this class has outsized reach (auth/crypto/network/exec). Hardening: pin sensitive packages exactly and bump deliberately; keep the lockfile authoritative and CI-verified.`,
          });
        }
      }
    };

    inspect(deps, "dependencies");
    inspect(devDeps, "devDependencies");

    for (const name of Object.keys(deps)) {
      if (name in devDeps) {
        findings.push({
          rule: "deps.duplicate-across-blocks",
          severity: "info",
          file: man.path,
          line: null,
          quote: name,
          detail: `HEURISTIC: "${name}" appears in BOTH dependencies and devDependencies. This is a drift smell — the two specs can diverge and the resolved version becomes ambiguous. Hardening: keep each dependency in exactly one block.`,
        });
      }
    }

    if (directCount >= HIGH_COUNT_THRESHOLD) {
      findings.push({
        rule: "deps.high-count",
        severity: "info",
        file: man.path,
        line: null,
        quote: `${directCount} direct dependencies`,
        detail: `HEURISTIC: ${man.path} declares ${directCount} direct dependencies (threshold ${HIGH_COUNT_THRESHOLD}). A broad direct-dependency surface increases supply-chain exposure. Hardening: periodically prune unused deps and prefer the platform/stdlib where it suffices.`,
      });
    }
  }
  return findings;
}

// ─── Config / CI checks (ported from agent.mjs runConfigChecks) ─────────────
// Two quick offline static checks: least-privilege workflow permissions, and a
// committed .env that carries real-looking KEY=VALUE config. HEURISTIC + offline.

function runConfigChecks(files: SrcFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!f.text) continue;

    const isWorkflow = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path);
    if (isWorkflow) {
      f.text.split("\n").forEach((line, idx) => {
        if (/^\s*permissions:\s*write-all\s*$/.test(line)) {
          findings.push({
            rule: "config.workflow-broad-permissions",
            severity: "warn",
            file: f.path,
            line: idx + 1,
            quote: "permissions: write-all",
            detail:
              "HEURISTIC: workflow grants `permissions: write-all`, giving the GITHUB_TOKEN the broadest possible scope. " +
              "A compromised action step then inherits write to everything. Hardening: set least-privilege `permissions:` per " +
              "job (default to `contents: read` and add only the scopes a step actually needs).",
          });
        }
      });
    }

    const base = baseName(f.path);
    const isEnvFile = /^\.env(\.[A-Za-z0-9_-]+)?$/.test(base);
    const isTemplate = /\.(example|sample|dist|template)$/i.test(base);
    if (isEnvFile && !isTemplate) {
      const hasAssignment = f.text
        .split("\n")
        .some((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(l) && !/^\s*#/.test(l));
      if (hasAssignment) {
        findings.push({
          rule: "config.committed-env-file",
          severity: "warn",
          file: f.path,
          line: null,
          quote: `${base} (committed env file with assignments)`,
          detail:
            `HEURISTIC: a committed \`${base}\` carries \`KEY=VALUE\` assignments — env files are a common accidental-secret ` +
            `vector. Confirm it holds no live credentials; if it is a template, rename it to \`${base}.example\` and add ` +
            `\`${base}\` to .gitignore. The secret-shape scan above also inspects this file's contents.`,
        });
      }
    }
  }
  return findings;
}

// ─── Item IDs + grading (ported) ────────────────────────────────────────────

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

// ─── Narrator task (the ONE governed pass) ──────────────────────────────────
// Folds the legacy narrator system+user prompt into a single governed task over a
// CLASSIFICATION-ONLY digest. No secret value crosses this boundary (`quote` is
// value-free by construction).
function buildNarratorTask(
  date: string,
  counts: { critical: number; warn: number; info: number },
  findings: Finding[],
): string {
  const digest = findings
    .slice(0, 60)
    .map((f) => `- [${f.severity}] ${f.rule} @ ${f.file}${f.line ? ":" + f.line : ""} — ${f.quote || ""}`)
    .join("\n");
  return (
    `You are the Agix Security Officer's narrator. Write a short TL;DR over this deterministic security findings list. ` +
    `You are a calm, exacting security architect doing a posture review, not a pentester. Rules: summarize the shape of the ` +
    `risk surface (do not restate every finding); lead with the highest-severity theme; every input line is a CLASSIFICATION ` +
    `(shape + location), never a secret value, so never speculate a concrete credential; label heuristics as heuristics; ` +
    `4-8 sentences of plain prose, no headings, no lists, no em dashes, no filler.\n\n` +
    `Date: ${date}\nTotals: ${counts.critical} critical, ${counts.warn} warn, ${counts.info} info.\n\n` +
    `Findings (classification only):\n${digest}\n\nWrite the TL;DR.`
  );
}

// ─── Report rendering (narrator pattern, ported from composeReport) ─────────

function composeReport(args: {
  date: string;
  scanTargets: string[];
  filesScanned: number;
  findings: Finding[];
  narrative: { available: boolean; text?: string; reason?: string; model?: string };
}): string {
  const { date, scanTargets, filesScanned, findings, narrative } = args;
  const counts = countBySeverity(findings);
  const overall = counts.critical > 0 ? "critical" : counts.warn > 0 ? "pass-with-warnings" : "pass";
  const outcome =
    overall === "pass" ? "Pass — no findings" : overall === "pass-with-warnings" ? "Pass with warnings" : "Critical findings present";

  const lines: string[] = [];
  // Frontmatter (machine-readable summary).
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push(`agent: security-officer`);
  lines.push(`trust_level: proposer`);
  lines.push(`scan_targets: ${scanTargets.length}`);
  lines.push(`files_scanned: ${filesScanned}`);
  lines.push(`findings:`);
  lines.push(`  critical: ${counts.critical}`);
  lines.push(`  warn: ${counts.warn}`);
  lines.push(`  info: ${counts.info}`);
  lines.push(`overall: ${overall}`);
  lines.push(`narrative_available: ${narrative.available}`);
  lines.push("---");
  lines.push("");

  lines.push(`# Security Officer Audit · ${date}`);
  lines.push("");
  lines.push(`**Files scanned**: ${filesScanned}`);
  lines.push(`**Outcome**: ${outcome}`);
  lines.push("");
  lines.push(
    "> Read-only posture review. Findings are classification + location only — no raw secret value appears in this report. " +
      "Advisory: the Security Officer never blocks a commit or a deploy.",
  );
  lines.push("");

  // Narrator TL;DR (the LLM layer — optional, sits ABOVE the data).
  lines.push("## TL;DR");
  lines.push("");
  if (narrative.available && narrative.text) {
    lines.push(narrative.text);
    lines.push("");
    lines.push(
      `_Governed narration (certified by a distinct verifier) over a classification-only digest. The deterministic findings below are the authoritative data layer._`,
    );
  } else {
    lines.push(`_Narrative slot unavailable: ${narrative.reason || "no narrator output."}_`);
  }
  lines.push("");

  // Deterministic data layer.
  lines.push("## Findings");
  lines.push("");
  if (findings.length === 0) {
    lines.push("_No findings. Clean run._");
    lines.push("");
  } else {
    lines.push("| ID | Severity | Rule | Location |");
    lines.push("|---|---|---|---|");
    for (const f of findings) {
      const loc = `${f.file}${f.line ? ":" + f.line : ""}`;
      lines.push(`| ${f.id} | ${f.severity} | \`${f.rule}\` | \`${escapeCell(loc)}\` |`);
    }
    lines.push("");
    for (const f of findings) {
      lines.push(`### ${f.id} · ${f.severity.toUpperCase()} · \`${f.rule}\``);
      lines.push("");
      lines.push(`- **Location**: \`${f.file}${f.line ? ":" + f.line : ""}\``);
      if (f.quote) lines.push(`- **Classification**: \`${escapeBackticks(f.quote)}\``);
      lines.push(`- **Detail**: ${f.detail}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("## How to act on this");
  lines.push("");
  lines.push(
    "The Security Officer is a **proposer** — it never edits source, opens PRs, or runs offensive tooling. Each finding above " +
      "carries a hardening recommendation in its **Detail**. A human or an executor-trust agent acts on it. Critical findings " +
      "(secret shapes that are not verified fixtures) should be triaged first: confirm whether the value is a live credential " +
      "and rotate immediately if so.",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

function escapeBackticks(s: string): string {
  return String(s).replace(/`/g, "\\`");
}
function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|");
}
