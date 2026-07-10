// Agix Sentinel — public-release IP/PII guardian (proposer / worker caste), reborn
// on Bun.
//
// This is the BEHAVIOR layer. Identity, trust=proposer, model tiering
// (worker=haiku narration, verifier=sonnet grader), the boundary (write only
// wiki/sentinel/, deny publish/sign/push + agents/*/manifest sources), and
// public=true live in the sibling agent.json. Sentinel keeps its two-layer
// NARRATOR shape:
//   1. DETERMINISTIC gate (data layer) — a network-free, pattern-based scan over
//      the bounded read seam (secret patterns + real-email detection + the LEARNED
//      entity rules). Its hits are objective, so a smoke run is faithful and a
//      hallucination can never touch the verdict.
//   2. ADAPTIVE layer — ONE GOVERNED hive pass (ctx.hive.run) flags NOVEL entities
//      no rule has seen yet; a DISTINCT verifier certifies it (actor≠verifier).
//      High-confidence finds are LEARNED (wiki/sentinel/learned-entities.json) and
//      become PROPOSED gate rules, so the NEXT deterministic sweep catches by rule
//      what this one caught by reasoning. The loop compounds.
//
// Modes:
//   agix agent run sentinel [--target <path…>]      → sweep (default: the pack surface)
//   agix agent run sentinel generalize <agent>      → propose a stripped generic rewrite
//
// The legacy runtime.getModel().chat() calls (adaptive novel-entity detection +
// the generalization narration) each map to ONE ctx.hive.run (governed). State
// writes (learned-entities.json, the sweep report, the generalization proposal)
// map to ctx.writeRepoFile (bounded by boundary.write); the durable sweep memory
// maps to an attested ctx.comb.put (author=queen, verifier=distinct). The exposure
// NOTIFICATION (legacy runtime.sendNotification, channel=all on exposure_detected)
// now maps to ctx.notify — a CRITICAL "DO NOT RELEASE" alert on the `release`
// channel, dry-run/queued by default (see below).
//
// NOW WIRED (was NOT PORTED — the seam landed):
//   - The exposure NOTIFICATION (legacy runtime.sendNotification, channel=all on
//     exposure_detected). ctx.notify now exists, so a DO NOT RELEASE verdict pushes a
//     CRITICAL alert (channel="release"; the title + body name the leak COUNT and
//     severity; classification + location only, never a secret value). ROADMAP FLAG:
//     delivery is DRY-RUN/queued by default (recorded, not sent) — a live channel
//     transport is a deployment config that plugs into the same seam and fails closed.
//
// NOT PORTED (still deferred; flagged here + in the port's notPorted[]):
//   - The AUTHORITATIVE external gate script (scripts/release/verify-public-clean.sh)
//     invoked by the legacy via node:child_process spawnSync over absolute repo
//     paths. The reborn AgentContext exposes NO repoRoot and NO shell seam to the TS
//     orchestrator (the same boundary posture the ci-warden + investigator ports
//     note), and tool/credential use routes through the GOVERNED Go tool catalog +
//     guard-bee boundary, not a raw shell spawn from agent.ts. The deterministic
//     verdict is reduced to a built-in pattern gate applied over the bounded
//     ctx.readRepoFile sample; wiring the full external gate is deferred to a
//     governed `gate` tool in the Go catalog. The narrator property (verdict is
//     data, never the LLM's prose) is preserved by the built-in gate.
//   - Full-tree directory WALK of the target dirs (legacy readdir/walk). The reborn
//     contract exposes no directory-glob seam to the orchestrator, so the
//     deterministic gate samples a bounded set of target FILES (positional/--target
//     paths, else DEFAULT_SURFACE); the GOVERNED sweep carries read/grep/glob and
//     does the real enumeration in Go.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const LEARNED_PATH = "wiki/sentinel/learned-entities.json";
const SWEEPS_DIR = "wiki/sentinel/sweeps";
const GENERALIZATIONS_DIR = "wiki/sentinel/generalizations";

// Default public-bound surface files sampled through the bounded read seam for the
// deterministic gate when no --target is given. Illustrative representatives of the
// pack surface — the GOVERNED sweep (read/grep/glob) does the full enumeration.
const DEFAULT_SURFACE = [
  "README.md",
  "bin/agix",
  "agents/onboarding/agent.json",
  "agents/mentor/agent.json",
];

