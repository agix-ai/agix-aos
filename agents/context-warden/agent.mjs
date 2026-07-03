// Agix Context Warden — context & token manager to help avoid hallucinations.
//
// Thesis (CONTEXT_MANAGER_RESEARCH_AND_SPEC.md): hallucination is substantially a
// CONTEXT failure — models degrade before the window fills, driven by OBSERVABLE
// conditions. So a watcher can intervene before the model loses the thread. The
// denominator is the model's EFFECTIVE length (NoLiMa/RULER), not the advertised window.
//
// Two layers (narrator pattern):
//   LEADING (cheap, always-on, deterministic): occupancy vs effective length,
//     repetition, distractor/duplication density, growth velocity. → analyzeContext()
//     (pure + unit-tested by eval/).
//   TRAILING (cost-gated, LLM, only when leading signals are hot): contradiction/clash.
//   PLANNED (not yet built): critical-fact position (lost-in-the-middle) + grounding
//     similarity — documented for the sidecar follow-on, NOT currently computed.
//
// Modes:
//   agix agent run context-warden --input <file>     → on-demand audit of a context/session
//   (runtime sidecar / per-call interceptor = the runtime-integration follow-on)
//
// Trust: proposer — warns + recommends; only an operator-enabled autonomous mode acts.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ─── LEADING signals — pure, deterministic, unit-tested (the testable core) ──────
export function analyzeContext({ text = '', turns = null, modelId = 'default', table = {}, thresholds = {} } = {}) {
  const warnAt = thresholds.warn_at ?? 0.5;
  const compactAt = thresholds.compact_at ?? 0.8;

  const eff = (table.models?.[modelId] || table.default || { effective: 8000, advertised: 128000 });
  const tokens = estimateTokens(text);
  const occupancyPct = +(tokens / eff.effective).toFixed(3);
  const advertisedPct = +(tokens / eff.advertised).toFixed(3);

  const repetitionRate = ngramRepetition(text, 3);
  const distractorRatio = duplicateLineRatio(text);
  const contradictionMarkers = countContradictionMarkers(text);
  const growthVelocity = Array.isArray(turns) && turns.length > 1
    ? Math.round((estimateTokens(turns.join('\n')) ) / turns.length) : null;

  const flags = [];
  if (occupancyPct >= compactAt) flags.push('over-effective-length');       // hard
  else if (occupancyPct >= warnAt) flags.push('approaching-effective-length'); // soft
  if (repetitionRate >= 0.5) flags.push('repetition-loop');                  // "losing the thread"
  if (distractorRatio >= 0.3) flags.push('distractor-duplication');
  // Deterministic, ALWAYS-ON contradiction screen (fleet #8): a poisoned LOW-occupancy
  // context stays green and never reaches the cost-gated LLM check, yet the empirical
  // quality test showed superseded/contradictory facts are THE destabilizer. Catch the
  // common override markers cheaply here so they surface regardless of tier.
  if (contradictionMarkers > 0) flags.push('contradiction-suspected');
  if (growthVelocity && growthVelocity > eff.effective * 0.25) flags.push('high-growth-velocity');

  const hard = flags.some((f) => ['over-effective-length', 'repetition-loop'].includes(f));
  const tier = hard || occupancyPct >= compactAt ? 'compact'
    : (flags.length || occupancyPct >= warnAt) ? 'amber' : 'green';

  return {
    modelId, tokens, effective: eff.effective, advertised: eff.advertised,
    occupancyPct, advertisedPct, repetitionRate, distractorRatio, contradictionMarkers, growthVelocity,
    flags, tier, recommendations: recommend(flags, tier),
  };
}

