// agix-audit-ledger — the append-only, per-tenant governance ledger.
//
// The substrate for the loop-engineered SDLC (LOOP_ENGINEERED_SDLC.md §5) and
// the release/GTM layer (RELEASE_GTM_MANAGEMENT.md). Every gate decision,
// verifier verdict, held-out result, lease grant, merge, release, version bump,
// and launch is an append-only entry. **You cannot learn priors you did not
// record** — this is the L2 substrate the umbrella loop reads to compute DORA +
// the agentic gate metrics across runs.
//
// Relationship to the existing run-event (MULTI_LEVEL_ENTERPRISE_AOS_SPEC §1.3):
// the runtime's `_beginRunEvent` (agix-runtime.mjs:731) already emits an
// immutable per-agent telemetry record (models_used, totals, outputs_summary).
// This ledger EXTENDS that seed with the governance fields the multi-level spec
// adds (scope, actor, authority_used, inputs_hash, verifier, verdict,
// overridden_by_human) and RE-TARGETS it to a per-tenant append-only log keyed
// by the canonical governance key. It does not duplicate the run-event's
// telemetry — a ledger entry references a run (via scope.runId) and records the
// *governance* facts about it. Telemetry stays per-agent; the ledger is the
// per-tenant system of record.
//
// Scope + isolation reuse the state-backend contract (agix-state-backend.mjs):
// the canonical key nests
//   enterprises/{ent}/users/{u}/roles/{r}/mandates/{m}/runs/{run}
// (MULTI_LEVEL_ENTERPRISE_AOS_SPEC §3.1). A single-operator install collapses to
// the degenerate depth-1 path `tenants/agix/ledger` — byte-compatible with
// today's `tenants/agix/...` layout. Isolation is structural: a ledger instance
// is bound to one enterprise at construction; no API accepts a foreign
// enterprise, and every id is validated so path traversal cannot widen scope.
//
// Determinism: the core takes an injected `clock()` (→ ISO-8601 string) and
// `idgen()` (→ entry_id) — the same dependency-injection seam the runtime uses
// for uuidv7 + timestamps. No bare `Date.now()` / `Math.random()` lives in the
// entry-shaping logic, so a test can pin both and get byte-identical entries.

import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeId } from './agix-state-backend.mjs';
import { uuidv7 } from './model-adapters/uuid.mjs';

// The kinds of governed event the ledger records. Closed set on purpose — an
// unknown kind is a bug in the caller, not a thing to silently accept (you
// cannot learn priors from mis-recorded history).
export const LEDGER_KINDS = Object.freeze([
  'gate_decision',   // a gate ran (LOOP_ENGINEERED_SDLC §2)
  'verdict',         // a verifier's verdict on an actor's output
  'merge',           // Integrate gate: merge record + DORA lead-time stamp
  'lease',           // coordination control plane: a file/branch lease grant
  'release',         // Release gate: deploy stamp (RELEASE_GTM §2.1)
  'version_bump',    // version-manager: SemVer/CalVer assignment (RELEASE_GTM §2.2)
  'launch',          // gtm-advisor: launch tier / GA (RELEASE_GTM §2.3)
]);

// Verdict vocabulary. Gate decisions use the Stage-Gate four
// (LOOP_ENGINEERED_SDLC §2); verifier verdicts use the pass/fail/unverified
// triple (MULTI_LEVEL_ENTERPRISE_AOS_SPEC §1.3). The ledger accepts either
// union so a single `verdict` field serves both kinds.
export const VERDICTS = Object.freeze(['GO', 'KILL', 'HOLD', 'RECYCLE']);
export const VERIFICATIONS = Object.freeze(['pass', 'fail', 'unverified']);
const ALL_VERDICTS = new Set([...VERDICTS, ...VERIFICATIONS]);

// ─── Canonical key ─────────────────────────────────────────────────────
//
// The per-enterprise ledger document key. The entry itself carries the full
// governance scope (users/roles/mandates/runs); the physical log is one
// append-only stream per enterprise (the "org system of record"). Degenerate
// single-operator (`enterpriseId==='agix'`) → `tenants/agix/ledger`, matching
// today's local layout.

export function ledgerDocSegments({ enterpriseId }) {
  assertSafeId(enterpriseId, 'enterpriseId');
  return ['tenants', enterpriseId, 'ledger'];
}

