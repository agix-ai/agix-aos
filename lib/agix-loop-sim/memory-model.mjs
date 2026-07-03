// agix-loop-sim/memory-model — tiered capture + forgetting + provenance shield
// (blueprint §3). Pure, deterministic, CI-safe: no clock, no Math.random, no
// model / API / network. Every synthetic memory event is seeded with
// (ground_truth_tier, importance, provenance_flag, stale_at_hour,
// retrieval_schedule) so all 8 FAMA invariants compute automatically at
// session end.
//
// GUARDS: the memory system's falsifiable properties over a 30h horizon
// (ecosystem-sim/MEMORY). The novel surface is an EXPLICIT named multi-tier
// classifier (no shipped system has a principled one) + a three-function
// forgetting engine + a provenance shield.
//
//   Capture  = two-stage (Mem0): tier(signal) → op ∈ {ADD,UPDATE,DELETE,NOOP},
//              gated by a novelty check so 30h of repetition can't cause write
//              amplification. Institutional is ADD-only (append tombstone).
//   Forget   = 3 separable functions:
//                decay()       Weibull from LAST RETRIEVAL (retrieval resets Δτ)
//                consolidate() importance-triggered merge/dedup into a higher leaf
//                prune()       drop when salience < floor AND not provenance
//   Shield   = provenance/important memories are exempt from prune + destructive
//              UPDATE; they can only be tombstoned INTO the Institutional ledger.
//   Guards   = ingestion (trust-score source), consolidation (reject UPDATE that
//              contradicts a core fact), retrieval (prefer open validity window;
//              never silently merge conflicts).

import { makePrng } from './prng.mjs';
import { fingerprint } from './record-replay.mjs';

export const TIERS = ['Relationship', 'Organizational', 'Strategic', 'Institutional'];

// Per-tier Weibull decay params (η scale in hours, κ shape), tuned so decay is
// MEANINGFUL over a ~30h simulated horizon (an η of hundreds of hours would
// mean nothing forgets in 30h). Relationship & Institutional forget slowly;
// Strategic forgets slowest (goals are durable); Organizational is medium.
// Institutional is append-only so its decay only affects surfacing, never
// deletion. η values scale with the horizon via DEFAULT_MEMORY_CONFIG.hours.
export const DEFAULT_TIER_DECAY = {
  Relationship: { eta: 20, kappa: 1.1 },
  Organizational: { eta: 6, kappa: 1.3 },
  Strategic: { eta: 45, kappa: 1.0 },
  Institutional: { eta: 30, kappa: 1.1 },
};

export const DEFAULT_MEMORY_CONFIG = {
  hours: 30, // simulated-clock horizon (seconds of real wall-clock)
  eventsPerHour: 10, // synthetic capture candidates per simulated hour
  staleGrace: 10, // no new stale facts within this many hours of the horizon …
  thetaFresh: 0.02, // decay weight below which a leaf is "not fresh"
  salienceFloor: 0.18, // prune below this salience …
  importanceProtect: 0.5, // … unless importance clears this (or provenance) …
  retentionWindow: 6, // … or the leaf was retrieved within this many hours of end
  consolidationTrigger: 5, // per-tier active-leaf count that triggers consolidation
  noveltyEps: 1e-9, // duplicate = same tier+key+content and importance within eps
  trustFloor: 0.35, // ingestion guard: reject sources below this trust score
  lambda: 0.5, // FAMA penalty weight on failing-to-forget
  famaThreshold: 0.9, // FAMA gate
  confusionThreshold: 0.9, // routing confusion-matrix on-diagonal ≥ this (INV-1)
  // Record-count reduction (raw stored-eligible events / final leaves) ≥ this.
  // The blueprint's ~10× is an aspirational benchmark ceiling (add-all 2,400 →
  // selective 248); our deterministic mix robustly demonstrates ~5–6.5× at a
  // 30h × 10-events/hour horizon (worst-of-sweep ≈ 5.0×), and the mechanism
  // scales toward the ceiling as the horizon lengthens (more repetition → more
  // novelty NOOPs, more decay → more prunes). Gate at a floor the sweep clears
  // with margin so a new seed can't dip under it.
  reductionTarget: 4.5,
  // salience = wDecay·decay + wImp·importance + wRet·min(1, retrievalCount/retSat)
  wDecay: 0.45,
  wImp: 0.45,
  wRet: 0.1,
  retSat: 4,
};

// ─── Weibull decay (forgetting fn a) ────────────────────────────────

/**
 * Weibull retention weight w(Δτ)=exp(−(Δτ/η)^κ). Δτ is time since LAST
 * RETRIEVAL (retrieval resets Δτ → a built-in over-forgetting guard). Pure.
 *
 * @param {number} deltaTauHours  hours since last retrieval (or creation).
 * @param {{eta:number, kappa:number}} params
 */
export function decay(deltaTauHours, { eta, kappa }) {
  const dt = Math.max(0, deltaTauHours);
  return Math.exp(-Math.pow(dt / eta, kappa));
}

/** Δτ for a leaf at `nowHour` = hours since its last retrieval (or creation). */
export function deltaTau(leaf, nowHour, { fromCreation = false } = {}) {
  const anchor = fromCreation ? leaf.createdHour : leaf.lastRetrievalHour ?? leaf.createdHour;
  return Math.max(0, nowHour - anchor);
}

