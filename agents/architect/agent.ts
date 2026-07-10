// Agix Architect — the CTO cross-reference agent (worker / proposer caste),
// reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer,
// model tiering worker=sonnet/verifier=haiku, the boundary that lets it write ONLY
// spec files, deny git, public=true) lives in the sibling agent.json, which the Go
// engine reads. For each in-flight spec it runs ONE GOVERNED hive pass (queen
// decompose → worker forage → synthesize → DISTINCT verifier), so the relevance
// scan is certified (actor≠verifier), never a raw model call. It re-renders ONLY
// the <!-- ARCHITECT:BEGIN/END --> marker section of the spec — the operator's
// hand edits everywhere else are preserved (strip-before-scan, splice-after).
//
// Faithful reduction of agents/architect/agent.mjs. Ported: the marker-delimited
// four-list annotation (applies / duplicates / roadmap_impact / architecture
// conflicts), the defensive filter that keeps the scan honest (no invented IDs or
// paths), the BUILD_FRAMEWORK roadmap parse, the recent-brief window, dry-run, and
// an attested Comb leaf per spec.
//
// PORTED via the governed `glob` tool (previously deferred). The reborn engine now
// grants a worker the fs read/grep/glob tools, bounded to the agent's
// boundary+repoRoot, INSIDE a governed pass — so the directory sweeps the Node
// version did with readdir now run as one governed discovery pass (actor≠verifier):
//   - Spec AUTO-DISCOVERY. With no spec named, a governed glob pass enumerates every
//     wiki/director/specs/*.md AND clients/*/wiki/director/specs/*.md, so a scheduled
//     run scans the whole spec surface exactly as the legacy readdir sweep did. Named
//     specs (positionals / --spec) short-circuit discovery; --no-discover forces the
//     explicit-only path.
//   - The recursive architecture/**/*.md TOC INDEX. The same discovery pass globs the
//     architecture tree, so architecture_conflicts are once again verified against a
//     REAL index (no invented paths) instead of being force-dropped client-side.
//   - Brief discovery. The discovery pass globs wiki/research/*-brief.md (+ the
//     per-client mirror); the date-window read-probe is retained as an OFFLINE
//     fallback so a run with no glob signal still finds the conventional briefs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const SPECS_REL_DIR = "wiki/director/specs";
const RESEARCH_REL_DIR = "wiki/research";
const ROADMAP_REL_PATH = "docs/framework/BUILD_FRAMEWORK.md";
const DEFAULT_LOOKBACK_DAYS = 28;
const DEFAULT_MARKER_BEGIN = "<!-- ARCHITECT:BEGIN -->";
const DEFAULT_MARKER_END = "<!-- ARCHITECT:END -->";

type Milestone = { id: string; status: string; handoff: string; blocked_on: string };
type Track = { letter: string; name: string; summary: string };
type Roadmap = { path: string; milestones: Milestone[]; tracks: Track[] };
type Brief = { date: string; path: string; markdown: string };

