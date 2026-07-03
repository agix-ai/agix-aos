// SPDX-License-Identifier: Apache-2.0
// agix-mentor — the LIVE memory layer for the anticipating-mentor gate.
//
// `agix-mentor-gate.mjs` is the shipped DECISION primitive: given an action and a
// `memory` object {precedentCount, precedentSimilarity, operatorApprovedSimilarWithinDays}
// it returns ask | propose | proceed. Until now those memory values were supplied by
// hand (see mentor-demo.mjs). This module is the layer that DERIVES them from the
// operator's real runtime memory — then calls `decide`.
//
// REAL SURFACE: the gate's inputs are derived from the runtime's memory surfaces.
// Two precedent backends are now real and supported:
//
//   1. `runtime.getGbrain()` (lib/agix-gbrain.mjs) — the embedded local knowledge
//      fabric. PREFERRED when present: it has a real backlink graph, so it can
//      honor the spec's full G1 criterion — ">=3 BACKLINKED precedents within
//      >=0.7 similarity" (architecture/.../MENTOR_LEADER_AGENT.md §2). A precedent
//      page that is referenced by other pages (backlinks) is stronger evidence
//      than a bare keyword hit, and the fabric's `search` returns a bounded [0,1]
//      relevance score the gate's ≥0.7 threshold reads directly.
//
//   2. `runtime.getMemoryStore()` (lib/agix-memory-store.mjs) — the BM25 L0 store.
//      FALLBACK when no gbrain surface is available. Its recall score is an
//      unbounded BM25 value (LEXICAL, corpus-relative), squashed to a bounded
//      proxy below; it has no link graph, so the backlink criterion is dropped
//      (not faked) on this path.
//
// `gatherMemory` resolves the gbrain surface first and uses it when present,
// falling back to the memory store otherwise. The memory-store path's API is:
//
//   store.offload({ text, tags = [], session_id = null, meta = {} }) -> record
//   store.recall({ query, k = 5, tags = [] })                        -> [{ score, ...record }]
//     record = { id, ts, text, tags, session_id, meta }
//     score  = BM25 (Okapi k1=1.5 b=0.75) — LEXICAL, UNBOUNDED, corpus-relative.
//              It is NOT a cosine similarity in [0,1]. We squash it to a bounded
//              proxy below and label the heuristic honestly.
//
// Mapping the gate's three inputs onto this single store:
//
//   G1 precedent (precedentCount / precedentSimilarity)
//     - Prior "precedents" are memory records tagged PRECEDENT_TAG.
//     - recall({ query: action.title, tags: [PRECEDENT_TAG] }) → matching records.
//     - precedentCount    = # of matching records whose proxy-similarity ≥ similarityMin.
//     - precedentSimilarity = the BEST (max) proxy-similarity among qualifiers.
//     - PROXY (documented limitation): the store has no embedding/cosine and no
//       backlink graph. We squash the BM25 score to [0,1) with a monotonic
//       transform `1 - exp(-score / SIM_SCALE)` so the gate's ≥0.7 threshold stays
//       meaningful. This is a HEURISTIC for "match strength", not a true semantic
//       similarity, and the backlink criterion from the spec cannot be evaluated
//       (the store has no link graph) — so it is dropped, not faked.
//
//   G2 recentApproval (operatorApprovedSimilarWithinDays)
//     - Operator approvals are memory records tagged APPROVAL_TAG carrying
//       `meta.approved_at` (ISO ts; falls back to the record's own `ts`).
//     - recall({ query: action.title, tags: [APPROVAL_TAG] }) → similar approvals.
//     - Return the age in days of the MOST RECENT similar approval, or null.
//
// Then `decide(action, memory)` runs UNCHANGED.
//
// Spec: architecture/03-ai-ml/agent-architecture/MENTOR_LEADER_AGENT.md §2 + §5 + §6

import { decide, GATE_DEFAULTS } from './agix-mentor-gate.mjs';
import { recordLearning } from './agix-soul.mjs';

