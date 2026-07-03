// agix-slash — the slash-command surface + interactive mode.
//
// `agix` (no args)      → interactive mentor mode: type natural language OR slash commands.
// `agix /<cmd> ...`     → one-shot slash command (scriptable; Claude-Code friendly).
//
// Slash commands are the fast paths; settings SAVE via /settings (agix-settings.mjs).
// Mirrors the CLI_INTERFACE_IDEATION surface. v1 wires the implemented commands and
// clearly marks the runtime-integration follow-ons (auth browser-OAuth, swarm primitive).

import { createInterface } from 'node:readline';
import { listAgents, runAgent, loadAgentManifest } from './agix-runtime.mjs';
import { KNOWN_SETTINGS, loadSettings, setSetting, settingsPath } from './agix-settings.mjs';
import { readSoul, appendLearning, soulPath } from './agix-soul.mjs';

const COMMANDS = {
  '/help':     'show this menu',
  '/settings': 'view/set instance settings  (/settings · /settings set <key> <value> · /settings get <key>)',
  '/agents':   'list your agents (tier-aware)',
  '/run':      'run an agent now  (/run <agent> [--flag value …])',
  '/soul':     'view your instance soul.md or append a learning  (/soul · /soul note "<learning>")',
  '/auth':     'login / whoami / switch org  (browser-OAuth)',
  '/swarm':    'many agents on one task  (/swarm "<task>")',
  '/trust':    'view an agent\'s advisory trust level  (/trust <agent>)',
};

export async function runSlash(parts, { json = false } = {}) {
  const [cmd, ...rest] = parts;
  switch (cmd) {
    case '/help':
    case undefined:
      console.log('Agix slash commands:\n' + Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join('\n') +
        '\n\nIn interactive mode, plain text goes to the mentor; slash commands are the fast paths.');
      return;

    case '/settings': {
      const sub = rest[0];
      if (sub === 'set') { const [, key, ...val] = rest; if (!key || !val.length) return console.error('usage: /settings set <key> <value>'); setSetting(key, val.join(' ')); console.log(`✓ ${key} = ${val.join(' ')}  (saved → ${settingsPath()})`); return; }
      if (sub === 'get') { const v = loadSettings()[rest[1]]; console.log(v === undefined ? '(unset)' : v); return; }
      const s = loadSettings();
      console.log(`Settings (${settingsPath()}):`);
      for (const [k, desc] of Object.entries(KNOWN_SETTINGS)) console.log(`  ${k.padEnd(20)} ${s[k] !== undefined ? String(s[k]) : '(unset)'.padEnd(10)}  — ${desc}`);
      const extra = Object.keys(s).filter((k) => !(k in KNOWN_SETTINGS));
      if (extra.length) { console.log('  (custom):'); for (const k of extra) console.log(`  ${k.padEnd(20)} ${s[k]}`); }
      return;
    }

    case '/agents': {
      const agents = await listAgents();
      const tier = loadSettings().tier || 'basic';
      console.log(`Agents (tier=${tier}):`);
      for (const a of agents) { const d = a.manifest?.description || ''; console.log(`  ${String(a.name).padEnd(20)} ${d ? d.slice(0, 88) + (d.length > 88 ? '…' : '') : ''}`); }
      return;
    }

    case '/run': {
      const [name, ...flags] = rest;
      if (!name) return console.error('usage: /run <agent> [--flag value …]');
      const opts = parseFlags(flags);
      return runAgent(name, opts);
    }

    case '/trust': {
      const name = rest[0];
      if (!name) return console.error('usage: /trust <agent>');
      try {
        const m = await loadAgentManifest(name);
        const lvl = m?.soul?.trust_level || 'unknown';
        console.log(`${name}: trust=${lvl}  (advisory — declared intent, not sandbox-enforced in v0.2)`);
        if (lvl === 'executor') console.log(`  ⚠ executor: can write files + run commands on your machine. Review before running.`);
      } catch { console.error(`no agent: ${name}`); }
      return;
    }

    case '/soul': {
      const sub = rest[0];
      if (sub === 'note') {
        const text = rest.slice(1).join(' ').trim();
        if (!text) return console.error('usage: /soul note "<learning>"');
        const r = appendLearning(text);
        if (r.appended) console.log(`✓ noted${r.createdSection ? ' (started Learnings section)' : ''}: ${r.bullet}`);
        else if (r.deduped) console.log(`· already recorded (no-op): ${r.bullet}`);
        else console.error('nothing to note (empty learning)');
        return;
      }
      const text = readSoul();
      if (!text) return console.log(`No soul yet at ${soulPath()}. Run \`agix init\` to scaffold it.`);
      console.log(text.endsWith('\n') ? text : text + '\n');
      return;
    }

    case '/auth':
      console.log('Browser-OAuth login (CLOUD_AGENT_AUTH.md Lane 2) — the interactive auth surface is the runtime-integration follow-on. For now, agents/CI use the contributor-key lane (AGIX_CONTRIBUTOR_KEY).');
      return;

    case '/swarm':
      console.log(`Swarm (many agents on one task) is specced in AGIX.ONBOARD.1 Phase E (the Ideation-Loop fan-out). Task captured: ${rest.join(' ') || '(none)'} — primitive build is the follow-on.`);
      return;

    default:
      console.error(`Unknown slash command: ${cmd}. Try /help.`);
  }
}

function parseFlags(flags) {
  const o = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i].startsWith('--')) { const k = flags[i].slice(2); const v = flags[i + 1] && !flags[i + 1].startsWith('--') ? flags[++i] : true; o[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; }
  }
  return o;
}

export async function interactive() {
  const name = loadSettings().operator_first_name;
  console.log(`Agix — interactive mode.${name ? ` Welcome back, ${name}.` : ''}  Type /help for commands, plain text for the mentor, /exit to quit.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'agix › ' });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (t === '/exit' || t === '/quit') break;
    if (t.startsWith('/')) { try { await runSlash(t.split(/\s+/)); } catch (e) { console.error(e.message); } }
    else if (t) console.log('(mentor) — the conversational mentor/sensei session is wired at onboarding; for now use slash commands (/help).');
    rl.prompt();
  }
  rl.close();
  console.log('bye.');
}
