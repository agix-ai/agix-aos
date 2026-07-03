// agix-agent-template — the agent scaffolding generator (AGIX.ONBOARD.1 E.3).
//
// This is the recursion / "OS-making" pillar: the AOS makes more of itself. A
// single `agix agent new <name>` call emits a complete, internally-consistent,
// IMMEDIATELY-smoke-green agent — manifest + entry + persona + policy — that a
// human can then flesh out. It is also the marketplace feeder: the four files
// it writes are exactly the shape every shipped agent in `agents/<name>/` carries
// (see agents/context-warden/, agents/sentinel/).
//
// Q4 resolved = TEMPLATE-FIRST. A mentor-assisted generation (the leader agent
// fills core_truths/boundaries from a one-line intent) is the documented
// fast-follow, NOT this. So the four files are deterministic, generic, and
// carry explicit `TODO(you)` markers for the fields a human should sharpen.
//
// The generator is pure-ish and testable: `buildAgentFiles()` returns the
// four file CONTENTS as strings (no disk), and `scaffoldAgent()` writes them to
// a target dir with the guard rails (refuse-existing, slug validation). The
// CLI (`bin/agix` cmdNew) is a thin wrapper over scaffoldAgent().

import { mkdir, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Trust levels mirror the AGA.Soul.1 two-layer model (see agents/*/manifest.yaml
// `soul.trust_level` + agents/*/policy.yaml). The generator only ever scaffolds
// proposer/observer/executor — a `narrator` is a cadence-driven sleep-time
// routine whose shape differs enough that it gets its own (future) template.
export const VALID_TRUST_LEVELS = ['observer', 'proposer', 'executor'];
export const DEFAULT_TRUST_LEVEL = 'proposer';

// A safe agent slug: lowercase letters, digits, single dashes between segments.
// Must start + end with an alphanumeric (no leading/trailing/double dashes).
// This is the same shape the existing agent dirs use (context-warden, git-orchestrator).
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && SLUG_RE.test(name);
}

// Per-trust-level filesystem + bash defaults for the generated policy.yaml.
// These mirror the conventions in the shipped agents:
//   observer → read-only + writes ONLY its own wiki report space
//   proposer → same write surface; proposes plans, never pushes source
//   executor → may write source + commit + push branches (broadest)
function policyDefaultsFor(trust, name) {
  const reportDir = `wiki/${name}/`;
  if (trust === 'observer') {
    return {
      read: ['wiki/', 'architecture/', `agents/${name}/`],
      write: [reportDir],
      deny: ['backend/', 'frontend/', 'agents/*/agent.mjs', '.github/'],
      tools: ['Read', 'Grep', 'Glob', 'Write'],
      // Observers must not push, commit, deploy, or touch secrets.
      bashDeny: [
        'git push',
        'git commit',
        'gh pr merge',
        'gh release (create|edit|upload|delete)',
        'gcloud secrets versions access',
      ],
    };
  }
  if (trust === 'executor') {
    return {
      read: ['agents/', 'lib/', 'bin/', 'wiki/', 'architecture/'],
      // Executor writes source — keep its own report space too, but it is not
      // confined to it. Still deny the highest-risk paths by convention.
      write: [`agents/${name}/`, 'lib/', reportDir],
      deny: ['.github/'],
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Executors may commit + push branches, but never force-push or deploy.
      bashDeny: [
        'git push.*--force',
        'git push.*-f\\b',
        'gcloud run deploy',
        'gcloud secrets versions access',
        'gh pr merge.*--admin',
      ],
    };
  }
  // proposer (default)
  return {
    read: [`agents/${name}/`, 'wiki/', 'architecture/'],
    write: [reportDir],
    deny: ['backend/', 'frontend/', 'agents/*/agent.mjs', '.github/'],
    tools: ['Read', 'Grep', 'Glob', 'Write'],
    bashDeny: [
      'git push',
      'git commit',
      'gh pr merge',
      'gh release (create|edit|upload|delete)',
      'gcloud secrets versions access',
    ],
  };
}

