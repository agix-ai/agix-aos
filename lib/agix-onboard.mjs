// agix-onboard.mjs — first-run AOS self-setup for a NEW USER (AGIX.ONBOARD.1 Phase D).
//
// This is the AOS onboarding ITSELF onto a new user's machine — NOT the
// client-codebase onboarding agent (agents/onboarding/agent.mjs, which analyzes a
// repo). On first `agix` run we make the package TURNKEY:
//
//   DL.12 — all-inclusive auto-provision: everything provisionable is provisioned
//           with ZERO prompts (gbrain seeded, wiki/ scaffolded, config + soul.md
//           skeleton, default settings). Idempotent + always safe.
//   DL.13 — no API key required: detect an installed CLI agent (Claude Code / Codex)
//           and default the provider to it (subscription auth, no key). An API key is
//           the FALLBACK, never a requirement; missing both never hard-fails provisioning.
//   D.2/D.3 — a brief, OPTIONAL get-to-know-you (name, role, goals/constraints). Only
//           this part + provider reporting is interactive; on non-TTY / --defaults we
//           use neutral placeholders and skip the prompts.
//   D.6 — point to (don't force-launch) the first sensei session.
//
// Orchestration lives here (testable, no process control); bin/agix wires the
// `agix init` command + the first-run auto-trigger around it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { LocalRuntime } from './agix-runtime.mjs';
import { detectCliAgent } from './model-adapters/cli-passthrough.mjs';

// ─── path resolution (override-able for tests) ───────────────────────────
//
// Paths are resolved against $AGIX_CONFIG_DIR or $HOME at CALL time (not module
// load) so a test can redirect HOME / set explicit dirs without import-order games.

function configDir() {
  return process.env.AGIX_CONFIG_DIR || resolve(homedir(), '.config/agix');
}
function onboardedMarkerPath() {
  return resolve(configDir(), '.onboarded');
}
function identityPath() {
  return resolve(configDir(), 'identity.json');
}
function settingsFilePath() {
  return resolve(configDir(), 'settings.json');
}
function soulPath() {
  return resolve(configDir(), 'soul.md');
}

// ─── small fs helpers ─────────────────────────────────────────────────────

function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')) || fallback; } catch { return fallback; }
}
function writeJson(path, obj, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', { mode });
}
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

// ─── isOnboarded ───────────────────────────────────────────────────────────

/**
 * True iff this machine has completed onboarding: the `.onboarded` marker exists
 * AND an identity.json is present. Both are required so a half-provisioned state
 * (e.g. an interrupted run) still re-offers onboarding rather than skipping it.
 */
export function isOnboarded() {
  return existsSync(onboardedMarkerPath()) && existsSync(identityPath());
}

// ─── autoProvision (DL.12 — zero-prompt, idempotent) ─────────────────────────

/**
 * The ALL-INCLUSIVE, ZERO-PROMPT setup. Always safe to run repeatedly; never
 * clobbers an existing identity/soul. Returns a summary of what was created vs
 * already present.
 *
 *   - seed the embedded local gbrain with a starter "getting-started" page so the
 *     knowledge fabric is non-empty (via runtime.getGbrain().putPage)
 *   - scaffold wiki/ under the runtime's writable output root (README + notes/)
 *   - create the config dir + a minimal soul.md skeleton (append-growing, DL.9)
 *   - write a default settings.json if absent
 *
 * @param {{ runtime?: object, dataRoot?: string }} [opts]
 *   runtime  — an existing LocalRuntime (tests inject a smoke runtime); else one is made
 *   dataRoot — explicit writable root for wiki/ (tests). Else runtime.outputRoot().
 */