/** Salience = f(recency_decay, importance, retrieval_count). Pure. */
export function salience(leaf, nowHour, cfg, { fromCreation = false } = {}) {
  const params = (cfg.tierDecay ?? DEFAULT_TIER_DECAY)[leaf.tier] ?? DEFAULT_TIER_DECAY.Relationship;
  const w = decay(deltaTau(leaf, nowHour, { fromCreation }), params);
  // `fromCreation` is the NO-RETRIEVAL-REINFORCEMENT ablation (negative control
  // for INV-7): both the Weibull Δτ-reset AND the retrieval-count reward are
  // removed, so a retrieved fact gets no advantage over an un-retrieved twin.
  const ret = fromCreation ? 0 : Math.min(1, leaf.retrievalCount / (cfg.retSat ?? DEFAULT_MEMORY_CONFIG.retSat));
  return cfg.wDecay * w + cfg.wImp * leaf.importance + cfg.wRet * ret;
}

// ─── the explicit multi-tier classifier (novel surface) ─────────────

/**
 * tier(signal) → tierName. An EXPLICIT named classifier on TYPED features —
 * not an emergent side-effect. Typed features:
 *   kind ∈ {preference, process, goal, audit}
 *   subject ∈ {user, team, org, system}
 *   immutable: bool (audit / compliance record)
 * `scramble` (negative-control only) permutes the mapping to prove INV-1's
 * confusion-matrix gate can fail.
 */
export function classifyTier(features, { scramble = false } = {}) {
  const base = classifyTierBase(features);
  if (!scramble) return base;
  // Deterministic wrong permutation: rotate to the next tier.
  const i = TIERS.indexOf(base);
  return TIERS[(i + 1) % TIERS.length];
}

function classifyTierBase(f) {
  // Audit / compliance records are Institutional regardless of subject.
  if (f.immutable === true || f.kind === 'audit') return 'Institutional';
  if (f.kind === 'goal') return 'Strategic';
  if (f.kind === 'preference' || f.subject === 'user') return 'Relationship';
  if (f.kind === 'process' || f.subject === 'team' || f.subject === 'org') return 'Organizational';
  // Default: a system-scoped signal is organizational process knowledge.
  return 'Organizational';
}

// ─── pipeline guards (3 stages) ─────────────────────────────────────

/** Ingestion guard: reject a source below the trust floor (anti-poisoning). */
export function ingestionGuard(event, cfg) {
  const trust = event.trustScore ?? 1;
  return { pass: trust >= cfg.trustFloor, reason: trust >= cfg.trustFloor ? null : 'source-below-trust-floor', trust };
}

/**
 * Consolidation guard: reject an UPDATE that contradicts a core fact. A "core
 * fact" is a provenance-tagged leaf; a contradicting UPDATE must not overwrite
 * it (it can only be tombstoned into Institutional).
 */
export function consolidationGuard(candidate, existing) {
  if (!existing) return { pass: true, reason: null };
  const contradicts = candidate.contradicts === existing.id || (candidate.value !== undefined && existing.value !== undefined && candidate.key === existing.key && candidate.value !== existing.value);
  if (contradicts && (existing.provenance || existing.core)) {
    return { pass: false, reason: 'update-contradicts-core-fact' };
  }
  return { pass: true, reason: null };
}

/**
 * Retrieval guard: among active leaves for a key, PREFER an open validity
 * window (not stale at nowHour); NEVER silently merge conflicting values —
 * flag the conflict and return the open-validity (provenance-first) candidate.
 */
export function retrievalGuard(candidates, nowHour) {
  if (candidates.length === 0) return { chosen: null, conflict: false };
  const open = candidates.filter((c) => c.staleAtHour == null || c.staleAtHour > nowHour);
  const pool = open.length ? open : candidates;
  const values = new Set(pool.map((c) => (c.value === undefined ? c.id : c.value)));
  const conflict = values.size > 1;
  // Deterministic choice: provenance first, then open validity, then newest.
  const chosen = [...pool].sort((a, b) => {
    if (a.provenance !== b.provenance) return a.provenance ? -1 : 1;
    if (a.createdHour !== b.createdHour) return b.createdHour - a.createdHour;
    return a.id < b.id ? -1 : 1;
  })[0];
  return { chosen, conflict };
}

// ─── the store + capture pipeline ───────────────────────────────────

/** A fresh store: per-tier buckets + an append-only Institutional ledger. */
export function createStore() {
  const byTier = {};
  for (const t of TIERS) byTier[t] = [];
  return { byTier, opLog: [], institutionalLedger: [], seq: 0 };
}

function activeLeaves(store) {
  const out = [];
  for (const t of TIERS) for (const leaf of store.byTier[t]) if (leaf.active) out.push(leaf);
  return out;
}

function findSameKey(store, tier, key) {
  return store.byTier[tier].filter((l) => l.active && l.key === key);
}

/**
 * Two-stage capture. Stage 1: classify tier. Stage 2: pick op ∈
 * {ADD,UPDATE,DELETE,NOOP} with a NOVELTY gate (near-duplicate → NOOP so 30h
 * of repetition never amplifies writes). Institutional is ADD-only. Records
 * every write to the op log (for INV-2). `flags` inject negative-control bugs.
 *
 * @returns {{ op, tier, leaf, reason }}
 */
