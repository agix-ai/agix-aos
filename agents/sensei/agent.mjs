// Agix Sensei — strategic-mentor agent.
//
// Invoked via `agix agent run sensei <mode> [flags]`. Six modes:
//
//   brief    Daily briefing — synthesize Goal Tree, observe yesterday's
//            commits + briefs + secretary runs, compose strategic briefing
//            via Opus, write to wiki/sensei-journal/<YYYY-MM>.md, optionally
//            email the operator (`--send`).
//   chat     Interactive REPL strategic check-in.
//   plan     Bounded plan-mode REPL — Sensei proposes doc edits, operator
//            commits atomically with `/commit "msg"` or aborts with `/abort`.
//   review   One-shot strategic-alignment review of a doc/spec. Loads Goal
//            Tree + activity, reads the target file, returns a structured
//            review. Used pre-commit on foundational doc changes:
//              `agix agent run sensei review --file <path> [--section <h>]`
//   session  Session tracker — `start <name>` / `end` / `status`.
//   goals    Dump synthesized Goal Tree as JSON (debugging).
//
// All five modes go through the unified runtime (lib/agix-runtime.mjs)
// for: Model protocol client, email send (`brief --send`), inter-agent
// fires (chat/plan `/fire` command), file paths. No direct google-auth-
// library usage — no Workspace API surface.
//
// Spec: architecture/03-ai-ml/agent-architecture/SENSEI_AGENT.md

import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import yaml from 'js-yaml';

import { runAgent } from '../../lib/agix-runtime.mjs';
import { doctor } from '../../lib/agix-fleet.mjs';
import {
  getActiveRole,
  loadRolePolicy,
  loadRolePersona,
  getOperatorEmail,
  assertOperatorAllowed,
  assertEditPathAllowed,
  assertFireAllowed,
  assertGitOperationAllowed,
  RolePolicyError,
} from './lib/role.mjs';

