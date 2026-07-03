// Agix Onboarding Agent — Phase 2 (LLM-wired).
//
// A good first agent to point at a new project to get oriented. Reads the
// codebase (read-only), produces:
//
//   1. wiki/sources/<YYYY-MM-DD>-<client-slug>-baseline.md
//      Primary source page — product capability baseline, stack
//      inventory, weakness assessment (P0/P1/P2), AI-readiness
//      scorecard, Discovery Sprint scope implications.
//   2. wiki/director/specs/<YYYY-MM-DD>-<client-slug>-foundation-plan.md
//      Architect-annotatable spec with <!-- ARCHITECT:BEGIN/END --> markers.
//
// Three LLM passes (cost-ordered):
//   • Scan (Haiku 4.5)   — parallel per-file summarize → file_summary[]
//   • Synth (Sonnet 4.6) — section synthesis + weakness candidates
//   • Judge (Opus 4.7)   — severity grading + 12-dim AI-readiness scorecard
//
// Token-budget enforcement: tracked via runtime.recordModelCall();
// halts cleanly at opts.maxTokens with whatever has landed.
//
// Smoke mode: short-circuits before LLM calls; writes a structurally-
// correct skeleton via runtime.writeRepoFile (runtime intercepts to a
// smoke sandbox) so doctor + smoke pass without burning tokens.
//
// Spec: wiki/director/specs/2026-05-17-client-agent-package.md §A.1
// Manifest: agents/onboarding/manifest.yaml
// Strategy: clients/<your-client>/CTO_DIRECTION.md §6.A

import { readFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLIENT_REPOS_DIR_REL = '.client-repos';
const SOURCES_REL_DIR = 'wiki/sources';
const SPECS_REL_DIR = 'wiki/director/specs';
const LOG_REL_PATH = 'wiki/log.md';

const DEFAULT_OPTS = {
  maxFiles: 500,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxTokens: 250_000,
  fetchConcurrency: 4,
  defaultDepth: 'full',
};

// File extensions the audit considers "source." Aligned with a
// prior client audit's effective scope.
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml',
  '.md',
  '.sql', '.graphql', '.gql',
  '.html',
  '.sh', '.bash', '.zsh',
]);

// Source filenames without extensions worth including.
const SOURCE_FILENAMES = new Set([
  'Dockerfile', 'dockerfile', '.dockerignore',
  '.env.example', '.eslintrc', '.prettierrc',
  'Makefile', 'makefile',
]);

// Directories never worth reading.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo',
  '.cache', 'coverage', '.nyc_output', '.pytest_cache', '__pycache__',
  '.venv', 'venv', '.idea', '.vscode', '.client-repos',
]);

// Pricing moved to the Model protocol's rate card
// (lib/model-adapters/rate-card.mjs) — cost-tracking happens
// structurally in Model.chat since 2026-06-10.