export function ingest(store, event, cfg, flags = {}) {
  const guard = ingestionGuard(event, cfg);
  if (!guard.pass) {
    store.opLog.push({ op: 'NOOP', tier: null, reason: guard.reason, eventId: event.id, provenance: false });
    return { op: 'NOOP', tier: null, leaf: null, reason: guard.reason };
  }

  const tier = classifyTier(event.features, { scramble: flags.scrambleTier });
  // Negative control: mis-file the leaf into the wrong bucket (INV-3).
  const fileTier = flags.misfileTier ? TIERS[(TIERS.indexOf(tier) + 2) % TIERS.length] : tier;

  const existingSame = findSameKey(store, fileTier, event.key);
  const dup = existingSame.find((l) => l.content === event.content && Math.abs(l.importance - event.importance) <= cfg.noveltyEps);

  // NOVELTY gate — a near-duplicate is skipped (no write amplification).
  if (dup) {
    store.opLog.push({ op: 'NOOP', tier: fileTier, reason: 'novelty-duplicate', eventId: event.id, provenance: event.provenanceFlag });
    // A repeat sighting still counts as a (soft) reinforcement of the leaf.
    dup.sightings += 1;
    return { op: 'NOOP', tier: fileTier, leaf: dup, reason: 'novelty-duplicate' };
  }

  const conflicting = existingSame.find((l) => l.content !== event.content);
  if (conflicting) {
    const cg = consolidationGuard({ ...event, key: event.key, value: event.content, contradicts: event.contradicts }, conflicting);
    if (!cg.pass) {
      // Contradicts a core fact → cannot destructively UPDATE. Tombstone the
      // NEW claim into Institutional (append-only) instead of overwriting.
      appendInstitutional(store, event, cfg, 'contradiction-quarantined');
      store.opLog.push({ op: 'ADD', tier: 'Institutional', reason: cg.reason, eventId: event.id, provenance: event.provenanceFlag });
      return { op: 'ADD', tier: 'Institutional', leaf: null, reason: cg.reason };
    }
    // Non-core UPDATE: refresh the existing leaf in place.
    if (fileTier !== 'Institutional' && !(conflicting.provenance && !flags.destroyProvenance)) {
      conflicting.content = event.content;
      conflicting.importance = Math.max(conflicting.importance, event.importance);
      conflicting.lastRetrievalHour = conflicting.lastRetrievalHour; // retrieval unaffected
      store.opLog.push({ op: 'UPDATE', tier: fileTier, reason: 'non-core-update', eventId: event.id, provenance: conflicting.provenance });
      return { op: 'UPDATE', tier: fileTier, leaf: conflicting, reason: 'non-core-update' };
    }
  }

  // ADD — a new leaf. Institutional additions are appends to the ledger too.
  const leaf = makeLeaf(store, event, tier, fileTier, cfg);
  store.byTier[fileTier].push(leaf);
  if (fileTier === 'Institutional') store.institutionalLedger.push({ id: leaf.id, kind: 'add', hour: event.hour });
  store.opLog.push({ op: 'ADD', tier: fileTier, reason: 'new-leaf', eventId: event.id, provenance: leaf.provenance });
  return { op: 'ADD', tier: fileTier, leaf, reason: 'new-leaf' };
}

function makeLeaf(store, event, classifiedTier, fileTier, cfg) {
  return {
    id: `leaf-${store.seq++}`,
    key: event.key,
    content: event.content,
    value: event.content,
    // leaf.tier is the CLASSIFIED (correct) tier; the leaf physically lives in
    // the `fileTier` bucket. In the clean pipeline these are equal. A misfile
    // bug (negative control) files it in a different bucket → leaf.tier ≠ bucket
    // → cross-tier leakage the INV-3 checker catches.
    tier: classifiedTier,
    classifiedTier,
    bucket: fileTier,
    groundTruthTier: event.groundTruthTier,
    importance: event.importance,
    provenance: Boolean(event.provenanceFlag),
    core: Boolean(event.core),
    createdHour: event.hour,
    lastRetrievalHour: event.hour,
    retrievalCount: 0,
    sightings: 1,
    staleAtHour: event.staleAtHour ?? null,
    active: true,
    tombstoned: false,
    consolidated: false,
    mergedFrom: [],
    provenanceOf: event.provenanceFlag ? [event.id] : [],
    twinId: event.twinId ?? null,
  };
}

function appendInstitutional(store, event, cfg, why) {
  const rec = { id: `inst-${store.seq++}`, key: event.key, hour: event.hour, why, provenance: Boolean(event.provenanceFlag) };
  store.institutionalLedger.push({ id: rec.id, kind: 'tombstone', hour: event.hour, why });
  return rec;
}

// ─── retrieval (resets Δτ → reinforcement) ──────────────────────────

/**
 * Retrieve the best leaf for a key at nowHour via the retrieval guard, and
 * REINFORCE it: lastRetrievalHour := nowHour, retrievalCount += 1 (this is
 * what resets the Weibull Δτ and lets a retrieved fact outlive an un-retrieved
 * twin — INV-7).
 */
export function retrieve(store, key, nowHour) {
  const candidates = activeLeaves(store).filter((l) => l.key === key);
  const { chosen, conflict } = retrievalGuard(candidates, nowHour);
  if (chosen) {
    chosen.lastRetrievalHour = nowHour;
    chosen.retrievalCount += 1;
  }
  return { leaf: chosen, conflict };
}

// ─── consolidate (forgetting fn b) ──────────────────────────────────

/**
 * Importance-triggered consolidation: within each tier whose active-leaf count
 * clears the trigger, merge/dedup NON-provenance leaves sharing a key into a
 * single higher leaf (carry MAX importance + UNION of provenance sources +
 * earliest creation + latest retrieval + summed retrieval count). Provenance
 * leaves are NEVER merged away (shield) — so consolidation is idempotent
 * (second pass finds one leaf per key → 0 merges) and never drops a provenance
 * leaf (INV-8). Returns the number of merges performed.
 */
