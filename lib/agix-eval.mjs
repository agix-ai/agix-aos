// agix-eval — the agent test harness. Discovers + runs every agent's eval suite
// (`agents/<name>/eval/*.suite.mjs`) so "every new agent gets a test" is enforceable +
// runnable: `agix agent eval <name>`, `agix agent eval --all` (CI gate), `--coverage`.
//
// A suite is a standalone node script that prints an "N/M (P%)" accuracy line and exits
// non-zero on failure (the convention context-warden + sentinel already follow).

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// Eval discovery is INTENTIONALLY scoped to the pack's shipped agents/ — it is a
// marketplace-quality gate (EXPECT_EVAL is all pack agents, `eval --all` is a CI
// gate). USER-generated agents (lib/agix-runtime.mjs userAgentsDir(), discovered
// by listAgents/runAgent/smoke) are deliberately NOT pulled into the pack's
// coverage gate — a user's local agent shouldn't gate the pack's CI. They still
// list / run / smoke; they just don't participate in `agix agent eval --all`.
const AGENTS_DIR = resolve(REPO_ROOT, 'agents');

// The public / free-tier set that MUST carry an effectiveness eval (coverage gate).
export const EXPECT_EVAL = [
  'onboarding', 'sensei', 'architect', 'research',
  'git-orchestrator', 'tester', 'investigator', 'context-warden',
];

export function discoverEvals() {
  const out = [];
  if (!existsSync(AGENTS_DIR)) return out;
  for (const agent of readdirSync(AGENTS_DIR)) {
    const evalDir = resolve(AGENTS_DIR, agent, 'eval');
    if (!existsSync(evalDir) || !statSync(evalDir).isDirectory()) continue;
    for (const f of readdirSync(evalDir)) {
      if (f.endsWith('.suite.mjs')) out.push({ agent, suite: f, path: resolve(evalDir, f) });
    }
  }
  return out;
}

export function runSuite(path) {
  const r = spawnSync('node', [path], { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const acc = (out.match(/(\d+\/\d+)\s*\(\d+%\)/) || [])[0] || null;
  return { path, pass: r.status === 0, exit: r.status, accuracy: acc, output: out };
}

export function runAgentEvals(name) {
  return discoverEvals().filter((e) => e.agent === name).map((e) => ({ ...e, ...runSuite(e.path) }));
}

export function runAllEvals() {
  return discoverEvals().map((e) => ({ ...e, ...runSuite(e.path) }));
}

export function coverageReport() {
  const have = new Set(discoverEvals().map((e) => e.agent));
  return EXPECT_EVAL.map((name) => ({ name, hasEval: have.has(name) }));
}