// ─── Entry ───────────────────────────────────────────────────────────

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const cfg = {
    scanModel:        defaults.scan_model        || 'claude-haiku-4-5',
    synthModel:       defaults.synth_model       || 'claude-sonnet-4-6',
    judgeModel:       defaults.judge_model       || 'claude-opus-4-7',
    maxFiles:         numOrDefault(defaults.max_files, DEFAULT_OPTS.maxFiles),
    maxFileBytes:     numOrDefault(defaults.max_file_bytes, DEFAULT_OPTS.maxFileBytes),
    maxTotalBytes:    numOrDefault(defaults.max_total_bytes, DEFAULT_OPTS.maxTotalBytes),
    maxTokens:        numOrDefault(opts.maxTokens, numOrDefault(defaults.max_tokens, DEFAULT_OPTS.maxTokens)),
    fetchConcurrency: numOrDefault(defaults.fetch_concurrency, DEFAULT_OPTS.fetchConcurrency),
    defaultDepth:     defaults.default_depth || DEFAULT_OPTS.defaultDepth,
    clientReposDir:   defaults.client_repos_dir || CLIENT_REPOS_DIR_REL,
  };

  const positional = Array.isArray(opts._) ? opts._ : [];
  // Smoke mode auto-defaults to 'audit' so the runtime stub exercises the
  // full render path (writes to smoke sandbox via runtime.writeRepoFile).
  // Otherwise behavior matches the operator's typed sub-command.
  const sub = positional[0]
    || (opts.client ? 'audit' : null)
    || (runtime.smoke ? 'audit' : null);

  if (!sub || sub === 'help') {
    printHelp();
    return { mode: null };
  }

  if (sub !== 'audit') {
    console.error(`Unknown sub-command: ${sub}`);
    printHelp();
    throw new Error(`Unknown onboarding sub-command: ${sub}`);
  }

  // ─── Smoke short-circuit ────────────────────────────────────────
  // Smoke verifies manifest + runtime + Model-protocol wiring without
  // cloning a repo or burning tokens. The Model stub returns a
  // smoke-marker response from .chat() and writes one ledger entry
  // per capability the real run would hit (AC-MP-09).
  if (runtime.smoke) {
    return await runSmoke({ runtime, cfg });
  }

  // ─── Validate operator inputs ───────────────────────────────────
  if (!opts.client) throw new Error('--client <slug> is required');
  if (!opts.repos)  throw new Error('--repos <url1,url2,...> is required');

  const clientSlug = String(opts.client);
  const repoUrls = String(opts.repos).split(',').map((s) => s.trim()).filter(Boolean);
  const depth = String(opts.depth || cfg.defaultDepth);
  if (depth !== 'full' && depth !== 'sample') {
    throw new Error(`--depth must be 'full' or 'sample' (got ${depth})`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();
  const phase0 = Date.now();

  // ─── Phase 1 — clone (read-only) ────────────────────────────────
  console.log(`onboarding: client=${clientSlug} depth=${depth} repos=${repoUrls.length}`);
  const clientReposRoot = resolve(runtime.repoRoot, cfg.clientReposDir, clientSlug);
  await mkdir(clientReposRoot, { recursive: true });

  const cloned = [];
  for (const url of repoUrls) {
    const repoName = repoNameFromUrl(url);
    const dest = resolve(clientReposRoot, repoName);
    if (!existsSync(dest)) {
      console.log(`  cloning ${url} → ${relative(runtime.repoRoot, dest)}`);
      const r = spawnSync('git', ['clone', '--depth', '1', url, dest], { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error(`git clone failed for ${url} (exit ${r.status}). Verify access (SSH/gh/PAT).`);
      }
    } else {
      console.log(`  refreshing ${repoName}`);
      spawnSync('git', ['-C', dest, 'fetch', '--depth', '1', 'origin'], { stdio: 'inherit' });
      spawnSync('git', ['-C', dest, 'reset', '--hard', 'origin/HEAD'], { stdio: 'inherit' });
    }
    const headSha = spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    cloned.push({ url, repo_name: repoName, path: dest, head_sha: headSha });
  }
  runtime.recordPhase('phase1_clone', Date.now() - phase0);

  // ─── Phase 2 — file walk ────────────────────────────────────────
  const phase2start = Date.now();
  let files = await walkRepos(cloned, depth, cfg);
  console.log(`onboarding: discovered ${files.length} source files`);
  if (files.length > cfg.maxFiles) {
    console.warn(`onboarding: capping at ${cfg.maxFiles} files`);
    files = files.slice(0, cfg.maxFiles);
  }
  let cumulative = 0;
  files = files.filter((f) => {
    if (cumulative + f.size > cfg.maxTotalBytes) return false;
    cumulative += f.size;
    return true;
  });
  runtime.recordPhase('phase2_walk', Date.now() - phase2start);

  // ─── Phase 3 — scan (Haiku, parallel) ───────────────────────────
  const model = runtime.getModel();
  const tokenBudget = { used: 0, max: cfg.maxTokens, halted: false };

  console.log(`onboarding: scan pass — ${files.length} files via ${cfg.scanModel}`);
  const phase3start = Date.now();
  const fileSummaries = await runScanPass({
    model, runtime, modelId: cfg.scanModel,
    files, concurrency: cfg.fetchConcurrency,
    maxFileBytes: cfg.maxFileBytes, tokenBudget,
  });
  runtime.recordPhase('phase3_scan', Date.now() - phase3start);
  console.log(`onboarding: scan produced ${fileSummaries.length} summaries · ${tokenBudget.used} tokens used / ${tokenBudget.max} budget`);
  if (tokenBudget.halted) {
    console.warn(`onboarding: scan pass halted on token budget — synth + judge will run on partial scan output`);
  }

  // ─── Phase 4 — synth (Sonnet) ───────────────────────────────────
  console.log(`onboarding: synth pass via ${cfg.synthModel}`);
  const phase4start = Date.now();
  let synth = await runSynthPass({
    model, runtime, modelId: cfg.synthModel,
    clientSlug, fileSummaries, cloned, tokenBudget,
  });
  // Citation validator + one retry on failure.
  let synthRetried = false;
  if (synth.weaknesses && !weaknessesHaveCitations(synth.weaknesses)) {
    console.warn(`onboarding: synth output missing citations — retrying once with stricter prompt`);
    synth = await runSynthPass({
      model, runtime, modelId: cfg.synthModel,
      clientSlug, fileSummaries, cloned, tokenBudget, strictCitations: true,
    });
    synthRetried = true;
  }
  runtime.recordPhase('phase4_synth', Date.now() - phase4start);

  // ─── Phase 5 — judge (Opus) ─────────────────────────────────────
  // --memory: ground the judge in lessons recalled from prior audits
  // (runtime.getMemoryStore(), Q1) and offload this audit's lessons
  // after. Off by default until the qualitative pilot ratifies it.
  console.log(`onboarding: judge pass via ${cfg.judgeModel}${opts.memory ? ' · memory on' : ''}`);
  const phase5start = Date.now();
  const memory = opts.memory ? runtime.getMemoryStore() : null;
  const judged = await runJudgePass({
    model, runtime, modelId: cfg.judgeModel,
    clientSlug, synth, tokenBudget, memory,
  });
  if (memory && judged.discovery_implications) {
    await memory.offload({
      text: `Audit lessons for ${clientSlug}: ${judged.discovery_implications}`,
      tags: ['onboarding', 'judge-pass', clientSlug],
      session_id: runtime.currentRunId,
    });
  }
  runtime.recordPhase('phase5_judge', Date.now() - phase5start);

  // ─── Phase 6 — render artifacts ─────────────────────────────────
  const sourceRel = `${SOURCES_REL_DIR}/${date}-${clientSlug}-baseline.md`;
  const specRel = `${SPECS_REL_DIR}/${date}-${clientSlug}-foundation-plan.md`;

  const sourceMd = renderSourcePage({
    clientSlug, date, depth, cloned, files, synth, judged,
    citationsHash: synthRetried ? 'retry-pass' : 'first-pass',
    tokenBudget,
  });
  const specMd = renderFoundationPlan({
    clientSlug, date, cloned, synth, judged,
  });

  await runtime.writeRepoFile(sourceRel, sourceMd);
  await runtime.writeRepoFile(specRel, specMd);
  runtime.recordFileWritten(sourceRel);
  runtime.recordFileWritten(specRel);
  await appendLog(runtime, `${startedAt} onboarding: ${clientSlug} baseline drafted (phase-2) — ${files.length} files · ${(judged.scorecard || []).length}/12 dims scored · ${(synth.weaknesses || []).length} weaknesses`);

  // ─── Cursors ────────────────────────────────────────────────────
  for (const c of cloned) {
    await runtime.writeState(`cursors-${clientSlug}--${c.repo_name}`, {
      client_slug: clientSlug,
      repo_url: c.url,
      repo_name: c.repo_name,
      last_audited_sha: c.head_sha,
      last_audited_at: new Date().toISOString(),
    });
  }

  return {
    mode: 'audit',
    phase: 2,
    client_slug: clientSlug,
    depth,
    files_inventoried: files.length,
    weaknesses_found: (synth.weaknesses || []).length,
    scorecard_dimensions_scored: (judged.scorecard || []).length,
    tokens_used: tokenBudget.used,
    artifacts: { source: sourceRel, spec: specRel },
    citation_retry: synthRetried,
    halted_on_budget: tokenBudget.halted,
  };
}

// ─── Smoke ───────────────────────────────────────────────────────────

async function runSmoke({ runtime, cfg }) {
  // Exercise the model surface so the ledger recording path is verified
  // end-to-end (AC-MP-09). The stub returns a canned response without
  // spending tokens; one ledger line per capability the real run hits.
  const smokeModel = runtime.getModel();
  for (const capability of ['cheap-classification', 'default-quality', 'long-context']) {
    await smokeModel.chat({
      capability,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'smoke' }],
      agent: 'onboarding',
    });
  }
  const date = new Date().toISOString().slice(0, 10);
  const slug = 'smoke-fake-client';
  const sourceRel = `${SOURCES_REL_DIR}/${date}-${slug}-baseline.md`;
  const specRel = `${SPECS_REL_DIR}/${date}-${slug}-foundation-plan.md`;
  const judged = { scorecard: cannedSmokeScorecard(), weaknesses_graded: [], discovery_implications: '_(smoke)_' };
  const synth = {
    section_1_product_baseline: '_(smoke)_',
    section_2_stack_inventory: '_(smoke)_',
    weaknesses: [],
  };
  const cloned = [{ url: 'https://example.com/smoke.git', repo_name: 'smoke', head_sha: '0000000', path: '/tmp/smoke' }];
  await runtime.writeRepoFile(sourceRel, renderSourcePage({
    clientSlug: slug, date, depth: 'sample', cloned, files: [], synth, judged,
    citationsHash: 'smoke', tokenBudget: { used: 0, max: cfg.maxTokens, halted: false },
  }));
  await runtime.writeRepoFile(specRel, renderFoundationPlan({ clientSlug: slug, date, cloned, synth, judged }));
  return { mode: 'smoke', client_slug: slug, scorecard: judged.scorecard };
}