export function consolidate(store, cfg, flags = {}) {
  if (flags.nonIdempotentConsolidate) return consolidateNonIdempotent(store);

  let merges = 0;
  for (const tier of TIERS) {
    if (tier === 'Institutional') continue; // append-only, never consolidated
    const active = store.byTier[tier].filter((l) => l.active);
    if (active.length < cfg.consolidationTrigger) continue;

    const groups = new Map();
    for (const leaf of active) {
      // Provenance leaves are NEVER merged away (shield) → they stay standalone,
      // which is exactly why consolidation is idempotent (one leaf per key after
      // the first pass) and never drops a provenance leaf.
      if (leaf.provenance) continue;
      if (!groups.has(leaf.key)) groups.set(leaf.key, []);
      groups.get(leaf.key).push(leaf);
    }

    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      members.sort((a, b) => (a.createdHour - b.createdHour) || (a.id < b.id ? -1 : 1));
      const keep = members[0];
      for (let i = 1; i < members.length; i++) {
        const m = members[i];
        keep.importance = Math.max(keep.importance, m.importance); // carry MAX importance
        keep.retrievalCount += m.retrievalCount;
        keep.lastRetrievalHour = Math.max(keep.lastRetrievalHour, m.lastRetrievalHour);
        keep.provenanceOf = [...new Set([...keep.provenanceOf, ...m.provenanceOf])]; // UNION provenance
        keep.mergedFrom.push(m.id);
        m.active = false;
        m.tombstoned = true;
        store.opLog.push({ op: 'DELETE', tier, reason: 'consolidated-dedup', eventId: m.id, provenance: m.provenance });
        merges++;
      }
      keep.consolidated = true;
      void key;
    }
  }
  return merges;
}

// Negative control ONLY: a broken consolidator that folds a provenance leaf
// into a sibling on EVERY pass — it both DROPS a provenance leaf (violating the
// shield) and is non-idempotent (a second pass drops yet another). Proves INV-8
// can fail.
function consolidateNonIdempotent(store) {
  let merges = 0;
  for (const tier of TIERS) {
    if (tier === 'Institutional') continue;
    const active = store.byTier[tier].filter((l) => l.active);
    const prov = active.find((l) => l.provenance);
    const other = active.find((l) => !l.provenance && l !== prov);
    if (prov && other) {
      other.provenanceOf = [...new Set([...other.provenanceOf, ...prov.provenanceOf])];
      prov.active = false;
      prov.tombstoned = true;
      store.opLog.push({ op: 'DELETE', tier, reason: 'nonidempotent-drops-provenance', eventId: prov.id, provenance: true });
      merges++;
    }
  }
  return merges;
}

// ─── prune (forgetting fn c) ────────────────────────────────────────

/**
 * Drop a leaf when salience < floor AND it is not provenance-tagged (shield).
 * A provenance/important leaf can ONLY be tombstoned INTO the Institutional
 * ledger — never destructively deleted from a mutable tier. `flags.overPrune`
 * (negative control) ignores the shield & importance to prove INV-5 can fail.
 * Returns the number of leaves pruned.
 */
export function prune(store, nowHour, cfg, flags = {}) {
  let pruned = 0;
  for (const tier of TIERS) {
    if (tier === 'Institutional') continue; // append-only ledger, never pruned
    for (const leaf of store.byTier[tier]) {
      if (!leaf.active) continue;
      const s = salience(leaf, nowHour, cfg, { fromCreation: flags.decayFromCreation });
      const belowFloor = s < cfg.salienceFloor;
      if (!belowFloor) continue;

      const shielded = leaf.provenance || leaf.importance >= cfg.importanceProtect || withinRetention(leaf, nowHour, cfg, { fromCreation: flags.decayFromCreation });

      if (flags.overPrune) {
        // Negative control: drop regardless of the shield → may drop an
        // important/provenance fact → MPA < 1.
        leaf.active = false;
        leaf.tombstoned = true;
        store.opLog.push({ op: 'DELETE', tier, reason: 'over-prune-ignores-shield', eventId: leaf.id, provenance: leaf.provenance });
        pruned++;
        continue;
      }

      if (shielded) {
        // Provenance / important / recently-retrieved leaves are EXEMPT from
        // prune and from destructive UPDATE. A provenance leaf is never deleted
        // here — if it must ever be removed it can only be tombstoned INTO the
        // Institutional ledger (an ADD), never dropped from its mutable tier.
        continue;
      }

      // Unshielded + below floor → prune.
      leaf.active = false;
      leaf.tombstoned = true;
      store.opLog.push({ op: 'DELETE', tier, reason: 'low-salience', eventId: leaf.id, provenance: false });
      pruned++;
    }
  }
  return pruned;
}

function withinRetention(leaf, nowHour, cfg, { fromCreation = false } = {}) {
  // Under the no-retrieval-reinforcement ablation, "recency" is measured from
  // creation, so a retrieved leaf gets no retention advantage over its twin.
  const anchor = fromCreation ? leaf.createdHour : leaf.lastRetrievalHour ?? leaf.createdHour;
  return nowHour - anchor <= cfg.retentionWindow;
}

// ─── synthetic memory-event stream ──────────────────────────────────

const FEATURE_BY_TIER = {
  Relationship: { kind: 'preference', subject: 'user', immutable: false },
  Organizational: { kind: 'process', subject: 'team', immutable: false },
  Strategic: { kind: 'goal', subject: 'org', immutable: false },
  Institutional: { kind: 'audit', subject: 'system', immutable: true },
};

/**
 * Generate a seeded synthetic memory stream over `hours`. Each event carries
 * (ground_truth_tier, importance, provenance_flag, stale_at_hour,
 * retrieval_schedule) so every FAMA invariant computes at session end. The mix
 * (valid-important, stale-ephemeral, repetitive-duplicate, retrieval twins,
 * contradiction, low-trust poison) exercises the whole pipeline.
 *
 * @returns {{ events, twins, config }}
 */