// Validate + normalize the governance scope carried on every entry. Only
// enterpriseId is required (it names the ledger); the deeper segments are
// present as the scope deepens toward a Run. Each provided id is validated so a
// malformed scope can never be appended (and so a read filter can't traverse).
function normalizeScope(scope, { requireEnterprise = true } = {}) {
  const s = scope || {};
  const out = {};
  if (s.enterpriseId !== undefined && s.enterpriseId !== null) {
    out.enterpriseId = assertSafeId(s.enterpriseId, 'enterpriseId');
  } else if (requireEnterprise) {
    throw new Error('audit-ledger: scope.enterpriseId is required');
  }
  for (const key of ['userId', 'roleId', 'mandateId', 'runId']) {
    if (s[key] !== undefined && s[key] !== null) out[key] = assertSafeId(s[key], `scope.${key}`);
  }
  return out;
}

// Does an entry's scope satisfy a (possibly partial) filter scope? Every field
// the filter names must match exactly; unspecified fields are wildcards. Lets a
// caller read "all entries for this mandate" or "this run" or "this role".
function scopeMatches(entryScope, filterScope) {
  if (!filterScope) return true;
  for (const key of ['enterpriseId', 'userId', 'roleId', 'mandateId', 'runId']) {
    if (filterScope[key] !== undefined && filterScope[key] !== null) {
      if (entryScope?.[key] !== filterScope[key]) return false;
    }
  }
  return true;
}

// ─── Storage backends (pluggable, symmetric to agix-state-backend) ─────
//
// A store speaks two operations on a JSONL key:
//   append(segments, line)  → append one JSON line (atomic; never drops)
//   readLines(segments)     → string[] of the appended JSON lines (in order)
// Lines are opaque JSON strings so the "JSONL" contract is literal on disk.

// In-memory reference store. Used by tests + as a dev/ephemeral ledger.
// Isolation semantics are identical to the file store: the full key path is the
// namespace.
export class MemoryLedgerStore {
  constructor() {
    this._logs = new Map();
  }

  _key(segments) {
    return segments.join('/');
  }

  async append(segments, line) {
    const key = this._key(segments);
    if (!this._logs.has(key)) this._logs.set(key, []);
    this._logs.get(key).push(line);
    return `mem://${key}`;
  }

  async readLines(segments) {
    return (this._logs.get(this._key(segments)) || []).slice();
  }
}

// File-backed JSONL store. Appends land under `<root>/<segments>.jsonl` via a
// single O_APPEND write per entry (atomic for a lone line; never truncates —
// the log is append-only by construction, there is no code path that rewrites
// it). `fsImpl` is injectable for tests; defaults to node:fs/promises.
export class FileLedgerStore {
  constructor({ root, fsImpl } = {}) {
    if (!root) throw new Error('FileLedgerStore: root is required');
    this.root = resolve(root);
    this._appendFile = fsImpl?.appendFile || appendFile;
    this._readFile = fsImpl?.readFile || readFile;
    this._mkdir = fsImpl?.mkdir || mkdir;
  }

  _path(segments) {
    return resolve(this.root, ...segments) + '.jsonl';
  }

  async append(segments, line) {
    const path = this._path(segments);
    await this._mkdir(dirname(path), { recursive: true });
    // Single append write; the trailing newline makes each entry one JSONL row.
    await this._appendFile(path, line + '\n');
    return path;
  }

  async readLines(segments) {
    const path = this._path(segments);
    let raw;
    try {
      raw = await this._readFile(path, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];  // no ledger yet = empty
      throw err;
    }
    return raw.split('\n').filter((l) => l.trim().length > 0);
  }
}

// Smoke store: symmetric to the runtime's smoke sandboxes. Writes land in an
// in-process map (never a real ledger) and are logged; reads see only what the
// smoke run itself wrote. A smoke run must be runnable on a fresh machine with
// zero config and must never mutate the real system of record.
export function makeSmokeLedgerStore() {
  const sandbox = new MemoryLedgerStore();
  return {
    smoke: true,
    async append(segments, line) {
      console.error(`  [smoke] would append audit entry · ${segments.join('/')}`);
      await sandbox.append(segments, line);
      return `smoke://${segments.join('/')}`;
    },
    async readLines(segments) {
      return sandbox.readLines(segments);
    },
  };
}

// ─── The ledger ────────────────────────────────────────────────────────

