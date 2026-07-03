// Agix Research Agent — agent logic.
//
// Invoked via `agix agent run research`. Two responsibilities folded into
// one run, matching what bin/agix-research-and-mail did pre-refactor:
//
//   1. Scan curated sources (Haiku) → synthesize a 6-section brief
//      (Sonnet) → grade (Opus) → write to wiki/research/<date>-brief.md.
//   2. Render the brief through the Sumi & Kin letter template and email
//      it to the operator (--no-signature; the template owns the chrome).
//
// Flags:
//   --dry-run         Print brief to stdout, no file writes, no email.
//   --no-research     Skip the scan; re-render + re-email the existing
//                     brief for today (cheap iteration on template tweaks).
//   --no-mail         Run the scan + write the file, but skip the email.
//   --source <name>   Scan only one named source.
//   --max-items <N>   Cap items entering synthesis pool.
//   --skip-critic     Skip Opus critic pass.
//   --date <YYYY-MM-DD>  Override the date in the brief filename.
//
// Spec: architecture/03-ai-ml/agent-architecture/RESEARCH_AGENT.md
// Letter template: templates/email-briefing.html
// Sources registry: architecture/03-ai-ml/agent-architecture/RESEARCH_AGENT_SOURCES.yaml

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { operatorFirstName } from '../../lib/agix-identity.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { marked, Renderer } from 'marked';

import { renderLastCycleStatus } from '../../lib/agix-director-queue.mjs';
import { slugifyTitle } from '../../lib/agix-brief-items.mjs';
import { textFromToolResult } from '../../lib/agix-mcp-client.mjs';