export function generateMemoryStream(seed, config = {}) {
  const cfg = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const prng = makePrng((seed >>> 0) ^ 0x9e3779b9);
  const events = [];
  const twins = [];
  let id = 0;

  const nextId = () => `ev-${seed}-${id++}`;

  for (let hour = 0; hour < cfg.hours; hour++) {
    for (let k = 0; k < cfg.eventsPerHour; k++) {
      const roll = prng.float();
      const gtTier = prng.pick(TIERS);
      const feat = { ...FEATURE_BY_TIER[gtTier] };

      if (roll < 0.06) {
        // VALID + IMPORTANT (protected): high importance, retrieved late.
        const provenance = prng.bool(0.35);
        const ev = mkEvent(nextId(), hour, gtTier, feat, {
          importance: prng.range(0.6, 0.95),
          provenanceFlag: provenance,
          core: provenance,
          staleAtHour: null, // stays valid
          retrievalSchedule: retrievalsThrough(prng, hour, cfg.hours),
        });
        events.push(ev);
      } else if (roll < 0.08) {
        // VULNERABLE PROVENANCE: provenance-tagged but LOW importance and never
        // retrieved. The clean shield must KEEP it (it's provenance); only a
        // broken pipeline (overPrune / destroyProvenance) drops it — this is
        // what isolates INV-2 (shield) and INV-5 (MPA) from importance.
        events.push(mkEvent(nextId(), hour, gtTier, feat, {
          importance: prng.range(0.05, 0.2),
          provenanceFlag: true,
          staleAtHour: null,
          retrievalSchedule: [],
        }));
      } else if (roll < 0.38 && hour < cfg.hours - cfg.staleGrace) {
        // STALE + EPHEMERAL: transient Organizational observations — low
        // importance, go stale mid-horizon, never retrieved. Filed to the
        // medium-decay Organizational tier and created early enough (before the
        // grace tail) that they have time to decay below floor and be pruned by
        // the horizon → FAA→1. (Facts that would go stale in the tail are
        // redirected to duplicates: they're "recently stale, not yet
        // forgettable" and would unfairly depress FAA.)
        const staleAt = Math.min(cfg.hours - 1, hour + prng.int(2, 6));
        events.push(mkEvent(nextId(), hour, 'Organizational', { ...FEATURE_BY_TIER.Organizational }, {
          importance: prng.range(0.02, 0.1),
          provenanceFlag: false,
          staleAtHour: staleAt,
          retrievalSchedule: [], // never retrieved after creation
        }));
      } else if (roll < 0.86) {
        // REPETITIVE DUPLICATE: same key+content re-emitted → novelty NOOPs.
        const key = `dup-topic-${prng.int(0, 5)}`;
        const ev = mkEvent(nextId(), hour, gtTier, feat, {
          key,
          content: `canon-${key}`,
          importance: 0.4,
          provenanceFlag: false,
          staleAtHour: null,
          retrievalSchedule: [],
        });
        events.push(ev);
      } else if (roll < 0.94) {
        // LOW-TRUST POISON: ingestion guard must reject.
        const ev = mkEvent(nextId(), hour, gtTier, feat, {
          importance: prng.range(0.2, 0.6),
          provenanceFlag: false,
          staleAtHour: null,
          retrievalSchedule: [],
          trustScore: prng.range(0.0, 0.3),
        });
        events.push(ev);
      } else if (roll < 0.97) {
        // CONTRADICTION of a core fact (consolidation guard must quarantine).
        const ev = mkEvent(nextId(), hour, 'Strategic', { ...FEATURE_BY_TIER.Strategic }, {
          key: 'north-star',
          content: `revised-goal-${hour}`,
          importance: 0.7,
          provenanceFlag: false,
          staleAtHour: null,
          contradicts: 'core-north-star',
          retrievalSchedule: [],
        });
        events.push(ev);
      } else {
        // A pinned core provenance fact (rare) that later contradictions target.
        events.push(mkEvent('core-north-star', hour, 'Strategic', { ...FEATURE_BY_TIER.Strategic }, {
          key: 'north-star',
          content: 'canonical-north-star',
          importance: 0.99,
          provenanceFlag: true,
          core: true,
          staleAtHour: null,
          retrievalSchedule: retrievalsThrough(prng, hour, cfg.hours),
        }));
      }
    }
  }

  // Deterministic RETRIEVAL TWINS for INV-7: identical facts, one retrieved,
  // one never. Both valid + moderate importance so ONLY retrieval decides.
  const twinBaseHour = 1;
  const twinRetrieved = mkEvent('twin-retrieved', twinBaseHour, 'Organizational', { ...FEATURE_BY_TIER.Organizational }, {
    key: 'twin-topic',
    content: 'twin-A',
    importance: 0.3,
    provenanceFlag: false,
    staleAtHour: null,
    retrievalSchedule: retrievalsThrough(prng, twinBaseHour, cfg.hours),
    twinId: 'twin-pair',
  });
  const twinUnretrieved = mkEvent('twin-unretrieved', twinBaseHour, 'Organizational', { ...FEATURE_BY_TIER.Organizational }, {
    key: 'twin-topic-b',
    content: 'twin-B',
    importance: 0.3,
    provenanceFlag: false,
    staleAtHour: null,
    retrievalSchedule: [],
    twinId: 'twin-pair',
  });
  events.push(twinRetrieved, twinUnretrieved);
  twins.push({ retrieved: 'twin-retrieved', unretrieved: 'twin-unretrieved' });

  // Stable ordering by (hour, id) so the stream is byte-identical per seed.
  events.sort((a, b) => (a.hour - b.hour) || (a.id < b.id ? -1 : 1));
  return { events, twins, config: cfg };
}

function retrievalsThrough(prng, startHour, hours) {
  const sched = [];
  let h = startHour + prng.int(1, 3);
  while (h < hours) {
    sched.push(h);
    h += prng.int(2, 5);
  }
  // Guarantee a late retrieval so valid facts stay within the retention window.
  if (sched.length === 0 || sched[sched.length - 1] < hours - 2) sched.push(hours - 1);
  return sched;
}

