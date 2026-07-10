// Agix Research Agent — the research scout (worker / proposer caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer →
// worker caste, model tiering queen=sonnet / worker=[haiku] / verifier=opus, the
// guard-bee boundary write only wiki/research/ + wiki/log.md, public=true) lives in
// the sibling agent.json, which the Go engine reads.
//
// The legacy pipeline was three separate raw model calls: per-source EXTRACT
// (Haiku, `cheap-classification`) → SYNTHESIZE the six-section brief (Sonnet,
// `default-quality`) → CRITIC grade (Opus, `long-context`). In the reborn contract
// that entire scan→synthesize→grade topology collapses into ONE governed hive pass:
// the queen decomposes, worker bees forage the registry sources (the scan fan-out,
// sized by manifest.workers), the queen synthesizes the brief, and a DISTINCT
// verifier certifies it (actor≠verifier). The Opus critic pass IS that verifier now
// — the four-dimension grade is the governed verdict, so the self-grade section is
// surfaced from r.verdict rather than a second raw model call. Per-role tiering
// (sonnet synth / haiku scan / opus grade) is reproduced by agent.json.models.
//
// Faithful reduction of agents/research/agent.mjs: the load-bearing brief +
// topic-dive syntheses are ported (brief → wiki/research/<date>-brief.md; dive →
// wiki/research/<date>-dive-<slug>.md), the wiki-log append is ported, the brief is
// recorded as an attested Comb leaf on the Knowledge branch, and the brief is now
// DELIVERED through the governed notify seam.
//
// PORTED via the reborn seam (previously deferred):
//   Email DELIVERY — the weekly brief is handed to the governed notify seam
//   (ctx.sendEmail), the orchestration twin of the Go core/tool/email tool. It is
//   OPT-IN (--send / --email; a bare run stays file + Comb only — the honest $0
//   default, so nothing is delivered unless asked) and DRY-RUN by default (recorded
//   + queued, nothing actually sent offline — no credential, no network). `emailed`
//   now reflects that dry-run delivery honestly (emailed:true, emailMode:"dry-run")
//   instead of the old hardcoded false. Default recipient is the manifest's declared
//   email output surface (else "operator"); --to overrides it. A dive never emails —
//   that stays the Director's territory, faithful to the Node "dive run; email is the
//   Director's job".
//
// NOT PORTED (honest roadmap flag):
//   1. LIVE email transport + the letter-style HTML render — a credentialed
//      SMTP/Gmail transport (the CliNotifier that shells the Go email tool with its
//      guard-bee grant) plus the marked + makeBriefingRenderer / renderBriefingHtml
//      chain + the email-briefing.html template + the Director-queue "last cycle
//      status" / reply-convention chrome. A live transport is a DEPLOYMENT CONFIG
//      that fails closed; dry-run delivery of the markdown brief is the honest default.
//   2. Live network foraging — HTTP fetch + the MCP-typed source client
//      (fetchMcpSource) + the concurrency pool. In the reborn model, foraging is a
//      Go-catalog tool (websearch/webfetch, declared in agent.json.tools) that the
//      governed hive owns; the TS layer NEVER re-implements a fetch/tool loop. The
//      registry is parsed here only to hand the hive its target list + provenance
//      counts; the scan itself runs governed in Go.
//   3. --no-research (re-render an existing brief) — that mode existed only to
//      re-email a prior brief cheaply via the HTML re-render; with the live HTML
//      transport unported it stays moot.
//   4. js-yaml / marked — Node deps, dropped. Sources are parsed with a minimal
//      dependency-free reader (name/url/priority) sufficient for the target list.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const SOURCES_REL_PATH = "agents/research/sources.yaml";
const RESEARCH_DIR = "wiki/research";
const WIKI_LOG_REL_PATH = "wiki/log.md";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

interface Source {
  name: string;
  url: string;
  priority: number;
  notes?: string;
}