export function autoProvision({ runtime = null, dataRoot = null } = {}) {
  const rt = runtime || new LocalRuntime({ agentName: 'onboarding' });
  const created = [];
  const skipped = [];

  // 1. Seed the embedded local gbrain (knowledge fabric) — non-empty on first run.
  let gbrainSeeded = false;
  try {
    const g = rt.getGbrain();
    if (!g.getPage('getting-started')) {
      g.putPage({
        slug: 'getting-started',
        title: 'Getting Started with Agix',
        tags: ['onboarding', 'agix'],
        content: [
          'Welcome to Agix — your local agentic operating system.',
          '',
          'This knowledge fabric (gbrain) stores pages with [[wikilinks]], tags, and a',
          'maintained backlink index. Your agents read it for precedent; you grow it as',
          'you work. See the [[Agix Welcome]] page for the basics.',
        ].join('\n'),
      });
      // A second page so the backlink graph is non-trivial out of the box.
      if (!g.getPage('agix-welcome')) {
        g.putPage({
          slug: 'agix-welcome',
          title: 'Agix Welcome',
          tags: ['onboarding'],
          content: 'Start with `agix` (interactive) or `agix agent run sensei`. Linked from [[Getting Started with Agix]].',
        });
      }
      gbrainSeeded = true;
    }
    created.push(gbrainSeeded ? 'gbrain (seeded)' : 'gbrain');
    if (!gbrainSeeded) { created.pop(); skipped.push('gbrain (already seeded)'); }
  } catch (err) {
    // gbrain provisioning must never block onboarding; surface, don't throw.
    skipped.push(`gbrain (skipped: ${err.message})`);
  }

  // 2. Scaffold wiki/ under the writable output root.
  const root = dataRoot || (typeof rt.outputRoot === 'function' ? rt.outputRoot() : process.cwd());
  const wikiDir = resolve(root, 'wiki');
  const wikiReadme = resolve(wikiDir, 'README.md');
  const wikiNotesDir = resolve(wikiDir, 'notes');
  if (!existsSync(wikiReadme)) {
    ensureDir(wikiNotesDir);
    writeFileSync(wikiReadme, [
      '# Your Agix Wiki',
      '',
      'This is your local knowledge base. Drop durable notes, runbooks, and decisions',
      'here as markdown; your agents can read them. Day-to-day session notes go under',
      '`notes/`.',
      '',
      'The knowledge fabric (gbrain) indexes `[[wikilinks]]` and tags across your pages.',
      '',
    ].join('\n'));
    // A starter note so notes/ is non-empty (git/dir-listing friendly).
    const starterNote = resolve(wikiNotesDir, 'welcome.md');
    if (!existsSync(starterNote)) {
      writeFileSync(starterNote, '# Welcome\n\nYour first note. Edit or delete me.\n');
    }
    created.push('wiki/');
  } else {
    skipped.push('wiki/ (already present)');
  }

  // 3. Config dir + minimal soul.md skeleton (append-growing per DL.9).
  ensureDir(configDir());
  const soul = soulPath();
  if (!existsSync(soul)) {
    writeFileSync(soul, [
      '# Agix Instance Soul',
      '',
      '_The append-growing identity of this Agix instance. Your agents read it; it',
      'accretes what the instance learns about you over time (AGIX.ONBOARD.1 Phase E)._',
      '',
      '## Identity',
      '',
      '_Set during onboarding — see `~/.config/agix/identity.json`._',
      '',
      '## North Star',
      '',
      '_What you are trying to build / solve. Filled in during get-to-know-you._',
      '',
      '## Preferences',
      '',
      '- autonomy: ask',
      '- cadence: manual',
      '',
      '## Notes',
      '',
      `_Appended dated notes grow below._`,
      '',
    ].join('\n'), { mode: 0o600 });
    created.push('soul.md');
  } else {
    skipped.push('soul.md (already present)');
  }

  // 3b. Seed the default sensei instance so `agix agent run sensei` works turnkey.
  //     Sensei's loadInstance('agix') requires persona.md + goal-tree-sources.yaml
  //     under <configDir>/sensei/instances/agix/ or it throws. We point the Goal
  //     Tree synthesis at the user's own soul.md (their captured North Star). The
  //     persona is a GENERIC basic-tier mentor — no operator/client specifics.
  //     Idempotent: never clobber an instance the user has customized.
  const instanceDir = resolve(configDir(), 'sensei/instances/agix');
  const personaFile = resolve(instanceDir, 'persona.md');
  const sourcesFile = resolve(instanceDir, 'goal-tree-sources.yaml');
  if (!existsSync(personaFile) || !existsSync(sourcesFile)) {
    ensureDir(instanceDir);
    if (!existsSync(personaFile)) {
      writeFileSync(personaFile, [
        '# Sensei — your strategic mentor',
        '',
        'You are Sensei, the user\'s strategic mentor. You help them clarify and make',
        'progress toward their north star, propose concrete next steps, and coordinate',
        'the agent fleet on their behalf. Be direct and practical — favor a clear next',
        'action over abstract advice. Ground your guidance in what you read from the',
        'user\'s soul.md (their identity + north star) and the wider knowledge fabric.',
        '',
      ].join('\n'));
    }
    if (!existsSync(sourcesFile)) {
      // YAML written as a template string (js-yaml isn't imported in this module;
      // the shape is simple + stable). repo_root is the ABSOLUTE config dir so the
      // synthesis resolves soul.md regardless of the caller's cwd.
      writeFileSync(sourcesFile, [
        '# Auto-seeded at onboarding (basic tier). Points the Goal Tree synthesis at YOUR',
        '# captured north star + identity in soul.md. Edit to add more sources as you grow.',
        `repo_root: ${configDir()}`,
        'north_star:',
        '  - path: soul.md',
        '    section: North Star',
        'context:',
        '  - path: soul.md',
        '',
      ].join('\n'));
    }
    created.push('sensei instance');
  } else {
    skipped.push('sensei instance (already present)');
  }

  // 4. settings.json — MERGE defaults in (chooseWorkspace may have written data_dir
  //    here first). Read existing-or-{}, fill any MISSING default key, write back —
  //    so data_dir is preserved AND the defaults are set. Idempotent.
  const settings = settingsFilePath();
  const settingsExisted = existsSync(settings);
  const current = readJson(settings, {});
  const defaults = { autonomy: 'ask', cadence: 'manual', tier: 'basic' };
  const merged = { ...current };
  for (const [k, v] of Object.entries(defaults)) {
    if (merged[k] === undefined) merged[k] = v;
  }
  writeJson(settings, merged);
  if (!settingsExisted) {
    created.push('settings.json');
  } else {
    skipped.push('settings.json (already present)');
  }

  return { created, skipped, wikiDir, configDir: configDir(), gbrainSeeded };
}