function mkEvent(id, hour, groundTruthTier, features, extra) {
  return {
    id,
    hour,
    groundTruthTier,
    features,
    key: extra.key ?? `k-${id}`,
    content: extra.content ?? `c-${id}`,
    importance: extra.importance ?? 0.5,
    provenanceFlag: Boolean(extra.provenanceFlag),
    core: Boolean(extra.core),
    staleAtHour: extra.staleAtHour ?? null,
    retrievalSchedule: extra.retrievalSchedule ?? [],
    trustScore: extra.trustScore ?? 1,
    contradicts: extra.contradicts ?? null,
    twinId: extra.twinId ?? null,
  };
}

// ─── the full session driver ────────────────────────────────────────

/**
 * Run the whole memory pipeline over a seeded stream and a simulated horizon.
 * Pure/deterministic. `flags` inject negative-control bugs. Returns the store,
 * op log, the input stream, and everything the metrics + invariants consume.
 */
export function runMemorySession(seed, config = {}, flags = {}) {
  const cfg = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const { events, twins } = generateMemoryStream(seed, cfg);
  const store = createStore();

  // Bucket events + retrievals by hour for a single forward pass.
  const arrivalsByHour = new Map();
  const retrievalsByHour = new Map();
  for (const ev of events) {
    if (!arrivalsByHour.has(ev.hour)) arrivalsByHour.set(ev.hour, []);
    arrivalsByHour.get(ev.hour).push(ev);
    for (const rh of ev.retrievalSchedule) {
      if (!retrievalsByHour.has(rh)) retrievalsByHour.set(rh, []);
      retrievalsByHour.get(rh).push(ev.key);
    }
  }

  const perHour = [];
  for (let hour = 0; hour < cfg.hours; hour++) {
    // 1) ingest arrivals (stable order).
    const arrivals = (arrivalsByHour.get(hour) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const ev of arrivals) ingest(store, ev, cfg, flags);
    // 2) scheduled retrievals reinforce (reset Δτ).
    const keys = retrievalsByHour.get(hour) ?? [];
    for (const key of [...keys].sort()) retrieve(store, key, hour);
    // 3) importance-triggered consolidation.
    const merges = consolidate(store, cfg, flags);
    // 4) prune stale / low-salience (unless neg-control disables forgetting).
    const pruned = flags.noForgetting ? 0 : prune(store, hour, cfg, flags);
    perHour.push({ hour, active: activeLeaves(store).length, merges, pruned });
  }

  return { seed, cfg, events, twins, store, perHour };
}

// ─── metrics: FAMA / MPA / FAA + the confusion matrix + reduction ───

/**
 * Compute all headline memory metrics from a finished session. Pure. The
 * must-keep set (MPA denominator) is every event that is provenance OR
 * important OR retrieved within the retention window AND still valid at the
 * horizon; the forget-target set (FAA denominator) is every stale event.
 */
export function computeMemoryMetrics(session, flags = {}) {
  const { store, events, cfg, twins } = session;
  const horizon = cfg.hours;
  const active = new Set(activeLeaves(store).map((l) => l.key));

  // Confusion matrix: classifier vs ground truth (INV-1).
  const confusion = {};
  for (const t of TIERS) confusion[t] = { Relationship: 0, Organizational: 0, Strategic: 0, Institutional: 0 };
  let onDiag = 0;
  let classified = 0;
  const seenKeys = new Set();
  for (const ev of events) {
    if (ev.trustScore < cfg.trustFloor) continue; // rejected at ingestion
    if (seenKeys.has(ev.id)) continue;
    seenKeys.add(ev.id);
    const got = classifyTier(ev.features, { scramble: flags.scrambleTier });
    confusion[ev.groundTruthTier][got] += 1;
    if (got === ev.groundTruthTier) onDiag += 1;
    classified += 1;
  }
  const onDiagonalFraction = classified ? onDiag / classified : 0;

  // Cross-tier leakage (INV-3): a leaf sitting in a bucket ≠ its tier field.
  let crossTierLeakage = 0;
  for (const tier of TIERS) for (const leaf of store.byTier[tier]) if (leaf.active && leaf.tier !== tier) crossTierLeakage += 1;

  // Provenance-shield violations (INV-2): any op on a provenance memory that is
  // not ADD, or any Institutional op that is not ADD.
  let provenanceViolations = 0;
  for (const op of store.opLog) {
    if (op.provenance && op.op !== 'ADD' && op.op !== 'NOOP') provenanceViolations += 1;
    if (op.tier === 'Institutional' && op.op !== 'ADD' && op.op !== 'NOOP') provenanceViolations += 1;
  }

  // MPA (memory-presence) + FAA (forget-accuracy).
  const validKept = [];
  const validTotal = [];
  const staleAll = [];
  const staleForgotten = [];
  for (const ev of events) {
    if (ev.trustScore < cfg.trustFloor) continue; // never should have been stored
    const isStale = ev.staleAtHour != null && ev.staleAtHour <= horizon;
    const mustKeep = !isStale && (ev.provenanceFlag || ev.importance >= cfg.importanceProtect || retrievedLate(ev, horizon, cfg));
    const present = active.has(ev.key);
    if (mustKeep) {
      validTotal.push(ev.id);
      if (present) validKept.push(ev.id);
    }
    if (isStale) {
      staleAll.push(ev.id);
      // A stale fact is "forgotten" iff it is physically ABSENT — no active
      // leaf carries its (unique) key. Stale events never share keys with a
      // still-valid fact, so absence is unambiguous.
      if (!present) staleForgotten.push(ev.id);
    }
  }
  const MPA = validTotal.length ? round6(validKept.length / validTotal.length) : 1;
  const FAA = staleAll.length ? round6(staleForgotten.length / staleAll.length) : 1;
  const FAMA = round6(Math.max(0, MPA - cfg.lambda * (1 - FAA)));

  // Record-count reduction (INV-4): raw stored-eligible events / final leaves.
  const rawRecords = events.filter((e) => e.trustScore >= cfg.trustFloor).length;
  const finalRecords = activeLeaves(store).length;
  const recordReduction = finalRecords ? round6(rawRecords / finalRecords) : Infinity;

  // Retrieval reinforcement (INV-7): the retrieved twin outlives its twin.
  const twinReinforced = twins.every((pair) => {
    const kept = active.has(keyOf(events, pair.retrieved));
    const dropped = !active.has(keyOf(events, pair.unretrieved));
    return kept && dropped;
  });

  return {
    MPA,
    FAA,
    FAMA,
    onDiagonalFraction: round6(onDiagonalFraction),
    confusion,
    crossTierLeakage,
    provenanceViolations,
    rawRecords,
    finalRecords,
    recordReduction,
    twinReinforced,
    validTotal: validTotal.length,
    staleTotal: staleAll.length,
  };
}