// A minimal, dependency-free reader for agents/research/sources.yaml — enough to
// recover the ordered target list (name + url + priority + one-line notes) that the
// governed hive forages. Multi-line block scalars (notes: |) are not expanded; the
// literal registry parse (js-yaml) was a Node dep and is not ported.
function parseSources(raw: string): Source[] {
  const sources: Source[] = [];
  let cur: Source | null = null;
  for (const line of raw.split("\n")) {
    const name = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (name) {
      cur = { name: name[1], url: "", priority: 0 };
      sources.push(cur);
      continue;
    }
    if (!cur) continue;
    const url = line.match(/^\s*url:\s*(.+?)\s*$/);
    if (url) { cur.url = url[1]; continue; }
    const prio = line.match(/^\s*priority:\s*(\d+)/);
    if (prio) { cur.priority = parseInt(prio[1], 10); continue; }
    const notes = line.match(/^\s*notes:\s*(.+?)\s*$/);
    if (notes && notes[1] !== "|" && notes[1] !== ">") { cur.notes = notes[1]; }
  }
  return sources
    .filter((s) => s.name && s.url)
    .sort((a, b) => b.priority - a.priority);
}

// Dive output filename component: prefer the operator-meaningful item ID, else a
// slug of the topic. (Ported from the Node diveSlug + slugifyTitle.)
function diveSlug(diveItemId: string, topic: string): string {
  if (diveItemId && /^[A-Za-z0-9.-]+$/.test(diveItemId)) return diveItemId.replace(/\./g, "-");
  const slug = (topic || "dive")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "dive";
}