/** Memory-store tag under which prior precedents are recorded. */
export const PRECEDENT_TAG = 'precedent';

/** Memory-store tag under which the mentor records operator approvals of work. */
export const OPERATOR_APPROVAL_TAG = 'operator-approval';

export const GATHER_DEFAULTS = {
  // Pull a few more candidates than the gate threshold so we can filter by
  // similarity and still have a population to count.
  recallK: 12,
  // Below this proxy-similarity a "precedent" is too weak to count. Matches the
  // gate's precedentSimilarityMin so the count and the gate agree.
  similarityMin: GATE_DEFAULTS.precedentSimilarityMin,
  // How many recent approval records to scan.
  approvalScanK: 50,
  // BM25 squash scale (see simProxy). Tuned so a strong multi-term lexical match
  // (BM25 ≈ 3–4 in a small corpus) maps above the 0.7 gate, while a single weak
  // term match (BM25 ≈ 0.7–1.0) stays below it. HEURISTIC — see file header.
  simScale: 2.0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Action → query text ─────────────────────────────────────────────────────

/**
 * Reduce an action to the query text + keyword set we match memory against.
 * Lowercased, stop-word-trimmed tokens of the title.
 */
export function actionKeywords(action) {
  const title = (action?.title || '').toLowerCase();
  const STOP = new Set([
    'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'at',
    'you', 'your', "you've", 'same', 'new', 'as', 'last', 'this', 'that', 'into',
  ]);
  return title
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Squash an unbounded BM25 score into a bounded [0,1) proxy for "match strength".
 * HEURISTIC: the memory store recall is lexical BM25, not a semantic cosine, so
 * this is not a true similarity. Monotonic in `score`, so ranking is preserved and
 * the gate's ≥similarityMin threshold remains meaningful. score ≤ 0 → 0.
 */
export function simProxy(score, scale = GATHER_DEFAULTS.simScale) {
  if (!(score > 0)) return 0;
  return 1 - Math.exp(-score / scale);
}

// ─── memory-store adapter ──────────────────────────────────────────────────────

/**
 * Normalize the runtime memory store from either dependency shape:
 *   - { memoryStore }  — pass the store directly (preferred for tests/demos)
 *   - { runtime }      — pull runtime.getMemoryStore()
 * Returns the store (with .recall) or null if neither is usable.
 */
function resolveStore({ memoryStore, runtime } = {}) {
  if (memoryStore && typeof memoryStore.recall === 'function') return memoryStore;
  if (runtime && typeof runtime.getMemoryStore === 'function') {
    const s = runtime.getMemoryStore();
    if (s && typeof s.recall === 'function') return s;
  }
  return null;
}

/**
 * Normalize the runtime gbrain surface from either dependency shape:
 *   - { gbrain }   — pass the fabric directly (preferred for tests/demos)
 *   - { runtime }  — pull runtime.getGbrain()
 * Returns the fabric (with .search + .getBacklinks) or null if neither is usable.
 */
function resolveGbrain({ gbrain, runtime } = {}) {
  if (gbrain && typeof gbrain.search === 'function' && typeof gbrain.getBacklinks === 'function') return gbrain;
  if (runtime && typeof runtime.getGbrain === 'function') {
    const g = runtime.getGbrain();
    if (g && typeof g.search === 'function' && typeof g.getBacklinks === 'function') return g;
  }
  return null;
}

// ─── G1 (preferred): backlinked precedents from the gbrain knowledge fabric ────────

/**
 * Derive the gate's `precedentCount` + `precedentSimilarity` from the gbrain fabric,
 * honoring the SPEC's full criterion: a qualifying precedent is a page that
 *   (a) ranks ≥ similarityMin in a relevance search against the action title, AND
 *   (b) is BACKLINKED (referenced by at least one other page) — the link-graph
 *       signal the BM25 store cannot express.
 *
 * - count      = number of qualifying (similar AND backlinked) precedent pages.
 * - similarity = the BEST (max) relevance among qualifiers, already in [0,1].
 *
 * @returns {{precedentCount:number, precedentSimilarity:number, precedents:Array}}
 */
export function gatherPrecedentsFromGbrain(action, gbrain, cfg = GATHER_DEFAULTS) {
  const c = { ...GATHER_DEFAULTS, ...cfg };
  const q = (action?.title || '').trim();
  if (!q || !gbrain || typeof gbrain.search !== 'function') {
    return { precedentCount: 0, precedentSimilarity: 0, precedents: [] };
  }
  const hits = gbrain.search(q, { limit: c.recallK }) || [];
  const qualifying = [];
  for (const hit of hits) {
    const similarity = typeof hit.score === 'number' ? hit.score : 0;
    if (similarity < c.similarityMin) continue;
    // Backlink criterion: the precedent must be referenced by ≥1 other page.
    const backlinks = gbrain.getBacklinks(hit.slug) || [];
    if (backlinks.length === 0) continue;
    qualifying.push({ slug: hit.slug, title: hit.title, similarity, backlinks: backlinks.length });
  }
  const precedentSimilarity = qualifying.reduce((m, p) => Math.max(m, p.similarity), 0);
  return { precedentCount: qualifying.length, precedentSimilarity, precedents: qualifying };
}

// ─── G1 (fallback): precedents from the memory store ────────────────────────────────

/**
 * Recall precedents similar to `action` from the memory store and derive the gate's
 * `precedentCount` + `precedentSimilarity`.
 *
 * - count      = number of recalled precedent-tagged records whose proxy-similarity
 *                ≥ similarityMin.
 * - similarity = the BEST (max) qualifying proxy-similarity, in [0,1).
 *
 * @returns {Promise<{precedentCount:number, precedentSimilarity:number, precedents:Array}>}
 */
export async function gatherPrecedents(action, store, cfg = GATHER_DEFAULTS) {
  const c = { ...GATHER_DEFAULTS, ...cfg };
  const q = (action?.title || '').trim();
  if (!q || !store || typeof store.recall !== 'function') {
    return { precedentCount: 0, precedentSimilarity: 0, precedents: [] };
  }

  const hits = (await store.recall({ query: q, k: c.recallK, tags: [PRECEDENT_TAG] })) || [];
  const qualifying = [];
  for (const hit of hits) {
    const similarity = simProxy(typeof hit.score === 'number' ? hit.score : 0, c.simScale);
    if (similarity < c.similarityMin) continue;
    qualifying.push({ id: hit.id, text: hit.text, similarity, score: hit.score });
  }

  const precedentSimilarity = qualifying.reduce((m, p) => Math.max(m, p.similarity), 0);
  return { precedentCount: qualifying.length, precedentSimilarity, precedents: qualifying };
}

// ─── G2: recent operator approval from the memory store ──────────────────────────

/**
 * Recall the most recent operator approval of work SIMILAR to `action` and derive
 * the gate's `operatorApprovedSimilarWithinDays`.
 *
 * Approvals are memory records tagged OPERATOR_APPROVAL_TAG. Each carries:
 *   - text: a short topic line ("approved weekly investor update")
 *   - meta.approved_at: ISO timestamp of the operator's approval (falls back to
 *     the record's own `ts` if absent)
 * "Similar" = the record came back from a lexical recall against the action title
 * (BM25 already enforces token overlap). Returns the age in days of the most recent
 * similar approval, or null if none.
 *
 * @returns {Promise<{operatorApprovedSimilarWithinDays:(number|null), match:object|null}>}
 */
export async function gatherRecentApproval(action, store, { now = Date.now(), scanK = GATHER_DEFAULTS.approvalScanK } = {}) {
  const q = (action?.title || '').trim();
  if (!q || !store || typeof store.recall !== 'function') {
    return { operatorApprovedSimilarWithinDays: null, match: null };
  }

  const hits = (await store.recall({ query: q, k: scanK, tags: [OPERATOR_APPROVAL_TAG] })) || [];
  let best = null; // { ageDays, record }
  for (const rec of hits) {
    const approvedAt = rec.meta?.approved_at || rec.ts;
    if (!approvedAt) continue;
    const ts = Date.parse(approvedAt);
    if (Number.isNaN(ts)) continue;
    const ageDays = Math.max(0, (now - ts) / MS_PER_DAY);
    if (!best || ageDays < best.ageDays) best = { ageDays, record: rec };
  }

  if (!best) return { operatorApprovedSimilarWithinDays: null, match: null };
  return {
    operatorApprovedSimilarWithinDays: Math.round(best.ageDays * 100) / 100,
    match: { text: best.record.text, score: best.record.score, ageDays: best.ageDays },
  };
}

// ─── gatherMemory: the public entry point ──────────────────────────────────────

/**
 * Derive the gate's `memory` object from the LIVE runtime memory surfaces, then
 * run the gate. Precedent backend resolution:
 *   - if a gbrain fabric is resolvable (`{ gbrain }` directly, or `{ runtime }`
 *     exposing `getGbrain()`), use it — full backlinked-precedent criterion.
 *   - else fall back to the BM25 memory store (`{ memoryStore }` directly, or
 *     `{ runtime }` exposing `getMemoryStore()`).
 * Recent-approval (G2) is always derived from the memory store when available.
 *
 * @param {{title:string, reversible:boolean, riskTier:'low'|'med'|'high'}} action
 * @param {{gbrain?:object, memoryStore?:object, runtime?:object}} deps  the live (or smoke) memory surfaces
 * @param {object} [opts]
 * @param {object} [opts.gatherCfg]  overrides for GATHER_DEFAULTS
 * @param {object} [opts.gateCfg]    overrides for GATE_DEFAULTS (passed to decide)
 * @param {number} [opts.now]        clock injection for testability
 * @returns {Promise<{
 *   action:object,
 *   memory:{precedentCount:number, precedentSimilarity:number, operatorApprovedSimilarWithinDays:(number|null)},
 *   decision:object,           // the full decide() result
 *   evidence:{precedents:Array, approvalMatch:(object|null)},
 * }>}
 */
export async function gatherMemory(action, deps = {}, opts = {}) {
  const { gatherCfg = {}, gateCfg = GATE_DEFAULTS, now = Date.now() } = opts;
  const gbrain = resolveGbrain(deps);
  const store = resolveStore(deps);

  // G1 precedent: prefer the gbrain fabric (full backlinked-precedent criterion);
  // fall back to the BM25 memory store when no gbrain surface is available.
  const { precedentCount, precedentSimilarity, precedents, precedentSource } = gbrain
    ? { ...gatherPrecedentsFromGbrain(action, gbrain, gatherCfg), precedentSource: 'gbrain' }
    : { ...(await gatherPrecedents(action, store, gatherCfg)), precedentSource: 'memory-store' };

  // G2 recent approval: derived from the memory store (operator-approval records).
  const { operatorApprovedSimilarWithinDays, match: approvalMatch } = await gatherRecentApproval(action, store, {
    now,
    scanK: (gatherCfg.approvalScanK ?? GATHER_DEFAULTS.approvalScanK),
  });

  const memory = { precedentCount, precedentSimilarity, operatorApprovedSimilarWithinDays };
  const decision = decide(action, memory, gateCfg);

  return { action, memory, decision, evidence: { precedents, approvalMatch, precedentSource } };
}

// ─── PROPOSE: objection-window plumbing ────────────────────────────────────────

/**
 * The PROPOSE path made runnable: "notify the operator, then act unless they
 * object within the window." Dependency-light — the real scheduler integration
 * (runtime.scheduler.scheduleAt) can drive this with the same shape; here it's a
 * single awaitable so the demo and tests run without a scheduler.
 *
 * @param {object} args
 * @param {(info:{phase:'notify'|'proceed'|'aborted', reason?:string})=>any} args.notify
 *   invoked at notify time AND at the final outcome; smoke-safe (just logging is fine).
 * @param {number} [args.waitHours]   the operator-facing window (4h default in prod).
 * @param {()=>(boolean|Promise<boolean>)} [args.isObjected]
 *   polled after the window; truthy => the operator objected => do NOT proceed.
 * @param {number} [args.delayMs]     ACTUAL wait used for the demo/tests (NOT 4h).
 *   Defaults to a tiny delay so the window is modeled without blocking. In prod the
 *   scheduler supplies waitHours*3600_000; here we keep it small on purpose.
 * @param {(ms:number)=>Promise<void>} [args.sleep]  injectable sleep (tests use 0).
 * @returns {Promise<{proceeded:boolean, objected:boolean, waitHours:number, delayMs:number}>}
 */
export async function proposeWithObjectionWindow({
  notify,
  waitHours = GATE_DEFAULTS.proposeObjectionWindowHours,
  isObjected = () => false,
  delayMs = 5,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (typeof notify !== 'function') throw new Error('proposeWithObjectionWindow: notify must be a function');

  await notify({ phase: 'notify', reason: `act in ${waitHours}h unless you object` });
  await sleep(delayMs); // models the window; prod uses the scheduler at waitHours

  const objected = Boolean(await isObjected());
  if (objected) {
    await notify({ phase: 'aborted', reason: 'operator objected within the window' });
    return { proceeded: false, objected: true, waitHours, delayMs };
  }
  await notify({ phase: 'proceed', reason: 'no objection within the window' });
  return { proceeded: true, objected: false, waitHours, delayMs };
}

// ─── Seeding helper (for demo + tests) ─────────────────────────────────────────
//
// NOT a fake interface — this writes into the REAL memory store (or its smoke
// stub) via the documented `offload()` API, so the demo/tests exercise the same
// surface production uses. It is a convenience for staging an operator's memory.

/**
 * Offload precedent records into the memory store under PRECEDENT_TAG.
 * @param {object} store  a memory store (real or runtime smoke stub) with offload()
 * @param {Array<{text:string, tags?:string[]}>} entries
 */
export async function seedPrecedents(store, entries = []) {
  for (const e of entries) {
    await store.offload({ text: e.text, tags: [PRECEDENT_TAG, ...(e.tags || [])] });
  }
}

/**
 * Offload operator-approval records into the memory store under OPERATOR_APPROVAL_TAG.
 *
 * An operator approval is a DURABLE thing the mentor learns about the user (a confirmed
 * preference / accepted pattern), so — per AGIX.ONBOARD.1 Phase E.2 — each approval is
 * also accreted into the instance soul via recordLearning(). The soul write is
 * BEST-EFFORT and guarded: a failure (or no scaffolded soul) NEVER blocks the approval
 * from landing in the memory store, and never crashes the mentor.
 *
 * @param {object} store  a memory store (real or runtime smoke stub) with offload()
 * @param {Array<{text:string, approvedDaysAgo?:number, tags?:string[]}>} approvals
 * @param {{now?:number, accreteToSoul?:boolean}} [opts]
 *   accreteToSoul — set false to suppress the soul side-effect (default true).
 */
export async function seedApprovals(store, approvals = [], { now = Date.now(), accreteToSoul = true } = {}) {
  for (const a of approvals) {
    const approved_at = new Date(now - (a.approvedDaysAgo ?? 0) * MS_PER_DAY).toISOString();
    await store.offload({
      text: a.text,
      tags: [OPERATOR_APPROVAL_TAG, ...(a.tags || [])],
      meta: { approved_at },
    });
    // The accretion side-effect: a confirmed approval is something the AOS now knows
    // about the operator — grow the soul with it. Guarded so the soul-write surface
    // (a read-only config dir, a missing soul, etc.) can never break the mentor.
    if (accreteToSoul && a.text) {
      try { recordLearning(a.text, { category: 'approved', now }); } catch { /* best-effort */ }
    }
  }
}