const CONFIG_DIR = resolve(homedir(), '.config/agix');
const SENSEI_INSTANCES_DIR = resolve(CONFIG_DIR, 'sensei/instances');

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const positional = Array.isArray(opts._) ? opts._ : [];
  const mode = positional[0];

  // Smoke short-circuit. Sensei has six real modes; under smoke we
  // want to validate the model surface (one ledger line per capability
  // the real run would hit — AC-MP-09) without entering an interactive
  // REPL, shelling git, or writing to the journal. Mirror the Secretary
  // pattern: loop the two capabilities Sensei actually uses (cheap-
  // classification for the Goal Tree synthesis, long-context for
  // strategic reasoning), then return a synthetic envelope. Runs even
  // when no mode is supplied (the smoke entrypoint passes `_: []`),
  // because the smoke contract is "exercise the surfaces" not "preview
  // the help text."
  if (runtime.smoke) {
    const smokeModel = runtime.getModel();
    for (const capability of ['cheap-classification', 'long-context']) {
      await smokeModel.chat({
        capability,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'smoke' }],
        agent: 'sensei',
      });
    }
    console.log(`[smoke] sensei short-circuit · model verified`);
    return { mode: mode || null, smoke: true };
  }

  if (!mode) {
    printHelp();
    return { mode: null };
  }

  // ─── Role-channeling (Phase 1) ──────────────────────────────────
  // Spec: wiki/concepts/sensei-role-tracks.md
  // Default role=cto preserves the legacy solo-operator flow.
  const role = getActiveRole(opts);
  const policy = await loadRolePolicy(role);
  const persona = await loadRolePersona(role);
  const operatorEmail = getOperatorEmail();
  assertOperatorAllowed(policy, operatorEmail, { smoke: Boolean(runtime.smoke) });

  const ctx = {
    runtime,
    opts,
    manifest,
    defaults,
    positional: positional.slice(1),
    instance: opts.instance || defaults.default_instance || 'agix',
    send: Boolean(opts.send),
    dryRun: Boolean(opts.dryRun),
    summarizeModel: defaults.summarize_model || 'claude-haiku-4-5',
    strategicModel: defaults.strategic_model || 'claude-opus-4-7',
    fireAllowlist: Array.isArray(defaults.fire_allowlist) ? defaults.fire_allowlist : ['research', 'secretary'],
    cacheDir: runtime.cacheDir,
    sessionsDir: resolve(runtime.cacheDir, 'sessions'),
    chatsDir: resolve(runtime.cacheDir, 'chats'),
    // Role-channeling additions:
    role,
    policy,
    persona,
    operatorEmail,
  };

  await mkdir(ctx.sessionsDir, { recursive: true });
  await mkdir(ctx.chatsDir, { recursive: true });
  await mkdir(runtime.resolveRepoPath('wiki/sensei-journal'), { recursive: true });

  switch (mode) {
    case 'brief':   return briefMode(ctx);
    case 'chat':    return chatMode(ctx);
    case 'plan':    return planMode(ctx);
    case 'review':  return reviewMode(ctx);
    case 'session': return sessionMode(ctx);
    case 'goals':   return goalsDump(ctx);
    default:
      console.error(`Unknown mode: ${mode}`);
      printHelp();
      throw new Error(`Unknown sensei mode: ${mode}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// MODES
// ════════════════════════════════════════════════════════════════════

// ─── Mode: brief ─────────────────────────────────────────────────────

async function briefMode(ctx) {
  const instance = await loadInstance(ctx.instance);
  const model = ctx.runtime.getModel();

  console.log(`Sensei (${ctx.instance}) — composing daily briefing…`);
  const goalTree = await synthesizeGoalTree(ctx, model, instance);
  console.log(`  ✓ Goal Tree: ${Object.keys(goalTree).length} top-level sections`);

  const activity = await fetchRecentActivity(ctx);
  console.log(`  ✓ Activity: ${activity.commits.length} commits · ${activity.briefs.length} briefs · ${activity.secretaryRuns} secretary runs`);

  // A7-3 SHIM (until Sensei P0.6 fleet-command-surface lands).
  // Shells out to `agix agent doctor --json` and renders the section
  // structurally in JS (not via the LLM) so the contract is
  // deterministic. When P0.6 lands and Sensei consults Madoguchi
  // + doctor as a first-class capability, replace this shim with the
  // richer integration. The placement (top vs bottom of brief) is the
  // signal: top = something needs attention, bottom = all healthy.
  const fleetHealth = await gatherFleetHealth(ctx);
  console.log(`  ✓ Fleet health: ${fleetHealth.summaryLine}`);

  console.log(`  → Strategic reasoning via ${ctx.strategicModel}…`);
  const composed = await composeBriefing(ctx, model, instance, goalTree, activity);
  const briefing = applyFleetHealthSection(composed, fleetHealth);

  if (ctx.dryRun) {
    console.log('\n────────── BRIEFING (dry-run) ──────────\n');
    console.log(briefing);
    return { mode: 'brief', dryRun: true };
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const journalPath = await appendJournal(ctx, ctx.instance, dateStr, 'brief',
    `Daily briefing composed. ${activity.commits.length} commits scanned, ${activity.briefs.length} briefs surfaced.`,
    briefing);
  console.log(`  ✓ Journal: ${journalPath}`);

  if (ctx.send) {
    const subject = `Agix Sensei — ${dateStr} (${weekdayName()})`;
    try {
      const result = await ctx.runtime.sendEmail({
        toSelf: true,
        subject,
        body: briefing,
        signature: false,
      });
      console.log(`  ✓ Sent to inbox · subject "${subject}"${result.messageId ? ` · ${result.messageId}` : ''}`);
    } catch (err) {
      console.warn(`  ! email send failed: ${err.message}; printing instead.`);
      console.log('\n' + briefing);
    }
  } else {
    console.log('\n────────── BRIEFING ──────────\n');
    console.log(briefing);
    console.log('\n(Pass --send to email via lib/agix-send.mjs.)');
  }

  return { mode: 'brief', sent: ctx.send, journalPath };
}

// ─── Mode: chat ──────────────────────────────────────────────────────

async function chatMode(ctx) {
  const instance = await loadInstance(ctx.instance);
  const model = ctx.runtime.getModel();

  console.log(`Sensei (${ctx.instance}) — loading Goal Tree…`);
  const goalTree = await synthesizeGoalTree(ctx, model, instance);
  const activity = await fetchRecentActivity(ctx);
  console.log(`North Star: ${goalTree.north_star?.text || '(missing)'}`);
  console.log(`Type '/help' for commands, '/exit' to leave.\n`);

  const sessionId = `chat-${Date.now()}`;
  const chatLogPath = resolve(ctx.chatsDir, `${sessionId}.jsonl`);
  const history = [];
  const startTime = Date.now();
  let turnCount = 0;
  let agentFires = 0;
  const MAX_AGENT_FIRES = 3;

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const userInput = await rl.question('> ');
      if (!userInput.trim()) continue;
      const trimmed = userInput.trim();

      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/help') {
        console.log('Commands: /journal-entry "<text>", /fire research [--source <name>], /fire secretary [--dry-run], /goals, /exit');
        continue;
      }
      if (trimmed === '/goals') {
        console.log(JSON.stringify(goalTree, null, 2));
        continue;
      }
      if (trimmed.startsWith('/journal-entry ')) {
        const entry = trimmed.slice('/journal-entry '.length).replace(/^["']|["']$/g, '');
        const p = await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'chat-journal', entry, null);
        console.log(`[journaled to ${p}]`);
        continue;
      }
      if (trimmed.startsWith('/fire ')) {
        if (agentFires >= MAX_AGENT_FIRES) {
          console.log(`(fire cap reached: ${MAX_AGENT_FIRES} fires/session; start a fresh chat for more)`);
          continue;
        }
        const cmd = trimmed.slice('/fire '.length);
        console.log(`About to fire: agix agent run ${cmd}`);
        const confirm = await rl.question('Confirm? (y/n) ');
        if (confirm.trim().toLowerCase() === 'y') {
          const result = await fireAgent(ctx, cmd);
          console.log(result);
          agentFires++;
          await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'chat-fire',
            `Fired agent: ${cmd}. Result: ${result.slice(0, 200)}`, null);
        } else {
          console.log('(fire cancelled)');
        }
        continue;
      }

      history.push({ role: 'user', content: userInput });
      turnCount++;
      const sys = buildSystemPrompt(instance, goalTree, activity, 'chat', ctx.persona);
      const resp = await model.chat({
        capability: 'long-context',
        max_tokens: 1500,
        system: sys,
        messages: history,
        thinking: { type: 'adaptive' },
        agent: 'sensei',
      });
      const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
      history.push({ role: 'assistant', content: text });
      console.log('\nSensei:\n' + text + '\n');

      await appendFile(chatLogPath,
        JSON.stringify({ ts: new Date().toISOString(), user: userInput, sensei: text }) + '\n'
      );
    }
  } finally {
    rl.close();
  }

  const durationMin = Math.round((Date.now() - startTime) / 60000);
  const digest = `Chat session · ${turnCount} turns · ${durationMin} min · ${agentFires} agent-fire(s).`;
  await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'chat-summary', digest, null);
  console.log(`\nSession closed. ${digest}`);
  console.log(`Transcript: ${chatLogPath}`);
  return { mode: 'chat', turns: turnCount, durationMin, agentFires };
}

// ─── Fleet health shim (A7-3) ────────────────────────────────────────
//
// Pre-P0.6 bridge between `agix agent doctor --json` and the brief.
// Doctor lives in lib/agix-fleet.mjs; Sensei consumes its JSON here.
// Per the runtime spec's "Doctor's own failure contract": absence of
// the agents array is itself a red flag — fleet unverified is worse
// than fleet has issues.
//
// When Sensei P0.6 (chat-mode-as-fleet-command-surface) lands and
// Madoguchi is built, this shim is replaced by:
//   - madoguchi.status() for "who's running NOW"
//   - doctor for "is each agent installed and healthy"
//   - a unified Fleet Health surface that the Sensei chat consults
//     before any /fire and that brief mode pulls from at compose time.
// Until then, this 40-line shim is enough.

async function gatherFleetHealth(ctx) {
  // Call doctor in-process rather than shelling out. Shelling out hit
  // a Node spawnSync stdout-buffering ceiling at 8KB even with explicit
  // maxBuffer; the in-process call avoids the issue entirely and is
  // faster. Doctor's own failure-mode contract is preserved: catch any
  // throw and surface it as "unverified" — worse than any individual
  // red per SENSEI_AGENT.md § Fleet health behavior.
  let report;
  try {
    report = await doctor({});
  } catch (err) {
    return {
      verified: false,
      doctorFailed: true,
      doctorError: err.message,
      agents: [],
      summaryLine: `! doctor failed: ${err.message}`,
    };
  }

  // Healthy path: classify and summarize
  const reds = report.agents.filter((a) => a.status === 'red');
  const yellows = report.agents.filter((a) => a.status === 'yellow');
  const greens = report.agents.filter((a) => a.status === 'green');
  const skipped = report.agents.filter((a) => a.status === 'skipped');

  let summaryLine;
  if (reds.length === 0 && yellows.length === 0) {
    summaryLine = `all ${greens.length} agents healthy${skipped.length ? ` (${skipped.length} skipped)` : ''}`;
  } else {
    const parts = [];
    if (reds.length) parts.push(`${reds.length} red`);
    if (yellows.length) parts.push(`${yellows.length} yellow`);
    if (greens.length) parts.push(`${greens.length} green`);
    summaryLine = parts.join(', ');
  }
  return {
    verified: true,
    doctorFailed: false,
    agents: report.agents,
    reds,
    yellows,
    greens,
    skipped,
    summary: report.summary,
    summaryLine,
  };
}

function renderFleetHealthSection(fh) {
  // Section title and body shape per SENSEI_AGENT.md §
  // Fleet health behavior. Top-placement signal: only if reds exist
  // OR doctor itself failed. Otherwise a one-line trailer is enough.
  if (fh.doctorFailed) {
    return `## Fleet health\n\n! **Doctor itself failed** — fleet is unverified. ${fh.doctorError}\n\nRun \`agix agent doctor\` to investigate.\n`;
  }
  if (fh.reds.length === 0 && fh.yellows.length === 0) {
    return `## Fleet health\n\nAll ${fh.greens.length} agents healthy${fh.skipped.length ? ` · ${fh.skipped.length} skipped (no schedule)` : ''}.\n`;
  }
  const lines = ['## Fleet health', ''];
  if (fh.reds.length) {
    lines.push(`**${fh.reds.length} agent${fh.reds.length === 1 ? '' : 's'} red** — needs attention:`);
    lines.push('');
    for (const a of fh.reds) {
      const failedChecks = a.checks.filter((c) => c.status === 'red');
      const firstFailure = failedChecks[0];
      const detail = firstFailure ? `${firstFailure.name}: ${firstFailure.detail}` : '(unspecified)';
      lines.push(`- **${a.agent}** — ${detail}`);
      if (a.remediation) lines.push(`  - Run: \`${a.remediation}\``);
    }
    lines.push('');
  }
  if (fh.yellows.length) {
    lines.push(`${fh.yellows.length} agent${fh.yellows.length === 1 ? '' : 's'} yellow (idle/host-asleep):`);
    for (const a of fh.yellows) lines.push(`- ${a.agent}`);
    lines.push('');
  }
  if (fh.greens.length) {
    lines.push(`${fh.greens.length} agent${fh.greens.length === 1 ? '' : 's'} green.`);
  }
  return lines.join('\n') + '\n';
}