// ─── selectProvider (DL.13 — no API key required) ───────────────────────────

/**
 * Pick the default model provider WITHOUT requiring an API key.
 *
 *   - Privacy-spine "prefer local": if the LOCAL model lane is configured
 *     (AGIX_LOCAL_MODEL_URL + AGIX_LOCAL_MODEL both set), default to provider
 *     `local` and report "using your local model" — no key needed. Checked FIRST.
 *   - Else, if an installed CLI agent is detected (Claude Code / Codex), set
 *     `default_provider` to it and report "using your <label> account" — no key needed.
 *   - Else, if an API key env var is present, default to that provider.
 *   - Else, return a clear, NON-FATAL message telling the user to install a CLI agent
 *     or set a key via `agix /settings set`. Provisioning is NOT blocked either way.
 *
 * @param {{ detect?: () => (string|null) }} [opts] — detect injected for tests.
 * @returns {{ provider: string|null, source: 'local'|'cli'|'api-key'|'none', label: string, key_required: boolean, message: string }}
 */
export function selectProvider({ detect = detectCliAgent } = {}) {
  // Local model lane FIRST (privacy-spine "prefer local"): the model layer routes to
  // a local ollama endpoint when both AGIX_LOCAL_MODEL_URL + AGIX_LOCAL_MODEL are set.
  const localUrl = (process.env.AGIX_LOCAL_MODEL_URL || '').trim();
  const localModel = (process.env.AGIX_LOCAL_MODEL || '').trim();
  if (localUrl && localModel) {
    try { setSettingSafe('default_provider', 'local'); } catch { /* settings write is best-effort */ }
    return {
      provider: 'local',
      source: 'local',
      label: 'local model',
      key_required: false,
      message: `Using your local model (${localModel} via ${localUrl}) — no key needed.`,
    };
  }

  const cli = detect();
  if (cli) {
    const label = cli === 'codex' ? 'OpenAI Codex' : 'Claude Code';
    // Persist as the default provider so every session/agent reads the same choice.
    try { setSettingSafe('default_provider', cli); } catch { /* settings write is best-effort */ }
    return {
      provider: cli,
      source: 'cli',
      label,
      key_required: false,
      message: `Using your ${label} account — no API key needed.`,
    };
  }

  // No CLI agent — fall back to an API key if one is already in the environment.
  const keyed = [
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['OPENAI_API_KEY', 'openai'],
    ['GEMINI_API_KEY', 'gemini'],
  ].find(([envVar]) => process.env[envVar]);
  if (keyed) {
    const [, provider] = keyed;
    try { setSettingSafe('default_provider', provider); } catch { /* best-effort */ }
    return {
      provider,
      source: 'api-key',
      label: provider,
      key_required: true,
      message: `Using the ${provider} API key from your environment.`,
    };
  }

  return {
    provider: null,
    source: 'none',
    label: '(none)',
    key_required: true,
    message:
      'No CLI agent (Claude Code / Codex) detected and no API key set. ' +
      'Install Claude Code or Codex and sign in for zero-key use, or set a key with ' +
      '`agix /settings set default_provider anthropic` plus the matching *.env. ' +
      'Setup continues either way — you can configure this later.',
  };
}