const SOURCES_REL_PATH = 'agents/research/sources.yaml';
const RESEARCH_REL_DIR = 'wiki/research';
const WIKI_LOG_REL_PATH = 'wiki/log.md';
const TEMPLATE_REL_PATH = 'agents/research/email-briefing.html';

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const o = {
    dryRun: Boolean(opts.dryRun),
    noResearch: Boolean(opts.noResearch),
    noMail: Boolean(opts.noMail),
    source: opts.source || null,
    maxItems: Number(opts.maxItems ?? defaults.max_items ?? 40),
    skipCritic: Boolean(opts.skipCritic),
    date: opts.date || new Date().toISOString().slice(0, 10),
    // Dive mode (Director Phase 3): bias synthesis toward a specific
    // topic and write to a dive-named sub-brief instead of the canonical
    // weekly brief. Email and wiki-log are suppressed — the Director
    // handles those.
    topic: typeof opts.topic === 'string' ? opts.topic.trim() : null,
    diveItemId: typeof opts.diveItemId === 'string' ? opts.diveItemId.trim() : null,
  };
  const isDive = Boolean(o.topic);
  if (isDive) {
    // Dive runs are always file-only — Director owns notification.
    o.noMail = true;
  }

  const SCAN_MODEL = defaults.scan_model || 'claude-haiku-4-5';
  const SYNTH_MODEL = defaults.synth_model || 'claude-sonnet-4-6';
  const CRITIC_MODEL = defaults.critic_model || 'claude-opus-4-7';
  const FETCH_CONCURRENCY = Number(defaults.fetch_concurrency ?? 4);
  const FETCH_TIMEOUT_MS = Number(defaults.fetch_timeout_ms ?? 20_000);
  const SOURCE_CONTENT_MAX_CHARS = Number(defaults.source_content_max_chars ?? 12_000);
  const MIN_RELEVANCE_SCORE = Number(defaults.min_relevance_score ?? 3);
  const OPERATOR_FIRST_NAME = defaults.operator_first_name || operatorFirstName();

  const researchDir = runtime.resolveRepoPath(RESEARCH_REL_DIR);
  await mkdir(researchDir, { recursive: true });

  const briefRelPath = isDive
    ? `${RESEARCH_REL_DIR}/${o.date}-dive-${diveSlug(o.diveItemId, o.topic)}.md`
    : `${RESEARCH_REL_DIR}/${o.date}-brief.md`;
  const briefPath = runtime.resolveRepoPath(briefRelPath);

  // Smoke short-circuit. The full scan→synthesis→critic pipeline is
  // designed around stub responses dying in the relevance filter ("0
  // items ≥3 score → aborting"), which produces a false-positive
  // smoke failure. Verify the read paths that smoke actually cares
  // about (sources registry, email template, runtime hydration) then
  // return a synthetic pass.
  if (runtime.smoke) {
    // Exercise the model surface so the ledger recording path is
    // verified end-to-end (AC-MP-09). The stub returns a canned
    // response without spending tokens; one ledger line per capability
    // the real run would hit.
    const smokeModel = runtime.getModel();
    for (const capability of ['cheap-classification', 'default-quality', 'long-context']) {
      await smokeModel.chat({
        capability,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'smoke' }],
        agent: 'research',
      });
    }
    await loadSources(runtime);
    try { await runtime.readRepoFile(TEMPLATE_REL_PATH); } catch (err) {
      throw new Error(`Research smoke: email template unreadable — ${err.message}`);
    }
    console.log('[smoke] research short-circuit · sources + template + model verified');
    return { wrote: false, sent: false, smoke: true };
  }

  // ── 1. Run the research scan (unless --no-research) ──────────────
  if (!o.noResearch) {
    const model = runtime.getModel();
    const sources = await loadSources(runtime);

    const targets = o.source ? sources.filter(s => s.name === o.source) : sources;
    if (targets.length === 0) {
      throw new Error(o.source ? `No source named "${o.source}"` : 'No sources defined in registry');
    }

    console.log(`Scanning ${targets.length} source${targets.length === 1 ? '' : 's'} for the week of ${o.date}…`);

    const fetched = await mapConcurrent(targets, FETCH_CONCURRENCY, async (src) => {
      try {
        const content = src.type === 'mcp'
          ? await fetchMcpSource(runtime, src, SOURCE_CONTENT_MAX_CHARS)
          : await fetchSource(src, FETCH_TIMEOUT_MS, SOURCE_CONTENT_MAX_CHARS);
        return { source: src, content, error: null };
      } catch (err) {
        console.warn(`  ✗ ${src.name}: ${err.message}`);
        return { source: src, content: null, error: err.message };
      }
    });

    console.log(`Extracting items via ${SCAN_MODEL}…`);
    const extractions = await mapConcurrent(
      fetched.filter(f => f.content),
      FETCH_CONCURRENCY,
      async ({ source, content }) => {
        try {
          const items = await extractItems(model, source, content, SOURCE_CONTENT_MAX_CHARS);
          console.log(`  ✓ ${source.name}: ${items.length} item${items.length === 1 ? '' : 's'} ≥${MIN_RELEVANCE_SCORE}`);
          return { source, items };
        } catch (err) {
          console.warn(`  ✗ ${source.name} extraction: ${err.message}`);
          return { source, items: [] };
        }
      }
    );

    const pool = [];
    let droppedNoUrl = 0, droppedRoot = 0, droppedArxiv = 0;
    for (const { source, items } of extractions) {
      for (const it of items) {
        if (it.score < MIN_RELEVANCE_SCORE) continue;
        const validity = validateItemUrl(it.url, source.url);
        if (validity.ok) pool.push({ ...it, source: source.name });
        else if (validity.reason === 'no-url') droppedNoUrl++;
        else if (validity.reason === 'site-root') droppedRoot++;
        else if (validity.reason === 'arxiv-future') droppedArxiv++;
      }
    }
    if (droppedNoUrl + droppedRoot + droppedArxiv > 0) {
      console.log(`Dropped: ${droppedNoUrl} no-url · ${droppedRoot} site-root · ${droppedArxiv} fabricated-arxiv-id`);
    }
    pool.sort((a, b) => b.score - a.score);
    const candidates = pool.slice(0, o.maxItems);
    console.log(`Synthesis pool: ${candidates.length} item${candidates.length === 1 ? '' : 's'} (of ${pool.length} after URL validation)`);

    if (candidates.length === 0) {
      throw new Error('No items survived the relevance filter. Aborting before synthesis.');
    }

    console.log(`Synthesizing brief via ${SYNTH_MODEL}${isDive ? ` (dive: ${o.topic})` : ''}…`);
    const draft = await synthesizeBrief(model, candidates, o.date, targets.length, pool.length, o.topic);

    let critic = null;
    if (!o.skipCritic) {
      console.log(`Critic pass via ${CRITIC_MODEL}…`);
      critic = await criticGrade(model, draft);
    }

    const finalBrief = composeFinalBrief(draft, critic, o.date, targets.length, pool.length, { isDive, topic: o.topic, diveItemId: o.diveItemId });

    if (o.dryRun) {
      console.log('\n────────── BRIEF (dry-run, not written) ──────────\n');
      console.log(finalBrief);
      return { wrote: false, sent: false, dryRun: true };
    }

    await runtime.writeRepoFile(briefRelPath, finalBrief);
    console.log(`✓ Brief written: ${briefPath}`);

    if (!isDive) {
      await appendWikiLog(runtime, o.date, targets.length, pool.length, candidates.length);
      console.log(`✓ Wiki log appended`);
    }

    const runLogPath = resolve(runtime.cacheDir, 'runs', `${o.date}.jsonl`);
    await mkdir(resolve(runtime.cacheDir, 'runs'), { recursive: true });
    await writeFile(runLogPath, extractions
      .map(e => JSON.stringify({ source: e.source.name, items_count: e.items.length, top_score: Math.max(0, ...e.items.map(i => i.score)) }))
      .join('\n') + '\n');
    console.log(`✓ Run log: ${runLogPath}`);
  } else {
    console.log('Skipping research scan; using existing brief.');
  }

  // ── 2. Render + email the brief (unless --no-mail) ───────────────
  if (o.noMail) {
    console.log(isDive ? 'dive run; email is the Director\'s job.' : '--no-mail; skipping email.');
    return { wrote: !o.noResearch, sent: false, isDive, briefPath: briefRelPath };
  }

  if (!existsSync(briefPath)) {
    throw new Error(`No brief at ${briefPath}. Run without --no-research to generate one.`);
  }
  const briefMarkdown = await readFile(briefPath, 'utf8');
  if (!briefMarkdown.trim()) {
    throw new Error(`Brief at ${briefPath} is empty.`);
  }

  const lastCycleSection = await renderLastCycleStatus({
    runtime,
    forDate: o.date,
    sourceAgent: 'research',
  });

  const htmlBody = await renderBriefingHtml({
    runtime,
    briefMarkdown,
    dateStr: o.date,
    operatorFirstName: OPERATOR_FIRST_NAME,
    lastCycleSection,
  });

  if (o.dryRun) {
    console.log('\n────────── EMAIL HTML (dry-run, not sent) ──────────\n');
    console.log(htmlBody);
    return { wrote: !o.noResearch, sent: false, dryRun: true };
  }

  await runtime.sendEmail({
    toSelf: true,
    subject: `Research Brief — ${o.date}`,
    body: htmlBody,
    html: true,
    signature: false,
  });
  console.log(`✓ Email sent: Research Brief — ${o.date}`);

  return { wrote: !o.noResearch, sent: true };
}