// ─── Scan pass ───────────────────────────────────────────────────────

async function runScanPass({ model, runtime, modelId, files, concurrency, maxFileBytes, tokenBudget }) {
  const summaries = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < files.length && !tokenBudget.halted) {
      const f = files[cursor++];
      try {
        const content = await readFile(f.path, 'utf8');
        const truncated = content.length > maxFileBytes ? content.slice(0, maxFileBytes) : content;
        const summary = await scanFile({ model, runtime, modelId, file: f, content: truncated, tokenBudget });
        if (summary) summaries.push(summary);
      } catch (err) {
        console.warn(`  scan: ${f.repo_relative}: ${err.message}`);
      }
    }
  }));
  return summaries;
}

async function scanFile({ model, runtime, modelId, file, content, tokenBudget }) {
  if (tokenBudget.halted) return null;
  const sys = `You are a code-evaluation assistant for the Agix Onboarding Agent. Read one source file from a client repository and return a strict JSON object (no prose, no fences) with this shape:
{
  "purpose": "<one sentence — what this file does>",
  "key_apis": ["<symbol or route>", ...],
  "notable_patterns": ["<pattern observed>", ...],
  "weakness_signals": [{ "category": "security|tenancy|cost|tests|deploy|data-model|deps|observability|other", "claim": "<short, specific>", "line": <int>, "severity_hint": "P0|P1|P2" }, ...]
}

If nothing notable, return {"purpose": "<purpose>", "key_apis": [], "notable_patterns": [], "weakness_signals": []}.
Cite line numbers from the file. Only flag a weakness signal if you can pin it to a line.`;

  const user = `File: ${file.repo_relative}
Size: ${file.size} bytes

\`\`\`
${content}
\`\`\``;

  const resp = await model.chat({
    capability: 'cheap-classification',
    max_tokens: 800,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'onboarding',
  });
  recordCall(runtime, modelId, resp, tokenBudget);
  const text = resp.content?.map((b) => (b.type === 'text' ? b.text : '')).join('').trim() || '';
  const parsed = tryParseJson(text);
  if (!parsed) return null;
  return { ...parsed, path: file.repo_relative };
}