// A settings write that resolves the path at CALL time (test HOME redirect safe).
function setSettingSafe(key, value) {
  const path = settingsFilePath();
  const s = readJson(path, {});
  s[key] = value;
  writeJson(path, s);
}

// ─── getToKnowYou (D.2/D.3 — richer, interactive only on TTY) ────────────────

const PLACEHOLDER_IDENTITY = Object.freeze({
  operator_first_name: '',
  operator_full_name: '',
  role: '',
  goals: '',
  constraints: '',
});

/**
 * Collect a brief, RICHER get-to-know-you: name, role, goals/constraints. Writes to
 * identity.json + appends a dated North Star note to soul.md.
 *
 *   - interactive + TTY → prompt via readline.
 *   - non-interactive / non-TTY / no answers → neutral placeholders, prompts skipped.
 *
 * Never clobbers an existing non-empty identity field (idempotent re-runs preserve
 * what the user already gave). Returns the merged identity.
 *
 * @param {{ interactive?: boolean, answers?: object, isTTY?: boolean }} [opts]
 *   answers — pre-supplied answers (tests / scripted); bypasses prompting.
 */
export async function getToKnowYou({ interactive = true, answers = null, isTTY = process.stdin.isTTY } = {}) {
  const path = identityPath();
  const existing = readJson(path, {});

  let collected = { ...PLACEHOLDER_IDENTITY };
  const canPrompt = interactive && isTTY && !answers;

  if (answers) {
    collected = { ...collected, ...answers };
  } else if (canPrompt) {
    collected = await promptIdentity(existing);
  }
  // else: non-interactive → placeholders only (skip prompting).

  // Merge: keep any existing non-empty field; fill from collected only when missing.
  const merged = { ...existing };
  for (const [k, v] of Object.entries(collected)) {
    const cur = merged[k];
    const hasCur = typeof cur === 'string' && cur.trim();
    const hasNew = typeof v === 'string' && v.trim();
    if (!hasCur && hasNew) merged[k] = v.trim();
  }
  // Derive full name from first name when only the first was given.
  if (!merged.operator_full_name && merged.operator_first_name) {
    merged.operator_full_name = merged.operator_first_name;
  }

  writeJson(path, merged);

  // Append a dated North Star note to soul.md when we learned goals (append-growing).
  const goals = merged.goals;
  if (goals && typeof goals === 'string' && goals.trim() && existsSync(soulPath())) {
    const date = new Date().toISOString().slice(0, 10);
    const name = merged.operator_first_name || 'operator';
    appendFileSync(
      soulPath(),
      `\n### ${date} — onboarding\n- Operator: ${name}${merged.role ? ` (${merged.role})` : ''}\n- North Star: ${goals.trim()}${merged.constraints ? `\n- Constraints: ${merged.constraints.trim()}` : ''}\n`,
    );
  }

  return merged;
}