// YAML list helper — emit a block-style list of single-quoted scalars.
function yamlList(items, indent = '    ') {
  if (!items || items.length === 0) return `${indent}[]`;
  return items.map((s) => `${indent}- '${String(s).replace(/'/g, "''")}'`).join('\n');
}
// YAML flow-list helper for the policy file's read/write/deny + tools.allow.
function yamlFlow(items) {
  return '[' + (items || []).map((s) => `"${s}"`).join(', ') + ']';
}

// ─── manifest.yaml ───────────────────────────────────────────────────
function renderManifest({ name, displayName, description, trust }) {
  const truths = [
    `TODO(you): the durable invariant this agent holds across all sessions — what is always true about its job.`,
    `Its output travels as a deterministic data layer plus a narration; a hallucination corrupts the prose, never the verdict (narrator pattern).`,
  ];
  const boundaries = trust === 'executor'
    ? [
        'Never force-pushes, never deploys, never accesses secrets — those are operator-only actions.',
        'TODO(you): the things this agent must NEVER do, stated as hard negatives.',
      ]
    : trust === 'observer'
    ? [
        'Read-only — never edits source, never commits, never pushes; writes ONLY its own report space.',
        'Never echoes a found secret value — reports classification + location only.',
      ]
    : [
        `Proposer — proposes (a plan, a report, a draft); never edits source, commits, or pushes directly (an executor or the operator applies).`,
        'Never echoes a found secret value — reports classification + location only.',
      ];
  // description is double-quoted so a colon in the text (e.g. "TODO(you): …")
  // doesn't break the YAML scalar; embedded double-quotes are escaped.
  const descYaml = `"${String(description).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `name: ${name}
display_name: ${displayName}
description: ${descYaml}

runtime:
  language: nodejs
  node_version: '>=20'
  memory_mb: 512
  timeout_sec: 120

# On-demand by default — invoked via \`agix agent run ${name} --input <...>\`.
# Add a \`schedule:\` block (cron) here to make it a periodic routine.
config:
  # Optional — the deterministic path runs WITHOUT a key (so smoke + no-network
  # runs stay faithful). Only the cost-gated LLM path uses it.
  - ANTHROPIC_API_KEY: optional

outputs:
  - kind: file
    path: wiki/${name}/reports/{{date}}.md

# ─── Soul (soft identity, AGA.Soul.1 two-layer model) ───────────────
soul:
  version: '1.0'
  trust_level: ${trust}        # observer | proposer | executor | narrator
  core_truths:
${yamlList(truths)}
  boundaries:
${yamlList(boundaries)}
  vibe: 'TODO(you): one line describing tone, approach, and disposition.'
  memory_scope: 'wiki/${name}/'
  policy_file: 'agents/${name}/policy.yaml'

defaults:
  # Cost-gated model for any LLM step (kept cheap by default).
  trailing_model: claude-haiku-4-5
  # TODO(you): add tunable knobs your agent reads from manifest.defaults here.
`;
}

// ─── agent.mjs ───────────────────────────────────────────────────────
function renderAgentMjs({ name, displayName }) {
  return `// ${displayName} (agents/${name}/agent.mjs)
//
// Scaffolded by \`agix agent new ${name}\` — the agent-template generator.
// This is a WORKING starting point: it is immediately smoke-green and has a
// minimal real path. Replace the TODO(you) bodies with your agent's logic.
//
// The contract (see lib/agix-runtime.mjs): export an async \`run({ runtime,
// opts, manifest })\`. The runtime supplies every platform surface — the model
// client (runtime.getModel()), file I/O (runtime.writeRepoFile/readRepoFile),
// state (runtime.readState/writeState), the knowledge graph (runtime.getGbrain()),
// notifications, the bus, etc. Agent code never touches ~/.config/agix/ directly.

// ─── Pure core (the testable part) ──────────────────────────────────
// Keep your real logic in pure functions like this so an eval suite under
// agents/${name}/eval/ can unit-test it without a runtime. The generated
// example just echoes a structured summary of the input.
export function analyze({ text = '', opts = {} } = {}) {
  const lines = String(text).split('\\n').filter(Boolean);
  return {
    chars: String(text).length,
    lines: lines.length,
    // TODO(you): replace with the real signal your agent computes.
    summary: lines.length ? lines[0].slice(0, 120) : '(empty input)',
  };
}

// ─── Runner ─────────────────────────────────────────────────────────
export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);

  // ── Smoke short-circuit ──────────────────────────────────────────
  // \`agix agent smoke ${name}\` runs here with runtime.smoke === true. It must
  // return WITHOUT real side effects (no network, no real writes) and print a
  // smoke marker. Verifying the model surface is optional but cheap — the smoke
  // model stub returns a canned response and burns no tokens.
  if (runtime.smoke) {
    const a = analyze({ text: 'smoke check\\nline two', opts });
    const m = runtime.getModel?.();
    if (m) {
      await m.chat({
        capability: 'cheap-classification',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'smoke' }],
        agent: '${name}',
      });
    }
    console.log(\`[smoke] ${name} short-circuit · analysis (lines=\${a.lines}) + model verified\`);
    return { ran: false, smoke: true };
  }

  // ── Real path ────────────────────────────────────────────────────
  // 1. Read input (a file via --input, or inline --text).
  let text = opts.text || '';
  if (opts.input) {
    try { text = await runtime.readRepoFile(opts.input); }
    catch { /* fall through with whatever we have */ }
  }

  // 2. Compute the deterministic signal (the always-on, cheap layer).
  const a = analyze({ text, opts });

  // 3. (Optional) cost-gated LLM step — only when it earns its cost. Guarded so
  //    a no-key / read-only environment still produces the deterministic verdict.
  let narration = null;
  if (opts.narrate && runtime.getModel) {
    try {
      const resp = await runtime.getModel().chat({
        capability: 'cheap-classification',
        model: defaults.trailing_model,
        max_tokens: 200,
        messages: [{ role: 'user', content: \`Summarize in 2-3 lines:\\n\\n\${text.slice(0, 8000)}\` }],
        agent: '${name}',
      });
      narration = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    } catch (err) { narration = \`(narration skipped: \${err.message})\`; }
  }

  // 4. Write a report — BEST-EFFORT (a read-only install must not crash the run;
  //    the verdict is in the return value + printed below regardless).
  const report = renderReport({ date, a, narration });
  let reportPath = null;
  try { reportPath = await runtime.writeRepoFile(\`wiki/${name}/reports/\${date}.md\`, report); }
  catch { /* read-only — verdict still returned */ }

  console.log(\`${name}: \${a.lines} line(s), \${a.chars} char(s)\${reportPath ? ' → ' + reportPath : ''}\`);
  return { ran: true, ...a, reportPath };
}

function renderReport({ date, a, narration }) {
  const lines = [
    \`# ${displayName} report — \${date}\`, '',
    '## Summary', '',
    \`| field | value |\`, \`|---|---|\`,
    \`| lines | \${a.lines} |\`,
    \`| chars | \${a.chars} |\`,
    \`| first line | \${a.summary} |\`, '',
  ];
  if (narration) lines.push('## Narration (cost-gated)', '', narration, '');
  return lines.join('\\n');
}
`;
}

