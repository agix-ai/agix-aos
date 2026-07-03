// agix-gbrain.mjs — embedded local knowledge fabric (North Star pillar; AGIX.ONBOARD.1 DL.11).
//
// A ZERO-external-dependency, ZERO-setup knowledge graph: pages with content +
// tags + `[[wikilinks]]`, a maintained backlink index, and keyword/tag relevance
// search. It AUTO-PROVISIONS — the first `putPage()` (or `getGbrain()` access)
// creates its store directory + empty index, so a fresh install never errors and
// no postgres / external service is involved.
//
// This is the `runtime.getGbrain()` surface. It slots beside the runtime's other
// swappable surfaces (`getBus()` / `getMemoryStore()` / `getModel()`) and mirrors
// their exact contract: a real disk-backed client + an in-memory smoke-mode stub,
// chosen by SMOKE mode. The mentor leader agent (lib/agix-mentor.mjs) reads this
// surface for backlinked-precedent evidence (`search` + `getBacklinks`) — the
// criterion the BM25 memory store cannot express because it has no link graph.
//
// STORAGE CHOICE — JSON file store (not node:sqlite). Rationale:
//   - The public pack must run on any Node ≥20 with NO native build and NO flags.
//     `node:sqlite` is still behind `--experimental-sqlite` on most builds and
//     prints a runtime warning — unacceptable for a turnkey onboarding surface.
//   - The corpus this fabric holds (onboarding precedents, decisions, runbook
//     pages) is small (hundreds, not millions of pages); a JSON document loaded
//     once per process is plenty.
//   - The schema is graph-shaped (pages + a backlink adjacency map), which a
//     single JSON document models directly.
// The backing store is a clean seam: a postgres/pgvector-backed implementation can
// replace it later behind the SAME API (the real-gbrain upgrade path) without any
// caller change.
//
// DATA LOCATION — under the runtime's writable output root, never the (possibly
// read-only) install tree. `runtime.outputRoot()` routes dev checkouts in-tree and
// every install to a writable data dir ($AGIX_DATA_DIR / $XDG_STATE_HOME/agix /
// ~/.local/state/agix). The store lives at `<outputRoot>/gbrain/store.json`.
//
// SIMILARITY HONESTY — search ranks by token-overlap + tag-overlap (a lexical
// proxy), returning a bounded score in [0,1]. This is NOT a true semantic
// embedding similarity; the embedding upgrade is the real-gbrain path. The score
// is monotonic and bounded so the mentor-gate's ≥0.7 threshold stays meaningful.

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const STORE_SUBDIR = 'gbrain';
const STORE_FILE = 'store.json';
const SCHEMA_VERSION = 1;

// ─── wikilink extraction ────────────────────────────────────────────────────────
//
// Obsidian-style `[[Target]]` or `[[Target|display text]]`. We key the graph on
// the slugified target (the part before any `|`). Repo convention is bare slugs.

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Slugify a title or link target to a canonical page slug. */
export function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extract the set of outbound link target slugs from `[[wikilinks]]` in content. */
export function extractWikilinks(content) {
  const out = new Set();
  const text = String(content || '');
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const slug = slugify(m[1]);
    if (slug) out.add(slug);
  }
  return [...out];
}

// ─── tokenization + relevance ────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'as', 'by', 'it', 'this', 'that', 'from',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Token/tag-overlap relevance of a page against a query, in [0,1]. A lexical
 * proxy — NOT a semantic embedding. The score is the harmonic-leaning blend of
 * (a) query-coverage: fraction of query tokens present in the page, and
 * (b) tag/title bonus. Bounded, monotonic in overlap, so the mentor-gate ≥0.7
 * threshold is meaningful.
 */
export function relevance(queryTokens, page) {
  const q = queryTokens;
  if (!q.length) return 0;
  const haystack = new Set([
    ...tokenize(page.title),
    ...tokenize(page.content),
    ...(page.tags || []).flatMap((t) => tokenize(t)),
  ]);
  if (haystack.size === 0) return 0;

  let matched = 0;
  let titleMatched = 0;
  const titleTokens = new Set(tokenize(page.title));
  const tagTokens = new Set((page.tags || []).flatMap((t) => tokenize(t)));
  for (const t of new Set(q)) {
    if (haystack.has(t)) {
      matched += 1;
      // Matches in the title or a tag are stronger signal than body-only.
      if (titleTokens.has(t) || tagTokens.has(t)) titleMatched += 1;
    }
  }
  const uniqueQ = new Set(q).size;
  const coverage = matched / uniqueQ;            // [0,1]
  const focus = titleMatched / uniqueQ;          // [0,1] — title/tag emphasis
  // Weight coverage heavily, add a focus bonus; clamp to [0,1].
  const score = 0.75 * coverage + 0.25 * focus;
  return Math.max(0, Math.min(1, score));
}

// ─── the store ────────────────────────────────────────────────────────────────────

/**
 * Resolve the gbrain store directory under the runtime's writable output root.
 * Falls back to the same data-dir logic the runtime uses when no runtime is given
 * (so the store can be constructed standalone in tests / tools).
 */