// readline prompt loop for the get-to-know-you. Each answer is optional (Enter skips).
async function promptIdentity(existing) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, cur) => new Promise((res) => {
    const suffix = cur ? ` [${cur}]` : '';
    rl.question(`${q}${suffix}: `, (a) => res(a.trim()));
  });
  try {
    console.log("\nA few quick questions so your agents know you (press Enter to skip any):");
    const first = await ask('Your first name', existing.operator_first_name);
    const role = await ask('Your role (e.g. founder, engineer)', existing.role);
    const goals = await ask('What are you trying to build or solve', existing.goals);
    const constraints = await ask('Any constraints worth knowing (budget, timeline, stack)', existing.constraints);
    return {
      operator_first_name: first,
      operator_full_name: first,
      role,
      goals,
      constraints,
    };
  } finally {
    rl.close();
  }
}

// ─── chooseWorkspace (pick the visible, user-owned workspace dir) ─────────────

/**
 * Decide WHERE this Agix instance keeps the user's workspace — their wiki/ + the
 * gbrain knowledge fabric — and persist that choice so every later outputRoot()
 * call agrees. This must run BEFORE autoProvision's first outputRoot()/gbrain call.
 *
 * Precedence mirrors runtime.outputRoot():
 *   - $AGIX_DATA_DIR set        → env wins; do NOT prompt, do NOT persist.   source 'env'
 *   - dev checkout (.git)       → repo is the workspace; do NOT prompt
 *                                 (outputRoot forces repoRoot here regardless). 'dev-checkout'
 *   - install, data_dir already → idempotent re-run; use it, no prompt.       'configured'
 *   - install, first time       → prompt (interactive+TTY) or default ~/agix; mkdir +
 *                                 MERGE-persist data_dir into settings.json.    'chosen'
 *
 * @param {{ interactive?: boolean, answers?: object, isTTY?: boolean, runtime?: object }} [opts]
 * @returns {Promise<{ dir: string, source: string, prompted: boolean }>}
 */
export async function chooseWorkspace({
  interactive = true,
  answers = null,
  isTTY = process.stdin.isTTY,
  runtime = null,
} = {}) {
  const rt = runtime || new LocalRuntime({ agentName: 'onboarding' });

  // Env override wins outright — don't prompt, don't persist (outputRoot reads env first).
  if (process.env.AGIX_DATA_DIR) {
    return { dir: resolve(process.env.AGIX_DATA_DIR), source: 'env', prompted: false };
  }

  // Dev checkout: outputRoot() forces repoRoot, so prompting would make a false promise.
  if (existsSync(resolve(rt.repoRoot, '.git'))) {
    return { dir: rt.repoRoot, source: 'dev-checkout', prompted: false };
  }

  // An install. If a workspace was already chosen, honor it (idempotent re-run).
  const settingsPath = settingsFilePath();
  const existing = readJson(settingsPath, {});
  if (typeof existing.data_dir === 'string' && existing.data_dir.trim()) {
    return { dir: expandTilde(existing.data_dir), source: 'configured', prompted: false };
  }

  // First-time install: pick the dir.
  const DEFAULT_WORKSPACE = '~/agix';
  let chosen = DEFAULT_WORKSPACE;
  let prompted = false;
  if (answers && typeof answers.data_dir === 'string' && answers.data_dir.trim()) {
    chosen = answers.data_dir.trim();
  } else if (interactive && isTTY && !answers) {
    chosen = await promptWorkspace(DEFAULT_WORKSPACE);
    prompted = true;
  }
  // else: non-interactive / non-TTY → the visible default ~/agix.

  const dir = expandTilde(chosen);
  ensureDir(dir);

  // MERGE-persist: never clobber other settings keys (provider, tier, etc.).
  const merged = { ...readJson(settingsPath, {}), data_dir: dir };
  writeJson(settingsPath, merged);

  return { dir, source: 'chosen', prompted };
}

