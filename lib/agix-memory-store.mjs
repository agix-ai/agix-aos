// agix-memory-store — Q1 memory primitive (Sprint 1, redirected 2026-05-19).
//
// The Agix-owned seam: `runtime.getMemoryStore()` returns this store;
// the backing implementation is a thin Agix-native L0 (raw session
// capture) + naïve BM25 recall — chosen over vendoring the OpenClaw
// plugin per the Sprint 1 redirect (the plugin exports only its
// gateway `register`; the internals aren't a public API). L1/L2/L3
// (fact extraction, scene induction, persona) are deferred to
// research-driven Agix-shaped versions.
//
// Success criterion (reframed per the North Star refinement): can the
// operator close a Sensei session and resume it tomorrow grounded in
// what was decided yesterday? Token reduction is a secondary metric.
//
// Storage rides the runtime's tenant/dojo-keyed state contract (one
// state document, `memory-l0`) — so memory is automatically scoped per
// tenant, per Dojo, per agent, local or cloud, with no new
// infrastructure. Records are raw text captures with tags; recall is
// lexical BM25, deterministic and dependency-free.

const STATE_NAME = 'memory-l0';
const MAX_RECORDS = 500; // L0 retention cap; oldest evicted first.

export class MemoryStore {
  constructor({ runtime }) {
    if (!runtime) throw new Error('MemoryStore: runtime is required');
    this.runtime = runtime;
  }

  async _load() {
    const doc = await this.runtime.readState(STATE_NAME, { records: [] });
    return Array.isArray(doc?.records) ? doc.records : [];
  }

  async _save(records) {
    await this.runtime.writeState(STATE_NAME, { records });
  }

  /**
   * L0 capture. Stores one raw memory record.
   *   { text, tags = [], session_id = null, meta = {} }
   * Returns the stored record (with id + ts).
   */
  async offload({ text, tags = [], session_id = null, meta = {} } = {}) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('MemoryStore.offload: text is required');
    }
    const records = await this._load();
    const record = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      text: text.trim(),
      tags: tags.filter((t) => typeof t === 'string'),
      session_id,
      meta,
    };
    records.push(record);
    // Evict oldest beyond the cap.
    while (records.length > MAX_RECORDS) records.shift();
    await this._save(records);
    return record;
  }

  /**
   * Naïve recall: BM25 over the record corpus, optionally filtered by
   * tags (a record matches when it carries every requested tag).
   * Returns up to `k` records, highest score first, each as
   * { score, ...record }. Empty/contentless queries return [].
   */
  async recall({ query, k = 5, tags = [] } = {}) {
    const terms = tokenize(query || '');
    if (terms.length === 0) return [];
    let records = await this._load();
    if (tags.length) {
      records = records.filter((r) => tags.every((t) => r.tags.includes(t)));
    }
    if (records.length === 0) return [];
    const scored = bm25(terms, records);
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

// Smoke-mode stub, symmetric to the state-backend stub: fully
// in-process (offload + recall work within the smoke run), nothing
// persisted, offloads logged so the operator sees what would land.
export function makeSmokeMemoryStore() {
  const records = [];
  return {
    smoke: true,
    async offload({ text, tags = [], session_id = null, meta = {} } = {}) {
      const record = {
        id: `mem-smoke-${records.length}`,
        ts: new Date().toISOString(),
        text: String(text || '').trim(),
        tags, session_id, meta,
      };
      console.error(`  [smoke] would offload memory · ${record.text.slice(0, 60)}…`);
      records.push(record);
      return record;
    },
    async recall({ query, k = 5, tags = [] } = {}) {
      const terms = tokenize(query || '');
      if (terms.length === 0) return [];
      let pool = records;
      if (tags.length) pool = pool.filter((r) => tags.every((t) => r.tags.includes(t)));
      if (pool.length === 0) return [];
      return bm25(terms, pool)
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}

// ─── BM25 (Okapi, k1=1.5 b=0.75) ───────────────────────────────────────

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function bm25(queryTerms, records, k1 = 1.5, b = 0.75) {
  const docs = records.map((r) => tokenize(`${r.text} ${r.tags.join(' ')}`));
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  // Document frequency per query term.
  const df = new Map();
  for (const term of new Set(queryTerms)) {
    df.set(term, docs.filter((d) => d.includes(term)).length);
  }
  return records.map((record, i) => {
    const doc = docs[i];
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const n = df.get(term) || 0;
      if (n === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const f = tf.get(term) || 0;
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.length / avgLen)));
    }
    return { score, ...record };
  });
}