function applyFleetHealthSection(briefing, fh) {
  const section = renderFleetHealthSection(fh);
  // Top-placement: if any agent is red OR doctor failed, the operator
  // can't miss it. Otherwise tail-placement keeps strategic content first.
  const promoteToTop = fh.doctorFailed || fh.reds?.length > 0;
  if (promoteToTop) {
    // Insert after the title line but before the rest of the brief.
    const lines = briefing.split('\n');
    const titleIdx = lines.findIndex((l) => l.trim().startsWith('# '));
    if (titleIdx === -1) return section + '\n' + briefing;
    // Skip the title and a single date line if present (matches the
    // composeBriefing template: title line + date line at the top).
    let insertAt = titleIdx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() !== '') insertAt++;
    return lines.slice(0, insertAt).join('\n') + '\n\n' + section + lines.slice(insertAt).join('\n');
  }
  // Tail-placement: append before any trailing whitespace.
  return briefing.replace(/\s*$/, '\n\n') + section;
}

// ─── Mode: review ────────────────────────────────────────────────────
//
// One-shot strategic-alignment review of a doc/spec. Loads Sensei's
// Goal Tree + recent activity (same context as brief/chat), reads the
// target file (and optional section), and asks Opus for a structured
// review: alignment with North Star, sequencing concerns, scope drift,
// missing pieces, things that look right. Writes to the journal under
// `doc-review` kind and prints to stdout. Pre-commit checkpoint for
// foundational doc changes.
//
//   agix agent run sensei review --file <path> [--section <header>]
//                                [--no-journal] [--instance <name>]