// Expand a leading `~` to the user's home dir, then resolve to absolute.
function expandTilde(p) {
  if (typeof p === 'string' && p.startsWith('~')) {
    return resolve(homedir(), p.slice(1).replace(/^[/\\]/, ''));
  }
  return resolve(p);
}

// Single-question readline prompt for the workspace dir (Enter accepts the default).
async function promptWorkspace(def) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) => {
      rl.question(
        `Where should Agix keep your workspace — your wiki and knowledge base? [${def}]: `,
        (a) => res(a.trim()),
      );
    });
    return answer || def;
  } finally {
    rl.close();
  }
}

// ─── runOnboarding (the orchestrator) ────────────────────────────────────────

/**
 * Orchestrate first-run onboarding end to end:
 *   autoProvision → selectProvider → getToKnowYou → write .onboarded marker → summary.
 *
 * @param {{
 *   interactive?: boolean, runtime?: object, dataRoot?: string,
 *   detect?: () => (string|null), answers?: object, isTTY?: boolean,
 *   log?: (line: string) => void,
 * }} [opts]
 * @returns {Promise<object>} a summary object (also printed via log unless quiet).
 */
export async function runOnboarding({
  interactive = true,
  runtime = null,
  dataRoot = null,
  detect = detectCliAgent,
  answers = null,
  isTTY = process.stdin.isTTY,
  log = (line) => console.log(line),
} = {}) {
  // Resolve ONE runtime so chooseWorkspace + autoProvision agree on outputRoot().
  const rt = runtime || new LocalRuntime({ agentName: 'onboarding' });

  // FIRST: pick + persist the visible workspace (data_dir) so it's in settings.json
  // before autoProvision's first outputRoot()/gbrain call resolves the writable root.
  const workspace = await chooseWorkspace({ interactive, answers, isTTY, runtime: rt });

  const provision = autoProvision({ runtime: rt, dataRoot });
  const provider = selectProvider({ detect });
  const identity = await getToKnowYou({ interactive, answers, isTTY });
  writeMarker(provider);

  const name = identity.operator_first_name || 'there';
  const summary = {
    onboarded: true,
    identity,
    provider,
    provision,
    workspace,
    marker: onboardedMarkerPath(),
  };

  // D.6 — point to the first sensei session; don't force a model call.
  log('');
  log(`✓ You're set up${name !== 'there' ? `, ${name}` : ''}. Agix is ready to go.`);
  log(`  Workspace: ${workspace.dir}   (your wiki + knowledge base)`);
  log(`  Provider: ${provider.message}`);
  log(`  Provisioned: ${provision.created.join(', ') || '(all already present)'}`);
  log('');
  log('Next:');
  log('  • `agix`                     — interactive mentor + slash commands');
  log('  • `agix agent run sensei`    — start your first guided sensei session');
  log('  • `agix agent list`          — see your fleet');
  log('');

  return summary;
}

// Write the `.onboarded` marker (records when + the chosen provider for diagnostics).
function writeMarker(provider) {
  const path = onboardedMarkerPath();
  ensureDir(configDir());
  writeFileSync(path, JSON.stringify({
    onboarded_at: new Date().toISOString(),
    provider: provider?.provider || null,
    provider_source: provider?.source || 'none',
  }, null, 2) + '\n', { mode: 0o600 });
  return path;
}

// Exposed for bin/agix's first-run auto-trigger (non-TTY silent provision path).
export { onboardedMarkerPath, configDir as onboardConfigDir };
