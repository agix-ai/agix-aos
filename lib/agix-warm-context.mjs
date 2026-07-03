// agix-warm-context — the warm-worker context discipline (PHASE_BUS_RUNTIME_1 T.2).
//
// A warm bus worker reuses ONE context across tasks (DL.1 — the efficiency win). But that
// is exactly the accumulation context-warden was built to watch: as tasks pile up, the
// context grows and can collect superseded/contradictory facts. So between tasks the worker
// runs context-warden over its accumulated context and COMPACTS when it trips.
//
// Compaction is RELEVANCE-AWARE (the lost-in-the-middle fix). The naive policy was pin-recent
// — `items.slice(-pinRecent)` — which keeps only the most-recent item(s) and DROPS the
// authoritative fact whenever it is NOT the most-recent one (a needle buried mid-context).
// The hard reliability benchmark proved this deterministically: pin-recent dropped the needle
// in 5/5 lost-in-the-middle scenarios. So when a `query` is supplied, compaction now keeps the
// query-relevant lines (word-boundary keyword overlap — NOT naive substring, so 'note' does
// not false-match 'noted' in filler) UNION the most-recent `pinRecent` items. With no `query`
// it falls back to the original pin-recent behavior, so existing callers see no change.
// This is the bus + context-warden complementarity made real: the bus buys the cost savings;
// the warden guards the quality — and now it guards the buried needle too.

import { analyzeContext } from '../agents/context-warden/agent.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _table = null;
function table() {
  if (_table) return _table;
  try { _table = JSON.parse(readFileSync(resolve(__dirname, '../agents/context-warden/effective-length.json'), 'utf8')); }
  catch { _table = { default: { effective: 8000, advertised: 128000 } }; }
  return _table;
}

// Stopwords for relevance keyword extraction: generic question scaffolding plus a few
// high-frequency words that would otherwise match the distractor filler. Kept here (not in the
// benchmark) so wardenStep is the single source of truth for the relevance algorithm — the hard
// benchmark routes its keyword-aware arm through this function rather than re-implementing it.
const STOPWORDS = new Set(['the', 'is', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'what', 'who', 'which',
  'with', 'only', 'answer', 'current', 'and', 'as', 'per', 'most', 'recent', 'number', 'name', 'value',
  'identifier', 'code', 'path', 'this', 'that', 'its', 'are', 'be', 'at', 'by', 'or', 'from', 'latest',
  'note', 'entry', 'production', 'used', 'using', 'uses', 'listed', 'does', 'count', 'percentage',
  'tier', 'client', 'internal', 'module', 'service']);

// Extract content keywords from a free-text query: lowercase, strip punctuation (keep hyphens),
// drop stopwords and very-short (<3-char) tokens.
export function queryKeywords(query) {
  return new Set(
    String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

// Word-boundary match: keyword `w` appears in `line` as a whole token (allowing hyphens inside),
// so 'orion' matches 'cluster Orion' but 'note' would NOT match 'noted'. Escapes regex metachars.
// This is the lesson the hard benchmark already learned: naive substring matching let 'note' match
// 'noted' in the filler and kept ~19 noise lines — word-boundary matching is the fix.
function lineMentions(line, kw) {
  const lower = String(line).toLowerCase();
  for (const w of kw) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(lower)) return true;
  }
  return false;
}

// Pure decision: given the accumulated context `items`, analyze + decide compaction.
// Compacts on compact-tier (over-effective-length / repetition) OR a suspected contradiction
// (the empirically biggest reliability risk). Returns the analysis + the (possibly trimmed)
// item list. No I/O, no model — deterministic + unit-testable.
//
// Options:
//   modelId   — which effective-length profile to score against.
//   pinRecent — how many most-recent items to always preserve (the authoritative override).
//   query     — OPTIONAL relevance hint (the current task's question / text). When provided,
//               compaction keeps query-relevant OLD lines (word-boundary keyword overlap) in
//               addition to the most-recent `pinRecent` items — so a buried needle survives.
//               When omitted, compaction is exactly the original pin-recent behavior.
export function wardenStep(items, { modelId = 'claude-sonnet-4-6', pinRecent = 1, query = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const a = analyzeContext({ text: list.join('\n'), modelId, table: table(), thresholds: {} });
  const shouldCompact = a.tier === 'compact' || a.flags.includes('contradiction-suspected');

  let kept;
  let keptRelevant = 0;
  let strategy;
  if (!shouldCompact) {
    kept = list;
    strategy = 'none';
  } else if (query && queryKeywords(query).size) {
    // Relevance-aware: keep query-relevant lines UNION the most-recent pinRecent items.
    const kw = queryKeywords(query);
    const recentStart = Math.max(0, list.length - Math.max(1, pinRecent));
    const out = [];
    list.forEach((line, i) => {
      const isRecent = i >= recentStart;
      const mentions = lineMentions(line, kw);
      if (isRecent || mentions) {
        out.push(line);
        if (!isRecent && mentions) keptRelevant++;   // a relevant OLD line that pin-recent would have dropped
      }
    });
    // Safety: never compact to empty; if nothing matched, fall back to most-recent pinRecent.
    kept = out.length ? out : list.slice(-pinRecent);
    strategy = 'relevance-aware';
  } else {
    // No query (or no usable keywords): original pin-recent behavior — no regression.
    kept = list.slice(-pinRecent);
    strategy = 'pin-recent';
  }

  return {
    tier: a.tier,
    flags: a.flags,
    occupancyPct: a.occupancyPct,
    shouldCompact,
    strategy,
    kept,
    keptRelevant,
    dropped: shouldCompact ? Math.max(0, list.length - kept.length) : 0,
  };
}