interface ScanResult {
  applies: Array<{ item_id: string; brief_path: string; relevance: string; note: string }>;
  duplicates: Array<{ item_id: string; brief_path: string; duplicate_of: string; duplicate_brief_path: string; note: string }>;
  roadmap_impact: Array<{ milestone_id: string; kind: string; note: string }>;
  architecture_conflicts: Array<{ architecture_path: string; kind: string; section: string; note: string }>;
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0), no scan, no
  // file write, no Comb write. Mirrors the Node smoke contract.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the spec cross-reference reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const flags = ctx.input.flags;
  const lookbackDays = Number(flags["lookback-days"] ?? DEFAULT_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS;
  const date = typeof flags.date === "string" ? flags.date : isoDate();
  const dryRun = flags["dry-run"] === true || flags.dryRun === true;
  const markerBegin = DEFAULT_MARKER_BEGIN;
  const markerEnd = DEFAULT_MARKER_END;

  const noDiscover = flags["no-discover"] === true || flags.noDiscover === true;

  // ── 1. Resolve target specs + discovery context (governed glob pass) ──────
  // Named specs (positionals / --spec) win. When none are named — a scheduled
  // sweep — a GOVERNED glob pass enumerates the whole spec surface. The same pass
  // globs the recent briefs and the architecture index, so arch conflicts are
  // verified against a REAL index. --no-discover forces the explicit-only path.
  const named = resolveSpecPaths(ctx);
  const discovery = noDiscover ? EMPTY_DISCOVERY : await discover(ctx, named.length === 0);
  const specPaths = named.length > 0 ? named : discovery.specs;
  if (specPaths.length === 0) {
    ctx.log(
      noDiscover
        ? "no spec named and --no-discover set — pass one or more spec paths (e.g. wiki/director/specs/foo.md) or --spec <path>"
        : `no specs found — none named and the governed glob sweep of ${SPECS_REL_DIR}/ (+ clients/*/…) returned nothing to annotate`,
    );
    return { ok: true, specs: 0, applied: 0, duplicates: 0, roadmap_impact: 0, architecture_conflicts: 0 };
  }

  // ── 2. Recent Research briefs — glob discovery ∪ date-window probe ─────────
  const briefs = await loadRecentBriefs(ctx, lookbackDays, date, discovery.briefs);
  if (briefs.length === 0) {
    ctx.log(`no briefs in ${RESEARCH_REL_DIR}/ within ${lookbackDays} days — nothing to cross-reference`);
    return { ok: true, specs: specPaths.length, applied: 0, duplicates: 0, roadmap_impact: 0, architecture_conflicts: 0 };
  }

  // ── 3. Phase-2 context: the roadmap (single known file) + the architecture ─
  //     index (globbed above), so architecture_conflicts are verified, not dropped.
  const roadmap = await loadRoadmap(ctx);
  const archPaths = new Set(discovery.arch);
  ctx.log(
    `scanning ${specPaths.length} spec${specPaths.length === 1 ? "" : "s"} against ${briefs.length} recent brief${briefs.length === 1 ? "" : "s"}` +
      (roadmap ? ` · roadmap: ${roadmap.milestones.length} milestones` : " · roadmap: (none)") +
      ` · architecture index: ${archPaths.size} doc${archPaths.size === 1 ? "" : "s"}` +
      (named.length === 0 ? " · specs: auto-discovered (glob)" : ""),
  );

  let totalApplied = 0;
  let totalDuplicates = 0;
  let totalRoadmapImpact = 0;
  let totalArchConflicts = 0;
  let scanned = 0;
  let allVerified = true;
  let verifier: string | null = null;
  let lastCostUSD = 0;

  for (const specRelPath of specPaths) {
    const specMarkdown = await ctx.readRepoFile(specRelPath);
    if (specMarkdown === null) {
      ctx.log(`skip: no spec at ${specRelPath}`);
      continue;
    }
    const stripped = stripMarkerSection(specMarkdown, markerBegin, markerEnd);

    // ── One GOVERNED cross-reference pass for THIS spec (actor≠verifier) ──
    const task = buildScanTask(stripped, briefs, roadmap, [...archPaths]);
    const r = await ctx.hive.run(task);
    verifier = r.verifierActor;
    lastCostUSD = r.cost.usd;
    if (!r.verified) allVerified = false;

    // Defensive filter: drop anything not tied to a REAL loaded artifact — keeps
    // the governed scan honest (no invented item IDs, brief paths, milestones, or
    // architecture paths — arch conflicts are now checked against the globbed index).
    const scan = parseScan(r.answer);
    const filtered = filterScanResult(scan, briefs, roadmap, archPaths);
    totalApplied += filtered.applies.length;
    totalDuplicates += filtered.duplicates.length;
    totalRoadmapImpact += filtered.roadmap_impact.length;
    totalArchConflicts += filtered.architecture_conflicts.length;

    const block = renderMarkerBlock(filtered, markerBegin, markerEnd, date);
    const nextMarkdown = applyMarkerBlock(stripped, block, markerBegin, markerEnd);

    if (dryRun) {
      ctx.log(
        `(dry-run) ${specRelPath}: applies=${filtered.applies.length} dup=${filtered.duplicates.length} ` +
          `roadmap=${filtered.roadmap_impact.length} arch=${filtered.architecture_conflicts.length}`,
      );
    } else {
      try {
        await ctx.writeRepoFile(specRelPath, nextMarkdown);
      } catch (e) {
        ctx.log(`spec write skipped: ${(e as Error).message}`);
      }
    }
    scanned++;

    // Feed the hive: record the annotation as an attested Comb leaf, vouched by
    // the run's DISTINCT verifier, so the cross-reference is durable memory.
    const specName = specRelPath.split("/").pop() ?? specRelPath;
    await ctx.comb
      .put({
        id: `architect/${specName}`,
        content:
          `architect/${specName} ${date}: applies=${filtered.applies.length} dup=${filtered.duplicates.length} ` +
          `roadmap=${filtered.roadmap_impact.length} arch=${filtered.architecture_conflicts.length}` +
          (filtered.applies[0]?.note ? ` — ${filtered.applies[0].note}` : ""),
        branch: "software", // TOGAF Software Architecture — specs live here
        author: r.queenActor,
        verifier: r.verifierActor,
        trust: 0.7,
      })
      .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
  }

  ctx.log(
    `done. ${scanned} spec${scanned === 1 ? "" : "s"} scanned: ` +
      `${totalApplied} applies, ${totalDuplicates} duplicates, ${totalRoadmapImpact} roadmap impacts, ${totalArchConflicts} arch conflicts`,
  );

  return {
    ok: scanned > 0 ? allVerified : true,
    specs: specPaths.length,
    scanned,
    briefs: briefs.length,
    applied: totalApplied,
    duplicates: totalDuplicates,
    roadmap_impact: totalRoadmapImpact,
    architecture_conflicts: totalArchConflicts,
    dryRun,
    verifier,
    costUSD: lastCostUSD,
  };
});

