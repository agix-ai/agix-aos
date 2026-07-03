// Agix Architect — CTO Agent, Phases 1 + 2.
//
// Cross-references new Research findings AND in-flight roadmap +
// architecture context against the specs in wiki/director/specs/. For
// each spec, asks Sonnet to identify:
//   1. Brief items that materially APPLY to the spec.       (Phase 1)
//   2. Brief items that are DUPLICATES of older briefs.     (Phase 1)
//   3. BUILD_FRAMEWORK.md milestones the spec moves/blocks. (Phase 2)
//   4. architecture/ docs the spec conflicts with.          (Phase 2)
// Renders all four lists into a marker-delimited "Related new findings"
// section in the spec. Re-runs only touch the marker section —
// operator's hand edits everywhere else are preserved.
//
// No emails, no Workspace API surface, no git operations. Phases 1 + 2
// are pure local-file annotation. Phase 3 (brief-level duplicate digest)
// is the next addition.
//
// Spec: architecture/03-ai-ml/agent-architecture/ARCHITECT_AGENT.md
// Manifest: agents/architect/manifest.yaml

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, basename, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SPECS_REL_DIR = 'wiki/director/specs';
const RESEARCH_REL_DIR = 'wiki/research';
const ROADMAP_REL_PATH = 'docs/framework/BUILD_FRAMEWORK.md';
const ARCHITECTURE_REL_DIR = 'architecture';

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const o = {
    dryRun: Boolean(opts.dryRun),
    spec: opts.spec || null,
    lookbackDays: Number(opts.lookbackDays ?? defaults.lookback_days ?? 28),
    date: opts.date || new Date().toISOString().slice(0, 10),
  };

  const SCAN_MODEL = defaults.scan_model || 'claude-sonnet-4-6';
  const MARKER_BEGIN = defaults.marker_begin || '<!-- ARCHITECT:BEGIN -->';
  const MARKER_END = defaults.marker_end || '<!-- ARCHITECT:END -->';

  const specPaths = await findSpecPaths(runtime, o.spec);
  if (specPaths.length === 0) {
    console.log(o.spec
      ? `No spec at ${o.spec}.`
      : `No specs at ${SPECS_REL_DIR}/*.md — nothing to annotate. (The Director's APPROVE executor files specs there; first run will be a no-op until then.)`);
    if (!o.dryRun) await runtime.writeState('cursor', { last_run_at: new Date().toISOString() });
    return { specs: 0, applied: 0, duplicates: 0 };
  }

  const briefs = await loadRecentBriefs(runtime, o.lookbackDays);
  if (briefs.length === 0) {
    console.log(`No briefs in ${RESEARCH_REL_DIR}/ within ${o.lookbackDays} days — nothing to cross-reference.`);
    if (!o.dryRun) await runtime.writeState('cursor', { last_run_at: new Date().toISOString() });
    return { specs: specPaths.length, applied: 0, duplicates: 0, roadmap_impact: 0, architecture_conflicts: 0 };
  }

  // Phase 2 inputs: roadmap (milestone table + track descriptions) and
  // architecture (TOC index of design docs, not full content). Both are
  // optional — if either is missing, we just skip those output sections.
  const roadmap = await loadRoadmap(runtime);
  const archIndex = await loadArchitectureIndex(runtime);
  console.log(`Roadmap: ${roadmap ? `${roadmap.milestones.length} milestones loaded` : '(none)'} · architecture: ${archIndex.length} doc${archIndex.length === 1 ? '' : 's'} indexed`);

  console.log(`Scanning ${specPaths.length} spec${specPaths.length === 1 ? '' : 's'} against ${briefs.length} recent brief${briefs.length === 1 ? '' : 's'} via ${SCAN_MODEL}…`);

  const model = runtime.getModel();
  const systemPrompt = await readFile(resolve(__dirname, 'prompts/relevance-scan.md'), 'utf8');

  let totalApplied = 0;
  let totalDuplicates = 0;
  let totalRoadmapImpact = 0;
  let totalArchConflicts = 0;

  for (const specRelPath of specPaths) {
    process.stdout.write(`  · ${specRelPath.padEnd(50)} `);
    try {
      const specMarkdown = await runtime.readRepoFile(specRelPath);
      const stripped = stripMarkerSection(specMarkdown, MARKER_BEGIN, MARKER_END);
      const scan = await scanSpec({
        model,
        systemPrompt,
        specMarkdown: stripped,
        briefs,
        roadmap,
        archIndex,
      });
      const filtered = filterScanResult(scan, briefs, roadmap, archIndex);
      totalApplied += filtered.applies.length;
      totalDuplicates += filtered.duplicates.length;
      totalRoadmapImpact += filtered.roadmap_impact.length;
      totalArchConflicts += filtered.architecture_conflicts.length;
      const block = renderMarkerBlock({
        ...filtered,
        markerBegin: MARKER_BEGIN,
        markerEnd: MARKER_END,
        date: o.date,
      });
      const nextMarkdown = applyMarkerBlock(stripped, block, MARKER_BEGIN, MARKER_END);
      if (o.dryRun) {
        console.log(`(dry-run) applies=${filtered.applies.length} dup=${filtered.duplicates.length} roadmap=${filtered.roadmap_impact.length} arch=${filtered.architecture_conflicts.length}`);
      } else {
        await runtime.writeRepoFile(specRelPath, nextMarkdown);
        console.log(`applies=${filtered.applies.length} dup=${filtered.duplicates.length} roadmap=${filtered.roadmap_impact.length} arch=${filtered.architecture_conflicts.length}`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  if (!o.dryRun) {
    await runtime.writeState('cursor', { last_run_at: new Date().toISOString() });
  }

  console.log(`Done. Total annotations across ${specPaths.length} spec${specPaths.length === 1 ? '' : 's'}: ${totalApplied} applies, ${totalDuplicates} duplicates, ${totalRoadmapImpact} roadmap impacts, ${totalArchConflicts} architecture conflicts.`);

  return {
    specs: specPaths.length,
    briefs: briefs.length,
    applied: totalApplied,
    duplicates: totalDuplicates,
    roadmap_impact: totalRoadmapImpact,
    architecture_conflicts: totalArchConflicts,
  };
}

// ─── Spec discovery ─────────────────────────────────────────────────

async function findSpecPaths(runtime, onlySpec) {
  if (onlySpec) {
    // Accept either a shared spec, a clients/<slug>/wiki/director/specs/<file>
    // path, or a bare filename (assumed shared).
    if (onlySpec.includes('/')) {
      return existsSync(runtime.resolveRepoPath(onlySpec)) ? [onlySpec] : [];
    }
    const rel = `${SPECS_REL_DIR}/${onlySpec}`;
    return existsSync(runtime.resolveRepoPath(rel)) ? [rel] : [];
  }
  const out = [];

  // 1. Shared specs at wiki/director/specs/*.md
  const sharedDir = runtime.resolveRepoPath(SPECS_REL_DIR);
  if (existsSync(sharedDir)) {
    const entries = await readdir(sharedDir);
    for (const f of entries.filter(f => f.endsWith('.md')).sort()) {
      out.push(`${SPECS_REL_DIR}/${f}`);
    }
  }

  // 2. Compartmentalized per-client specs at clients/<slug>/wiki/director/specs/*.md
  const clientsRoot = runtime.resolveRepoPath('clients');
  if (existsSync(clientsRoot)) {
    const slugs = await readdir(clientsRoot);
    for (const slug of slugs.sort()) {
      const clientSpecsRel = `clients/${slug}/${SPECS_REL_DIR}`;
      const clientSpecsAbs = runtime.resolveRepoPath(clientSpecsRel);
      if (!existsSync(clientSpecsAbs)) continue;
      const entries = await readdir(clientSpecsAbs);
      for (const f of entries.filter(f => f.endsWith('.md')).sort()) {
        out.push(`${clientSpecsRel}/${f}`);
      }
    }
  }

  return out;
}

// ─── Brief discovery ───────────────────────────────────────────────

async function loadRecentBriefs(runtime, lookbackDays) {
  const fullDir = runtime.resolveRepoPath(RESEARCH_REL_DIR);
  if (!existsSync(fullDir)) return [];
  const entries = await readdir(fullDir);
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000);
  const out = [];
  for (const f of entries) {
    // Match weekly briefs only; skip dive sub-briefs (which are item-specific).
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-brief\.md$/);
    if (!m) continue;
    const date = m[1];
    const dt = new Date(date + 'T00:00:00Z');
    if (dt < cutoff) continue;
    const relPath = `${RESEARCH_REL_DIR}/${f}`;
    const markdown = await runtime.readRepoFile(relPath);
    out.push({ date, path: relPath, markdown });
  }
  // Chronological order (oldest first) so Sonnet can reason about which
  // items came earlier when classifying duplicates.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ─── Roadmap loader (Phase 2) ──────────────────────────────────────

// Reads docs/framework/BUILD_FRAMEWORK.md and extracts:
//   - milestones: the §5 status board (ID, status, blocked_on)
//   - tracks: §3 track descriptions (one-line summary per track)
// Returns null if the file is missing — Phase 2 output sections that
// depend on it are then skipped.
async function loadRoadmap(runtime) {
  const fullPath = runtime.resolveRepoPath(ROADMAP_REL_PATH);
  if (!existsSync(fullPath)) return null;
  const text = await readFile(fullPath, 'utf8');

  // ── Milestone table ──
  const milestones = [];
  // Match lines like: | A1 | done | <handoff> | <blocked-on> |
  const rowRe = /^\|\s*([A-Z]\d{1,2})\s*\|\s*(pending|in_progress|blocked|done)\s*\|\s*([^|]*)\|\s*([^|]*)\|/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    milestones.push({
      id: m[1],
      status: m[2].trim(),
      handoff: m[3].trim(),
      blocked_on: m[4].trim(),
    });
  }

  // ── Tracks (H3 inside § Tracks) ──
  // Each track header is `### Track <letter> — <name>`. Capture letter + name
  // + the first non-empty paragraph that follows.
  const tracks = [];
  const trackRe = /^###\s+Track\s+([A-Z])\s+[—\-]\s+(.+?)\s*$/gm;
  while ((m = trackRe.exec(text)) !== null) {
    const letter = m[1];
    const name = m[2].trim();
    // Snag the first paragraph after this header
    const start = m.index + m[0].length;
    const after = text.slice(start, start + 2000);
    const para = (after.match(/^\s*\n([^\n#].+?)(?:\n\n|\n#)/s) || [])[1] || '';
    tracks.push({ letter, name, summary: para.replace(/\s+/g, ' ').trim().slice(0, 280) });
  }

  return { path: ROADMAP_REL_PATH, milestones, tracks };
}

// ─── Architecture index loader (Phase 2) ──────────────────────────

// Walks architecture/**/*.md, skipping README.md and the architecture/
// root index. For each doc, extracts a small TOC: H1 title, first
// non-frontmatter paragraph, list of H2 headings. This is enough for
// Sonnet to reason about conflicts without loading 500-line full docs.
async function loadArchitectureIndex(runtime) {
  const fullDir = runtime.resolveRepoPath(ARCHITECTURE_REL_DIR);
  if (!existsSync(fullDir)) return [];

  const docs = [];
  const stack = [fullDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'README.md') continue;            // index pages, not designs
      const relPath = relative(runtime.repoRoot, full);
      try {
        const text = await readFile(full, 'utf8');
        const toc = extractDocToc(text);
        if (!toc.h1) continue;                              // skip mal-formed docs
        docs.push({ path: relPath, ...toc });
      } catch {}
    }
  }
  // Stable order so Sonnet sees consistent context across runs.
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

function extractDocToc(markdown) {
  let body = markdown;
  // Strip YAML frontmatter if present
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close !== -1) body = body.slice(close + 4).replace(/^\s*\n/, '');
  }
  const lines = body.split(/\r?\n/);

  const h1 = (lines.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim() || null;

  // First non-empty paragraph after the H1 (skip blockquotes / metadata)
  let para = '';
  let sawH1 = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) { sawH1 = true; continue; }
    if (!sawH1) continue;
    if (/^[#>]/.test(lines[i]) || /^\*\*/.test(lines[i]) || lines[i].trim() === '') continue;
    // Greedy: this line plus continuation until blank
    let buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^#/.test(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    para = buf.join(' ').slice(0, 320);
    break;
  }

  const h2s = lines.filter(l => /^##\s+/.test(l)).map(l => l.replace(/^##\s+/, '').trim()).slice(0, 12);

  return { h1, intro: para, h2s };
}

// ─── Marker handling ────────────────────────────────────────────────

// Returns the spec markdown with any existing marker block stripped
// (and the surrounding blank lines tidied). Used before the Sonnet call
// so Sonnet doesn't see its own prior output and re-rank against it.
function stripMarkerSection(markdown, markerBegin, markerEnd) {
  const begin = markdown.indexOf(markerBegin);
  if (begin === -1) return markdown;
  const end = markdown.indexOf(markerEnd, begin);
  if (end === -1) return markdown; // malformed; leave it alone
  const before = markdown.slice(0, begin).replace(/\n+$/, '');
  const after = markdown.slice(end + markerEnd.length).replace(/^\n+/, '');
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

// Splices the rendered marker block into the spec markdown. If the spec
// already has a marker pair, replace between them; otherwise append.
function applyMarkerBlock(specMarkdown, block, markerBegin, markerEnd) {
  const begin = specMarkdown.indexOf(markerBegin);
  if (begin !== -1) {
    const end = specMarkdown.indexOf(markerEnd, begin);
    if (end !== -1) {
      return (
        specMarkdown.slice(0, begin) +
        block +
        specMarkdown.slice(end + markerEnd.length)
      );
    }
  }
  // First insertion — append to end with a separating blank line.
  const trimmed = specMarkdown.replace(/\n+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

function renderMarkerBlock({ applies, duplicates, roadmap_impact, architecture_conflicts, markerBegin, markerEnd, date }) {
  const lines = [markerBegin, '## Related new findings', ''];
  lines.push(`_Auto-updated ${date} by Agix Architect. This section is regenerated each run — don't edit between the comment markers._`);
  lines.push('');

  const empty = applies.length === 0
    && duplicates.length === 0
    && roadmap_impact.length === 0
    && architecture_conflicts.length === 0;

  if (empty) {
    lines.push('_No related findings since last scan._');
  } else {
    if (applies.length > 0) {
      lines.push('**Applies to this spec:**');
      lines.push('');
      for (const a of applies) {
        const link = `[\`${a.item_id}\`](${repoRelativeFromSpec(a.brief_path)})`;
        const rel = a.relevance ? ` — ${a.relevance}` : '';
        const note = a.note ? ` ${a.note}` : '';
        lines.push(`- ${link}${rel}.${note}`);
      }
      lines.push('');
    }
    if (duplicates.length > 0) {
      lines.push('**Duplicate of prior coverage:**');
      lines.push('');
      for (const d of duplicates) {
        const link = `[\`${d.item_id}\`](${repoRelativeFromSpec(d.brief_path)})`;
        const dupLink = `[\`${d.duplicate_of}\`](${repoRelativeFromSpec(d.duplicate_brief_path)})`;
        const note = d.note ? ` ${d.note}` : '';
        lines.push(`- ${link} duplicates ${dupLink}.${note}`);
      }
      lines.push('');
    }
    if (roadmap_impact.length > 0) {
      lines.push('**Roadmap impact:**');
      lines.push('');
      for (const r of roadmap_impact) {
        const link = `[\`${r.milestone_id}\`](${repoRelativeToRoadmapFromSpec()})`;
        const note = r.note ? ` ${r.note}` : '';
        lines.push(`- ${link} — ${r.kind}.${note}`);
      }
      lines.push('');
    }
    if (architecture_conflicts.length > 0) {
      lines.push('**Architecture conflicts:**');
      lines.push('');
      for (const c of architecture_conflicts) {
        const link = `[\`${c.architecture_path}\`](${repoRelativeArchFromSpec(c.architecture_path)})`;
        const section = c.section ? ` §${c.section}` : '';
        const note = c.note ? ` ${c.note}` : '';
        lines.push(`- ${link}${section} — ${c.kind}.${note}`);
      }
      lines.push('');
    }
  }
  lines.push(markerEnd);
  return lines.join('\n');
}

// Spec files live at wiki/director/specs/<name>.md. Resolve relative
// links from there to the other repo paths the marker block references.

function repoRelativeFromSpec(briefRepoPath) {
  // briefRepoPath: "wiki/research/2026-05-15-brief.md"
  if (briefRepoPath.startsWith('wiki/research/')) {
    return `../../research/${briefRepoPath.slice('wiki/research/'.length)}`;
  }
  return `/${briefRepoPath}`;
}

function repoRelativeToRoadmapFromSpec() {
  // spec is at wiki/director/specs/<name>.md → roadmap at
  // docs/framework/BUILD_FRAMEWORK.md. Up three, into docs/framework.
  return `../../../docs/framework/BUILD_FRAMEWORK.md`;
}

function repoRelativeArchFromSpec(archRepoPath) {
  // spec at wiki/director/specs/<name>.md → architecture at
  // architecture/<...>. Up three, into architecture.
  if (archRepoPath.startsWith('architecture/')) {
    return `../../../${archRepoPath}`;
  }
  return `/${archRepoPath}`;
}

// ─── Sonnet scan ───────────────────────────────────────────────────

export async function scanSpec({ model, systemPrompt, specMarkdown, briefs, roadmap, archIndex }) {
  const briefsBlock = briefs
    .map(b => `=== BRIEF ${b.date} (${b.path}) ===\n${b.markdown}`)
    .join('\n\n');

  let roadmapBlock = '';
  if (roadmap && roadmap.milestones.length > 0) {
    const tracksText = roadmap.tracks
      .map(t => `Track ${t.letter} (${t.name}): ${t.summary}`)
      .join('\n');
    const milestonesText = roadmap.milestones
      .map(m => `  ${m.id} · ${m.status}${m.blocked_on ? ` · blocked on ${m.blocked_on}` : ''}`)
      .join('\n');
    roadmapBlock =
      `=== ROADMAP (${roadmap.path}) ===\n\n` +
      `Tracks:\n${tracksText}\n\n` +
      `Milestone status board:\n${milestonesText}`;
  }

  let archBlock = '';
  if (archIndex.length > 0) {
    const docsText = archIndex
      .map(d => {
        const h2s = d.h2s.length > 0 ? `\n  Sections: ${d.h2s.join(' · ')}` : '';
        return `- ${d.path}\n  Title: ${d.h1}\n  Intro: ${d.intro || '(none)'}${h2s}`;
      })
      .join('\n\n');
    archBlock = `=== ARCHITECTURE INDEX (${archIndex.length} docs) ===\n\n${docsText}`;
  }

  const userMessage =
    `SPEC (path: marker-stripped, full content follows):\n\n${specMarkdown}\n\n` +
    `===\n\n` +
    `RECENT BRIEFS (oldest first):\n\n${briefsBlock}` +
    (roadmapBlock ? `\n\n${roadmapBlock}` : '') +
    (archBlock ? `\n\n${archBlock}` : '');

  const resp = await model.chat({
    capability: 'default-quality',
    max_tokens: 2500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    agent: 'architect',
  });
  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { applies: [], duplicates: [], roadmap_impact: [], architecture_conflicts: [] };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      applies: Array.isArray(parsed.applies) ? parsed.applies : [],
      duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
      roadmap_impact: Array.isArray(parsed.roadmap_impact) ? parsed.roadmap_impact : [],
      architecture_conflicts: Array.isArray(parsed.architecture_conflicts) ? parsed.architecture_conflicts : [],
    };
  } catch {
    return { applies: [], duplicates: [], roadmap_impact: [], architecture_conflicts: [] };
  }
}

// Defensive filter: drop entries whose item_id isn't well-formed, whose
// brief_path / milestone_id / architecture_path doesn't match a real
// loaded artifact. Keeps Sonnet honest — no invented IDs, no invented
// file paths.
export function filterScanResult(scan, briefs, roadmap, archIndex) {
  const briefPaths = new Set(briefs.map(b => b.path));
  const milestoneIds = new Set((roadmap?.milestones || []).map(m => m.id));
  const archPaths = new Set(archIndex.map(d => d.path));
  const wellFormedItemId = (id) => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}\.[A-Z]\d+$/.test(id);
  const wellFormedMilestone = (id) => typeof id === 'string' && /^[A-Z]\d{1,2}$/.test(id);

  const applies = (scan.applies || [])
    .filter(a => a && wellFormedItemId(a.item_id) && briefPaths.has(a.brief_path))
    .map(a => ({
      item_id: a.item_id,
      brief_path: a.brief_path,
      relevance: typeof a.relevance === 'string' ? a.relevance.trim() : '',
      note: typeof a.note === 'string' ? a.note.trim() : '',
    }))
    .slice(0, 5);

  const duplicates = (scan.duplicates || [])
    .filter(d => d
      && wellFormedItemId(d.item_id) && briefPaths.has(d.brief_path)
      && wellFormedItemId(d.duplicate_of) && briefPaths.has(d.duplicate_brief_path))
    .map(d => ({
      item_id: d.item_id,
      brief_path: d.brief_path,
      duplicate_of: d.duplicate_of,
      duplicate_brief_path: d.duplicate_brief_path,
      note: typeof d.note === 'string' ? d.note.trim() : '',
    }))
    .slice(0, 5);

  const roadmap_impact = (scan.roadmap_impact || [])
    .filter(r => r && wellFormedMilestone(r.milestone_id) && milestoneIds.has(r.milestone_id))
    .map(r => ({
      milestone_id: r.milestone_id,
      kind: ['blocks', 'unblocks', 'advances', 'relates'].includes(r.kind) ? r.kind : 'relates',
      note: typeof r.note === 'string' ? r.note.trim() : '',
    }))
    .slice(0, 5);

  const architecture_conflicts = (scan.architecture_conflicts || [])
    .filter(c => c && typeof c.architecture_path === 'string' && archPaths.has(c.architecture_path))
    .map(c => ({
      architecture_path: c.architecture_path,
      kind: ['supersedes', 'conflicts', 'extends', 'depends-on'].includes(c.kind) ? c.kind : 'conflicts',
      section: typeof c.section === 'string' ? c.section.trim() : '',
      note: typeof c.note === 'string' ? c.note.trim() : '',
    }))
    .slice(0, 5);

  return { applies, duplicates, roadmap_impact, architecture_conflicts };
}