// ─── Synth pass ──────────────────────────────────────────────────────

async function runSynthPass({ model, runtime, modelId, clientSlug, fileSummaries, cloned, tokenBudget, strictCitations = false }) {
  if (tokenBudget.halted) return { weaknesses: [] };

  // Group summaries by directory for easier sectional synthesis.
  const grouped = {};
  for (const s of fileSummaries) {
    const dir = s.path.split('/').slice(0, 3).join('/') || '/';
    (grouped[dir] ||= []).push(s);
  }

  const citationsRule = strictCitations
    ? `EVERY weakness MUST cite at least one file path + line number in the "files" array, e.g. [{"path": "api/src/foo.ts", "line": 42}]. If you cannot cite a line, do not include the weakness.`
    : `Every weakness should cite at least one file path + line number when possible.`;

  const sys = `You are the Agix Onboarding Agent's synthesis pass. You have per-file summaries from a Haiku scan over a client's repositories. Produce a strict JSON object (no prose, no fences) with this shape:
{
  "section_1_product_baseline": "<markdown — what the product does, personas, end-to-end journeys, data model summary>",
  "section_2_stack_inventory": "<markdown including tables for: frontend stack, API stack, data tier, deploy, integrations>",
  "weaknesses": [
    {
      "id": "<auto-generated, e.g. W-1>",
      "category": "security|tenancy|cost|tests|deploy|data-model|deps|observability|other",
      "title": "<short>",
      "description": "<one paragraph>",
      "ai_impact": "<one paragraph — why this matters for AI features>",
      "files": [{"path": "<repo-relative>", "line": <int>}, ...],
      "severity_hint": "P0|P1|P2"
    }
  ]
}

${citationsRule}
Focus on the highest-signal weaknesses: security, multi-tenancy, cost protection, test coverage, CI/CD, data model. Do not exceed 25 weaknesses; pick the 25 most impactful if you find more.`;

  const summariesByDir = Object.entries(grouped)
    .map(([dir, items]) => `\n### ${dir}\n${items.map((s) => `- ${s.path}: ${s.purpose}${(s.weakness_signals || []).length ? ` [signals: ${s.weakness_signals.length}]` : ''}`).join('\n')}\n${items.flatMap((s) => (s.weakness_signals || []).map((w) => `  - ${s.path}:${w.line} [${w.severity_hint}/${w.category}] ${w.claim}`)).join('\n')}`)
    .join('\n');

  const user = `Client slug: ${clientSlug}
Repos audited:
${cloned.map((c) => `- ${c.url} @ ${c.head_sha.slice(0, 7)}`).join('\n')}

${fileSummaries.length} files scanned. Per-directory summary (with weakness signals from scan pass):

${summariesByDir}`;

  const resp = await model.chat({
    capability: 'default-quality',
    max_tokens: 8000,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'onboarding',
  });
  recordCall(runtime, modelId, resp, tokenBudget);
  const text = resp.content?.map((b) => (b.type === 'text' ? b.text : '')).join('').trim() || '';
  const parsed = tryParseJson(text);
  if (!parsed) return { weaknesses: [] };
  return parsed;
}