// ── Spec resolution (positionals + --spec; auto-discovery NOT ported) ─────────
function resolveSpecPaths(ctx: AgentContext): string[] {
  const out = new Set<string>();
  const positionals = [ctx.input.mode, ...ctx.input.args].filter((s): s is string => !!s && s.trim().length > 0);
  for (const p of positionals) out.add(normalizeSpecPath(p.trim()));
  const specFlag = ctx.input.flags.spec;
  if (typeof specFlag === "string" && specFlag.trim()) out.add(normalizeSpecPath(specFlag.trim()));
  return [...out];
}

// A bare filename is assumed to be a shared spec under wiki/director/specs/.
function normalizeSpecPath(p: string): string {
  return p.includes("/") ? p : `${SPECS_REL_DIR}/${p}`;
}

// ── Discovery — one GOVERNED glob pass over the read boundary ─────────────────
type Discovery = { specs: string[]; briefs: string[]; arch: string[] };
const EMPTY_DISCOVERY: Discovery = { specs: [], briefs: [], arch: [] };

// The worker holds the fs `glob` tool (declared in agent.json, bounded to
// boundary.read + repoRoot). It enumerates the spec/brief/architecture surfaces
// and returns them as strict JSON. Degrades to empty on any parse failure —
// discovery is additive (named specs + the read-probe still work), never fatal.
async function discover(ctx: AgentContext, needSpecs: boolean): Promise<Discovery> {
  const task =
    `DISCOVERY. Use the glob tool to enumerate repo-relative file paths, then return STRICT JSON only ` +
    `(no prose, no code fences): {"specs":[...],"briefs":[...],"arch":[...]}.\n` +
    (needSpecs
      ? `- specs: every path matching \`${SPECS_REL_DIR}/*.md\` and \`clients/*/${SPECS_REL_DIR}/*.md\`\n`
      : `- specs: [] (specs were named on the invocation; skip them)\n`) +
    `- briefs: every path matching \`${RESEARCH_REL_DIR}/*-brief.md\` and \`clients/*/${RESEARCH_REL_DIR}/*-brief.md\`\n` +
    `- arch: every path matching \`architecture/**/*.md\`, excluding any README.md\n` +
    `Return ONLY real paths the glob tool produced; never invent or paraphrase a path.`;
  try {
    const r = await ctx.hive.run(task);
    return parseDiscovery(r.answer, needSpecs);
  } catch (e) {
    ctx.log(`discovery glob pass skipped: ${(e as Error).message}`);
    return EMPTY_DISCOVERY;
  }
}

// Defensive parse of the discovery pass answer. Each list is filtered to the shape
// its glob promised, so a stray path never leaks into the scan.
export function parseDiscovery(answer: string, needSpecs: boolean): Discovery {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return EMPTY_DISCOVERY;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return EMPTY_DISCOVERY;
  }
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))]
      : [];
  const specs = needSpecs ? list(parsed.specs).filter((p) => p.endsWith(".md")) : [];
  const briefs = list(parsed.briefs).filter((p) => /-brief\.md$/.test(p));
  const arch = list(parsed.arch).filter((p) => p.startsWith("architecture/") && p.endsWith(".md") && !/(?:^|\/)README\.md$/.test(p));
  return { specs, briefs, arch };
}