function resolveStoreDir({ runtime, dir } = {}) {
  if (dir) return dir;
  if (runtime && typeof runtime.outputRoot === 'function') {
    return resolve(runtime.outputRoot(), STORE_SUBDIR);
  }
  const base = process.env.AGIX_DATA_DIR
    || resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'agix');
  return resolve(base, STORE_SUBDIR);
}

/**
 * Embedded JSON-file knowledge fabric. Auto-provisions on first use.
 *
 *   new Gbrain({ runtime })   — store under runtime.outputRoot()/gbrain/
 *   new Gbrain({ dir })       — store under an explicit dir (tests/tools)
 *
 * In-memory state mirrors the on-disk document; writes are atomic (temp + rename).
 */
export class Gbrain {
  constructor({ runtime = null, dir = null } = {}) {
    this.storeDir = resolveStoreDir({ runtime, dir });
    this.storePath = resolve(this.storeDir, STORE_FILE);
    this._doc = null; // { schema, pages: {slug: page}, backlinks: {slug: [slug]} }
  }

  // ─── persistence (lazy + atomic) ──────────────────────────────────────────────

  _load() {
    if (this._doc) return this._doc;
    if (existsSync(this.storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.storePath, 'utf8'));
        this._doc = {
          schema: parsed.schema || SCHEMA_VERSION,
          pages: parsed.pages && typeof parsed.pages === 'object' ? parsed.pages : {},
          backlinks: parsed.backlinks && typeof parsed.backlinks === 'object' ? parsed.backlinks : {},
        };
        return this._doc;
      } catch {
        // Corrupt store — start fresh rather than crash a fresh-ish install.
        this._doc = this._empty();
        return this._doc;
      }
    }
    // Auto-provision: empty store in memory; not flushed until first write.
    this._doc = this._empty();
    return this._doc;
  }

  _empty() {
    return { schema: SCHEMA_VERSION, pages: {}, backlinks: {} };
  }

  _flush() {
    // Auto-provision the directory on first write — never the read-only install tree
    // (storeDir is under the runtime's writable output root).
    mkdirSync(this.storeDir, { recursive: true });
    const tmp = this.storePath + `.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this._doc, null, 2) + '\n');
    renameSync(tmp, this.storePath); // atomic on POSIX
  }

  // ─── backlink index maintenance ───────────────────────────────────────────────

  /** Recompute the full backlink adjacency map from every page's outbound links. */
  _rebuildBacklinks() {
    const doc = this._doc;
    const back = {};
    for (const [from, page] of Object.entries(doc.pages)) {
      for (const to of page.links || []) {
        if (!back[to]) back[to] = [];
        if (!back[to].includes(from)) back[to].push(from);
      }
    }
    doc.backlinks = back;
  }

  // ─── public API ─────────────────────────────────────────────────────────────────

  /**
   * Upsert a page. Links are the union of explicit `links` and `[[wikilinks]]`
   * extracted from `content`. Maintains the backlink index. Auto-provisions on
   * first call.
   *
   * @param {{slug?:string, title:string, content?:string, tags?:string[], links?:string[]}} page
   * @returns {object} the stored page record
   */
  putPage({ slug, title, content = '', tags = [], links = [] } = {}) {
    const doc = this._load();
    const canonicalSlug = slugify(slug || title);
    if (!canonicalSlug) throw new Error('Gbrain.putPage: slug or title is required');

    const extracted = extractWikilinks(content);
    const explicit = (links || []).map(slugify).filter(Boolean);
    const allLinks = [...new Set([...explicit, ...extracted])].filter((l) => l !== canonicalSlug);

    const now = new Date().toISOString();
    const existing = doc.pages[canonicalSlug];
    const record = {
      slug: canonicalSlug,
      title: String(title || slug || canonicalSlug),
      content: String(content || ''),
      tags: (tags || []).filter((t) => typeof t === 'string'),
      links: allLinks,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    doc.pages[canonicalSlug] = record;
    this._rebuildBacklinks();
    this._flush();
    return record;
  }

  /** Add a directed link from→to and re-index. Both pages need not exist yet. */
  addLink(from, to) {
    const doc = this._load();
    const f = slugify(from);
    const t = slugify(to);
    if (!f || !t || f === t) return false;
    const page = doc.pages[f];
    if (!page) {
      // Create a stub page so the link is durable even before content lands.
      doc.pages[f] = {
        slug: f, title: from, content: '', tags: [], links: [t],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    } else if (!page.links.includes(t)) {
      page.links.push(t);
      page.updated_at = new Date().toISOString();
    } else {
      return false; // already linked
    }
    this._rebuildBacklinks();
    this._flush();
    return true;
  }

  /** Fetch a page by slug (or a title that slugifies to one). null if absent. */
  getPage(slugOrTitle) {
    const doc = this._load();
    return doc.pages[slugify(slugOrTitle)] || null;
  }

  /** All pages as an array (insertion-agnostic; sorted by slug for determinism). */
  listPages() {
    const doc = this._load();
    return Object.values(doc.pages).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Pages that link TO `slug`. Returns the full page records of the linkers,
   * sorted by slug. Empty array if none (never throws).
   */
  getBacklinks(slugOrTitle) {
    const doc = this._load();
    const slug = slugify(slugOrTitle);
    const linkers = doc.backlinks[slug] || [];
    return linkers
      .map((s) => doc.pages[s])
      .filter(Boolean)
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Keyword/tag relevance search. Returns up to `limit` pages ranked by a bounded
   * [0,1] relevance proxy, highest first, each as { score, page }. Pages with
   * zero overlap are dropped.
   *
   * @param {string} query
   * @param {{limit?:number}} [opts]
   * @returns {Array<{score:number, slug:string, title:string, tags:string[], page:object}>}
   */
  search(query, { limit = 10 } = {}) {
    const doc = this._load();
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const ranked = [];
    for (const page of Object.values(doc.pages)) {
      const score = relevance(tokens, page);
      if (score > 0) {
        ranked.push({ score, slug: page.slug, title: page.title, tags: page.tags, page });
      }
    }
    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Corpus statistics. Auto-provisions (returns zeros on a fresh store). */
  stats() {
    const doc = this._load();
    const pages = Object.values(doc.pages);
    const linkCount = pages.reduce((s, p) => s + (p.links?.length || 0), 0);
    const backlinkedSlugs = Object.keys(doc.backlinks).filter((s) => (doc.backlinks[s] || []).length > 0);
    return {
      pages: pages.length,
      links: linkCount,
      backlinked_pages: backlinkedSlugs.length,
      store_path: this.storePath,
      schema: doc.schema,
    };
  }
}

// ─── smoke-mode stub ──────────────────────────────────────────────────────────────
//
// In-memory, no disk — mirrors the bus / memory-store stub contract so smoke runs
// and tests need no filesystem. Same method names + shapes as the real Gbrain.

export function createGbrainStub() {
  const pages = new Map();      // slug -> page
  const backlinks = new Map();  // slug -> Set(from)

  function rebuild() {
    backlinks.clear();
    for (const [from, page] of pages) {
      for (const to of page.links || []) {
        if (!backlinks.has(to)) backlinks.set(to, new Set());
        backlinks.get(to).add(from);
      }
    }
  }

  return {
    smoke: true,
    putPage({ slug, title, content = '', tags = [], links = [] } = {}) {
      const canonical = slugify(slug || title);
      if (!canonical) throw new Error('Gbrain(stub).putPage: slug or title is required');
      const extracted = extractWikilinks(content);
      const explicit = (links || []).map(slugify).filter(Boolean);
      const allLinks = [...new Set([...explicit, ...extracted])].filter((l) => l !== canonical);
      const now = new Date().toISOString();
      const existing = pages.get(canonical);
      const record = {
        slug: canonical, title: String(title || slug || canonical), content: String(content || ''),
        tags: (tags || []).filter((t) => typeof t === 'string'), links: allLinks,
        created_at: existing?.created_at || now, updated_at: now,
      };
      pages.set(canonical, record);
      rebuild();
      return record;
    },
    addLink(from, to) {
      const f = slugify(from); const t = slugify(to);
      if (!f || !t || f === t) return false;
      let page = pages.get(f);
      if (!page) {
        page = { slug: f, title: from, content: '', tags: [], links: [t], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        pages.set(f, page);
      } else if (!page.links.includes(t)) {
        page.links.push(t);
      } else {
        return false;
      }
      rebuild();
      return true;
    },
    getPage(slugOrTitle) { return pages.get(slugify(slugOrTitle)) || null; },
    listPages() { return [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug)); },
    getBacklinks(slugOrTitle) {
      const slug = slugify(slugOrTitle);
      const set = backlinks.get(slug) || new Set();
      return [...set].map((s) => pages.get(s)).filter(Boolean).sort((a, b) => a.slug.localeCompare(b.slug));
    },
    search(query, { limit = 10 } = {}) {
      const tokens = tokenize(query);
      if (tokens.length === 0) return [];
      const ranked = [];
      for (const page of pages.values()) {
        const score = relevance(tokens, page);
        if (score > 0) ranked.push({ score, slug: page.slug, title: page.title, tags: page.tags, page });
      }
      return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    stats() {
      const ps = [...pages.values()];
      return {
        pages: ps.length,
        links: ps.reduce((s, p) => s + (p.links?.length || 0), 0),
        backlinked_pages: [...backlinks.keys()].filter((s) => (backlinks.get(s)?.size || 0) > 0).length,
        store_path: '(smoke — in-memory)',
        schema: SCHEMA_VERSION,
        smoke: true,
      };
    },
  };
}

/** Factory the runtime calls: real disk-backed client unless SMOKE=1. */
export function getGbrain({ runtime = null, dir = null } = {}) {
  return process.env.SMOKE === '1' ? createGbrainStub() : new Gbrain({ runtime, dir });
}