// ─── Sources ─────────────────────────────────────────────────────────

async function loadSources(runtime) {
  const raw = await runtime.readRepoFile(SOURCES_REL_PATH);
  const parsed = yaml.load(raw);
  const sources = (parsed.sources || []).filter(s => s && s.name && s.url);
  sources.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return sources;
}

// ─── Source fetching ────────────────────────────────────────────────

// MCP-typed source (Q3): the registry entry carries
//   { name, type: mcp, url: <server>, tool: <tool name>,
//     args?: {...}, auth?: { type: bearer|oauth2, ... } }
// and the content is whatever text the tool returns — the rest of the
// pipeline (extraction, scoring, synthesis) is source-type-agnostic.
async function fetchMcpSource(runtime, src, maxChars) {
  if (!src.tool) throw new Error(`mcp source "${src.name}": tool is required`);
  const client = runtime.getMCPClient({ url: src.url, auth: src.auth || null });
  if (!client.sessionId || client.smoke) await client.initialize();
  const result = await client.callTool(src.tool, src.args || {});
  if (result?.isError) {
    throw new Error(`mcp tool ${src.tool} returned an error: ${textFromToolResult(result).slice(0, 200)}`);
  }
  return textFromToolResult(result).slice(0, maxChars);
}

async function fetchSource(src, timeoutMs, maxChars) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(src.url, {
      headers: {
        'User-Agent': 'agix-research/1.0 (+https://example.com)',
        'Accept': 'text/html, application/xhtml+xml, application/xml, application/rss+xml, application/atom+xml, */*',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return stripContent(text).slice(0, maxChars);
  } finally {
    clearTimeout(timer);
  }
}

function stripContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Per-source extraction (Haiku) ──────────────────────────────────

async function extractItems(model, src, content, maxChars) {
  const sys = `You are a research scout for Agix, an "agentic implementations" consultancy. Your job is to scan one source page (a blog index, an arXiv listing, a release-notes page, etc.) and extract items that are relevant to LLM agents — specifically: techniques for agents that learn from their actions, failure modes / weaknesses, new frameworks/libraries, prompt-injection or security findings, eval/PRM advances, memory architectures, multi-agent coordination patterns, trajectory-based RL.

Score each item 0-5 by this rubric:
- 5: Reframes how Agix should build something we're already building (highest leverage)
- 4: New named technique with a working reference implementation or strong eval
- 3: Confirmed industry pattern shift (multiple sources converging)
- 2: Interesting but not actionable for Agix in the next 6 months
- 1: Mentioned in passing; trend-analysis only
- 0: Irrelevant / textbook recap / vendor marketing

Return strict JSON only:
{
  "items": [
    {
      "title": "<paper or post title — copy verbatim from the page>",
      "url": "<full URL to the SPECIFIC post or paper, copied verbatim from the page>",
      "score": <int 0-5>,
      "gist": "<one-sentence summary of what it is>",
      "why_for_agix": "<one-sentence implication for Agix>"
    }
  ]
}

Hard rules — violating any of these means DROP the item entirely (do not include it with a null or guessed value):

1. **Only include items with a specific, verbatim URL visible in the page content.** Copy-paste only. Never construct or guess a URL.
2. **The URL must point to a specific post, paper, or release** — NOT to a category root like ${'`'}/blog${'`'}, ${'`'}/research${'`'}, ${'`'}/learn${'`'}, ${'`'}/weblog${'`'}, ${'`'}/news${'`'}. It must contain a slug (e.g., ${'`'}/blog/agent-memory${'`'}) or paper ID (e.g., ${'`'}/abs/2503.16416${'`'}).
3. **NEVER fabricate arXiv IDs.** arXiv IDs follow ${'`'}YYMM.NNNNN${'`'} where YYMM is the publication year/month. If you cannot see the exact ID in the page text, drop the item.
4. **Only include items with score ≥ 3.**
5. **Maximum 5 items per source.** Pick the strongest.
6. If the page has nothing relevant or nothing with a specific URL, return ${'`'}{"items": []}${'`'}.

When in doubt, drop the item. A short list of well-cited items beats a long list with fabrications.`;

  const user = `Source: ${src.name}
URL: ${src.url}
Source notes: ${src.notes || '(none)'}

Page content (truncated to ${maxChars} chars):
${content}`;

  const resp = await model.chat({
    capability: 'cheap-classification',
    max_tokens: 1500,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'research',
  });
  const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  return parseJsonItems(text);
}

function parseJsonItems(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter(it => it && typeof it.title === 'string' && typeof it.score === 'number');
  } catch {
    return [];
  }
}