async function reviewMode(ctx) {
  const filePath = ctx.opts.file || ctx.positional[0];
  if (!filePath) {
    throw new Error('Usage: agix agent run sensei review --file <path> [--section <header>]');
  }
  const absPath = filePath.startsWith('/') ? filePath : resolve(ctx.runtime.repoRoot, filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const fullDoc = await readFile(absPath, 'utf8');
  const sectionHeader = ctx.opts.section || null;
  const focusBlock = sectionHeader ? extractSection(fullDoc, sectionHeader) : null;

  const instance = await loadInstance(ctx.instance);
  const model = ctx.runtime.getModel();

  console.log(`Sensei (${ctx.instance}) — strategic review of ${filePath}${sectionHeader ? ` § "${sectionHeader}"` : ''}…`);
  const goalTree = await synthesizeGoalTree(ctx, model, instance);
  const activity = await fetchRecentActivity(ctx);
  console.log(`  ✓ Goal Tree loaded · ${activity.commits.length} recent commits in context`);
  console.log(`  → Strategic reasoning via ${ctx.strategicModel}…`);

  const sys = buildSystemPrompt(instance, goalTree, activity, 'review', ctx.persona);
  const userMsg = composeReviewRequest({
    filePath,
    fullDoc,
    sectionHeader,
    focusBlock,
  });

  const resp = await model.chat({
    capability: 'long-context',
    max_tokens: 4000,
    system: sys,
    messages: [{ role: 'user', content: userMsg }],
    thinking: { type: 'adaptive' },
    agent: 'sensei',
  });
  const review = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();

  const header = `\n# Sensei Strategic Review — ${filePath}${sectionHeader ? ` § ${sectionHeader}` : ''}\n_${new Date().toISOString()} · model: ${ctx.strategicModel}_\n\n`;
  process.stdout.write(header + review + '\n');

  if (ctx.opts.journal !== false) {
    const summary = `Reviewed ${filePath}${sectionHeader ? ` § ${sectionHeader}` : ''}.`;
    const dateStr = new Date().toISOString().slice(0, 10);
    const journalPath = await appendJournal(ctx, ctx.instance, dateStr, 'doc-review', summary, review);
    console.log(`\n✓ Journaled to ${journalPath}`);
  }

  return { mode: 'review', filePath, sectionHeader, model: ctx.strategicModel, reviewChars: review.length };
}

function extractSection(doc, header) {
  // Find a markdown heading line matching `header` (case-insensitive, ignoring
  // leading `#`s and surrounding whitespace), then capture everything up to
  // the next heading of equal or shallower depth. If not found, return null
  // and the caller falls back to the whole doc.
  const lines = doc.split('\n');
  const want = header.replace(/^#+\s*/, '').trim().toLowerCase();
  let startIdx = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+(.*)$/);
    if (!m) continue;
    if (m[2].trim().toLowerCase() === want) {
      startIdx = i;
      startDepth = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+/);
    if (m && m[1].length <= startDepth) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

function composeReviewRequest({ filePath, fullDoc, sectionHeader, focusBlock }) {
  const wholeDocFenced = '```markdown\n' + fullDoc + '\n```';
  const focusFenced = focusBlock ? '```markdown\n' + focusBlock + '\n```' : null;
  const focusInstruction = sectionHeader
    ? `The operator is asking you to review the section "${sectionHeader}" specifically. The rest of the document is shown for context — anchor your review on this section.`
    : `The operator is asking you to review the whole document.`;
  return `I want your strategic-alignment review of the following document before I commit it.

File: \`${filePath}\`

${focusInstruction}

${focusFenced ? `## Section under review\n\n${focusFenced}\n\n## Full document context\n\n${wholeDocFenced}` : `## Document under review\n\n${wholeDocFenced}`}

Please give me a review with these sections (be direct, opinionated, evidence-based — reference the Goal Tree where relevant):

1. **Alignment with the North Star** — does this advance the strategic compass, or drift from it? Where does it land on the Agix mission to *install AI foundations the enterprise owns and grows*?
2. **Sequencing concerns** — is this the right thing to be building this week, given the Goal Tree's active priorities? What does it displace? What should it be sequenced behind?
3. **Scope critique** — too narrow? Too broad? Right shape but wrong size? Be specific about which parts are over/under-scoped.
4. **Strengths worth keeping** — what's genuinely well-conceived; what would I lose by cutting it back?
5. **Missing pieces or unaddressed risks** — what's the spec silent on that will bite later?
6. **Verdict** — one of: \`ship as-is\`, \`ship with the named revisions below\`, \`hold for a rethink\`. Make the call.

Reference specific quoted lines from the doc when you push back. Don't summarize the doc back to me — I wrote it. Land the review under 1000 words.`;
}

// ─── Mode: plan ──────────────────────────────────────────────────────

async function planMode(ctx) {
  const instance = await loadInstance(ctx.instance);
  const model = ctx.runtime.getModel();

  console.log(`Sensei (${ctx.instance}) — entering PLAN MODE…`);
  console.log(`In plan mode, foundational doc changes happen here. Atomic commit on /commit; rollback on /abort.\n`);

  const goalTree = await synthesizeGoalTree(ctx, model, instance);
  const activity = await fetchRecentActivity(ctx);
  console.log(`Goal Tree loaded · ${activity.commits.length} recent commits in context.`);
  console.log(`Type '/help' for plan-mode commands, '/exit' to abort.\n`);

  const sessionId = `plan-${Date.now()}`;
  const chatLogPath = resolve(ctx.chatsDir, `${sessionId}.jsonl`);
  const proposedEdits = [];
  const history = [];

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const userInput = await rl.question('plan> ');
      if (!userInput.trim()) continue;
      const trimmed = userInput.trim();

      if (trimmed === '/exit' || trimmed === '/abort') {
        if (proposedEdits.length > 0) {
          const confirm = await rl.question(`Abort with ${proposedEdits.length} pending edit(s) discarded? (y/n) `);
          if (confirm.trim().toLowerCase() !== 'y') continue;
        }
        console.log('Plan session aborted. No changes committed.');
        return { mode: 'plan', aborted: true };
      }
      if (trimmed === '/help') {
        console.log('Plan-mode commands:');
        console.log('  /list                 List currently proposed edits');
        console.log('  /diff <n>             Show full diff for edit n');
        console.log('  /drop <n>             Drop edit n from the plan');
        console.log('  /commit "<message>"   Apply all edits atomically + commit with sensei: prefix');
        console.log('  /abort                Discard all pending edits');
        console.log('  /exit                 Same as /abort');
        continue;
      }
      if (trimmed === '/list') {
        if (proposedEdits.length === 0) { console.log('(no edits proposed yet)'); continue; }
        proposedEdits.forEach((e, i) => console.log(`  [${i + 1}] ${e.path} — ${e.rationale}`));
        continue;
      }
      if (trimmed.startsWith('/diff ')) {
        const n = parseInt(trimmed.slice('/diff '.length), 10);
        const edit = proposedEdits[n - 1];
        if (!edit) { console.log(`(no edit at index ${n})`); continue; }
        console.log(`\n=== Edit ${n}: ${edit.path} ===`);
        console.log(`Rationale: ${edit.rationale}\n`);
        console.log('--- OLD ---');
        console.log(edit.oldText);
        console.log('--- NEW ---');
        console.log(edit.newText);
        console.log('===\n');
        continue;
      }
      if (trimmed.startsWith('/drop ')) {
        const n = parseInt(trimmed.slice('/drop '.length), 10);
        if (n < 1 || n > proposedEdits.length) { console.log(`(no edit at index ${n})`); continue; }
        const dropped = proposedEdits.splice(n - 1, 1)[0];
        console.log(`Dropped edit ${n}: ${dropped.path}`);
        continue;
      }
      if (trimmed.startsWith('/commit ')) {
        if (proposedEdits.length === 0) { console.log('(no edits to commit)'); continue; }
        const message = trimmed.slice('/commit '.length).replace(/^["']|["']$/g, '');
        const result = await applyAndCommitPlan(ctx, proposedEdits, message);
        console.log(result);
        await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'plan-commit',
          `Plan session committed: ${message}. ${proposedEdits.length} files changed.`, null);
        return { mode: 'plan', committed: true, edits: proposedEdits.length };
      }

      history.push({ role: 'user', content: userInput });
      const sys = buildSystemPrompt(instance, goalTree, activity, 'plan', ctx.persona);
      const fullPrompt = `${userInput}\n\nIf you want to propose a doc edit, respond with a JSON block of the form:
\`\`\`json
{"propose_edit": {"path": "<repo-relative path>", "search": "<exact text to replace>", "replace": "<new text>", "rationale": "<why>"}}
\`\`\`
Otherwise, respond conversationally. You can propose at most one edit per turn.`;
      const resp = await model.chat({
        capability: 'long-context',
        max_tokens: 3000,
        system: sys,
        messages: [...history.slice(0, -1), { role: 'user', content: fullPrompt }],
        thinking: { type: 'adaptive' },
        agent: 'sensei',
      });
      const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
      history.push({ role: 'assistant', content: text });

      const editMatch = text.match(/\{[\s\S]*"propose_edit"[\s\S]*\}/);
      if (editMatch) {
        try {
          const parsed = JSON.parse(editMatch[0]);
          const e = parsed.propose_edit;
          const absPath = ctx.runtime.resolveRepoPath(e.path);
          if (!existsSync(absPath)) {
            console.log('\nSensei:\n' + text + '\n');
            console.log(`(! proposed edit references missing file: ${e.path})`);
            continue;
          }
          const fileContent = await readFile(absPath, 'utf8');
          if (!fileContent.includes(e.search)) {
            console.log('\nSensei:\n' + text + '\n');
            console.log(`(! proposed edit's search text not found in ${e.path} verbatim — manual review needed)`);
            continue;
          }
          try {
            assertEditPathAllowed(ctx.policy, e.path);
          } catch (err) {
            if (err instanceof RolePolicyError) {
              console.log('\nSensei:\n' + text + '\n');
              console.log(`(! role "${ctx.role}" cannot edit ${e.path}: ${err.message})`);
              continue;
            }
            throw err;
          }
          const newContent = fileContent.replace(e.search, e.replace);
          proposedEdits.push({
            path: e.path,
            oldText: e.search,
            newText: e.replace,
            rationale: e.rationale,
            absPath,
            fullOld: fileContent,
            fullNew: newContent,
          });
          console.log('\nSensei:\n' + text + '\n');
          console.log(`(✓ Edit ${proposedEdits.length} staged. Use /diff ${proposedEdits.length} to review, /commit "msg" to apply all.)\n`);
        } catch (err) {
          console.log('\nSensei:\n' + text + '\n');
          console.log(`(! could not parse proposed edit: ${err.message})`);
        }
      } else {
        console.log('\nSensei:\n' + text + '\n');
      }

      await appendFile(chatLogPath,
        JSON.stringify({ ts: new Date().toISOString(), user: userInput, sensei: text }) + '\n'
      );
    }
  } finally {
    rl.close();
  }
}

// ─── Mode: session ───────────────────────────────────────────────────

async function sessionMode(ctx) {
  const sub = ctx.positional[0];
  if (!sub) {
    console.log('Usage: agix agent run sensei session {start <name>|end|status}');
    return { mode: 'session', error: 'missing subcommand' };
  }
  const activePath = resolve(ctx.sessionsDir, 'active.json');
  if (sub === 'start') {
    const name = ctx.positional[1] || 'unnamed';
    const session = { name, started_at: new Date().toISOString(), instance: ctx.instance };
    await writeFile(activePath, JSON.stringify(session, null, 2));
    console.log(`Session started: "${name}" at ${session.started_at}`);
    await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'session-start', `Session "${name}" started`, null);
    return { mode: 'session', action: 'start', name };
  }
  if (sub === 'end') {
    if (!existsSync(activePath)) { console.log('(no active session)'); return { mode: 'session', action: 'end', active: false }; }
    const session = JSON.parse(await readFile(activePath, 'utf8'));
    const start = new Date(session.started_at);
    const duration = Math.round((Date.now() - start.getTime()) / 60000);
    const archivePath = resolve(ctx.sessionsDir, `${session.started_at.replace(/[:.]/g, '-')}-${session.name}.json`);
    await writeFile(archivePath, JSON.stringify({ ...session, ended_at: new Date().toISOString(), duration_minutes: duration }, null, 2));
    await writeFile(activePath, '');
    console.log(`Session "${session.name}" ended · ${duration} min.`);
    await appendJournal(ctx, ctx.instance, new Date().toISOString().slice(0, 10), 'session-end',
      `Session "${session.name}" ended after ${duration} min`, null);
    return { mode: 'session', action: 'end', name: session.name, durationMinutes: duration };
  }
  if (sub === 'status') {
    if (!existsSync(activePath) || (await readFile(activePath, 'utf8')).trim() === '') {
      console.log('(no active session)');
      return { mode: 'session', action: 'status', active: false };
    }
    const session = JSON.parse(await readFile(activePath, 'utf8'));
    const elapsed = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);
    console.log(`Active: "${session.name}" · ${elapsed} min elapsed (since ${session.started_at})`);
    return { mode: 'session', action: 'status', active: true, name: session.name, elapsedMinutes: elapsed };
  }
  console.log(`Unknown session subcommand: ${sub}`);
  return { mode: 'session', error: `unknown subcommand: ${sub}` };
}