export function weaknessesHaveCitations(weaknesses) {
  if (!Array.isArray(weaknesses) || weaknesses.length === 0) return true;
  return weaknesses.every((w) => Array.isArray(w.files) && w.files.length > 0
    && w.files.every((f) => f && typeof f.path === 'string' && typeof f.line === 'number'));
}

// ─── Judge pass ──────────────────────────────────────────────────────

async function runJudgePass({ model, runtime, modelId, clientSlug, synth, tokenBudget, memory = null }) {
  if (tokenBudget.halted || !synth.weaknesses) {
    return { scorecard: cannedSmokeScorecard(), weaknesses_graded: synth.weaknesses || [], discovery_implications: '_(budget halted)_' };
  }

  // Q1 memory: recall prior audit lessons relevant to this client's
  // weakness profile and ground the judge in them.
  let recalledBlock = '';
  if (memory) {
    const query = (synth.weaknesses || []).map((w) => w.title || w.summary || '').join(' ').slice(0, 2000);
    const recalled = await memory.recall({ query, k: 3, tags: ['onboarding'] });
    if (recalled.length) {
      recalledBlock = `\n\nLessons from prior audits (recalled from memory; weigh as precedent, not ground truth):\n` +
        recalled.map((r) => `- ${r.text.slice(0, 500)}`).join('\n');
    }
  }

  const sys = `You are the Agix Onboarding Agent's judgment pass. Take the synthesis output below and produce a strict JSON object (no prose, no fences) with this shape:
{
  "scorecard": [
    {"dimension": "Data model|Async / job infra|Realtime|Auth + tenancy|Cost control|CI/CD + tests|Observability|Schema validation|AI client surface|Deploy / hosting|Frontend AI surface|Dependency hygiene", "score": "Ready|Gap|Blocker", "justification": "<one sentence>"}
  ],
  "weaknesses_graded": [
    { /* echo each input weakness with these adjustments */
      "id": "<P0-N | P1-N | P2-N>",
      "severity": "P0|P1|P2",
      "confidence": "high|medium|low",
      "rationale_for_severity": "<one sentence>",
      ...rest_of_input_weakness
    }
  ],
  "discovery_implications": "<markdown — what the Discovery / Foundation Sprint scope must include to unblock AI features given these findings>"
}

Score all 12 dimensions in scorecard. Re-key weaknesses to P0/P1/P2 IDs (P0-1, P0-2, ..., P1-1, ...). Severity rules: P0 blocks any AI feature ship; P1 must be in Foundation Sprint scope; P2 is transparency note.`;

  const user = `Client slug: ${clientSlug}

Synthesis output:
${JSON.stringify(synth, null, 2).slice(0, 60_000)}${recalledBlock}`;

  // Note: `thinking: { type: 'adaptive' }` was passed pre-migration. The
  // Model protocol's ChatRequest doesn't expose a `thinking` knob yet
  // (spec §2); adaptive extended thinking is dropped here until the
  // protocol surfaces it. Capability routing still lands the call on
  // Opus 4.7 (the model that benefited from the flag).
  const resp = await model.chat({
    capability: 'long-context',
    max_tokens: 8000,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'onboarding',
  });
  recordCall(runtime, modelId, resp, tokenBudget);
  const text = resp.content?.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || '';
  const parsed = tryParseJson(text);
  if (!parsed) {
    return { scorecard: cannedSmokeScorecard(), weaknesses_graded: synth.weaknesses || [], discovery_implications: '_(judge pass parse-failed)_' };
  }
  return parsed;
}