// ── Brief loading — glob discovery ∪ the date-window read probe ──────────────
async function loadRecentBriefs(
  ctx: AgentContext,
  lookbackDays: number,
  baseDate: string,
  discoveredBriefPaths: string[] = [],
): Promise<Brief[]> {
  const base = new Date(baseDate + "T00:00:00Z");
  const minTime = base.getTime() - lookbackDays * 86_400_000;
  const maxTime = base.getTime();
  const seen = new Map<string, Brief>();

  // From the governed glob discovery, windowed by the date encoded in the filename.
  for (const rel of discoveredBriefPaths) {
    const date = briefDate(rel);
    if (!date) continue;
    const t = new Date(date + "T00:00:00Z").getTime();
    if (!Number.isFinite(t) || t < minTime || t > maxTime) continue;
    if (seen.has(rel)) continue;
    const markdown = await ctx.readRepoFile(rel);
    if (markdown) seen.set(rel, { date, path: rel, markdown });
  }

  // Offline fallback: the conventional shared-dir date-window read probe, so a run
  // with no glob signal still finds the canonical briefs.
  for (let i = 0; i <= lookbackDays; i++) {
    const d = new Date(base.getTime() - i * 86_400_000);
    const date = isoDate(d);
    const rel = `${RESEARCH_REL_DIR}/${date}-brief.md`;
    if (seen.has(rel)) continue;
    const markdown = await ctx.readRepoFile(rel);
    if (markdown) seen.set(rel, { date, path: rel, markdown });
  }

  // Chronological (oldest first) so the scan can reason about which items came
  // earlier when classifying duplicates.
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function briefDate(rel: string): string | null {
  const m = rel.match(/(\d{4}-\d{2}-\d{2})-brief\.md$/);
  return m ? m[1] : null;
}

// ── Roadmap loader (Phase 2) — pure parse over the single known file ─────────
async function loadRoadmap(ctx: AgentContext): Promise<Roadmap | null> {
  const text = await ctx.readRepoFile(ROADMAP_REL_PATH);
  if (text === null) return null;

  const milestones: Milestone[] = [];
  const rowRe = /^\|\s*([A-Z]\d{1,2})\s*\|\s*(pending|in_progress|blocked|done)\s*\|\s*([^|]*)\|\s*([^|]*)\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text)) !== null) {
    milestones.push({ id: m[1], status: m[2].trim(), handoff: m[3].trim(), blocked_on: m[4].trim() });
  }

  const tracks: Track[] = [];
  const trackRe = /^###\s+Track\s+([A-Z])\s+[—\-]\s+(.+?)\s*$/gm;
  while ((m = trackRe.exec(text)) !== null) {
    const letter = m[1];
    const name = m[2].trim();
    const start = m.index + m[0].length;
    const after = text.slice(start, start + 2000);
    const para = (after.match(/^\s*\n([^\n#].+?)(?:\n\n|\n#)/s) || [])[1] || "";
    tracks.push({ letter, name, summary: para.replace(/\s+/g, " ").trim().slice(0, 280) });
  }

  return { path: ROADMAP_REL_PATH, milestones, tracks };
}

// ── Task shaping — the input the governed hive scans ─────────────────────────
function buildScanTask(specMarkdown: string, briefs: Brief[], roadmap: Roadmap | null, archPaths: string[]): string {
  const briefsBlock = briefs.map((b) => `=== BRIEF ${b.date} (${b.path}) ===\n${b.markdown}`).join("\n\n");

  let roadmapBlock = "";
  if (roadmap && roadmap.milestones.length > 0) {
    const tracksText = roadmap.tracks.map((t) => `Track ${t.letter} (${t.name}): ${t.summary}`).join("\n");
    const milestonesText = roadmap.milestones
      .map((m) => `  ${m.id} · ${m.status}${m.blocked_on ? ` · blocked on ${m.blocked_on}` : ""}`)
      .join("\n");
    roadmapBlock = `\n\n=== ROADMAP (${roadmap.path}) ===\n\nTracks:\n${tracksText}\n\nMilestone status board:\n${milestonesText}`;
  }

  // Architecture index (globbed): the scan may cite an architecture_path ONLY from
  // this list. Use the read tool to open a doc before flagging a conflict.
  const archBlock =
    archPaths.length > 0
      ? `\n\n=== ARCHITECTURE INDEX (${archPaths.length} docs — cite architecture_path VERBATIM from this list only) ===\n` +
        archPaths.map((p) => `- ${p}`).join("\n")
      : "";

  return (
    `Cross-reference this in-flight spec against the recent Research briefs and roadmap. ` +
    `Surface only APPLIES, DUPLICATES, ROADMAP IMPACT, and ARCHITECTURE CONFLICTS, each bar HIGH. ` +
    `Cite item IDs and paths VERBATIM. Emit STRICT JSON only ` +
    `{applies:[], duplicates:[], roadmap_impact:[], architecture_conflicts:[]}, no prose, no fences.\n\n` +
    `SPEC (marker-stripped, full content):\n\n${specMarkdown}\n\n===\n\n` +
    `RECENT BRIEFS (oldest first):\n\n${briefsBlock}${roadmapBlock}${archBlock}`
  );
}

// ── JSON extraction (mirrors the Node scanSpec parse) ────────────────────────
function parseScan(answer: string): ScanResult {
  const empty: ScanResult = { applies: [], duplicates: [], roadmap_impact: [], architecture_conflicts: [] };
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return empty;
  try {
    const parsed = JSON.parse(m[0]);
    return {
      applies: Array.isArray(parsed.applies) ? parsed.applies : [],
      duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
      roadmap_impact: Array.isArray(parsed.roadmap_impact) ? parsed.roadmap_impact : [],
      architecture_conflicts: Array.isArray(parsed.architecture_conflicts) ? parsed.architecture_conflicts : [],
    };
  } catch {
    return empty;
  }
}

// ── Defensive filter — no invented IDs or paths (ported verbatim in spirit) ──
// architecture_conflicts are verified against `archPaths` (the globbed architecture
// index). An empty set (‑‑no-discover, or a glob that returned nothing) naturally
// yields no arch flags — the same conservative posture, now data-driven.
export function filterScanResult(
  scan: ScanResult,
  briefs: Brief[],
  roadmap: Roadmap | null,
  archPaths: Set<string> = new Set(),
): ScanResult {
  const briefPaths = new Set(briefs.map((b) => b.path));
  const milestoneIds = new Set((roadmap?.milestones || []).map((m) => m.id));
  const wellFormedItemId = (id: unknown) => typeof id === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Z]\d+$/.test(id);
  const wellFormedMilestone = (id: unknown) => typeof id === "string" && /^[A-Z]\d{1,2}$/.test(id);
  const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");

  const applies = (scan.applies || [])
    .filter((a) => a && wellFormedItemId(a.item_id) && briefPaths.has(a.brief_path))
    .map((a) => ({ item_id: a.item_id, brief_path: a.brief_path, relevance: clean(a.relevance), note: clean(a.note) }))
    .slice(0, 5);

  const duplicates = (scan.duplicates || [])
    .filter(
      (d) =>
        d &&
        wellFormedItemId(d.item_id) &&
        briefPaths.has(d.brief_path) &&
        wellFormedItemId(d.duplicate_of) &&
        briefPaths.has(d.duplicate_brief_path),
    )
    .map((d) => ({
      item_id: d.item_id,
      brief_path: d.brief_path,
      duplicate_of: d.duplicate_of,
      duplicate_brief_path: d.duplicate_brief_path,
      note: clean(d.note),
    }))
    .slice(0, 5);

  const roadmap_impact = (scan.roadmap_impact || [])
    .filter((r) => r && wellFormedMilestone(r.milestone_id) && milestoneIds.has(r.milestone_id))
    .map((r) => ({
      milestone_id: r.milestone_id,
      kind: ["blocks", "unblocks", "advances", "relates"].includes(r.kind) ? r.kind : "relates",
      note: clean(r.note),
    }))
    .slice(0, 5);

  // Architecture conflicts — verified against the globbed index (no invented paths).
  const architecture_conflicts = (scan.architecture_conflicts || [])
    .filter((c) => c && typeof c.architecture_path === "string" && archPaths.has(c.architecture_path))
    .map((c) => ({
      architecture_path: c.architecture_path,
      kind: ["supersedes", "conflicts", "extends", "depends-on"].includes(c.kind) ? c.kind : "conflicts",
      section: clean(c.section),
      note: clean(c.note),
    }))
    .slice(0, 5);

  return { applies, duplicates, roadmap_impact, architecture_conflicts };
}

// ── Marker handling (ported verbatim in spirit — pure string ops) ────────────

// Returns the spec markdown with any existing marker block stripped, so the scan
// never sees its own prior output and re-ranks against it.
export function stripMarkerSection(markdown: string, markerBegin: string, markerEnd: string): string {
  const begin = markdown.indexOf(markerBegin);
  if (begin === -1) return markdown;
  const end = markdown.indexOf(markerEnd, begin);
  if (end === -1) return markdown; // malformed; leave it alone
  const before = markdown.slice(0, begin).replace(/\n+$/, "");
  const after = markdown.slice(end + markerEnd.length).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

// Splices the rendered marker block into the spec: replace between an existing
// marker pair, else append.
export function applyMarkerBlock(specMarkdown: string, block: string, markerBegin: string, markerEnd: string): string {
  const begin = specMarkdown.indexOf(markerBegin);
  if (begin !== -1) {
    const end = specMarkdown.indexOf(markerEnd, begin);
    if (end !== -1) {
      return specMarkdown.slice(0, begin) + block + specMarkdown.slice(end + markerEnd.length);
    }
  }
  const trimmed = specMarkdown.replace(/\n+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

export function renderMarkerBlock(f: ScanResult, markerBegin: string, markerEnd: string, date: string): string {
  const lines = [markerBegin, "## Related new findings", ""];
  lines.push(`_Auto-updated ${date} by Agix Architect. This section is regenerated each run — don't edit between the comment markers._`);
  lines.push("");

  const empty =
    f.applies.length === 0 && f.duplicates.length === 0 && f.roadmap_impact.length === 0 && f.architecture_conflicts.length === 0;

  if (empty) {
    lines.push("_No related findings since last scan._");
  } else {
    if (f.applies.length > 0) {
      lines.push("**Applies to this spec:**", "");
      for (const a of f.applies) {
        const link = `[\`${a.item_id}\`](${repoRelativeFromSpec(a.brief_path)})`;
        const rel = a.relevance ? ` — ${a.relevance}` : "";
        const note = a.note ? ` ${a.note}` : "";
        lines.push(`- ${link}${rel}.${note}`);
      }
      lines.push("");
    }
    if (f.duplicates.length > 0) {
      lines.push("**Duplicate of prior coverage:**", "");
      for (const d of f.duplicates) {
        const link = `[\`${d.item_id}\`](${repoRelativeFromSpec(d.brief_path)})`;
        const dupLink = `[\`${d.duplicate_of}\`](${repoRelativeFromSpec(d.duplicate_brief_path)})`;
        const note = d.note ? ` ${d.note}` : "";
        lines.push(`- ${link} duplicates ${dupLink}.${note}`);
      }
      lines.push("");
    }
    if (f.roadmap_impact.length > 0) {
      lines.push("**Roadmap impact:**", "");
      for (const r of f.roadmap_impact) {
        const link = `[\`${r.milestone_id}\`](${repoRelativeToRoadmapFromSpec()})`;
        const note = r.note ? ` ${r.note}` : "";
        lines.push(`- ${link} — ${r.kind}.${note}`);
      }
      lines.push("");
    }
    if (f.architecture_conflicts.length > 0) {
      lines.push("**Architecture conflicts:**", "");
      for (const c of f.architecture_conflicts) {
        const link = `[\`${c.architecture_path}\`](${repoRelativeArchFromSpec(c.architecture_path)})`;
        const section = c.section ? ` §${c.section}` : "";
        const note = c.note ? ` ${c.note}` : "";
        lines.push(`- ${link}${section} — ${c.kind}.${note}`);
      }
      lines.push("");
    }
  }
  lines.push(markerEnd);
  return lines.join("\n");
}

// Spec files live at wiki/director/specs/<name>.md — resolve relative links from
// there to the other repo paths the marker block references (faithful to Node;
// the fixed depth is correct for shared specs).
function repoRelativeFromSpec(briefRepoPath: string): string {
  if (briefRepoPath.startsWith("wiki/research/")) {
    return `../../research/${briefRepoPath.slice("wiki/research/".length)}`;
  }
  return `/${briefRepoPath}`;
}

function repoRelativeToRoadmapFromSpec(): string {
  return `../../../docs/framework/BUILD_FRAMEWORK.md`;
}

function repoRelativeArchFromSpec(archRepoPath: string): string {
  if (archRepoPath.startsWith("architecture/")) {
    return `../../../${archRepoPath}`;
  }
  return `/${archRepoPath}`;
}