// ─── Mode: goals ─────────────────────────────────────────────────────

async function goalsDump(ctx) {
  const instance = await loadInstance(ctx.instance);
  const model = ctx.runtime.getModel();
  const goalTree = await synthesizeGoalTree(ctx, model, instance);
  console.log(JSON.stringify(goalTree, null, 2));
  return { mode: 'goals', tree: goalTree };
}

// ════════════════════════════════════════════════════════════════════
// CORE PRIMITIVES
// ════════════════════════════════════════════════════════════════════

async function loadInstance(name) {
  const dir = resolve(SENSEI_INSTANCES_DIR, name);
  if (!existsSync(dir)) {
    throw new Error(`Instance "${name}" not found at ${dir}. See docs/operations/sensei-setup.md.`);
  }
  const personaPath = resolve(dir, 'persona.md');
  const sourcesPath = resolve(dir, 'goal-tree-sources.yaml');
  if (!existsSync(personaPath)) throw new Error(`Missing ${personaPath}`);
  if (!existsSync(sourcesPath)) throw new Error(`Missing ${sourcesPath}`);
  const persona = await readFile(personaPath, 'utf8');
  const sources = yaml.load(await readFile(sourcesPath, 'utf8'));
  return { name, dir, persona, sources };
}

async function synthesizeGoalTree(ctx, model, instance) {
  const root = instance.sources.repo_root || ctx.runtime.repoRoot;
  const sourceBundles = {};

  for (const [slot, entries] of Object.entries(instance.sources)) {
    if (slot === 'repo_root' || !Array.isArray(entries)) continue;
    sourceBundles[slot] = [];
    for (const entry of entries) {
      try {
        if (entry.path) {
          const abs = resolve(root, entry.path);
          if (existsSync(abs)) {
            const content = await readFile(abs, 'utf8');
            sourceBundles[slot].push({ path: entry.path, section: entry.section, content: content.slice(0, 20000) });
          }
        } else if (entry.glob) {
          const m = entry.glob.match(/^(.+?)\/\*(.+)$/);
          if (m) {
            const dir = resolve(root, m[1]);
            const ext = m[2];
            if (existsSync(dir)) {
              let files = (await readdir(dir)).filter((f) => f.endsWith(ext)).sort().reverse();
              if (entry.last_n) files = files.slice(0, entry.last_n);
              for (const f of files) {
                const content = await readFile(join(dir, f), 'utf8');
                sourceBundles[slot].push({ path: `${m[1]}/${f}`, content: content.slice(0, 8000) });
              }
            }
          }
        }
      } catch {
        // Skip unreadable sources rather than crash
      }
    }
  }

  const sys = `You are synthesizing a Goal Tree for an enterprise's strategic mentor agent. Read the labeled doc bundles below and produce a strict JSON object with this shape:

{
  "north_star": {"text": "<one-sentence mission>", "tagline": "<tagline if any>", "source": "<doc path>"},
  "pillars": [{"name": "...", "source": "..."}, ...],
  "active_workstreams": [{"name": "...", "milestones": [...], "status": "...", "source": "..."}, ...],
  "week_priority": {"text": "<extracted from log top entry>", "source": "..."},
  "research_briefs": [{"path": "...", "headline": "..."}],
  "queued_briefs": [{"path": "...", "headline": "..."}]
}

Rules:
- Copy text verbatim where possible; do not paraphrase the North Star.
- If a slot has no doc bundle, set it to null or [] as appropriate.
- Return strict JSON only, no prose.`;

  const user = Object.entries(sourceBundles)
    .map(([slot, bundles]) => bundles.length === 0 ? `## ${slot}\n(no docs)` : `## ${slot}\n` + bundles.map((b) => `### ${b.path}${b.section ? ` (section: ${b.section})` : ''}\n${b.content}`).join('\n\n'))
    .join('\n\n');

  const resp = await model.chat({
    capability: 'cheap-classification',
    max_tokens: 3000,
    system: sys,
    messages: [{ role: 'user', content: user.slice(0, 80000) }],
    agent: 'sensei',
  });
  const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'Goal Tree synthesis failed to return JSON' };
  try { return JSON.parse(m[0]); } catch { return { error: 'Goal Tree JSON parse failed', raw: text.slice(0, 500) }; }
}