// ─── PERSONA.md ──────────────────────────────────────────────────────
function renderPersona({ name, displayName, description, trust }) {
  const trustLine = {
    observer: 'observer (read-only) · writes only its own report space',
    proposer: 'proposer · proposes plans/reports, never pushes source',
    executor: 'executor · may write source, commit, and push branches',
  }[trust];
  return `# ${displayName}

**Trust:** ${trustLine}

> Scaffolded by \`agix agent new ${name}\`. Replace the TODO(you) sections with your
> agent's real purpose, then sharpen \`manifest.yaml\` (core_truths, boundaries, vibe).

## What it is

${description}

TODO(you): a paragraph on what this agent does and why it exists.

## How it works

- **Deterministic core (\`analyze()\` in \`agent.mjs\`):** the cheap, always-on signal —
  unit-test it under \`agents/${name}/eval/\`.
- **Cost-gated step (optional):** an LLM pass that fires only when it earns its cost
  (\`--narrate\`). The deterministic verdict stands on its own.
- **Output:** a report written to \`wiki/${name}/reports/{{date}}.md\` (best-effort).

## Boundaries

${trust === 'executor'
  ? '- May write source + commit + push branches; NEVER force-pushes, deploys, or accesses secrets.'
  : trust === 'observer'
  ? '- Read-only — never edits source, commits, or pushes; writes ONLY its own report space.'
  : '- Proposer — proposes a report/plan; never edits source, commits, or pushes directly.'}
- Never echoes a found secret value — classification + location only.
- TODO(you): any agent-specific boundaries.
${trust === 'executor'
  ? `
> ⚠ **Executor trust — advisory only.** This agent declares \`executor\`: it
> can write files and run commands on your machine. These boundaries are
> documented intent, NOT a runtime sandbox (v0.2 does not sandbox-enforce
> them — runtime enforcement is on the roadmap, see SECURITY.md). Only run
> executor-trust agents you trust and have reviewed.
`
  : ''}`;
}

// ─── policy.yaml ─────────────────────────────────────────────────────
function renderPolicy({ name, trust }) {
  const p = policyDefaultsFor(trust, name);
  return `# ${name} — advisory policy (AGA.Soul.1 Layer 2).