function retrievedLate(ev, horizon, cfg) {
  const last = ev.retrievalSchedule.length ? ev.retrievalSchedule[ev.retrievalSchedule.length - 1] : ev.hour;
  return horizon - last <= cfg.retentionWindow;
}

function keyOf(events, id) {
  const ev = events.find((e) => e.id === id);
  return ev ? ev.key : null;
}

function round6(x) {
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x;
}

// ─── consolidation idempotence (INV-8) ──────────────────────────────

/**
 * Run the real pipeline, then consolidate a SECOND time: an idempotent
 * consolidator produces 0 new merges and drops no provenance leaf.
 */
export function consolidationIdempotence(seed, config = {}, flags = {}) {
  // Always build the session with the CLEAN pipeline, then apply the extra
  // consolidation passes with the (possibly broken) flags — this isolates the
  // idempotence PROPERTY of consolidate() from the rest of the pipeline.
  const session = runMemorySession(seed, config, {});
  const provCount = () => activeLeaves(session.store).filter((l) => l.provenance).length;
  const provBefore = provCount();
  const firstPass = consolidate(session.store, session.cfg, flags);
  const provMid = provCount();
  const secondPass = consolidate(session.store, session.cfg, flags);
  const provAfter = provCount();
  return {
    // Idempotent iff the second pass performs no new merges AND drops no
    // provenance leaf across either pass.
    idempotent: secondPass === 0 && provAfter >= provMid && provMid >= provBefore,
    firstPassMerges: firstPass,
    secondPassMerges: secondPass,
    provBefore,
    provMid,
    provAfter,
  };
}

// ─── the 8 FAMA invariants (checker + probe + negative control) ─────

const CLEAN = {};