// Deterministic contradiction screen — counts OVERRIDE/supersede markers that signal a
// fact was later changed (the "context clash/poisoning" pattern). A cheap leading proxy
// for the cost-gated LLM contradiction check; never a substitute for it.
function countContradictionMarkers(s) {
  const re = /\b(supersed(?:e|es|ed|ing)|rotated to|migrated to|updated to|changed to|corrected to|revised to|no longer\b|actually,? it'?s|scratch that|disregard the (?:above|previous)|overrid(?:e|es|den)|now (?:set to|uses|points to)|was .{1,40}? now)\b/gi;
  return (String(s).match(re) || []).length;
}

function estimateTokens(s) {
  // chars/token varies: English prose ~4, code/JSON ~3, CJK ~1. UNDERCOUNTING is the unsafe
  // direction for a watchdog (it under-warns), so bias conservative + handle dense content.
  s = s || '';
  if (!s) return 0;
  const cjk = (s.match(/[　-鿿가-힯豈-﫿]/g) || []).length; // ~1 token/char
  const rest = s.length - cjk;
  const punct = (s.match(/[{}[\]<>;:=,"'`/\\|]/g) || []).length;
  const dense = rest > 0 && punct / rest > 0.05;        // JSON/code/markup → denser tokenization
  const divisor = dense ? 3.0 : 3.6;                     // conservative vs the naive 4
  return Math.ceil(rest / divisor) + cjk;
}
function ngramRepetition(s, n) {
  const toks = String(s).toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length < n * 2) return 0;
  const grams = [];
  for (let i = 0; i + n <= toks.length; i++) grams.push(toks.slice(i, i + n).join(' '));
  return +(1 - new Set(grams).size / grams.length).toFixed(3);
}
function duplicateLineRatio(s) {
  const lines = String(s).split('\n').map((l) => l.trim()).filter((l) => l.length > 8);
  if (lines.length < 4) return 0;
  return +(1 - new Set(lines).size / lines.length).toFixed(3);
}
function recommend(flags, tier) {
  const r = [];
  if (flags.includes('over-effective-length') || tier === 'compact')
    r.push('Compact: pin critical facts (decisions, open items, task spec) first, then clear oldest tool results — compact early, before the window fills.');
  if (flags.includes('approaching-effective-length'))
    r.push('Approaching effective length — prepare to compact; flag any single tool output that is a large fraction of the window.');
  if (flags.includes('repetition-loop'))
    r.push('Repetition detected (a "losing the thread" signal) — re-anchor the task + key constraints to the END of the context, or spawn a fresh sub-agent.');
  if (flags.includes('distractor-duplication'))
    r.push('High duplication/distractors — prune duplicates and low-relevance tool results; re-rank rather than append.');
  if (flags.includes('high-growth-velocity'))
    r.push('Context growing fast — offload bulky outputs to the memory tier and keep references (just-in-time retrieval).');
  if (flags.includes('contradiction-suspected'))
    r.push('Possible superseded/contradictory facts (override markers detected) — the empirically biggest reliability risk. Verify which value is CURRENT and pin the authoritative one; consider the LLM contradiction check.');
  if (!r.length) r.push('Healthy — context occupancy and hygiene are within reliable bounds.');
  return r;
}

// ─── On-demand audit runner ──────────────────────────────────────────
export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const modelId = opts.model || defaults.trailing_model || 'default';
  const thresholds = { warn_at: defaults.warn_at, compact_at: defaults.compact_at };

  if (runtime.smoke) {
    const a = analyzeContext({ text: 'hello world '.repeat(50), modelId, table: { default: { effective: 8000, advertised: 128000 } }, thresholds });
    const m = runtime.getModel?.();
    if (m) await m.chat({ capability: 'cheap-classification', max_tokens: 16, messages: [{ role: 'user', content: 'smoke' }], agent: 'context-warden' });
    console.log(`[smoke] context-warden short-circuit · analysis (tier=${a.tier}) + model verified`);
    return { audited: false, smoke: true };
  }

  // Load the context/session to audit + the effective-length table.
  let text = opts.text || '';
  if (opts.input) { try { text = await readFile(resolve(runtime.repoRoot, opts.input), 'utf8'); } catch { /* fall through */ } }
  let table = {};
  try { table = JSON.parse(await runtime.readRepoFile(defaults.effective_length_table)); } catch { table = { default: { effective: 8000, advertised: 128000 } }; }

  const a = analyzeContext({ text, modelId, table, thresholds });

  // TRAILING (cost-gated): only when leading signals are hot + a model is available.
  let trailing = null;
  if (a.tier !== 'green' && runtime.getModel) {
    try {
      const resp = await runtime.getModel().chat({
        capability: 'cheap-classification', model: defaults.trailing_model, max_tokens: 300,
        messages: [{ role: 'user', content: `Does the following context contain internal contradictions or a fact that is later overridden (a "context clash/poisoning" risk)? Answer in 2-3 lines, citing the conflict if any.\n\n${text.slice(0, 12000)}` }],
        agent: 'context-warden',
      });
      trailing = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    } catch (err) { trailing = `(trailing check skipped: ${err.message})`; }
  }

  const report = renderReport({ date, a, trailing });
  // Report write + notification are BEST-EFFORT — a standalone/read-only runtime (e.g. a
  // brew install dir, no registered notification surface) must not crash the audit; the
  // verdict is in the return value + printed below regardless.
  let reportPath = null;
  try { reportPath = await runtime.writeRepoFile(`wiki/context-warden/audits/${date}.md`, report); } catch { /* read-only — verdict still returned */ }
  if (a.tier === 'compact' && runtime.sendNotification) {
    try { await runtime.sendNotification({ severity: 'warning', what: 'degradation_risk_high', summary: `Context warden: ${a.tier} — ${Math.round(a.occupancyPct * 100)}% of effective length, flags: ${a.flags.join(', ') || 'none'}`, link: reportPath }); } catch { /* no surface registered — best-effort */ }
  }
  console.log(`context-warden: ${a.tier} · ${Math.round(a.occupancyPct * 100)}% of effective length · flags: ${a.flags.join(', ') || 'none'}`);
  for (const r of a.recommendations) console.log(`  → ${r}`);
  return { audited: true, tier: a.tier, occupancyPct: a.occupancyPct, flags: a.flags, reportPath };
}

function renderReport({ date, a, trailing }) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [
    `# Context Warden audit — ${date}`, '',
    '## TL;DR', '', '> [narration]', '',
    `**Tier: ${a.tier === 'green' ? '✅ green' : a.tier === 'amber' ? '🟡 amber' : '🔴 compact'}** · ${a.tokens} tokens ≈ **${pct(a.occupancyPct)} of effective length** (${a.effective}, model ${a.modelId}) · ${pct(a.advertisedPct)} of advertised`, '',
    '## Leading signals', '',
    `| signal | value |`, `|---|---|`,
    `| occupancy (of effective length) | ${pct(a.occupancyPct)} |`,
    `| repetition rate | ${pct(a.repetitionRate)} |`,
    `| duplication/distractor ratio | ${pct(a.distractorRatio)} |`,
    `| growth velocity | ${a.growthVelocity ?? 'n/a'} tok/turn |`,
    `| flags | ${a.flags.join(', ') || 'none'} |`, '',
    '## Recommendations (proposer — not auto-applied)', '',
    ...a.recommendations.map((r) => `- ${r}`), '',
  ];
  if (trailing) lines.push('## Trailing check — contradiction/clash (cost-gated)', '', `> faithfulness flags mean "verify", not "false".`, '', trailing, '');
  return lines.join('\n');
}