function validateItemUrl(url, sourceUrl) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return { ok: false, reason: 'no-url' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'no-url' }; }
  if (sourceUrl && url.replace(/\/$/, '') === sourceUrl.replace(/\/$/, '')) return { ok: false, reason: 'site-root' };
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length < 2) {
    if (segs.length === 0) return { ok: false, reason: 'site-root' };
    return { ok: false, reason: 'site-root' };
  }
  if (parsed.hostname.includes('arxiv.org')) {
    const idMatch = parsed.pathname.match(/(\d{4})\.\d+/);
    if (idMatch) {
      const yymm = parseInt(idMatch[1], 10);
      const now = new Date();
      const currentYymm = (now.getFullYear() % 100) * 100 + (now.getMonth() + 1);
      if (yymm > currentYymm) return { ok: false, reason: 'arxiv-future' };
    }
  }
  return { ok: true };
}

// ─── Brief synthesis (Sonnet) ───────────────────────────────────────

async function synthesizeBrief(model, candidates, dateStr, sourcesScanned, itemsTotal, topic = null) {
  const topicBias = topic
    ? `\n\n**FOCUS TOPIC: ${topic}**\nthe operator asked for a focused DIVE on this topic. Bias every section toward items relevant to it. Drop items that aren't relevant even if they're individually interesting — a tight dive beats a padded brief. The brief title and intro line should reflect the topic focus.\n`
    : '';

  const sys = `You are Agix's Research Agent, writing ${topic ? 'a focused DIVE brief' : 'the Weekly Research Brief'}.${topicBias}

Output a single markdown document following EXACTLY this 6-section template. Be concise. Cite everything. No filler. No corporate voice.

Template:

# ${topic ? `Agix Research — Dive on ${topic} (${dateStr})` : `Agix Research Brief — ${dateStr}`}

> ${topic ? `Focused dive on ${topic}. ${dateStr}. ${sourcesScanned} sources scanned.` : `Week of ${dateStr}. ${sourcesScanned} sources scanned. ${itemsTotal} items above the relevance threshold.`}

## 1. New techniques worth tracking (≤3)

For each item: \`### <name>\` then a 2-sentence gist, then a \`**Why for Agix:**\` line. Max 3 items. Pick the strongest (highest score, broadest leverage).

## 2. Reframe an Agix assumption (1)

Pick ONE specific claim or design choice in current Agix strategy docs (RECURSIVE_LEARNING_STRATEGY.md or AGENT_ARCHITECTURE_STRATEGY.md) that this week's evidence shows is behind the frontier. Structure as: original claim, new evidence (1-2 sentences with citation), minimal patch to close the gap (1-2 sentences). Link the doc + section.

## 3. "If Agix built this" opportunity (1)

One underbuilt opportunity sized for Agix to actually pursue. Concrete: what it is, who else is in the space, what's underbuilt, what Agix's wedge would be. 3-5 sentences.

## 4. New failure modes / risks surfaced this week

Bulleted list. Each item: name (bold), 1-line description, link, severity (low/medium/high). Skip the section if nothing surfaced.

## 5. Source log

Numbered list — one entry per unique URL cited in §§1-4. Format: \`1. [Title](URL) — 1-line gist\`. Skip the section if there are no citations.

Hard rules:
- **Citations are inline markdown links: \`[Title](URL)\` directly in the prose.** Do NOT use numbered references like \`[1]\` or \`[15]\` in §§1-4 — those create cross-section numbering bugs. Just write the link inline.
- **Every URL used inline in §§1-4 also gets an entry in §5.** §5 is the consolidated reference list; renumber it 1..N over only the URLs that actually appear above.
- §1 ≤ 3 items. §3 = exactly 1 idea. §4 ≤ 5 items.
- Use the URL field from the input items VERBATIM. Never construct or guess a URL.
- **Every item used as evidence MUST have a real URL in the input.** If an input item has no URL, do not cite it as evidence — pick a different item.
- For arXiv items: only include if the input URL is an arxiv.org/abs/<id> link. Never construct an arXiv ID from a title.
- Voice: direct, builder-to-builder. No em dashes. No AI vocabulary (delve, crucial, robust, comprehensive, nuanced).`;

  const itemsText = candidates
    .map((it, i) => `[${i + 1}] (score ${it.score}, source: ${it.source})
title: ${it.title}
url: ${it.url || '(no url)'}
gist: ${it.gist}
why_for_agix: ${it.why_for_agix}`)
    .join('\n\n');

  const resp = await model.chat({
    capability: 'default-quality',
    max_tokens: 4000,
    system: sys,
    messages: [{ role: 'user', content: `Candidate items from this week's scan:\n\n${itemsText}\n\nWrite the brief.` }],
    agent: 'research',
  });
  return resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

// ─── Critic pass (Opus) ─────────────────────────────────────────────

async function criticGrade(model, brief) {
  const sys = `You are the Critic for the Agix Research Agent's weekly brief. Grade the brief against the four-dimension rubric from AGENT_ARCHITECTURE_STRATEGY.md.

Return strict JSON only:
{
  "scores": {
    "accuracy":     { "score": <1-5>, "note": "<one sentence>" },
    "completeness": { "score": <1-5>, "note": "<one sentence>" },
    "timeliness":   { "score": <1-5>, "note": "<one sentence>" },
    "governance":   { "score": <1-5>, "note": "<one sentence>" }
  },
  "issues": ["<concrete problem 1>", "<concrete problem 2>"]
}

Rubric:
- Accuracy: every claim in §§1-4 has a numbered entry in §5. No unverified assertions. No fabricated URLs.
- Completeness: did §§1-4 cover what mattered, or did the brief miss obvious items? Are §2 and §3 actually concrete?
- Timeliness: are cited items recent (≤90 days preferred), or is the brief padded with older work?
- Governance: did the agent stay in its lane (no strategy-doc rewrites, no client-facing claims, no fabrications)? Any tool overreach?

Be tough but fair. Floor scores at 1, ceiling at 5. If no issues, return an empty array.`;

  const resp = await model.chat({
    capability: 'long-context',
    max_tokens: 800,
    system: sys,
    messages: [{ role: 'user', content: `Brief to grade:\n\n${brief}` }],
    agent: 'research',
  });
  const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ─── Final composition ─────────────────────────────────────────────

function composeFinalBrief(draft, critic, dateStr, sourcesScanned, itemsTotal, diveMeta = null) {
  const isDive = Boolean(diveMeta?.isDive);
  const title = isDive
    ? `Agix Research — Dive on ${diveMeta.topic} (${dateStr})`
    : `Agix Research Brief — ${dateStr}`;
  const tags = isDive
    ? '[research, agents, dive]'
    : '[research, agents, weekly-brief]';
  const diveLines = isDive
    ? `\ndive_topic: ${escapeYaml(diveMeta.topic)}\n` +
      (diveMeta.diveItemId ? `dive_item_id: ${diveMeta.diveItemId}\n` : '')
    : '';
  const frontmatter = `---
title: ${title}
type: ${isDive ? 'research-dive' : 'research-brief'}
domain: agents, llm-research
created: ${dateStr}
status: published
tags: ${tags}${diveLines}
sources_scanned: ${sourcesScanned}
items_surviving_filter: ${itemsTotal}
related: [[agent-hierarchy]], [[research-agent]], [[recursive-learning-strategy]]
---

`;

  let body = draft;

  if (!/## 6\. Self-grade/.test(body)) {
    body += '\n\n## 6. Self-grade (dogfooding the eval rubric)\n\n';
    if (critic && critic.scores) {
      const s = critic.scores;
      body += '| Dimension | Score (1-5) | Notes |\n|---|---|---|\n';
      for (const k of ['accuracy', 'completeness', 'timeliness', 'governance']) {
        const row = s[k] || { score: '?', note: '(no critic data)' };
        body += `| ${cap(k)} | ${row.score} | ${row.note} |\n`;
      }
      if (Array.isArray(critic.issues) && critic.issues.length > 0) {
        body += '\n**Open issues flagged by critic:**\n';
        for (const it of critic.issues) body += `- ${it}\n`;
      }
    } else {
      body += '_(Critic pass skipped or failed; no self-grade this run.)_\n';
    }
  }

  return frontmatter + body + '\n';
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Dive output filename component: prefer the originating item ID
// (already operator-meaningful), fall back to a topic slug.
function diveSlug(diveItemId, topic) {
  if (diveItemId && /^[A-Za-z0-9.-]+$/.test(diveItemId)) {
    return diveItemId.replace(/\./g, '-');
  }
  return slugifyTitle(topic || '', 'dive');
}

// Bare-minimum YAML scalar escape — wraps in double quotes only when
// the string contains characters that would break frontmatter parsing.
function escapeYaml(s) {
  if (s == null) return '';
  const str = String(s);
  return /[:#&*?{}[\],]/.test(str) ? JSON.stringify(str) : str;
}

// ─── Wiki log append ────────────────────────────────────────────────

async function appendWikiLog(runtime, dateStr, sourcesScanned, itemsTotal, itemsPicked) {
  const entry = `\n## ${dateStr} — Research Agent: weekly brief published\n\n- ${sourcesScanned} sources scanned · ${itemsTotal} items above relevance threshold · ${itemsPicked} entered synthesis pool.\n- Full brief: [\`wiki/research/${dateStr}-brief.md\`](research/${dateStr}-brief.md).\n`;

  // Read the running log from the writable OUTPUT root (where writeRepoFile puts it),
  // guarded — first run / read-only install returns '' instead of crashing after the brief.
  const existing = await runtime.readOutputFile(WIKI_LOG_REL_PATH);
  const lines = existing.split('\n');
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { insertAt = i; break; }
  }
  const next = lines.slice(0, insertAt).join('\n') + entry + '\n' + lines.slice(insertAt).join('\n');
  await runtime.writeRepoFile(WIKI_LOG_REL_PATH, next);
}

// ─── Concurrency helper ────────────────────────────────────────────

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Email rendering (Sumi & Kin letter) ────────────────────────────

const SUMI = '#14213D';
const SUMI_2 = '#2B3A5C';
const SUMI_3 = '#6B7691';
const KIN = '#B08840';
const WASHI_2 = '#ECE6D8';
const SERIF = "'Cormorant Garamond', 'Georgia', 'Times New Roman', serif";
const SANS = "'Geist', -apple-system, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";

function makeBriefingRenderer({ dateStr }) {
  const r = new Renderer();
  const state = { sectionLetter: null, itemNumber: 0 };
  const nextSection = () => {
    state.sectionLetter = state.sectionLetter
      ? String.fromCharCode(state.sectionLetter.charCodeAt(0) + 1)
      : 'A';
    state.itemNumber = 0;
  };
  const nextItemId = () => {
    if (!state.sectionLetter) nextSection();
    state.itemNumber += 1;
    return `${dateStr}.${state.sectionLetter}${state.itemNumber}`;
  };

  r.heading = ({ tokens, depth }) => {
    const text = r.parser.parseInline(tokens);
    if (depth === 1) {
      return `<h1 style="margin:32px 0 12px 0; padding:0; font-family:${SERIF}; font-weight:500; font-style:italic; font-size:26px; line-height:1.2; letter-spacing:-0.01em; color:${SUMI};">${text}</h1>`;
    }
    if (depth === 2) {
      nextSection();
      return `<h2 style="margin:36px 0 4px 0; padding:0 0 8px 0; font-family:${SERIF}; font-weight:500; font-style:italic; font-size:22px; line-height:1.25; letter-spacing:-0.005em; color:${SUMI}; border-bottom:1px solid ${KIN};">${text}</h2>`;
    }
    if (depth === 3) {
      const id = nextItemId();
      return (
        `<h3 style="margin:24px 0 6px 0; padding:0; font-family:${SANS}; font-weight:600; font-size:13px; line-height:1.4; letter-spacing:0.08em; text-transform:uppercase; color:${SUMI};">` +
        `<span style="color:${KIN}; font-family:${MONO}; font-weight:500; text-transform:none; letter-spacing:0.04em; font-size:12px; margin-right:8px;">${id}</span>` +
        `${text}` +
        `</h3>`
      );
    }
    return `<h4 style="margin:18px 0 4px 0; padding:0; font-family:${SANS}; font-weight:600; font-size:14px; color:${SUMI};">${text}</h4>`;
  };

  r.paragraph = ({ tokens }) => {
    const text = r.parser.parseInline(tokens);
    return `<p style="margin:0 0 14px 0; font-family:${SERIF}; font-size:16px; line-height:1.65; color:${SUMI}; letter-spacing:0;">${text}</p>`;
  };

  r.list = (token) => {
    const tag = token.ordered ? 'ol' : 'ul';
    const items = token.items
      .map(item =>
        `<li style="margin:6px 0; padding:0; font-family:${SERIF}; font-size:16px; line-height:1.6; color:${SUMI};">${r.parser.parse(item.tokens)}</li>`
      )
      .join('');
    return `<${tag} style="margin:0 0 16px 22px; padding:0;">${items}</${tag}>`;
  };

  r.listitem = ({ tokens }) =>
    `<li style="margin:6px 0; padding:0; font-family:${SERIF}; font-size:16px; line-height:1.6; color:${SUMI};">${r.parser.parse(tokens).replace(/^<p[^>]*>|<\/p>$/g, '')}</li>`;

  r.link = ({ href, title, tokens }) => {
    const text = r.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} style="color:${SUMI}; text-decoration:underline; text-decoration-color:${KIN}; text-underline-offset:2px;">${text}</a>`;
  };

  r.strong = ({ tokens }) =>
    `<strong style="font-weight:600; color:${SUMI};">${r.parser.parseInline(tokens)}</strong>`;
  r.em = ({ tokens }) =>
    `<em style="font-style:italic;">${r.parser.parseInline(tokens)}</em>`;
  r.codespan = ({ text }) =>
    `<code style="font-family:${MONO}; font-size:13px; background:${WASHI_2}; padding:1px 5px; border-radius:3px; color:${SUMI_2};">${text}</code>`;
  r.blockquote = ({ tokens }) => {
    const inner = r.parser.parse(tokens);
    return `<blockquote style="margin:16px 0; padding:6px 0 6px 16px; border-left:2px solid ${KIN}; color:${SUMI_2}; font-style:italic; font-family:${SERIF}; font-size:16px; line-height:1.6;">${inner}</blockquote>`;
  };
  r.hr = () =>
    `<hr style="border:none; border-top:1px solid rgba(20,33,61,0.12); margin:28px 0;">`;

  return r;
}

function renderBriefBody(markdown, dateStr) {
  const renderer = makeBriefingRenderer({ dateStr });
  return marked.parse(markdown, { renderer });
}

function stripBriefFrontmatter(md) {
  let out = md;
  if (out.startsWith('---')) {
    const closing = out.indexOf('\n---', 3);
    if (closing !== -1) {
      out = out.slice(closing + 4).replace(/^\s*\n/, '');
    }
  }
  out = out.replace(/^#\s+.*$/m, '').trimStart();
  return out;
}

function buildReplyConventionBlock(dateStr) {
  return (
    `<div style="margin:40px 0 0 0; padding:18px 20px; background:${WASHI_2}; border-left:2px solid ${KIN}; font-family:${SERIF}; font-size:14px; line-height:1.55; color:${SUMI_2};">` +
    `<p style="margin:0 0 8px 0; font-family:${SANS}; font-weight:600; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:${SUMI};">How to direct execution</p>` +
    `<p style="margin:0 0 10px 0; font-family:${SERIF}; font-size:14px; line-height:1.55; color:${SUMI_2};">Reply to this email with item IDs and a verb. The Director Agent reads replies on its next run and acts.</p>` +
    `<ul style="margin:0 0 0 18px; padding:0;">` +
    `<li style="margin:3px 0; font-family:${SERIF}; font-size:14px; line-height:1.5; color:${SUMI};"><code style="font-family:${MONO}; font-size:12px; color:${KIN}; font-weight:500;">YES ${dateStr}.A1</code> — file a spec, queue for build</li>` +
    `<li style="margin:3px 0; font-family:${SERIF}; font-size:14px; line-height:1.5; color:${SUMI};"><code style="font-family:${MONO}; font-size:12px; color:${KIN}; font-weight:500;">DIVE ${dateStr}.A1</code> — spawn a focused research run</li>` +
    `<li style="margin:3px 0; font-family:${SERIF}; font-size:14px; line-height:1.5; color:${SUMI};"><code style="font-family:${MONO}; font-size:12px; color:${KIN}; font-weight:500;">DEFER ${dateStr}.A1</code> — re-surface in next brief</li>` +
    `<li style="margin:3px 0; font-family:${SERIF}; font-size:14px; line-height:1.5; color:${SUMI};"><code style="font-family:${MONO}; font-size:12px; color:${KIN}; font-weight:500;">SKIP ${dateStr}.A1</code> — dismiss this item</li>` +
    `</ul>` +
    `<p style="margin:10px 0 0 0; font-family:${SERIF}; font-size:13px; line-height:1.5; color:${SUMI_3}; font-style:italic;">Plain English works too — the classifier handles "implement the AgentPRM item" or "skip B, dive on C1".</p>` +
    `</div>`
  );
}

function greetingForHour(hourLocal) {
  if (hourLocal < 12) return 'Good morning';
  if (hourLocal < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDateLine(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return fmt.format(d);
}

async function renderBriefingHtml({ runtime, briefMarkdown, dateStr, operatorFirstName, lastCycleSection }) {
  const template = await runtime.readRepoFile(TEMPLATE_REL_PATH);
  const trimmed = stripBriefFrontmatter(briefMarkdown);

  // Director-injected "Last cycle's status" — prepended above the synthesis
  // body so the operator sees outcomes of past directives before reading
  // new ones. Renderer counters (sectionLetter, itemNumber) reset per
  // call, so the status section's IDs would collide with the body's;
  // wrap the status block in its own renderer pass instead.
  const statusHtml = lastCycleSection
    ? renderBriefBody(lastCycleSection, dateStr)
    : '';

  const bodyHtml = renderBriefBody(trimmed, dateStr);
  const replyBlock = buildReplyConventionBlock(dateStr);

  const now = new Date();
  const greet = greetingForHour(now.getHours());
  return template
    .replace(/\{\{eyebrow\}\}/g, 'Research Brief')
    .replace(/\{\{salutation\}\}/g, `${greet}, ${operatorFirstName}.`)
    .replace(/\{\{date_line\}\}/g, formatDateLine(now))
    .replace(/\{\{body_html\}\}/g, statusHtml + bodyHtml + replyBlock)
    .replace(/\{\{closing\}\}/g, '— Your Secretary')
    .replace(
      /\{\{footer_note\}\}/g,
      `Filed at wiki/research/${dateStr}-brief.md · Director Agent reads replies on its next run.`,
    );
}