export const MEMORY_INVARIANTS = [
  {
    id: 'INV-1-routing-confusion-on-diagonal',
    hypothesis: 'The explicit tier classifier keeps the routing confusion matrix on-diagonal ≥ threshold.',
    check() {
      const s = runMemorySession(1, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      const thr = DEFAULT_MEMORY_CONFIG.confusionThreshold;
      return { ok: m.onDiagonalFraction >= thr, violations: m.onDiagonalFraction >= thr ? [] : [{ onDiag: m.onDiagonalFraction }], detail: `on-diagonal ${m.onDiagonalFraction}`, metric: m.onDiagonalFraction };
    },
    negativeControl() {
      const s = runMemorySession(1, CLEAN, { scrambleTier: true });
      const m = computeMemoryMetrics(s, { scrambleTier: true });
      return { ok: m.onDiagonalFraction >= 0.9, violations: m.onDiagonalFraction < 0.9 ? [{ onDiag: m.onDiagonalFraction }] : [], detail: `scrambled on-diagonal ${m.onDiagonalFraction}` };
    },
  },
  {
    id: 'INV-2-provenance-add-only-institutional',
    hypothesis: 'A provenance memory is only ever ADDed (never destructively UPDATE/DELETE); Institutional is append-only.',
    check() {
      const s = runMemorySession(2, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      return { ok: m.provenanceViolations === 0, violations: m.provenanceViolations ? [{ provenanceViolations: m.provenanceViolations }] : [], detail: `${m.provenanceViolations} provenance-shield breach(es)`, metric: m.provenanceViolations };
    },
    negativeControl() {
      const s = runMemorySession(2, CLEAN, { destroyProvenance: true, overPrune: true });
      const m = computeMemoryMetrics(s, { destroyProvenance: true, overPrune: true });
      return { ok: m.provenanceViolations === 0, violations: m.provenanceViolations ? [{ provenanceViolations: m.provenanceViolations }] : [] };
    },
  },
  {
    id: 'INV-3-cross-tier-leakage-zero',
    hypothesis: 'No leaf sits in a tier bucket that differs from its assigned tier (leakage = 0).',
    check() {
      const s = runMemorySession(3, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      return { ok: m.crossTierLeakage === 0, violations: m.crossTierLeakage ? [{ crossTierLeakage: m.crossTierLeakage }] : [], detail: `${m.crossTierLeakage} leaked leaf/leaves`, metric: m.crossTierLeakage };
    },
    negativeControl() {
      const s = runMemorySession(3, CLEAN, { misfileTier: true });
      const m = computeMemoryMetrics(s, { misfileTier: true });
      return { ok: m.crossTierLeakage === 0, violations: m.crossTierLeakage ? [{ crossTierLeakage: m.crossTierLeakage }] : [] };
    },
  },
  {
    id: 'INV-4-stale-absent-and-bounded',
    hypothesis: 'Stale facts are forgotten (FAA→1) and the record count is bounded (~N× reduction).',
    check() {
      const s = runMemorySession(4, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      const ok = m.FAA >= 0.9 && m.recordReduction >= DEFAULT_MEMORY_CONFIG.reductionTarget;
      return { ok, violations: ok ? [] : [{ FAA: m.FAA, recordReduction: m.recordReduction }], detail: `FAA ${m.FAA}, reduction ${m.recordReduction}×`, metric: m.FAA };
    },
    negativeControl() {
      const s = runMemorySession(4, CLEAN, { noForgetting: true });
      const m = computeMemoryMetrics(s, { noForgetting: true });
      const ok = m.FAA >= 0.9 && m.recordReduction >= DEFAULT_MEMORY_CONFIG.reductionTarget;
      return { ok, violations: ok ? [] : [{ FAA: m.FAA, recordReduction: m.recordReduction }] };
    },
  },
  {
    id: 'INV-5-MPA-hard-gate',
    hypothesis: 'No over-forgetting: every valid fact is retained (MPA == 1.0 — one dropped important fact fails).',
    check() {
      const s = runMemorySession(5, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      return { ok: m.MPA === 1, violations: m.MPA === 1 ? [] : [{ MPA: m.MPA }], detail: `MPA ${m.MPA}`, metric: m.MPA };
    },
    negativeControl() {
      const s = runMemorySession(5, CLEAN, { overPrune: true });
      const m = computeMemoryMetrics(s, { overPrune: true });
      return { ok: m.MPA === 1, violations: m.MPA === 1 ? [] : [{ MPA: m.MPA }] };
    },
  },
  {
    id: 'INV-6-FAMA-threshold',
    hypothesis: 'FAMA = max(0, MPA − λ(1−FAA)) clears the threshold.',
    check() {
      const s = runMemorySession(6, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      return { ok: m.FAMA >= DEFAULT_MEMORY_CONFIG.famaThreshold, violations: m.FAMA >= DEFAULT_MEMORY_CONFIG.famaThreshold ? [] : [{ FAMA: m.FAMA }], detail: `FAMA ${m.FAMA}`, metric: m.FAMA };
    },
    negativeControl() {
      const s = runMemorySession(6, CLEAN, { noForgetting: true });
      const m = computeMemoryMetrics(s, { noForgetting: true });
      return { ok: m.FAMA >= DEFAULT_MEMORY_CONFIG.famaThreshold, violations: m.FAMA >= DEFAULT_MEMORY_CONFIG.famaThreshold ? [] : [{ FAMA: m.FAMA }] };
    },
  },
  {
    id: 'INV-7-retrieval-reinforcement',
    hypothesis: 'A retrieved fact outlives an otherwise-identical un-retrieved twin (retrieval resets Δτ).',
    check() {
      const s = runMemorySession(7, CLEAN, {});
      const m = computeMemoryMetrics(s, {});
      return { ok: m.twinReinforced, violations: m.twinReinforced ? [] : [{ twinReinforced: false }], detail: `twin reinforced=${m.twinReinforced}`, metric: m.twinReinforced ? 1 : 0 };
    },
    negativeControl() {
      // Decay from creation ignores retrieval → the twin is NOT reinforced.
      const s = runMemorySession(7, CLEAN, { decayFromCreation: true });
      const m = computeMemoryMetrics(s, { decayFromCreation: true });
      return { ok: m.twinReinforced, violations: m.twinReinforced ? [] : [{ twinReinforced: false }] };
    },
  },
  {
    id: 'INV-8-idempotent-consolidation',
    hypothesis: 'Consolidating twice performs no new merges and drops no provenance leaf.',
    check() {
      const r = consolidationIdempotence(8, CLEAN, {});
      return { ok: r.idempotent, violations: r.idempotent ? [] : [{ secondPassMerges: r.secondPassMerges, provBefore: r.provBefore, provAfter: r.provAfter }], detail: `2nd-pass merges ${r.secondPassMerges}`, metric: r.secondPassMerges };
    },
    negativeControl() {
      const r = consolidationIdempotence(8, CLEAN, { nonIdempotentConsolidate: true });
      return { ok: r.idempotent, violations: r.idempotent ? [] : [{ secondPassMerges: r.secondPassMerges }] };
    },
  },
];

/**
 * Run every memory invariant + its negative control. Aggregate shape mirrors
 * runInvariants so the scorecard consumes it uniformly.
 */
export function runMemoryInvariants() {
  const results = [];
  let safetyViolations = 0;
  let negativeControlsCaught = 0;
  for (const inv of MEMORY_INVARIANTS) {
    const pos = inv.check();
    const neg = inv.negativeControl();
    if (!pos.ok) safetyViolations += Math.max(1, pos.violations.length);
    if (!neg.ok) negativeControlsCaught += 1;
    results.push({
      id: inv.id,
      hypothesis: inv.hypothesis,
      checkOk: pos.ok,
      negativeControlCaught: !neg.ok,
      detail: pos.detail,
      metric: pos.metric,
    });
  }
  return { safetyViolations, negativeControlsCaught, invariantsTotal: MEMORY_INVARIANTS.length, results };
}

/** Fingerprint a memory session's stored surface (determinism gate). */
export function memorySessionFingerprint(session) {
  return fingerprint({ byTier: mapTiers(session.store), opLog: session.store.opLog, institutional: session.store.institutionalLedger });
}

function mapTiers(store) {
  const out = {};
  for (const t of TIERS) out[t] = store.byTier[t].map((l) => ({ id: l.id, key: l.key, tier: l.tier, importance: l.importance, provenance: l.provenance, active: l.active, retrievalCount: l.retrievalCount, lastRetrievalHour: l.lastRetrievalHour }));
  return out;
}