# Companion to the soul: block in manifest.yaml. Declares the capabilities +
# boundaries this agent SHOULD honor. v0.2 does NOT sandbox-enforce this at
# runtime; runtime enforcement is on the roadmap (see SECURITY.md). This is
# intent, not a guarantee.
agent: ${name}
trust_level: ${trust}

filesystem:
  read:  ${yamlFlow(p.read)}
  write: ${yamlFlow(p.write)}
  deny:  ${yamlFlow(p.deny)}

tools:
  allow: ${yamlFlow(p.tools)}

# ADVISORY ONLY (v0.2). These deny_patterns declare bash commands this agent
# SHOULD NOT run — they document intent, they are NOT sandbox-enforced at
# runtime yet. A runtime enforcement layer is on the roadmap (see SECURITY.md).
# Until then, treat this as a boundary the agent honors, not a guarantee.
bash:
  deny_patterns:
${yamlList(p.bashDeny, '    ')}

inference:
  can_delegate_to: []
  max_tool_calls: 100
`;
}

/**
 * Build the four agent file contents as strings. Pure — no disk I/O.
 * @returns {{ 'manifest.yaml': string, 'agent.mjs': string, 'PERSONA.md': string, 'policy.yaml': string }}
 */
export function buildAgentFiles({ name, trust = DEFAULT_TRUST_LEVEL, description = '' } = {}) {
  if (!isValidSlug(name)) {
    throw new Error(`Invalid agent name "${name}". Use a lowercase slug (letters, digits, single dashes), e.g. "demo-scout".`);
  }
  if (!VALID_TRUST_LEVELS.includes(trust)) {
    throw new Error(`Invalid trust level "${trust}". One of: ${VALID_TRUST_LEVELS.join(', ')}.`);
  }
  const displayName = 'Agix ' + name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  const desc = (description && String(description).trim())
    || `TODO(you): one-line description of what ${name} does. Scaffolded by \`agix agent new\`.`;
  return {
    'manifest.yaml': renderManifest({ name, displayName, description: desc, trust }),
    'agent.mjs': renderAgentMjs({ name, displayName }),
    'PERSONA.md': renderPersona({ name, displayName, description: desc, trust }),
    'policy.yaml': renderPolicy({ name, trust }),
  };
}

/**
 * Scaffold a new agent under <agentsDir>/<name>/ with the four files.
 * Guard rails: refuse if the dir already exists (no clobber); validate the slug.
 *
 * @param {object} args
 * @param {string} args.name        agent slug (validated)
 * @param {string} [args.trust]     observer | proposer | executor (default proposer)
 * @param {string} [args.description]
 * @param {string} args.agentsDir   absolute path to the agents/ root to write under
 * @returns {Promise<{ dir: string, files: string[], name: string, trust: string }>}
 */
export async function scaffoldAgent({ name, trust = DEFAULT_TRUST_LEVEL, description = '', agentsDir } = {}) {
  if (!agentsDir) throw new Error('scaffoldAgent: agentsDir is required.');
  const files = buildAgentFiles({ name, trust, description });   // validates name + trust
  const dir = resolve(agentsDir, name);
  if (existsSync(dir)) {
    throw new Error(`Refusing to clobber: agents/${name}/ already exists at ${dir}. Pick a different name or remove it first.`);
  }
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const [fname, content] of Object.entries(files)) {
    const full = join(dir, fname);
    await writeFile(full, content);
    written.push(full);
  }
  return { dir, files: written, name, trust };
}