function flagStr(flags: Record<string, string | boolean>, ...keys: string[]): string {
  for (const k of keys) {
    const v = flags[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
function flagBool(flags: Record<string, string | boolean>, ...keys: string[]): boolean {
  return keys.some((k) => flags[k] === true || flags[k] === "true");
}

// The default brief recipient: the manifest's declared email output surface
// (outputs[].kind === "email" → its path), else "" so the caller falls back to
// "operator" (the reborn analogue of the Node toSelf: true). --to overrides it.
function declaredEmailRecipient(ctx: AgentContext): string {
  const out = (ctx.manifest.outputs ?? []).find((o) => o.kind === "email");
  return (out?.path ?? "").trim();
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: one $0 governed pass to prove the synthesis surface is
  // live, no registry read, no file write, no Comb write. Mirrors the Node smoke
  // contract ("exercise the surface", not "preview the help").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the research synthesis surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const flags = ctx.input.flags;
  const date = flagStr(flags, "date") || isoDate();
  const dryRun = flagBool(flags, "dry-run", "dryRun");
  const sourceFilter = flagStr(flags, "source");
  const diveItemId = flagStr(flags, "dive-item-id", "diveItemId");

  // Dive mode: a topic-focused sub-brief (file-only; the Node dive suppressed email
  // + wiki-log — a dive stays the Director's notification territory). Topic from
  // --topic or `dive <topic>`.
  const topic =
    flagStr(flags, "topic") ||
    (ctx.input.mode === "dive" ? ctx.input.text.trim() : "");
  const isDive = Boolean(topic);

  // Delivery is OPT-IN (--send / --email); a bare run stays file + Comb only (the
  // honest $0 default — nothing is delivered unless the operator asks). Recipient:
  // --to wins, else the declared email output surface, else "operator".
  const wantsSend = flagBool(flags, "send", "email", "mail");
  const emailTo = flagStr(flags, "to") || declaredEmailRecipient(ctx) || "operator";

  // ── 1. Load the source registry (the hive's forage targets) ──────────────
  const sourcesRaw = (await ctx.readRepoFile(SOURCES_REL_PATH)) ?? "";
  const sources = parseSources(sourcesRaw);
  const targets = sourceFilter ? sources.filter((s) => s.name === sourceFilter) : sources;
  if (targets.length === 0) {
    // Faithful to the Node abort ("No sources defined in registry" / no named
    // source), returned rather than thrown (the reborn no-signal posture).
    ctx.log(sourceFilter ? `no source named "${sourceFilter}"` : "no sources in registry — nothing to scan");
    return { ok: false, reason: sourceFilter ? "no-such-source" : "no-sources" };
  }

  const sourceList = targets
    .map((s, i) => `${i + 1}. ${s.name} — ${s.url}${s.notes ? ` (${s.notes})` : ""}`)
    .join("\n");

  // ── 2. ONE governed pass: scan → synthesize → DISTINCT verifier certifies ─
  ctx.log(`${isDive ? "dive" : "brief"} · ${targets.length} source${targets.length === 1 ? "" : "s"} for ${date}`, {
    topic: topic || undefined,
  });
  const task = isDive
    ? `Run a focused research DIVE on: ${topic}. Forage these registry sources, keep only items relevant to the topic, ` +
      `and synthesize the six-section brief biased entirely toward it (title + intro line reflect the focus). ` +
      `Date: ${date}.\n\nSources:\n${sourceList}`
    : `Synthesize this cycle's Weekly Research Brief for ${date}. Forage these registry sources, score and filter ` +
      `candidates by the rubric, and produce the six-section brief. Cite every claim with an inline verbatim URL.` +
      `\n\nSources:\n${sourceList}`;

  const r = await ctx.hive.run(task);

  // ── 3. Compose the final brief (frontmatter + body + governed self-grade) ─
  const brief = composeFinalBrief(r.answer, date, targets.length, {
    isDive,
    topic,
    diveItemId,
    verifier: r.verifierActor,
    approved: r.verdict.approved,
    notes: r.verdict.notes,
  });

  const briefRel = isDive
    ? `${RESEARCH_DIR}/${date}-dive-${diveSlug(diveItemId, topic)}.md`
    : `${RESEARCH_DIR}/${date}-brief.md`;

  if (dryRun) {
    ctx.log("dry-run · brief composed, not written", { verifier: r.verifierActor });
    return {
      ok: r.verified,
      mode: isDive ? "dive" : "brief",
      dryRun: true,
      verifier: r.verifierActor,
      brief: briefRel,
      emailed: false, // --dry-run composes only: no write, no Comb leaf, no delivery
      emailMode: "none",
    };
  }

  // ── 4. Write the brief (bounded by boundary.write = wiki/research/) ───────
  try {
    await ctx.writeRepoFile(briefRel, brief);
  } catch (e) {
    ctx.log(`brief write skipped: ${(e as Error).message}`);
  }

  // ── 5. Append the wiki log (canonical weekly brief only — not dives) ──────
  if (!isDive) {
    await appendWikiLog(ctx, date, targets.length).catch((e) => ctx.log(`wiki log skipped: ${(e as Error).message}`));
  }

  // ── 6. Record the brief as an attested Comb leaf (Knowledge branch) ───────
  await ctx.comb
    .put({
      content: `research/${isDive ? "dive" : "brief"} ${date}${topic ? ` (${topic})` : ""}: ${r.answer.slice(0, 400)}`,
      branch: "knowledge", // TOGAF Knowledge Architecture — field-state intelligence
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: r.verdict.approved ? 0.8 : 0.4,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  // ── 7. Deliver the weekly brief via the governed notify seam (opt-in) ─────
  // The Node runtime.sendEmail, reborn: OPT-IN (--send / --email) and DRY-RUN by
  // default (recorded + queued, nothing sent offline — no credential, no network). A
  // live SMTP/Gmail transport plugs in fail-closed as a deployment config. Only the
  // weekly brief delivers; a dive is the Director's notification territory. Delivery
  // failure never fails the run — the brief file + Comb leaf are the durable
  // deliverables either way.
  let delivery: { emailed: boolean; emailMode: string; emailTo: string | null } = {
    emailed: false,
    emailMode: "none",
    emailTo: null,
  };
  if (!isDive && wantsSend) {
    try {
      const d = await ctx.sendEmail({
        to: emailTo,
        subject: `Agix Research Brief — ${date}`,
        body: brief,
      });
      // emailed = handed to the notify seam (queued/recorded) or genuinely sent;
      // emailMode says HOW (dry-run offline default vs a live transport mode).
      delivery = { emailed: d.queued || d.sent, emailMode: d.mode, emailTo };
      ctx.log(`brief delivery · mode=${d.mode} sent=${d.sent} queued=${d.queued}`, { to: emailTo });
    } catch (e) {
      ctx.log(`brief delivery skipped: ${(e as Error).message}`);
    }
  }

  return {
    ok: r.verified,
    mode: isDive ? "dive" : "brief",
    topic: topic || null,
    verifier: r.verifierActor,
    queen: r.queenActor,
    brief: briefRel,
    sourcesScanned: targets.length,
    emailed: delivery.emailed, // dry-run delivery → true (queued/recorded); emailMode says how
    emailMode: delivery.emailMode, // "dry-run" (offline default) | a live transport mode | "none"
    emailTo: delivery.emailTo,
    costUSD: r.cost.usd,
  };
});

// ── Final composition ──────────────────────────────────────────────────────
interface ComposeMeta {
  isDive: boolean;
  topic: string;
  diveItemId: string;
  verifier: string;
  approved: boolean;
  notes: string;
}

function composeFinalBrief(draft: string, dateStr: string, sourcesScanned: number, meta: ComposeMeta): string {
  const title = meta.isDive ? `Agix Research — Dive on ${meta.topic} (${dateStr})` : `Agix Research Brief — ${dateStr}`;
  const tags = meta.isDive ? "[research, agents, dive]" : "[research, agents, weekly-brief]";
  const diveLines = meta.isDive
    ? `\ndive_topic: ${escapeYaml(meta.topic)}\n` + (meta.diveItemId ? `dive_item_id: ${meta.diveItemId}\n` : "")
    : "";
  const frontmatter =
    `---\n` +
    `title: ${title}\n` +
    `type: ${meta.isDive ? "research-dive" : "research-brief"}\n` +
    `domain: agents, llm-research\n` +
    `created: ${dateStr}\n` +
    `status: published\n` +
    `tags: ${tags}${diveLines}\n` +
    `sources_scanned: ${sourcesScanned}\n` +
    `verified_by: ${meta.verifier}\n` +
    `related: [[agent-hierarchy]], [[research-agent]], [[recursive-learning-strategy]]\n` +
    `---\n\n`;

  let body = draft.trim();

  // Governed self-grade: the legacy Opus critic (accuracy/completeness/timeliness/
  // governance JSON) is now the governed verifier's verdict. Surface its
  // certification (actor≠verifier) as the dogfooded self-grade.
  if (!/## 6\. Self-grade/.test(body)) {
    body +=
      `\n\n## 6. Self-grade (dogfooding the governed verifier)\n\n` +
      `Certified by \`${meta.verifier}\` (actor≠verifier). Verdict: ${meta.approved ? "approved" : "rejected"}.\n` +
      (meta.notes ? `\n> ${meta.notes.trim()}\n` : "");
  }

  return frontmatter + body + "\n";
}

// Bare-minimum YAML scalar escape (ported from the Node escapeYaml).
function escapeYaml(s: string): string {
  const str = String(s ?? "");
  return /[:#&*?{}[\],]/.test(str) ? JSON.stringify(str) : str;
}

// ── Wiki log append ─────────────────────────────────────────────────────────
// Inserts the entry above the first existing "## " heading (newest-first), the
// same placement the Node appendWikiLog used. Guarded: a missing log (first run /
// tmp repo) reads as "" and the file is created.
async function appendWikiLog(ctx: AgentContext, dateStr: string, sourcesScanned: number): Promise<void> {
  const entry =
    `\n## ${dateStr} — Research Agent: brief published\n\n` +
    `- ${sourcesScanned} source${sourcesScanned === 1 ? "" : "s"} scanned · governed synthesis certified by a distinct verifier.\n` +
    `- Full brief: [\`wiki/research/${dateStr}-brief.md\`](research/${dateStr}-brief.md).\n`;

  const existing = (await ctx.readRepoFile(WIKI_LOG_REL_PATH)) ?? "";
  const lines = existing.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { insertAt = i; break; }
  }
  const next = lines.slice(0, insertAt).join("\n") + entry + "\n" + lines.slice(insertAt).join("\n");
  await ctx.writeRepoFile(WIKI_LOG_REL_PATH, next);
}