async function fetchRecentActivity(ctx) {
  const repoRoot = ctx.runtime.repoRoot;

  const gitLog = spawnSync('git', ['log', '--since=24.hours', '--pretty=format:%h %s', '--no-merges'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  const commits = (gitLog.stdout || '').split('\n').filter(Boolean).map((l) => ({ line: l }));

  const researchDir = resolve(repoRoot, 'wiki/research');
  let briefs = [];
  if (existsSync(researchDir)) {
    const all = await readdir(researchDir);
    briefs = all.filter((f) => f.endsWith('-brief.md')).sort().reverse().slice(0, 4);
  }

  const secretaryRunsDir = resolve(homedir(), '.cache/agix-secretary/runs');
  let secretaryRuns = 0;
  if (existsSync(secretaryRunsDir)) {
    const files = await readdir(secretaryRunsDir);
    const today = new Date().toISOString().slice(0, 10);
    secretaryRuns = files.filter((f) => f.startsWith(today)).length;
  }

  const wikiLogPath = resolve(repoRoot, 'wiki/log.md');
  let wikiLogTop = '';
  if (existsSync(wikiLogPath)) {
    const content = await readFile(wikiLogPath, 'utf8');
    const lines = content.split('\n');
    const start = lines.findIndex((l) => l.startsWith('## '));
    if (start >= 0) {
      const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
      wikiLogTop = lines.slice(start, end > 0 ? end : start + 40).join('\n');
    }
  }

  const handoffs = await gatherHandoffs(repoRoot);
  const tracks = await gatherWorkstreamTracks(repoRoot);
  const agentRuns = await gatherAgentRunStates();
  const researchOutcomes = await gatherResearchOutcomes(repoRoot);

  return { commits, briefs, secretaryRuns, wikiLogTop, handoffs, tracks, agentRuns, researchOutcomes };
}

// ─── New source helpers (2026-05-16, daily-plan v2) ─────────────────
//
// Sensei's morning brief now also reads handoffs, workstream-track status,
// and per-agent recent activity. The operator asked for a structured daily
// plan that surfaces:
//   - which handoffs are open and parallelizable today
//   - which workstream tracks (Vesper K2, Slice C, Architect Phase 3, etc.)
//     are actionable now per the BUILD_FRAMEWORK decision rule
//   - what each agent did most recently (Curator review, Director queue,
//     Research brief, Secretary briefing, Sprite Agent atlases)

async function gatherHandoffs(repoRoot) {
  const dir = resolve(repoRoot, 'docs/handoffs');
  if (!existsSync(dir)) return [];

  // Last 30 days of handoffs — anything older is stale enough that Sensei
  // shouldn't be planning around it.
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = await readdir(dir);
  const out = [];
  for (const f of all) {
    if (!f.endsWith('.md')) continue;
    const path = join(dir, f);
    let content;
    try { content = await readFile(path, 'utf8'); }
    catch { continue; }

    // Date — from filename if it leads with YYYY-MM-DD, else from frontmatter
    const filenameDate = f.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    const docDate = content.match(/^Date:\s*(\S+)/m)?.[1] || filenameDate;
    if (!docDate) continue;
    const ts = Date.parse(docDate);
    if (Number.isFinite(ts) && ts < thirtyDaysAgo) continue;

    const title = content.match(/^# (.+)$/m)?.[1] || f.replace(/\.md$/, '');
    const owner = content.match(/^Owner:\s*(.+)$/m)?.[1]?.trim();
    const status = content.match(/^Status:\s*`?([^`\n]+)`?/m)?.[1]?.trim();

    // First "Open items" / "What's next" / "What is open" section
    const nextRe = /^##+\s+(open items|what'?s next|what is open|open\s*\/|next.*?)\s*$/im;
    const nextMatch = content.match(nextRe);
    let nextChunk = '';
    if (nextMatch) {
      const startIdx = nextMatch.index + nextMatch[0].length;
      const after = content.slice(startIdx);
      const endIdx = after.search(/\n## /);
      nextChunk = (endIdx === -1 ? after : after.slice(0, endIdx)).trim().slice(0, 600);
    }

    out.push({ file: f, date: docDate, title, owner, status, nextChunk });
  }
  // Newest first.
  out.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  return out.slice(0, 12);
}

async function gatherWorkstreamTracks(repoRoot) {
  const path = resolve(repoRoot, 'docs/framework/BUILD_FRAMEWORK.md');
  if (!existsSync(path)) return { milestones: [], note: 'BUILD_FRAMEWORK.md not found' };

  const content = await readFile(path, 'utf8');

  // Track letter → name, from the §3 Tracks table.
  const trackNames = {};
  const trackTable = content.match(/^## 3\. Tracks[\s\S]*?(?=\n## )/m);
  if (trackTable) {
    for (const line of trackTable[0].split('\n')) {
      const m = line.match(/^\|\s*\*\*([A-Z])\*\*\s*\|\s*([^|]+?)\s*\|/);
      if (m) trackNames[m[1]] = m[2].trim();
    }
  }
  // Tracks added after the §3 table (M/N/O/P, …) are only declared as
  // "### Track X — Name (added …)" headings. Fill any gaps from those.
  for (const m of content.matchAll(/^###\s+Track\s+([A-Z])\s+[—-]\s+(.+)$/gm)) {
    if (!trackNames[m[1]]) {
      trackNames[m[1]] = m[2].replace(/\s*\(added[^)]*\)\s*$/i, '').trim();
    }
  }

  // Find the Status board section table.
  const start = content.search(/^## 5\. Status board/m);
  if (start === -1) return { milestones: [], trackNames, note: '§5 Status board not found' };
  const after = content.slice(start);
  const tableMatch = after.match(/\|\s*ID\s*\|[\s\S]+?(?=\n## )/);
  if (!tableMatch) return { milestones: [], trackNames, note: 'Status board table not parsed' };

  const milestones = [];
  for (const line of tableMatch[0].split('\n')) {
    const m = line.match(/^\|\s*([A-Z]\d+)\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (!m) continue;
    const [, id, status, ownerLink, blockedOn] = m;
    milestones.push({ id, track: id[0], status, ownerLink: ownerLink.trim(), blockedOn: blockedOn.trim() });
  }

  // Apply the decision-rule heuristic: which milestones are actionable now?
  // "Actionable" = status === 'pending' AND blockedOn references only IDs
  // whose status is 'done', or blockedOn is empty (apart from human:* blockers).
  const statusById = Object.fromEntries(milestones.map((m) => [m.id, m.status]));
  const isActionable = (m) => {
    if (m.status !== 'pending') return false;
    if (!m.blockedOn) return true;
    const ids = m.blockedOn.match(/\b[A-Z]\d+\b/g) || [];
    return ids.every((id) => statusById[id] === 'done');
  };
  const actionable = milestones.filter(isActionable);

  // Counts by status for the "where are we" line.
  const counts = milestones.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  // Domain split: a "client" track is a specific external engagement/tenant; everything
  // else is internal production. Configure your own client tracks via the
  // AGIX_CLIENT_TRACKS env var (comma-separated track ids) — defaults to none, so the
  // generic pack treats every track as internal until an operator opts a track in.
  const CLIENT_TRACKS = new Set((process.env.AGIX_CLIENT_TRACKS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const domainOf = (track) => (CLIENT_TRACKS.has(track) ? 'client' : 'internal');

  // In flight = everything currently in_progress, across every track. This
  // is the literal "what is being built right now" the morning update wants.
  const inFlight = milestones
    .filter((m) => m.status === 'in_progress')
    .map((m) => ({ ...m, trackName: trackNames[m.track] || m.track, domain: domainOf(m.track) }));

  // Per-track progress + the next milestone to land.
  const numOf = (id) => Number(id.slice(1));
  const byTrack = {};
  for (const m of milestones) {
    const t = (byTrack[m.track] ||= {
      letter: m.track,
      name: trackNames[m.track] || m.track,
      domain: domainOf(m.track),
      total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0,
      nextMilestone: null,
    });
    t.total++;
    t[m.status] = (t[m.status] || 0) + 1;
  }
  // nextMilestone per track: prefer in_progress, else first actionable
  // pending, else first pending — by milestone number.
  for (const t of Object.values(byTrack)) {
    const inTrack = milestones.filter((m) => m.track === t.letter).sort((a, b) => numOf(a.id) - numOf(b.id));
    const next = inTrack.find((m) => m.status === 'in_progress')
      || inTrack.find((m) => isActionable(m))
      || inTrack.find((m) => m.status === 'pending');
    if (next) {
      t.nextMilestone = { id: next.id, status: next.status, what: (next.ownerLink || '').slice(0, 120), blockedOn: next.blockedOn };
    }
  }

  return { milestones, actionable, counts, trackNames, inFlight, byTrack };
}

async function gatherResearchOutcomes(repoRoot) {
  const dir = resolve(repoRoot, 'wiki/research');
  if (!existsSync(dir)) return null;
  const all = (await readdir(dir)).filter((f) => f.endsWith('-brief.md')).sort().reverse();
  if (!all.length) return null;

  const file = all[0];
  let content;
  try { content = await readFile(resolve(dir, file), 'utf8'); }
  catch { return null; }

  const date = file.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim()
    || content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || file;
  const summary = content.match(/^>\s*(.+)$/m)?.[1]?.trim() || '';

  // Headline findings = the ### item headings, with their "Why for Agix"
  // line when present, so the morning update carries real outcomes rather
  // than just a filename.
  const items = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(.+)$/);
    if (!h) continue;
    let why = '';
    for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
      const w = lines[j].match(/\*\*Why for Agix:\*\*\s*(.+)$/);
      if (w) { why = w[1].trim(); break; }
      if (lines[j].startsWith('### ') || lines[j].startsWith('## ')) break;
    }
    items.push({ headline: h[1].trim(), why });
    if (items.length >= 6) break;
  }

  return { file, date, title, summary, items };
}

async function gatherAgentRunStates() {
  const cacheRoot = resolve(homedir(), '.cache');
  if (!existsSync(cacheRoot)) return [];

  const entries = await readdir(cacheRoot);
  const agentDirs = entries.filter((e) => e.startsWith('agix-') && e !== 'agix');

  const out = [];
  for (const d of agentDirs) {
    const agentName = d.replace(/^agix-/, '');
    const agentDir = resolve(cacheRoot, d);
    let lastRun = null;

    // Common pattern: <agentDir>/runs/ contains dated JSON or markdown files.
    const runsDir = resolve(agentDir, 'runs');
    if (existsSync(runsDir)) {
      try {
        const runs = (await readdir(runsDir)).sort().reverse();
        if (runs.length > 0) lastRun = runs[0];
      } catch { /* skip */ }
    }

    // Director-style: single file at top level (git-custodian.jsonl).
    if (!lastRun) {
      try {
        const files = await readdir(agentDir);
        const interesting = files.filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
        if (interesting.length > 0) lastRun = interesting[0];
      } catch { /* skip */ }
    }

    out.push({ agentName, lastRun });
  }
  return out;
}

async function composeBriefing(ctx, model, instance, goalTree, activity) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const sys = `${instance.persona}

You are composing the DAILY BRIEFING for ${dateStr} (${weekdayName()}).

Output strict markdown following this exact structure. Tag every
"Suggested today-focus" item with (P) if it can run in parallel with
another item on the list, or (S) if it must serialize.

# Agix Sensei — Daily Briefing
${dateStr} · 8:00 AM MST · ${weekdayName()}

## North Star
[verbatim from Goal Tree]

## This week's stated priority
[1-2 sentences extracted from the wiki/log.md top entry]

## Yesterday (last 24h)
- [commit summary, 2-4 bullets]
- [agent runs summary — name which agents fired and what they produced]
- [inbox summary if available]

## Where we are — milestone progress
[Use the MILESTONE PROGRESS context. Two short groups: **Internal Agix
production** first, then **Client production**. Lead each group with one
sentence on momentum (are we moving, stalled, or blocked). Then one line
per track that has any done or in-flight work:
"<Track name>: X/Y done — next: <id> <one short phrase>". Skip tracks
that are 0/Y with nothing in flight unless that track is the obvious next
thing to start. The point is a founder-glanceable "how close are we to
the next milestone, on both the internal product and client delivery."]

## In flight now
[Use the IN FLIGHT NOW context — every milestone whose status is
in_progress, across both domains. This is "what is actively being built
right now." If nothing is in_progress, say so plainly and point at the
single top actionable item instead.]

| Milestone | Track | What it is | Domain |
|---|---|---|---|

## Pending handoffs — what's open today
[Use the HANDOFFS context. Surface up to 6 handoffs from the last 30 days
whose Status is NOT \`shipped\` or whose nextChunk indicates open work.
Format as a table.]

| Handoff | Status | Owner | Next move | Parallelizable with |
|---|---|---|---|---|
[rows; "Parallelizable with" names other open handoffs / tracks that have
no shared files or dependency chain]

## Workstream tracks — actionable now
[Use the TRACKS context. Pull from \`tracks.actionable\` (milestones
whose dependencies are all done). Surface 3-6 top-priority. Apply
the BUILD_FRAMEWORK tiebreak: Track A > E > G > K > F > L > D > H > I > B > C > J.]

| Track | Milestone | What unblocks if this ships |
|---|---|---|

## Workstream snapshot — 6 lenses
For each lens below, write 1-2 sentences referencing concrete activity
or open work. Skip a lens with "(nothing notable today)" if true.

- **Research consumption** — use the RESEARCH OUTCOMES context: name the latest brief's 2-3 concrete findings (the actual technique/finding, not the filename) and, for each, whether it's addressable now and by whom. Flag any finding that maps onto an in-flight or actionable milestone above.
- **Agent improvement + recursive learning** — prompt versions promoted, eval cases added, critic flags from the most recent agent runs
- **North Star dev goals** — the actionable workstream tracks above, prioritized against this week's stated priority
- **Agix website implementations** — commits touching \`apps/website/\` + open handoffs there
- **Backend / runtime build** — commits touching \`agents/\`, \`lib/\`, \`bin/\`, \`launchd/\` + agent-runtime workstreams
- **Operator inbox + comms** — Secretary's most recent briefing if available

## Sensei's read
[2-4 sentences. Direct. Opinionated. Reference one specific doc or brief.
Call out the load-bearing decision the operator should make today.]

## Suggested today-focus
[1-4 numbered items, time-blocked. Tag each with (P) parallel or (S) serial.
Order so items the operator should personally do are first;
agent-handoff-able items (file a brief, fire an agent) are inline.]

## Strategic memory surface
[ONE old decision (>3 days back) worth re-checking. Reference its source.]

## ASK
[1-3 (y/n) asks the operator can ack via CLI, e.g. "Fire <brief-name>?", "Update <doc> with <change>?", "Lock today on <focus item>?"]

Hard rules:
- No em dashes.
- No AI vocabulary (delve, crucial, robust, comprehensive, nuanced).
- Builder-to-builder voice.
- Every doc reference is a backtick \`path\` or markdown link.
- If a section has nothing real to say, write "(nothing notable today)" rather than fabricating.
- Parallelization tags (P/S) are required on every today-focus item.`;

  const handoffsCtx = (activity.handoffs || []).length
    ? activity.handoffs.map((h) => `- ${h.file} | date=${h.date} | status=${h.status || '(none)'} | owner=${h.owner || '(none)'} | next: ${(h.nextChunk || '').replace(/\n/g, ' ').slice(0, 300)}`).join('\n')
    : '(no handoffs in the last 30 days)';

  const tracksCtx = activity.tracks?.milestones?.length
    ? `Total milestones: ${activity.tracks.milestones.length} (${Object.entries(activity.tracks.counts || {}).map(([s, n]) => `${s}: ${n}`).join(', ')})
ACTIONABLE NOW (deps all done, status pending):
${(activity.tracks.actionable || []).map((m) => `  ${m.id} — blockedOn: ${m.blockedOn || '(none)'} — ownerLink: ${m.ownerLink || '(none)'}`).join('\n')}`
    : '(no track data parsed)';

  const agentRunsCtx = (activity.agentRuns || []).length
    ? activity.agentRuns.map((a) => `  ${a.agentName} — last activity: ${a.lastRun || '(no runs)'}`).join('\n')
    : '(no agent run data)';

  // Per-domain milestone progress (internal Agix production vs client
  // production) and the cross-track in-flight list.
  const byTrack = activity.tracks?.byTrack || {};
  const fmtTrackLine = (t) => `  ${t.letter} ${t.name}: ${t.done}/${t.total} done`
    + (t.in_progress ? `, ${t.in_progress} in flight` : '')
    + (t.blocked ? `, ${t.blocked} blocked` : '')
    + (t.nextMilestone ? ` — next: ${t.nextMilestone.id} [${t.nextMilestone.status}]${t.nextMilestone.what ? ` ${t.nextMilestone.what}` : ''}` : '');
  const sortByLetter = (a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0);
  const internalTracks = Object.values(byTrack).filter((t) => t.domain === 'internal').sort(sortByLetter);
  const clientTracks = Object.values(byTrack).filter((t) => t.domain === 'client').sort(sortByLetter);
  const progressCtx = `INTERNAL AGIX PRODUCTION:
${internalTracks.map(fmtTrackLine).join('\n') || '  (no internal track data)'}
CLIENT PRODUCTION:
${clientTracks.map(fmtTrackLine).join('\n') || '  (no client track data)'}`;

  const inFlightCtx = (activity.tracks?.inFlight || []).length
    ? activity.tracks.inFlight.map((m) => `  ${m.id} (${m.trackName}) [${m.domain || 'internal'}]: ${(m.ownerLink || '').replace(/\n/g, ' ').slice(0, 220)}`).join('\n')
    : '(nothing in_progress on the status board)';

  const ro = activity.researchOutcomes;
  const researchCtx = ro
    ? `${ro.title}${ro.date ? ` (${ro.date})` : ''}
${ro.summary ? `Summary: ${ro.summary}` : ''}
Findings:
${(ro.items || []).map((it) => `  - ${it.headline}${it.why ? ` — why for Agix: ${it.why}` : ''}`).join('\n') || '  (no findings parsed)'}`
    : '(no research brief found)';

  const user = `GOAL TREE:
${JSON.stringify(goalTree, null, 2)}

YESTERDAY'S COMMITS (last 24h):
${activity.commits.map((c) => c.line).join('\n') || '(none)'}

RECENT RESEARCH BRIEFS (most recent first):
${activity.briefs.join('\n') || '(none)'}

RESEARCH OUTCOMES (latest brief, extracted):
${researchCtx}

MILESTONE PROGRESS (BUILD_FRAMEWORK §5, by domain):
${progressCtx}

IN FLIGHT NOW (status = in_progress):
${inFlightCtx}

SECRETARY RUNS TODAY: ${activity.secretaryRuns}

PER-AGENT RECENT ACTIVITY:
${agentRunsCtx}

HANDOFFS (last 30 days):
${handoffsCtx}

WORKSTREAM TRACKS (BUILD_FRAMEWORK §5 status board):
${tracksCtx}

WIKI LOG TOP ENTRY:
${activity.wikiLogTop || '(none)'}

Compose the briefing now.`;

  const resp = await model.chat({
    capability: 'long-context',
    max_tokens: 3000,
    system: sys,
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'adaptive' },
    agent: 'sensei',
  });
  return resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

function buildSystemPrompt(instance, goalTree, activity, mode, persona = '') {
  const modeNote = mode === 'plan'
    ? '\nYou are in PLAN MODE. You may propose doc edits as JSON blocks per the per-turn instructions. Be careful, precise; propose at most one edit per turn. Atomicity is the user\'s call via /commit.'
    : mode === 'chat'
      ? '\nYou are in CHAT MODE. Conversational but compact. Reference the Goal Tree as ground truth. Offer to fire agents only when it\'s the obvious next move.'
      : mode === 'review'
        ? '\nYou are in REVIEW MODE. The operator is asking you to assess a foundational doc change against the North Star and the Goal Tree BEFORE it lands. Treat this like an architecture review board. You are not a copyeditor — you are the strategic alignment check. Push back when scope, priorities, or sequencing drift from the Goal Tree. Validate when alignment is strong.'
        : '';
  const personaOverlay = persona ? `${persona}\n\n---\n\n` : '';
  return `${personaOverlay}${instance.persona}${modeNote}

## Current Goal Tree (synthesized from canonical docs)
${JSON.stringify(goalTree, null, 2)}

## Yesterday's activity context
- Commits last 24h: ${activity.commits.length}
- Recent research briefs: ${activity.briefs.join(', ')}
- Secretary runs today: ${activity.secretaryRuns}
`;
}

async function applyAndCommitPlan(ctx, edits, message) {
  // Role policy gate: commit requires explicit allowed: true.
  try {
    assertGitOperationAllowed(ctx.policy, 'commit');
  } catch (err) {
    if (err instanceof RolePolicyError) return `! ${err.message}`;
    throw err;
  }
  for (const e of edits) {
    await writeFile(e.absPath, e.fullNew);
  }
  const stagedPaths = edits.map((e) => e.path);
  const add = spawnSync('git', ['add', ...stagedPaths], { cwd: ctx.runtime.repoRoot, encoding: 'utf8' });
  if (add.status !== 0) {
    return `! git add failed: ${add.stderr}`;
  }
  const fullMessage = `sensei(${ctx.instance} · ${ctx.role}): ${message}\n\nApplied ${edits.length} edit${edits.length === 1 ? '' : 's'} in a ${ctx.role}-mode plan session:\n${edits.map((e, i) => `  ${i + 1}. ${e.path} — ${e.rationale}`).join('\n')}\n\nOperator: ${ctx.operatorEmail || 'unknown'}\nCo-Authored-By: Sensei (${ctx.role}-confirmed) <noreply@example.com>`;
  const commit = spawnSync('git', ['commit', '-m', fullMessage], { cwd: ctx.runtime.repoRoot, encoding: 'utf8' });
  if (commit.status !== 0) {
    return `! git commit failed: ${commit.stderr}`;
  }
  return `✓ Plan committed locally.\n${commit.stdout}\n\nReview with: git show HEAD\nPush when ready: git push origin main`;
}

// fireAgent — chat/plan REPL's /fire command. After the runtime
// migration, sub-agent invocations go through runAgent() rather than
// spawning a child Node process for bin/agix-<X>. The allowlist comes
// from the manifest's defaults.fire_allowlist.
async function fireAgent(ctx, cmd) {
  const tokens = cmd.split(/\s+/);
  const agentName = tokens[0];
  // Role policy narrows the manifest allow-list. The intersection wins.
  try {
    assertFireAllowed(ctx.policy, ctx.fireAllowlist, agentName);
  } catch (err) {
    if (err instanceof RolePolicyError) return `! ${err.message}`;
    throw err;
  }
  // Parse the remaining tokens with the same flag conventions the agix
  // CLI uses. Reuse a tiny inline parser (keeps this self-contained).
  const flagArgs = tokens.slice(1);
  const opts = { _: [] };
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const peek = flagArgs[i + 1];
      if (peek !== undefined && !peek.startsWith('--')) { val = peek; i++; }
      else { val = true; }
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const coerced = (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) ? Number(val) : val;
    opts[camel] = coerced;
    if (key.startsWith('no-') && val === true) {
      opts[key.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false;
    }
  }

  try {
    const result = await runAgent(agentName, opts);
    return `✓ ${agentName} completed. Result: ${JSON.stringify(result).slice(0, 500)}`;
  } catch (err) {
    return `! ${agentName} failed: ${err.message.slice(0, 500)}`;
  }
}

async function appendJournal(ctx, instanceName, dateStr, kind, summary, body) {
  const yearMonth = dateStr.slice(0, 7);
  const journalRelPath = `wiki/sensei-journal/${yearMonth}.md`;
  const journalPath = ctx.runtime.resolveRepoPath(journalRelPath);
  const exists = existsSync(journalPath);
  if (!exists) {
    await ctx.runtime.writeRepoFile(journalRelPath,
      `---\ntitle: Sensei Journal — ${yearMonth}\ntype: sensei-journal\ndomain: agents, strategy\nstatus: active\n---\n\n# Sensei Journal — ${yearMonth}\n\n> Append-only audit log of every Sensei action. One entry per action, most recent first.\n\n`
    );
  }
  const timestamp = new Date().toISOString();
  // Per wiki/concepts/sensei-role-tracks.md § Session log shape, include
  // role in the header when present. Falls back to legacy shape when ctx
  // has no role (smoke-mode calls, defensive default).
  const roleTag = ctx.role ? `${ctx.role} · ` : '';
  const entry = `## ${timestamp} · ${kind} (${roleTag}${instanceName})\n\n${summary}\n${body ? '\n<details>\n<summary>Full output</summary>\n\n```\n' + body.slice(0, 4000) + '\n```\n</details>\n' : ''}\n`;
  const current = await readFile(journalPath, 'utf8');
  const headerEnd = current.indexOf('\n\n> Append-only');
  const insertAfter = headerEnd >= 0 ? current.indexOf('\n\n', headerEnd + 1) + 2 : current.length;
  const next = current.slice(0, insertAfter) + entry + '\n' + current.slice(insertAfter);
  await writeFile(journalPath, next);
  return journalPath;
}

function weekdayName() {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
}

function printHelp() {
  console.log(`Sensei modes (run via \`agix agent run sensei <mode> [flags]\`):

  brief [--send] [--dry-run]    Daily briefing (writes journal; --send emails operator)
  chat                          Interactive strategic check-in REPL
  plan                          Bounded plan session (foundational doc changes)
  review --file <p> [--section <h>] [--no-journal]
                                Strategic-alignment review of a doc/spec (pre-commit gate)
  session start <name>          Mark a focused session beginning
  session end                   Close the active session
  session status                Show active session, if any
  goals                         Dump synthesized Goal Tree as JSON

  --instance <name>             Select a non-default instance (default: agix)

Spec: architecture/03-ai-ml/agent-architecture/SENSEI_AGENT.md
`);
}
