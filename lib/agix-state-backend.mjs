// agix-state-backend — Q0 cloud multi-tenant state adapter.
//
// Sprint 0 of docs/dev-backlog/2026-05-19-agix-runtime-extensions.md.
// The runtime's state surface (`readState` / `writeState` / `statePath`)
// gains a pluggable backend so the same agent code runs against the
// local filesystem (today) or a multi-tenant cloud store (Firestore,
// per docs/dev-backlog/consumer-workspace-build/02-data-model-runtime-persistence.md).
//
// Key structure everywhere:
//
//   tenants/{tenant_id}/agents/{agent}/state/{name}                      (no Dojo)
//   tenants/{tenant_id}/dojos/{dojo_id}/agents/{agent}/state/{name}      (Dojo-scoped)
//
// Isolation is structural: every read/write resolves its document path
// from the runtime's own (tenantId, dojoId, agentName) — there is no
// API that takes a foreign tenant's path. IDs are validated so path
// traversal (`..`, `/`) cannot widen the namespace.
//
// State documents are opaque JSON blobs (the existing local contract is
// "one JSON file per state name"); Firestore stores them as a single
// `json` string field rather than mapped Firestore types, keeping local
// and cloud semantics byte-identical. Firestore's 1 MiB document limit
// applies; state names that need more belong in GCS, not state.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeId(id, label) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(
      `${label} "${id}" is not a valid identifier — expected /${SAFE_ID.source}/ ` +
      `(no slashes, dots, or path traversal).`,
    );
  }
  return id;
}

// Resolve the canonical document path segments for a state document.
// Single source of truth for both backends and for LocalRuntime's
// Dojo-scoped file layout.
export function stateDocSegments({ tenantId, dojoId = null, agent, name }) {
  assertSafeId(tenantId, 'tenantId');
  assertSafeId(agent, 'agent');
  assertSafeId(name, 'state name');
  if (dojoId !== null) assertSafeId(dojoId, 'dojoId');
  return dojoId === null
    ? ['tenants', tenantId, 'agents', agent, 'state', name]
    : ['tenants', tenantId, 'dojos', dojoId, 'agents', agent, 'state', name];
}

// ─── In-memory backend ─────────────────────────────────────────────────
//
// Reference implementation of the backend contract. Used by tests and
// usable as a dev/ephemeral store. Isolation semantics are identical to
// Firestore's: the key is the full tenant/dojo path.

export class MemoryStateBackend {
  constructor() {
    this._docs = new Map();
  }

  async read(scope, fallback = null) {
    const key = stateDocSegments(scope).join('/');
    if (!this._docs.has(key)) return fallback;
    try {
      return JSON.parse(this._docs.get(key));
    } catch {
      return fallback;
    }
  }

  async write(scope, data) {
    const key = stateDocSegments(scope).join('/');
    this._docs.set(key, JSON.stringify(data));
    return `mem://${key}`;
  }
}

// ─── Firestore backend (REST, dependency-free) ────────────────────────
//
// Talks to the Firestore REST API directly so the agents pack adds no
// SDK weight. Auth is injected: `tokenProvider` is any async () => token
// (e.g. google-auth-library's getAccessToken, or the metadata server on
// Cloud Run). `fetchImpl` is injectable for tests.

export class FirestoreStateBackend {
  constructor({ projectId, databaseId = '(default)', tokenProvider, fetchImpl } = {}) {
    if (!projectId) throw new Error('FirestoreStateBackend: projectId is required');
    if (typeof tokenProvider !== 'function') {
      throw new Error('FirestoreStateBackend: tokenProvider must be an async function returning an access token');
    }
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  _docUrl(scope) {
    const path = stateDocSegments(scope).join('/');
    return (
      `https://firestore.googleapis.com/v1/projects/${this.projectId}` +
      `/databases/${this.databaseId}/documents/${path}`
    );
  }

  async _headers() {
    const token = await this.tokenProvider();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async read(scope, fallback = null) {
    const res = await this.fetchImpl(this._docUrl(scope), {
      method: 'GET',
      headers: await this._headers(),
    });
    if (res.status === 404) return fallback;
    if (!res.ok) {
      throw new Error(`FirestoreStateBackend.read: ${res.status} for ${stateDocSegments(scope).join('/')}`);
    }
    const doc = await res.json();
    const raw = doc?.fields?.json?.stringValue;
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async write(scope, data) {
    const url = this._docUrl(scope);
    const body = JSON.stringify({
      fields: {
        json: { stringValue: JSON.stringify(data) },
        updated_at: { timestampValue: new Date().toISOString() },
      },
    });
    const res = await this.fetchImpl(`${url}?updateMask.fieldPaths=json&updateMask.fieldPaths=updated_at`, {
      method: 'PATCH',
      headers: await this._headers(),
      body,
    });
    if (!res.ok) {
      throw new Error(`FirestoreStateBackend.write: ${res.status} for ${stateDocSegments(scope).join('/')}`);
    }
    return url;
  }
}

// ─── Smoke backend ─────────────────────────────────────────────────────
//
// Symmetric to the local runtime's smoke write-sandbox: writes land in
// an in-process map (never the real store) and are logged; reads return
// the fallback so smoke runs require no cloud credentials and observe
// no production state. Conservative on purpose — a smoke run must be
// runnable on a fresh machine with zero config.

export function makeSmokeStateBackend() {
  const sandbox = new MemoryStateBackend();
  return {
    smoke: true,
    async read(scope, fallback = null) {
      // Smoke reads see only what the smoke run itself wrote.
      return sandbox.read(scope, fallback);
    },
    async write(scope, data) {
      const key = stateDocSegments(scope).join('/');
      console.error(`  [smoke] would write cloud state · ${key}`);
      await sandbox.write(scope, data);
      return `smoke://${key}`;
    },
  };
}