// ── Deterministic gate patterns (network-free, high-signal, low false-positive) ──
const SECRET_PATTERNS: { category: string; re: RegExp }[] = [
  { category: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { category: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { category: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: "provider-api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
];
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
// Generic placeholder domains a public tool may legitimately ship (never a leak).
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net",
  "your-domain.com", "your-company.com", "test.com", "email.com", "domain.com",
]);

interface GateHit {
  category: string;
  file: string;
  redacted: string; // classification + location only — NEVER the raw secret value
}
interface LearnedRow {
  entity: string;
  type: string;
  proposed_gate_rule: string;
  first_seen: string;
}
interface NovelEntity {
  entity: string;
  type?: string;
  confidence?: string;
  why?: string;
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Redaction discipline (inherited from the soul): report classification + location,
// never the value. Secrets are masked; a learned/name/email finding shows the
// classification token, not a raw secret string.
function mask(s: string): string {
  if (s.length <= 4) return "•".repeat(s.length);
  return s.slice(0, 3) + "•".repeat(Math.min(12, Math.max(3, s.length - 3)));
}
function maskEmail(e: string): string {
  const [local, domain = ""] = e.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed sweep surface once ($0), no report,
  // no learn, no Comb write. Mirrors the Node smoke contract ("exercise the
  // surfaces"): the deterministic gate is network-free, so nothing is stubbed.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the release-guardian sweep surface is live");
    ctx.log("smoke short-circuit · governed sweep surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const target = generalizeTarget(ctx);
  if (target) return generalizeMode(ctx, target);
  return sweepMode(ctx);
});

// ── sweep: deterministic gate (data) + one governed adaptive pass + learn ────────
async function sweepMode(ctx: AgentContext): Promise<AgentResult> {
  const date = isoDate();
  const targets = resolveTargets(ctx);

  // 1. Deterministic gate — the data layer whose verdict the LLM can never corrupt.
  const learnedRules = await loadLearnedRules(ctx);
  const gate = await runStaticGate(ctx, targets, learnedRules);
  ctx.log(
    `static gate · scanned ${targets.length} target(s) · ${gate.findingCount} hit(s) ` +
      `(${gate.clean ? "clean" : "EXPOSURE"})`,
  );

  // 2. Adaptive layer — the ONE governed intelligence pass. Legacy
  //    runtime.getModel().chat() → ctx.hive.run; a DISTINCT verifier certifies.
  const sample = await sampleTargets(ctx, targets, 12_000);
  const r = await ctx.hive.run(
    `You are sweeping a PUBLIC-bound open-source surface. It must contain NO real-world private entities. ` +
      `From the content below, list SPECIFIC items that look like private IP a generic public tool should not ship: ` +
      `person names, company or client names, project codenames, internal product names, physical addresses, or ` +
      `unique identifiers. Ignore generic placeholders (example.com, <your-client>, the operator). For each item ` +
      `return an object {entity, type, confidence:"high"|"med"|"low", why}. Reply ONLY with a JSON array.` +
      (gate.clean ? "" : ` The static gate already flagged ${gate.findingCount} known-pattern hit(s); focus on the NOVEL.`) +
      `\n\nTARGETS: ${targets.join(", ")}\n\n--- CONTENT ---\n${sample}`,
  );
  const novel = parseNovel(r.answer);

  // 3. Learn — high-confidence novel entities compound into proposed gate rules.
  const learned = await updateLearnedEntities(ctx, novel.high, date);

  const exposure = !gate.clean || novel.high.length > 0;

  // 4. Narrator report (deterministic data + governed narration), bounded write.
  const reportPath = `${SWEEPS_DIR}/${date}.md`;
  const report = renderSweepReport({ date, targets, gate, novel, learned, exposure, verifier: r.verifierActor });
  try {
    await ctx.writeRepoFile(reportPath, report);
    ctx.log("sweep report written", { path: reportPath });
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // Exposure → push a CRITICAL "DO NOT RELEASE" alert through the governed notify
  // seam (dry-run/queued by default; a live channel transport plugs in fail-closed
  // as a deployment config). Detection + the report are unchanged; the alert is
  // additive and never fails the sweep. Redaction discipline holds: the alert names
  // the leak COUNT + severity + classification, never a raw secret value.
  let notified = false;
  if (exposure) {
    const gateCats = [...new Set(gate.hits.map((h) => h.category))];
    const alertBody =
      `Public-clean sweep found ${gate.findingCount} deterministic gate hit(s)` +
      (gateCats.length ? ` (${gateCats.join(", ")})` : "") +
      ` and ${novel.high.length} high-confidence novel private-entity candidate(s) across ${targets.length} ` +
      `target(s): ${targets.join(", ")}. DO NOT RELEASE. Classification + location only — no secret value is echoed. ` +
      `Report: ${reportPath}. Operator action: remediate each finding, then re-sweep before publishing.`;
    try {
      const dr = await ctx.notify({
        channel: "release",
        level: "critical",
        title: `Sentinel: DO NOT RELEASE — ${gate.findingCount} leak(s), ${novel.high.length} novel high-confidence`,
        body: alertBody,
        to: "operator",
      });
      notified = dr.sent || dr.queued;
      ctx.log(
        `EXPOSURE — ${gate.findingCount} gate hit(s), ${novel.high.length} high-confidence novel candidate(s); ` +
          `DO NOT RELEASE — alert ${dr.sent ? "sent" : "queued"} (channel=${dr.channel}, mode=${dr.mode})`,
      );
    } catch (e) {
      ctx.log(`exposure alert skipped: ${(e as Error).message}`);
    }
  }

  // 5. Persist the sweep verdict as durable, attested memory (actor≠verifier).
  await ctx.comb
    .put({
      id: `sentinel/sweep/${date}`,
      content:
        `sentinel/sweep ${date}: ${exposure ? "EXPOSURE" : "clean"} — ` +
        `gate=${gate.findingCount} novel_high=${novel.high.length} learned=${learned.added.length} ` +
        `targets=${targets.join(",")}`,
      branch: "knowledge", // TOGAF Knowledge Architecture — the learned IP boundary lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: exposure ? 0.9 : 0.7,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    swept: true,
    clean: !exposure,
    exposure,
    gate_hits: gate.findingCount,
    gate_categories: [...new Set(gate.hits.map((h) => h.category))],
    novel_candidates: novel.all.length,
    novel_high: novel.high.length,
    learned: learned.added.length,
    learned_total: learned.total,
    verifier: r.verifierActor,
    report: reportPath,
    notified, // CRITICAL "DO NOT RELEASE" alert pushed through ctx.notify on exposure (dry-run/queued by default)
    costUSD: r.cost.usd,
  };
}

// ── generalize: propose a stripped, public-safe rewrite of a client-inspired agent ─
async function generalizeMode(ctx: AgentContext, agentName: string): Promise<AgentResult> {
  const date = isoDate();
  const files: string[] = [];
  for (const rel of [
    `agents/${agentName}/agent.json`,
    `agents/${agentName}/PERSONA.md`,
    `agents/${agentName}/agent.ts`,
    `agents/${agentName}/manifest.yaml`,
    `agents/${agentName}/agent.mjs`,
  ]) {
    const text = await ctx.readRepoFile(rel).catch(() => null);
    if (text != null) files.push(`# ${rel}\n${text.slice(0, 4_000)}`);
  }
  if (files.length === 0) {
    ctx.log(`agent not found: ${agentName}`);
    return { ok: false, mode: "generalize", reason: "agent-not-found", agent: agentName };
  }

  // Legacy runtime.getModel().chat() → one governed pass; a DISTINCT verifier certifies.
  const r = await ctx.hive.run(
    `This agent may have been inspired by a specific client. Propose a GENERIC, public-safe version: a redaction ` +
      `map (every client, operator, or IP-specific detail mapped to a config value or a generic placeholder), ` +
      `preserving the utility. Then list what MUST become configurable. Be concrete. This is a PROPOSAL only; ` +
      `edit nothing.\n\n${files.join("\n\n")}`,
  );
  const proposal = r.answer.trim();

  const proposalPath = `${GENERALIZATIONS_DIR}/${agentName}-${date}.md`;
  const doc =
    `# Sentinel — generalization proposal: ${agentName}\n\n` +
    `> Proposer output — review and apply manually; nothing was edited.\n` +
    `> Governed pass, certified by ${r.verifierActor} (actor≠verifier).\n\n` +
    `${proposal}\n`;
  try {
    await ctx.writeRepoFile(proposalPath, doc);
    ctx.log("generalization proposal written", { path: proposalPath });
  } catch (e) {
    ctx.log(`proposal write skipped: ${(e as Error).message}`);
  }

  await ctx.comb
    .put({
      content: `sentinel/generalize ${date}: proposed public-safe rewrite of ${agentName} — ${proposal.slice(0, 300)}`,
      branch: "knowledge",
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    mode: "generalize",
    generalized: agentName,
    verifier: r.verifierActor,
    proposal: proposalPath,
    costUSD: r.cost.usd,
  };
}

// ─── Deterministic gate ──────────────────────────────────────────────────────
async function runStaticGate(
  ctx: AgentContext,
  targets: string[],
  learnedRules: LearnedRow[],
): Promise<{ clean: boolean; hits: GateHit[]; findingCount: number }> {
  const hits: GateHit[] = [];
  for (const rel of targets) {
    const text = await ctx.readRepoFile(rel).catch(() => null);
    if (text == null) continue;

    for (const { category, re } of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) hits.push({ category, file: rel, redacted: mask(m[0]) });
    }
    for (const m of text.matchAll(EMAIL_RE)) {
      const email = m[0];
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain && PLACEHOLDER_DOMAINS.has(domain)) continue;
      hits.push({ category: "email", file: rel, redacted: maskEmail(email) });
    }
    // The compounding loop: rules LEARNED from prior sweeps now catch by pattern.
    for (const rule of learnedRules) {
      let re: RegExp;
      try {
        re = new RegExp(rule.proposed_gate_rule, "gi");
      } catch {
        continue; // a malformed learned rule never breaks the gate
      }
      if (re.test(text)) hits.push({ category: `learned:${rule.type}`, file: rel, redacted: rule.entity });
    }
  }
  return { clean: hits.length === 0, hits, findingCount: hits.length };
}

// ─── Learning — novel entities become durable proposed gate rules ─────────────
async function loadLearnedRules(ctx: AgentContext): Promise<LearnedRow[]> {
  const raw = await ctx.readRepoFile(LEARNED_PATH).catch(() => null);
  if (!raw) return [];
  try {
    const store = JSON.parse(raw) as { entities?: LearnedRow[] };
    return Array.isArray(store.entities) ? store.entities : [];
  } catch {
    return [];
  }
}

async function updateLearnedEntities(
  ctx: AgentContext,
  novelHigh: NovelEntity[],
  date: string,
): Promise<{ added: LearnedRow[]; total: number }> {
  let store: { entities: LearnedRow[]; updated: string | null } = { entities: [], updated: null };
  const raw = await ctx.readRepoFile(LEARNED_PATH).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { entities?: LearnedRow[]; updated?: string | null };
      store = { entities: Array.isArray(parsed.entities) ? parsed.entities : [], updated: parsed.updated ?? null };
    } catch {
      /* corrupt store → start fresh (never blocks the sweep) */
    }
  }

  const known = new Set(store.entities.map((e) => String(e.entity).toLowerCase()));
  const added: LearnedRow[] = [];
  for (const e of novelHigh) {
    const key = String(e.entity).toLowerCase();
    if (!key || known.has(key)) continue;
    known.add(key);
    const rule = `\\b${String(e.entity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
    const row: LearnedRow = { entity: e.entity, type: e.type || "unknown", proposed_gate_rule: rule, first_seen: date };
    store.entities.push(row);
    added.push(row);
  }
  if (added.length) {
    store.updated = date;
    try {
      await ctx.writeRepoFile(LEARNED_PATH, JSON.stringify(store, null, 2) + "\n");
    } catch (e) {
      ctx.log(`learned-entities write skipped: ${(e as Error).message}`);
    }
  }
  return { added, total: store.entities.length };
}

// ─── Adaptive-layer parsing ───────────────────────────────────────────────────
function parseNovel(answer: string): { all: NovelEntity[]; high: NovelEntity[] } {
  try {
    const arr = JSON.parse((answer.match(/\[[\s\S]*\]/) || ["[]"])[0]) as unknown;
    const all = Array.isArray(arr) ? (arr.filter((e) => e && typeof e === "object" && "entity" in e) as NovelEntity[]) : [];
    return { all, high: all.filter((e) => e.confidence === "high") };
  } catch {
    return { all: [], high: [] };
  }
}

// ─── Target resolution + sampling (bounded read seam) ─────────────────────────
function resolveTargets(ctx: AgentContext): string[] {
  const flag = typeof ctx.input.flags.target === "string" ? ctx.input.flags.target : "";
  const explicit = [flag, ctx.input.text]
    .flatMap((s) => String(s || "").split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const deduped = [...new Set(explicit)];
  return deduped.length ? deduped : DEFAULT_SURFACE;
}

async function sampleTargets(ctx: AgentContext, targets: string[], budget: number): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const rel of targets) {
    if (used >= budget) break;
    const text = await ctx.readRepoFile(rel).catch(() => null);
    if (text == null) continue;
    const slice = text.slice(0, Math.min(3_000, budget - used));
    parts.push(`# ${rel}\n${slice}`);
    used += slice.length;
  }
  return parts.join("\n\n");
}

// generalizeTarget extracts the agent name for generalize mode from either form:
//   sentinel generalize <agent>     (mode="generalize", args[0]=<agent>)
//   sentinel --generalize <agent>   (flags.generalize=<agent> | true + mode=<agent>)
function generalizeTarget(ctx: AgentContext): string {
  if (ctx.input.mode === "generalize") return (ctx.input.args[0] ?? "").trim();
  const g = ctx.input.flags.generalize;
  if (typeof g === "string") return g.trim();
  if (g === true) return (ctx.input.mode ?? "").trim();
  return "";
}

// ─── Narrator report (deterministic data + governed narration) ────────────────
function renderSweepReport(a: {
  date: string;
  targets: string[];
  gate: { clean: boolean; hits: GateHit[]; findingCount: number };
  novel: { all: NovelEntity[]; high: NovelEntity[] };
  learned: { added: LearnedRow[]; total: number };
  exposure: boolean;
  verifier: string;
}): string {
  const { date, targets, gate, novel, learned, exposure, verifier } = a;
  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${date}`);
  lines.push("agent: sentinel");
  lines.push(`exposure: ${exposure}`);
  lines.push(`gate_hits: ${gate.findingCount}`);
  lines.push(`novel_candidates: ${novel.all.length}`);
  lines.push(`novel_high: ${novel.high.length}`);
  lines.push(`learned: ${learned.added.length}`);
  lines.push(`verifier: ${verifier}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Sentinel sweep · ${date}`);
  lines.push("");
  lines.push(`**Verdict: ${exposure ? "🚫 EXPOSURE — DO NOT RELEASE" : "✅ clean"}**`);
  lines.push("");
  lines.push(`- Targets: ${targets.join(", ")}`);
  lines.push(`- Static gate: ${gate.clean ? "clean" : `${gate.findingCount} hit(s)`}`);
  lines.push(`- Adaptive layer: ${novel.all.length} candidate(s), ${novel.high.length} high-confidence (certified by ${verifier}, actor≠verifier)`);
  lines.push(`- Learned this sweep: ${learned.added.length} new entit${learned.added.length === 1 ? "y" : "ies"} (store total ${learned.total})`);
  lines.push("");
  lines.push(
    `_(Narrator pattern: the deterministic gate above is the source of truth; the adaptive layer is a governed pass and can never overturn a gate hit. On exposure a CRITICAL "DO NOT RELEASE" alert is pushed through the governed notify seam — dry-run/queued by default; a live channel transport is a deployment config.)_`,
  );
  lines.push("");

  if (!gate.clean) {
    lines.push("## Static gate hits (classification + location only)");
    lines.push("");
    for (const h of gate.hits.slice(0, 25)) lines.push(`- \`${h.category}\` in \`${h.file}\` → ${h.redacted}`);
    lines.push("");
  }
  if (novel.all.length) {
    lines.push("## Novel candidates (adaptive layer)");
    lines.push("");
    for (const e of novel.all) lines.push(`- **${e.entity}** (${e.type ?? "?"}, ${e.confidence ?? "?"}) — ${e.why ?? ""}`);
    lines.push("");
  }
  if (learned.added.length) {
    lines.push("## Learned → proposed gate rules");
    lines.push("");
    lines.push("Sentinel proposes ADDITIONS only. The next sweep catches these by rule:");
    lines.push("");
    for (const row of learned.added) lines.push(`- \`${row.proposed_gate_rule}\`  (${row.entity} · ${row.type})`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "_Sentinel is a **proposer** — it flags and proposes; it never edits source, never publishes or signs, and never echoes a secret value. It is a filter before the release, not the releaser._",
  );
  lines.push("");
  return lines.join("\n");
}