// ─── Token + cost tracking ──────────────────────────────────────────

function recordCall(runtime, model, resp, tokenBudget) {
  const tokens_in = resp?.usage?.input_tokens || 0;
  const tokens_out = resp?.usage?.output_tokens || 0;
  // Run-event + budget accounting now happens structurally inside
  // Model.chat (2026-06-10) — calling runtime.recordModelCall here
  // again would double-count. This helper only feeds the agent's own
  // in-process token budget for the halt-cleanly behavior.
  tokenBudget.used += tokens_in + tokens_out;
  if (tokenBudget.used >= tokenBudget.max) {
    tokenBudget.halted = true;
  }
}

// ─── File walk ───────────────────────────────────────────────────────

async function walkRepos(cloned, depth, cfg) {
  const out = [];
  for (const c of cloned) {
    await walkDir(c.path, out, c.path, cfg);
  }
  if (depth === 'sample') {
    // Keep newest 20 per directory.
    const byDir = new Map();
    for (const f of out) {
      const d = dirname(f.repo_relative);
      const arr = byDir.get(d) || [];
      arr.push(f);
      byDir.set(d, arr);
    }
    const sampled = [];
    for (const [, arr] of byDir) {
      arr.sort((a, b) => b.mtime - a.mtime);
      sampled.push(...arr.slice(0, 20));
    }
    return sampled;
  }
  return out;
}