export class AuditLedger {
  // `scope` binds this ledger to one enterprise (structural isolation — no
  // method takes a foreign enterprise). `store` is any backend above. `clock`
  // returns an ISO-8601 string; `idgen` returns an entry_id — both injected so
  // the core is deterministic under test.
  constructor({ scope, store, clock, idgen } = {}) {
    const bound = normalizeScope(scope);
    if (!bound.enterpriseId) throw new Error('AuditLedger: scope.enterpriseId is required');
    this.scope = bound;
    this.store = store || new MemoryLedgerStore();
    this.clock = clock || (() => new Date().toISOString());
    this.idgen = idgen || uuidv7;
    this._segments = ledgerDocSegments({ enterpriseId: bound.enterpriseId });
  }

  // Append one governed event. Atomic + never drops: the entry is shaped, its
  // kind + verdict + scope validated, then handed to the store's single append.
  // The full stored entry (with entry_id + ts filled) is returned so a caller
  // can reference it. Throws on an invalid kind/verdict/scope rather than
  // silently recording garbage — mis-recorded history poisons the L2 priors.
  async append(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('audit-ledger: entry must be an object');
    const kind = entry.kind;
    if (!LEDGER_KINDS.includes(kind)) {
      throw new Error(`audit-ledger: unknown kind "${kind}" (expected one of ${LEDGER_KINDS.join(', ')})`);
    }
    if (entry.verdict !== undefined && entry.verdict !== null && !ALL_VERDICTS.has(entry.verdict)) {
      throw new Error(`audit-ledger: unknown verdict "${entry.verdict}"`);
    }
    // The entry's scope defaults to (and cannot exceed enterprise-out-of) the
    // bound scope: the enterprise is fixed; deeper segments come from the entry.
    const entryScope = normalizeScope({ ...this.scope, ...(entry.scope || {}) });
    if (entryScope.enterpriseId !== this.scope.enterpriseId) {
      throw new Error('audit-ledger: entry scope may not name a foreign enterprise');
    }

    const record = {
      entry_id: entry.entry_id || this.idgen(),
      ts: entry.ts || this.clock(),
      scope: entryScope,
      actor: entry.actor ?? null,
      phase: entry.phase ?? null,
      kind,
      verifier: entry.verifier ?? null,
      verdict: entry.verdict ?? null,
      authority_used: entry.authority_used ?? null,
      inputs_hash: entry.inputs_hash ?? null,
      cost: entry.cost ?? null,
      overridden_by_human: entry.overridden_by_human ?? false,
    };
    // Anything extra the caller attached (e.g. gate name, reason, held-out gap)
    // rides along under `meta` so the closed schema stays stable.
    if (entry.meta !== undefined) record.meta = entry.meta;

    await this.store.append(this._segments, JSON.stringify(record));
    return record;
  }

  // Read entries, optionally filtered by (partial) scope, kind, and a `since`
  // ISO timestamp (inclusive lower bound on `ts`). Returns them in append order.
  async read({ scope, kind, since } = {}) {
    const filterScope = scope ? normalizeScope(scope, { requireEnterprise: false }) : null;
    if (filterScope?.enterpriseId && filterScope.enterpriseId !== this.scope.enterpriseId) {
      // A read can never cross the bound enterprise.
      return [];
    }
    const lines = await this.store.readLines(this._segments);
    const out = [];
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }  // tolerate a torn tail line
      if (kind && e.kind !== kind) continue;
      if (!scopeMatches(e.scope, filterScope)) continue;
      if (since && !(e.ts >= since)) continue;
      out.push(e);
    }
    return out;
  }

  // Governance rollup for the L2 umbrella loop: counts by kind + verdict +
  // phase, plus the DORA + gate metrics (delegated to agix-dora.mjs, pure over
  // the same entries). `scope` narrows the rollup (e.g. one role's seat).
  async stats({ scope } = {}) {
    const { computeDora, gateMetrics } = await import('./agix-dora.mjs');
    const entries = await this.read({ scope });
    const byKind = {};
    const byVerdict = {};
    const byPhase = {};
    for (const e of entries) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      if (e.verdict) byVerdict[e.verdict] = (byVerdict[e.verdict] || 0) + 1;
      if (e.phase) byPhase[e.phase] = (byPhase[e.phase] || 0) + 1;
    }
    return {
      total: entries.length,
      byKind,
      byVerdict,
      byPhase,
      dora: computeDora(entries),
      gates: gateMetrics(entries),
    };
  }
}