async function walkDir(dir, out, repoRoot, cfg) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkDir(full, out, repoRoot, cfg);
    } else if (e.isFile()) {
      const ext = extname(e.name);
      if (!SOURCE_EXTS.has(ext) && !SOURCE_FILENAMES.has(e.name)) continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (st.size > cfg.maxFileBytes) continue;
      out.push({
        repo_relative: relative(repoRoot, full),
        path: full,
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
}

// ─── Renderers ───────────────────────────────────────────────────────

function renderSourcePage({ clientSlug, date, depth, cloned, files, synth, judged, citationsHash, tokenBudget }) {
  const reposTable = cloned.map((c) => `| \`${c.url}\` | \`${c.head_sha.slice(0, 7)}\` |`).join('\n');
  const filesCount = files.length;

  const scorecardTable = (judged.scorecard || []).map((s) =>
    `| ${s.dimension} | **${s.score}** | ${s.justification || ''} |`
  ).join('\n');

  const findingsBySeverity = { P0: [], P1: [], P2: [] };
  for (const w of (judged.weaknesses_graded || synth.weaknesses || [])) {
    const sev = w.severity || w.severity_hint || 'P2';
    (findingsBySeverity[sev] || findingsBySeverity.P2).push(w);
  }
  const renderFindings = (arr) => arr.map((w) => {
    const cites = (w.files || []).map((f) => `\`${f.path}:${f.line}\``).join(', ');
    return `| **${w.id}** | ${w.title || '(untitled)'} | ${cites || '_(no citation)_'} | ${(w.ai_impact || w.description || '').replace(/\n/g, ' ')} |`;
  }).join('\n');

  return `---
title: ${clientSlug} — Repo Evaluation (Onboarding Agent, ${date})
type: source
domain: consulting, architecture
client: ${clientSlug}
created: ${date}
updated: ${date}
status: baseline
tags: [client, ${clientSlug}, evaluation, code-review, baseline, onboarding-agent]
---

# ${clientSlug} — Repo Evaluation

> A first read of the ${clientSlug} codebase, with the findings that
> shape the Foundation Sprint. Each weakness in §3 is traced to a
> file and line so it can be checked at the source before acting on it.

## Repos Audited

| URL | HEAD SHA |
|---|---|
${reposTable}

## 1. Product Capability Baseline

${synth.section_1_product_baseline || '_(synth pass produced no §1 — see Phase 2 logs)_'}

## 2. Stack Inventory

${synth.section_2_stack_inventory || '_(synth pass produced no §2 — see Phase 2 logs)_'}

## 3. Weakness Assessment

Severities: **P0 = blocks AI proposal until addressed** · **P1 = Discovery / Foundation Sprint must include** · **P2 = note for transparency, doesn't block**.

### 3.1 P0 — Security & Correctness Blockers

| # | Finding | Citation(s) | Why It Matters for AI |
|---|---|---|---|
${renderFindings(findingsBySeverity.P0) || '| _(none)_ | | | |'}

### 3.2 P1 — Foundation Sprint Must Include

| # | Finding | Citation(s) | Impact |
|---|---|---|---|
${renderFindings(findingsBySeverity.P1) || '| _(none)_ | | | |'}

### 3.3 P2 — Note for Transparency

| # | Finding | Citation(s) | Note |
|---|---|---|---|
${renderFindings(findingsBySeverity.P2) || '| _(none)_ | | | |'}

## 4. AI-Readiness Scorecard

| Dimension | Score | Justification |
|---|---|---|
${scorecardTable || '| _(judge pass produced no scorecard)_ | | |'}

## 5. Discovery / Foundation Sprint Scope Implications

${judged.discovery_implications || '_(judge pass produced no implications block)_'}

## 6. Citations

Every weakness in §3 carries a file path and line number from the
client repos, so each finding can be traced directly to its source.

## See Also

- \`wiki/director/specs/${date}-${clientSlug}-foundation-plan.md\` (sibling spec)
- \`agents/onboarding/\` (this agent)
- \`wiki/sources/2026-05-14-<your-client>-repo-eval.md\` (hand-rolled reference audit)

---

## Run Details

_Operator notes — not part of the evaluation. Run telemetry for the
engineer who triggered this audit._

| Field | Value |
|---|---|
| Generated | ${new Date().toISOString()} |
| Depth | ${depth} |
| Files scanned | ${filesCount} |
| Tokens used | ${tokenBudget.used} / ${tokenBudget.max} |
| Budget halted | ${tokenBudget.halted} |
| Citations validator | ${citationsHash} |
| Re-clone | use the operator-blessed clone command per \`ONBOARDING_AGENT_AUTHORIZATION.md\` |
`;
}

function renderFoundationPlan({ clientSlug, date, cloned, synth, judged }) {
  const blockerDims = (judged.scorecard || []).filter((d) => d.score === 'Blocker').map((d) => `- **${d.dimension}** — ${d.justification}`).join('\n');
  const p0Count = (judged.weaknesses_graded || synth.weaknesses || []).filter((w) => (w.severity || w.severity_hint) === 'P0').length;
  return `---
title: ${clientSlug} — Foundation Plan (Onboarding Agent, ${date})
type: director-spec
domain: architecture, client
client: ${clientSlug}
created: ${date}
updated: ${date}
status: draft
related:
  - ../sources/${date}-${clientSlug}-baseline.md
tags: [client, ${clientSlug}, foundation-sprint, onboarding-agent]
---

# ${clientSlug} — Foundation Plan

Drafted by the Onboarding Agent (Phase 2) from the audit at
\`../sources/${date}-${clientSlug}-baseline.md\`. Architect annotates the
marked block below on its next scheduled run.

## 1. Scope

The Foundation Sprint addresses the ${p0Count} P0 finding(s) surfaced in
the sibling baseline source page §3. The Blocker-graded dimensions on
the AI-readiness scorecard:

${blockerDims || '- _(no Blocker dimensions — clean baseline)_'}

## 2. Acceptance

Each P0 finding has a documented resolution PR with file:line citations
matching the baseline. The Blocker-graded dimensions move to Gap or
Ready on a re-audit by this agent at the end of the sprint.

## 3. Discovery Implications

${judged.discovery_implications || '_(judge pass produced no implications block — re-run audit)_'}

## 4. Repos Considered

${cloned.map((c) => `- \`${c.url}\` @ \`${c.head_sha.slice(0, 7)}\``).join('\n')}

<!-- ARCHITECT:BEGIN -->
_(Architect annotation pending — will be populated on next architect run per \`agents/architect/manifest.yaml\` schedule.)_
<!-- ARCHITECT:END -->
`;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Agix Onboarding Agent

Usage:
  agix agent run onboarding audit --client <slug> --repos <url1,url2,...> [--depth full|sample] [--max-tokens N]
  agix agent smoke onboarding

Required (for audit):
  --client <slug>       Client slug; matches the directory under
                        architecture/07-client-templates/<vertical>/clients/<slug>/
  --repos <url,...>     Comma-separated git URLs. Cloned read-only into
                        .client-repos/<slug>/<repo-name>/ (gitignored).

Optional:
  --depth full|sample   full = every source file; sample = newest 20 per directory.
                        Default: full.
  --max-tokens N        Soft cap on Anthropic token spend. Default 250000.

Outputs:
  wiki/sources/<date>-<slug>-baseline.md
  wiki/director/specs/<date>-<slug>-foundation-plan.md
  wiki/log.md (single-line append)
  ~/.cache/agix-onboarding/runs/<run_id>.json   (per-run record, written by runtime)
  ~/.cache/agix-onboarding/cursors-<slug>--<repo-name>.json
`);
}

function repoNameFromUrl(url) {
  return url.replace(/\.git$/, '').replace(/[/:]$/, '').split(/[/:]/).pop();
}

function numOrDefault(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function tryParseJson(text) {
  if (!text) return null;
  // Strip JSON fences if the model wrapped them.
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function appendLog(runtime, line) {
  const rel = LOG_REL_PATH;
  let prev = '';
  try { prev = await runtime.readRepoFile(rel); } catch { /* missing */ }
  const next = prev + (prev.endsWith('\n') || !prev ? '' : '\n') + line + '\n';
  await runtime.writeRepoFile(rel, next);
}

function cannedSmokeScorecard() {
  return [
    { dimension: 'Data model',          score: 'Blocker', justification: 'smoke-mode canned response' },
    { dimension: 'Async / job infra',   score: 'Ready',   justification: 'smoke-mode canned response' },
    { dimension: 'Realtime',            score: 'Ready',   justification: 'smoke-mode canned response' },
    { dimension: 'Auth + tenancy',      score: 'Blocker', justification: 'smoke-mode canned response' },
    { dimension: 'Cost control',        score: 'Blocker', justification: 'smoke-mode canned response' },
    { dimension: 'CI/CD + tests',       score: 'Blocker', justification: 'smoke-mode canned response' },
    { dimension: 'Observability',       score: 'Gap',     justification: 'smoke-mode canned response' },
    { dimension: 'Schema validation',   score: 'Ready',   justification: 'smoke-mode canned response' },
    { dimension: 'AI client surface',   score: 'Ready',   justification: 'smoke-mode canned response' },
    { dimension: 'Deploy / hosting',    score: 'Gap',     justification: 'smoke-mode canned response' },
    { dimension: 'Frontend AI surface', score: 'Gap',     justification: 'smoke-mode canned response' },
    { dimension: 'Dependency hygiene',  score: 'Gap',     justification: 'smoke-mode canned response' },
  ];
}
