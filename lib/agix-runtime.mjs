// agix-runtime — runtime interface + local adapter implementation.
//
// Phase 1 of architecture/03-ai-ml/agent-architecture/AGENT_RUNTIME_ARCHITECTURE.md.
// Single-tenant local runtime — `agix` is the implicit tenant. Multi-tenancy
// arrives in Phase 3.
//
// Agent contract: each agent at `agents/<name>/agent.mjs` exports `run({
// runtime, opts })`. The runtime supplies every platform-specific surface:
// Anthropic client, Workspace auth, email send, file paths, state I/O.
// Agent code never touches `~/.config/agix/`, never calls `bin/agix-send`,
// never instantiates GoogleAuth directly — all that is the runtime's job.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

import { sanitizeGoogleEnv, getImpersonatedOAuth2Client } from './agix-google-auth.mjs';
import { sendEmail, loadEnv as loadEnvFile } from './agix-send.mjs';
import { Model } from './agix-model.mjs';
import { makeSmokeModelStub } from './model-adapters/smoke.mjs';
import { assertSafeId, stateDocSegments, makeSmokeStateBackend } from './agix-state-backend.mjs';
import { MemoryStore, makeSmokeMemoryStore } from './agix-memory-store.mjs';
import { AuditLedger, FileLedgerStore, makeSmokeLedgerStore } from './agix-audit-ledger.mjs';
import { defineGraph } from './agix-state-graph.mjs';
import { MCPClient, makeSmokeMCPClient } from './agix-mcp-client.mjs';
import { createBus, createBusStub } from './agix-bus.mjs';
import { Gbrain, createGbrainStub } from './agix-gbrain.mjs';
import { currentActor } from './agix-identity.mjs';
import { checkAuthority } from './agix-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const CONFIG_DIR = resolve(homedir(), '.config/agix');
const ANTHROPIC_ENV_PATH = resolve(CONFIG_DIR, 'anthropic.env');

// ─── Dev-vs-install probe + user agents dir (install-write safety) ───
//
// USER-generated agents (`agix agent new`) must NOT land in the pack's install
// tree: a Homebrew Cellar libexec is wiped on `brew upgrade`, and a Linux/root
// install is read-only (the create would crash). So generated agents go to a
// user-writable, upgrade-safe, DISCOVERABLE dir — the same class of fix as
// outputRoot()'s read-only-install fallback.
//
// The signal is "dev checkout?" (has .git at repoRoot), NOT "is the tree
// writable?" — a macOS Cellar is user-WRITABLE but still gets wiped on upgrade.
// The .git probe routes a DEV checkout → in-tree agents/ (the built-in dev
// workflow: a freshly-generated agent shows up in the repo the developer is
// hacking on) and every INSTALL → the user agents dir.

// True when running from a dev checkout (repo has a .git entry), false on an
// installed pack (Homebrew/npm-global/tarball). Exported so bin/agix routes
// `agix agent new` to the same place discovery scans.
export function isDevCheckout(repoRoot = REPO_ROOT) {
  return existsSync(resolve(repoRoot, '.git'));
}

// The USER-writable agents dir, config-like so it persists across upgrades:
//   $AGIX_USER_AGENTS_DIR  (explicit override — used by tests + power users)
//   else  <$AGIX_CONFIG_DIR | ~/.config/agix>/agents/
// Auto-created by callers before writing. Reads tolerate its absence.
export function userAgentsDir() {
  if (process.env.AGIX_USER_AGENTS_DIR) return resolve(process.env.AGIX_USER_AGENTS_DIR);
  const configDir = process.env.AGIX_CONFIG_DIR || CONFIG_DIR;
  return resolve(configDir, 'agents');
}

// Where `agix agent new` should write: the pack's in-tree agents/ on a DEV
// checkout, the user agents dir on every INSTALL. One rule, used by the CLI;
// discovery (findAllAgents) scans BOTH regardless so a freshly-generated user
// agent is immediately listable / runnable / smokeable.
export function newAgentTargetDir({ repoRoot = REPO_ROOT } = {}) {
  return isDevCheckout(repoRoot) ? resolve(repoRoot, 'agents') : userAgentsDir();
}
const OPENAI_ENV_PATH = resolve(CONFIG_DIR, 'openai.env');
const GEMINI_ENV_PATH = resolve(CONFIG_DIR, 'gemini.env');
// OpenAI-compatible hosted gateways (see lib/model-adapters/openrouter.mjs +
// the groq/mistral wiring in lib/agix-model.mjs). Keys load lazily like the
// others — a missing key only fails when a call actually routes there.
const OPENROUTER_ENV_PATH = resolve(CONFIG_DIR, 'openrouter.env');
const GROQ_ENV_PATH = resolve(CONFIG_DIR, 'groq.env');
const MISTRAL_ENV_PATH = resolve(CONFIG_DIR, 'mistral.env');

// Tracks which agents have already received the `getAnthropicClient`
// deprecation warning so we only print once per agent per process.
const _deprecationWarned = new Set();

export class LocalRuntime {
  constructor({
    tenantId = 'agix', dojoId = null, agentName, repoRoot = REPO_ROOT,
    smoke = false, stateBackend = null, budget = null,
  } = {}) {
    sanitizeGoogleEnv();
    assertSafeId(tenantId, 'tenantId');
    if (dojoId !== null) assertSafeId(dojoId, 'dojoId');
    this.tenantId = tenantId;
    // Q0 multi-tenancy: `dojoId` is the per-workspace sub-namespace
    // inside a tenant (tenant = account, dojo = workspace). Absent =
    // today's single-tenant behavior, byte-identical paths. See
    // docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 0.
    this.dojoId = dojoId;
    this.agentName = agentName;
    this.repoRoot = repoRoot;
    this.smoke = smoke;
    this.configDir = CONFIG_DIR;
    // Q0: optional pluggable state backend (Firestore / memory). When
    // present, readState/writeState/statePath route through it instead
    // of the local filesystem. Smoke mode swaps in the smoke backend so
    // cloud-backed smoke runs need no credentials and touch no prod state.
    this.stateBackend = stateBackend && smoke ? makeSmokeStateBackend() : stateBackend;
    // Token/cost budget for this run: { max_cost_usd?, max_tokens? }.
    // Enforced structurally by the Model dispatcher (checkBudget before
    // every call); spend accrues via recordModelCall. Null = unlimited.
    this.budget = budget;
    this._spend = { cost_usd: 0, tokens: 0 };
    // Per-agent cache root. Phase 3 inserts `/<tenant_id>` between the
    // agent slug and `state.json` etc.; for now everything lives under the
    // implicit `agix` tenant.
    this.cacheDir = agentName
      ? resolve(homedir(), `.cache/agix-${agentName}`)
      : resolve(homedir(), '.cache/agix');
    // Smoke mode redirects every destructive write to a sandbox path
    // so the run validates code paths + auth + config without producing
    // real artifacts (no emails, no journal appends, no agent fires,
    // no Anthropic tokens burned).
    this.smokeWriteRoot = resolve(this.cacheDir, 'smoke');
  }

  // ─── Filesystem prep ─────────────────────────────────────────────

  async ensureDirs(extra = []) {
    await mkdir(this.configDir, { recursive: true });
    await mkdir(this.cacheDir, { recursive: true });
    for (const p of extra) await mkdir(p, { recursive: true });
  }

  // ─── Config + secrets ────────────────────────────────────────────

  // Read a `~/.config/agix/<name>.env` file into a parsed { KEY: value }.
  // Per-tenant: `~/.config/agix/<tenant_id>/<name>.env` overrides the root
  // (Phase 3 will use this exclusively).
  readEnvFile(name, { required = false } = {}) {
    const tenantPath = resolve(this.configDir, this.tenantId, `${name}.env`);
    const rootPath = resolve(this.configDir, `${name}.env`);
    if (existsSync(tenantPath)) return loadEnvFile(tenantPath, false);
    if (existsSync(rootPath)) return loadEnvFile(rootPath, false);
    if (required) {
      throw new Error(
        `Missing ${rootPath}. ` +
        `See docs/operations/${this.agentName || 'agix'}-setup.md.`
      );
    }
    return {};
  }

  // Anthropic client; cached per runtime instance.
  // Smoke mode: returns a stub that simulates the SDK surface without
  // making API calls. Each method returns canned shapes shaped enough
  // for agents to traverse without crashing.
  //
  // @deprecated since 2026-05-17 — use `runtime.getModel()` for
  // provider-agnostic access. Remains callable through the migration
  // window; emits a one-time per-agent warning so unmigrated callers
  // surface in logs.
  getAnthropicClient() {
    const warnKey = this.agentName || '(no-agent)';
    if (!_deprecationWarned.has(warnKey)) {
      console.warn(
        `[deprecated] runtime.getAnthropicClient() — migrate to runtime.getModel(). ` +
        `See architecture/03-ai-ml/MODEL_PROTOCOL.md §6. (agent=${warnKey})`,
      );
      _deprecationWarned.add(warnKey);
    }
    if (this._anthropic) return this._anthropic;
    if (this.smoke) {
      this._anthropic = makeSmokeAnthropicStub();
      return this._anthropic;
    }
    if (!existsSync(ANTHROPIC_ENV_PATH)) {
      throw new Error(
        `Missing ${ANTHROPIC_ENV_PATH}. Create it with: ANTHROPIC_API_KEY=sk-ant-... ` +
        `See docs/operations/${this.agentName || 'agix'}-setup.md.`
      );
    }
    const env = loadEnvFile(ANTHROPIC_ENV_PATH, true);
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in ' + ANTHROPIC_ENV_PATH);
    this._anthropic = new Anthropic({ apiKey });
    return this._anthropic;
  }

  // Model-agnostic client; cached per runtime instance. The model
  // dispatcher fans out to provider adapters (Anthropic, OpenAI,
  // Gemini) and writes a per-call ledger entry. Keys are loaded lazily
  // from `~/.config/agix/<provider>.env` or env vars; missing keys only
  // fail when a call actually routes to that provider.
  //
  // Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §2.1.
  getModel() {
    if (this._model) return this._model;
    if (this.smoke) {
      this._model = makeSmokeModelStub({ runtime: this });
      return this._model;
    }
    const keys = {
      anthropic:  readProviderKey(ANTHROPIC_ENV_PATH,  'ANTHROPIC_API_KEY'),
      openai:     readProviderKey(OPENAI_ENV_PATH,     'OPENAI_API_KEY'),
      gemini:     readProviderKey(GEMINI_ENV_PATH,     'GEMINI_API_KEY'),
      openrouter: readProviderKey(OPENROUTER_ENV_PATH, 'OPENROUTER_API_KEY'),
      groq:       readProviderKey(GROQ_ENV_PATH,       'GROQ_API_KEY'),
      mistral:    readProviderKey(MISTRAL_ENV_PATH,    'MISTRAL_API_KEY'),
    };
    this._model = new Model({ runtime: this, keys });
    return this._model;
  }

  // ─── Google Workspace auth ───────────────────────────────────────

  // Returns a google.auth.OAuth2 client carrying an impersonated access
  // token. Pass straight to a googleapis service constructor.
  // Smoke mode: returns a stub client. Agents that consume this client
  // and then actually invoke a googleapis service will still fail at the
  // API call — agents that need to be smoke-safe must check
  // `runtime.smoke` and skip the API work. This stub only guarantees
  // that fetching auth doesn't burn quota or trigger Google reauth.
  async getWorkspaceAuth({ serviceAccount, subject, scopes }) {
    if (this.smoke) {
      console.error(`  [smoke] would request Workspace auth · subject=${subject} · scopes=${(scopes || []).length}`);
      return {
        smoke: true,
        credentials: { access_token: 'smoke-stub-token', expiry_date: Date.now() + 3600_000 },
        getAccessToken: async () => ({ token: 'smoke-stub-token' }),
      };
    }
    return getImpersonatedOAuth2Client({
      saEmail: serviceAccount,
      subject,
      scopes,
    });
  }

  // ─── Email output ────────────────────────────────────────────────
  //
  // Smoke mode: no real send. Returns a synthetic envelope shape so
  // agents that destructure the result keep working.

  async sendEmail(options) {
    if (this.smoke) {
      const subject = options.subject || '(no subject)';
      const to = Array.isArray(options.to) ? options.to.join(',') : (options.to || 'self');
      console.error(`  [smoke] would send · to=${to} · subj="${subject}"`);
      return { messageId: `smoke-${Date.now()}@local`, smoke: true };
    }
    return sendEmail(options);
  }

  // ─── Notification output ─────────────────────────────────────────
  //
  // Per-employee notification primitive. Used by per-client orchestrator
  // agents (e.g. `client-orchestrator`) for pre-flight review
  // notifications. Production surfaces (push / in-app / email) land in
  // the per-client repo (e.g. the client's notification service); the runtime's
  // job is to provide a stable contract and a smoke-safe stub.
  //
  // Shape (caller passes):
  //   {
  //     channel: 'push' | 'in_app' | 'email' | 'all',
  //     recipient_id: <uuid>,
  //     subject: '<short summary line>',
  //     body: '<full notification payload>',
  //     payload: { /* arbitrary structured data for the receiving UI */ },
  //     action_buttons: [{ id: 'approve', label: 'Approve' }, ...],
  //     ttl_seconds: <int>,                  // notification expires after this
  //   }
  //
  // Returns: { notification_id, delivered_channels: [...], smoke }
  async sendNotification(options) {
    if (this.smoke) {
      const ch = options.channel || 'all';
      const subj = options.subject || '(no subject)';
      const buttons = (options.action_buttons || []).map(b => b.id).join('/') || '(none)';
      console.error(`  [smoke] would notify · channel=${ch} · subj="${subj}" · actions=${buttons}`);
      return {
        notification_id: `notif-smoke-${Date.now()}`,
        delivered_channels: ch === 'all' ? ['push', 'in_app', 'email'] : [ch],
        smoke: true,
      };
    }
    throw new Error(
      `sendNotification: no production notification surface registered. ` +
      `Per-client orchestrators that need this must either run in smoke mode ` +
      `or register a surface via runtime.registerNotificationSurface(fn) before fire.`,
    );
  }

  // Allow per-client agents (or the per-client repo's bootstrap) to
  // register a real notification surface. Once registered, sendNotification
  // delegates to it in non-smoke mode.
  registerNotificationSurface(fn) {
    if (typeof fn !== 'function') {
      throw new Error('registerNotificationSurface: argument must be a function');
    }
    this._notificationSurface = fn;
    // Re-wire sendNotification to use the registered surface for non-smoke calls.
    const prev = this.sendNotification.bind(this);
    this.sendNotification = async (options) => {
      if (this.smoke) return prev(options);
      return this._notificationSurface(options);
    };
  }

  // ─── Scheduler primitive ─────────────────────────────────────────
  //
  // Cycle-aware scheduling abstraction. The orchestrator-style agent
  // schedules its own next tick via this primitive rather than relying
  // on an external cron — keeps the scheduling intent visible in agent
  // code and lets smoke mode short-circuit cleanly.
  //
  // Three operations:
  //   scheduler.scheduleAt(at, payload) → { schedule_id, smoke }
  //   scheduler.tick()                  → calls due jobs in non-smoke
  //   scheduler.cancel(schedule_id)     → cancels a pending job
  //
  // Production surface: Cloud Scheduler + Cloud Run Jobs (client infra) or
  // launchd / cron (local). Agents register their fire handler via
  // runtime.registerSchedulerHandler(name, handlerFn) at startup.
  get scheduler() {
    if (this._scheduler) return this._scheduler;
    const smoke = this.smoke;
    const handlers = this._schedulerHandlers || (this._schedulerHandlers = new Map());

    this._scheduler = {
      async scheduleAt(at, payload) {
        if (smoke) {
          const when = at instanceof Date ? at.toISOString() : String(at);
          console.error(`  [smoke] would schedule · at=${when} · handler=${payload?.handler || '?'}`);
          return { schedule_id: `sched-smoke-${Date.now()}`, smoke: true };
        }
        throw new Error(
          `scheduler.scheduleAt: no production scheduler surface registered. ` +
          `Per-client orchestrators must call runtime.registerSchedulerSurface(fn) ` +
          `before fire to enable scheduled execution.`,
        );
      },
      async tick() {
        if (smoke) {
          console.error(`  [smoke] would tick scheduler · ${handlers.size} handlers registered`);
          return { ticked: 0, smoke: true };
        }
        throw new Error('scheduler.tick: no production scheduler surface registered.');
      },
      async cancel(scheduleId) {
        if (smoke) {
          console.error(`  [smoke] would cancel schedule · id=${scheduleId}`);
          return { cancelled: true, smoke: true };
        }
        throw new Error('scheduler.cancel: no production scheduler surface registered.');
      },
    };
    return this._scheduler;
  }

  registerSchedulerHandler(name, handlerFn) {
    if (typeof handlerFn !== 'function') {
      throw new Error('registerSchedulerHandler: handlerFn must be a function');
    }
    this._schedulerHandlers ??= new Map();
    this._schedulerHandlers.set(name, handlerFn);
  }

  registerSchedulerSurface(surface) {
    if (!surface || typeof surface.scheduleAt !== 'function' || typeof surface.tick !== 'function') {
      throw new Error('registerSchedulerSurface: surface must implement {scheduleAt, tick, cancel}');
    }
    this._schedulerSurface = surface;
    // Re-bind scheduler operations to delegate to the surface for non-smoke calls.
    this._scheduler = null;  // force recomputation; not strictly needed but defensive
  }

  // ─── File output ─────────────────────────────────────────────────

  // Resolve a repo-relative path. Phase 2+ swaps this for `gs://...`
  // resolution in the cloud adapter.
  resolveRepoPath(relPath) {
    return resolve(this.repoRoot, relPath);
  }

  // Writable OUTPUT root. In dev the repo is writable → outputs land in-tree (visible to
  // the developer). On a real install the pack lives in a READ-ONLY tree (e.g. Homebrew
  // libexec) → agents would crash writing there, so fall back to a writable data dir.
  // Reads of PACK data files still use repoRoot (resolveRepoPath); only writes + their
  // read-back move.
  //
  // Precedence (highest first):
  //   1. $AGIX_DATA_DIR             — explicit env override (wins outright).
  //   2. dev checkout (.git present) → repoRoot (in-tree, visible to the developer).
  //   3. `data_dir` from settings.json — the user-chosen workspace (`~/agix` by default),
  //      picked at onboarding. The visible, user-owned home for wiki/ + gbrain on installs.
  //   4. $XDG_STATE_HOME/agix, else ~/.local/state/agix — hidden default fallback.
  outputRoot() {
    if (this._outputRoot) return this._outputRoot;
    if (process.env.AGIX_DATA_DIR) {
      // (1) explicit override wins over everything below.
      this._outputRoot = resolve(process.env.AGIX_DATA_DIR);
    } else if (existsSync(resolve(this.repoRoot, '.git'))) {
      // (2) Signal is "dev checkout?" (has .git), NOT "is the tree writable?" — a macOS
      // Homebrew Cellar is user-WRITABLE but we still must not write user outputs into it
      // (wiped on upgrade); a Linux/root install is read-only and would crash. The .git
      // probe routes dev → in-tree (visible to the developer) and every install → a data dir.
      this._outputRoot = this.repoRoot;
    } else {
      // (3) honor a user-chosen workspace persisted in settings.json (defensive: any
      // missing file / parse error / absent-or-non-string data_dir falls through to (4)).
      this._outputRoot = readConfiguredDataDir()
        // (4) hidden default.
        || resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'agix');
    }
    return this._outputRoot;
  }

  resolveOutputPath(relPath) {
    return resolve(this.outputRoot(), relPath);
  }

  async writeRepoFile(relPath, content) {
    const root = this.smoke ? this.smokeWriteRoot : this.outputRoot();
    const fullPath = resolve(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return fullPath;
  }

  async readRepoFile(relPath) {
    return readFile(this.resolveRepoPath(relPath), 'utf8');
  }

  // Read a prior OUTPUT artifact (e.g. a running log this agent wrote) from the writable
  // output root, guarded — missing returns '' so first-run + read-only installs don't crash.
  async readOutputFile(relPath) {
    try { return await readFile(this.resolveOutputPath(relPath), 'utf8'); }
    catch { return ''; }
  }

  // ─── State (cursors, etc.) ───────────────────────────────────────

  // The (tenant, dojo, agent, name) scope for a state document — the
  // single argument shape every backend method takes. Isolation is
  // structural: agents can't name a foreign tenant/dojo because the
  // scope comes from the runtime's own identity, never from agent input.
  _stateScope(name) {
    return {
      tenantId: this.tenantId,
      dojoId: this.dojoId,
      agent: this.agentName || 'agix',
      name,
    };
  }

  statePath(name) {
    if (this.stateBackend) {
      return stateDocSegments(this._stateScope(name)).join('/');
    }
    if (this.dojoId !== null || this.tenantId !== 'agix') {
      // Tenant/Dojo-scoped local layout mirrors the cloud key structure:
      // ~/.cache/agix/tenants/<tenant>[/dojos/<dojo>]/agents/<agent>/state/<name>.json
      // Any non-default tenant takes this path even without a Dojo —
      // otherwise tenant-level state would fall back to the shared
      // legacy path and leak across tenants (found by the R0 spike).
      return resolve(
        homedir(), '.cache/agix',
        ...stateDocSegments(this._stateScope(name)),
      ) + '.json';
    }
    // Legacy single-tenant pattern (implicit `agix` tenant only):
    // ~/.cache/agix-<agent>/<name>.json.
    return resolve(this.cacheDir, `${name}.json`);
  }

  async readState(name, fallback = null) {
    if (this.stateBackend) {
      return this.stateBackend.read(this._stateScope(name), fallback);
    }
    const path = this.statePath(name);
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return fallback;
    }
  }

  async writeState(name, data) {
    if (this.stateBackend) {
      // Smoke runs already hold the smoke backend (constructor swap).
      return this.stateBackend.write(this._stateScope(name), data);
    }
    if (this.smoke) {
      const path = resolve(this.smokeWriteRoot, `${name}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(data, null, 2));
      return path;
    }
    const path = this.statePath(name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
    return path;
  }

  // ─── Budget (token/cost) ─────────────────────────────────────────
  //
  // Per-run spend protection: first-class per the 2026-06-06 brief §4
  // (token cost runaway) — agents without budgets as a structural
  // constraint hit the ceiling. Configure via the agent manifest
  // (`budget: { max_cost_usd, max_tokens }`) or runtime opts; the Model
  // dispatcher calls `checkBudget()` before every provider call, so an
  // over-budget run fails fast with a typed error instead of silently
  // accruing spend.

  budgetStatus() {
    const max_cost_usd = this.budget?.max_cost_usd ?? null;
    const max_tokens = this.budget?.max_tokens ?? null;
    const exceeded =
      (max_cost_usd !== null && this._spend.cost_usd >= max_cost_usd) ||
      (max_tokens !== null && this._spend.tokens >= max_tokens);
    return {
      configured: this.budget !== null,
      max_cost_usd,
      max_tokens,
      spent_usd: this._spend.cost_usd,
      spent_tokens: this._spend.tokens,
      remaining_usd: max_cost_usd === null ? null : Math.max(0, max_cost_usd - this._spend.cost_usd),
      exceeded,
    };
  }

  checkBudget() {
    const status = this.budgetStatus();
    if (status.exceeded) {
      throw new BudgetExceededError(status, this.agentName);
    }
    return status;
  }

  // ─── Authority gate (Hanko PDP enforcement seam) ──────────────────
  //
  // The single chokepoint for "may the current actor have <agent> take
  // <action>?" Resolves the operator (agix-identity.currentActor) and decides
  // against AGENT_POLICY.yaml (agix-policy.checkAuthority). Mode via AGIX_AUTHZ:
  //   off       — no-op (allow everything)
  //   advisory  — log a warning on deny, but allow (DEFAULT; safe rollout)
  //   enforce   — throw PermissionDeniedError on deny / requires-approval
  // Smoke runs and an UNRESOLVED actor (no identity) always bypass — you can't
  // meaningfully enforce against nobody (dev / un-onboarded / CI).
  authorize(action, { agent } = {}) {
    if (this.smoke) return { allowed: true, bypass: 'smoke' };
    const mode = authzMode();
    if (mode === 'off') return { allowed: true, bypass: 'off' };
    const actor = currentActor();
    if (!actor.email && (!actor.roles || actor.roles.length === 0)) {
      return { allowed: true, bypass: 'no-identity' };
    }
    const targetAgent = agent || this.agentName;
    const decision = checkAuthority(actor, targetAgent, action);
    // Audit seed: record the decision on the run event when one is open.
    if (this._currentRunEvent && this._currentRunEvent.outputs_summary) {
      (this._currentRunEvent.outputs_summary.authz ||= []).push({
        actor: actor.actorId, agent: targetAgent, action,
        allowed: decision.allowed, requiresApproval: decision.requiresApproval,
      });
    }
    if (!decision.allowed) {
      if (mode === 'enforce') {
        throw new PermissionDeniedError({ actor, agent: targetAgent, action, reason: decision.reason });
      }
      console.warn(`[authz advisory] ${decision.reason} — actor ${actor.email || actor.actorId}`);
    } else if (decision.requiresApproval && mode === 'enforce') {
      throw new PermissionDeniedError({
        actor, agent: targetAgent, action,
        reason: `requires human approval: ${targetAgent}.${action}`,
      });
    }
    return decision;
  }

  // ─── Memory primitive (Q1) ───────────────────────────────────────
  //
  // Agix-owned seam: L0 raw capture + BM25 recall riding the
  // tenant/dojo-keyed state contract. Symmetric to getModel():
  // cached per runtime, smoke mode returns the sandboxed stub.
  // Spec: docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 1.

  getMemoryStore() {
    if (this._memoryStore) return this._memoryStore;
    this._memoryStore = this.smoke
      ? makeSmokeMemoryStore()
      : new MemoryStore({ runtime: this });
    return this._memoryStore;
  }

  // ─── StateGraph primitive (Q2) ───────────────────────────────────
  //
  // Tiny native state machine for orchestrator-style agents (no
  // LangGraph dependency — runtime backlog §Sprint 2). Smoke mode is
  // inherited: transitions run (pure), actions/hooks (the I/O) are
  // skipped and logged.

  getStateGraph() {
    const smoke = this.smoke;
    return {
      defineGraph: (spec) => defineGraph({ ...spec, smoke }),
    };
  }

  // ─── MCP client primitive (Q3) ───────────────────────────────────
  //
  // Per-server MCP client, cached by URL. `server` is a URL string or
  // { url, auth } config. Smoke mode returns the canned stub. MCP moved
  // from trigger-gated to table stakes per the 2026-06-10 market scan;
  // see docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 3.

  getMCPClient(server) {
    const config = typeof server === 'string' ? { url: server } : (server || {});
    if (!config.url) throw new Error('getMCPClient: server url is required');
    this._mcpClients ??= new Map();
    if (this._mcpClients.has(config.url)) return this._mcpClients.get(config.url);
    const client = this.smoke
      ? makeSmokeMCPClient({ url: config.url })
      : new MCPClient({ ...config, clientName: `agix-${this.agentName || 'runtime'}` });
    this._mcpClients.set(config.url, client);
    return client;
  }

  // ─── Intra-agent bus primitive (North Star P3) ───────────────────
  //
  // The live, low-latency, local agent-to-agent coordination layer:
  // request/reply + pub/sub over a Unix domain socket spoken by the
  // Rust `lewis-aos-bus` daemon. Symmetric to getModel() / getMCPClient():
  // lazily constructed, cached per runtime instance, smoke mode returns
  // the in-memory stub (no daemon, no socket). The runtime's own identity
  // (agentName) is stamped on the wire so an agent cannot impersonate
  // another on the bus — the same anti-self-elevation invariant that
  // governs the soul/policy model, enforced at the transport.
  //
  // The daemon is provisioned out-of-band (`lewis-aos bus up`, or
  // lib/agix-bus-provision.mjs busUp()); this surface only connects to it.
  //
  // Spec: architecture/03-ai-ml/agent-architecture/RUST_INTRA_AGENT_BUS.md §2.
  getBus({ host = '127.0.0.1', port = 17645, trust = 'executor' } = {}) {
    if (this._bus) return this._bus;
    const agent = this.agentName || 'agix';
    this._bus = this.smoke
      ? createBusStub({ agent })
      : createBus({ host, port, agent, trust });
    return this._bus;
  }

  // ─── Embedded local gbrain (knowledge fabric; AGIX.ONBOARD.1 DL.11) ──
  //
  // The zero-dependency, zero-setup knowledge graph: pages + tags +
  // `[[wikilinks]]`, a maintained backlink index, and keyword/tag relevance
  // search. AUTO-PROVISIONS — first use creates its store under the runtime's
  // writable output root (`outputRoot()/gbrain/store.json`), never the
  // possibly-read-only install tree. Symmetric to getBus() / getMemoryStore():
  // lazily constructed, cached per runtime, smoke mode returns the in-memory
  // stub (no disk). The mentor leader agent reads this surface for
  // backlinked-precedent evidence (search + getBacklinks) — the criterion the
  // BM25 memory store can't express because it has no link graph.
  //
  // Backing store is a clean seam: a postgres/pgvector implementation can
  // replace the JSON-file store behind the SAME API (the real-gbrain upgrade
  // path) without any caller change.
  getGbrain() {
    if (this._gbrain) return this._gbrain;
    this._gbrain = this.smoke
      ? createGbrainStub()
      : new Gbrain({ runtime: this });
    return this._gbrain;
  }

  // ─── Governance audit ledger (L2 substrate; LOOP_ENGINEERED_SDLC §5) ──
  //
  // The append-only, per-tenant system of record for GOVERNED events — gate
  // decisions, verifier verdicts, version bumps, releases, launches (see
  // lib/agix-audit-ledger.mjs LEDGER_KINDS). Symmetric to getModel() /
  // getGbrain() / getBus(): lazily constructed, cached per runtime instance.
  //
  // Isolation is structural: the ledger is bound at construction to THIS
  // runtime's tenant (enterpriseId = tenantId) — no API accepts a foreign
  // enterprise, so a governance agent cannot record into another tenant's log.
  // This is the coherence seam: one tenant-scoped ledger the governance fleet
  // shares, rather than each agent rooting its own store.
  //
  // Backing store: a FileLedgerStore rooted under outputRoot()/governance, so
  // it honors $AGIX_DATA_DIR / dev-checkout / the user-chosen workspace / XDG
  // exactly like every other writable artifact. Smoke mode swaps in the sandbox
  // store (makeSmokeLedgerStore) so a smoke run touches no real system of record
  // and needs zero config on a fresh machine.
  getLedger() {
    if (this._ledger) return this._ledger;
    const store = this.smoke
      ? makeSmokeLedgerStore()
      : new FileLedgerStore({ root: this.resolveOutputPath('governance') });
    this._ledger = new AuditLedger({ scope: { enterpriseId: this.tenantId }, store });
    return this._ledger;
  }

  // ─── Session continuity (Q1: resumeRun, per legibility audit F-RT-06) ─
  //
  // The session-level continuity hook the consumer workspace's LC-4
  // ("close the tab, return tomorrow, resume — not restart") needs.
  // An agent calls `checkpoint(data)` whenever it has resumable state;
  // the next run calls `resumeRun()` to ground itself in it. One
  // checkpoint per agent scope (latest wins) — history belongs in the
  // memory store, not here.

  async checkpoint(data) {
    const record = {
      run_id: this.currentRunId,
      saved_at: new Date().toISOString(),
      agent: this.agentName || null,
      data,
    };
    await this.writeState('run-checkpoint', record);
    return record;
  }

  async resumeRun() {
    return this.readState('run-checkpoint', null);
  }

  // ─── Inter-agent fires ───────────────────────────────────────────
  //
  // When an agent wants to fire another agent, it should go through
  // this method (not import runAgent directly) so smoke mode can
  // intercept. Smoke mode returns a synthetic result without spawning.

  async runAgent(agentName, opts = {}) {
    if (this.smoke) {
      console.error(`  [smoke] would fire agent · ${agentName}`);
      // Smoke fires are tracked in the parent's outputs_summary if the
      // parent is recording one.
      if (this._currentRunEvent) {
        this._currentRunEvent.outputs_summary.agents_fired.push({ agent: agentName, smoke: true });
      }
      return { mode: 'smoke-stubbed', agent: agentName, smoke: true };
    }
    // Authority gate: may the current actor have this agent run? Advisory by
    // default; enforced when AGIX_AUTHZ=enforce. Smoke/un-onboarded bypass.
    this.authorize('run', { agent: agentName });
    // Propagate parent tenant by default; explicit opts.tenant wins.
    const result = await runAgent(agentName, { tenant: this.tenantId, ...opts });
    if (this._currentRunEvent) {
      this._currentRunEvent.outputs_summary.agents_fired.push({ agent: agentName });
    }
    return result;
  }

  // ─── Run-event recording (consumed by emitRunEvent in runAgent) ─

  /**
   * Initialize a run event object on the runtime. Called once by
   * runAgent() at agent entry; agents don't call this directly.
   */
  _beginRunEvent({ invocation }) {
    const runId = uuidv7();
    const shortHash = runId.replace(/-/g, '').slice(0, 8);
    this._currentRunEvent = {
      schema_version: '0.1-local',
      event_id: uuidv7(),
      agent: this.agentName,
      agent_id: `${this.agentName}-${shortHash}`,  // Madoguchi-compat naming
      run_id: runId,
      invocation,                                    // 'scheduled' | 'manual' | 'smoke'
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      manifest_sha: null,                            // filled by runAgent from install record
      agix_version: readAgixVersionStatic(),
      models_used: [],
      totals: { tokens_in: 0, tokens_out: 0, cost_usd: 0, calls: 0 },
      duration_phases_ms: {},
      outputs_summary: {
        emails_sent: 0,
        files_written: [],
        agents_fired: [],
        doc_changes: 0,
      },
      decisions: { drift_flags: [], rules_triggered: [] },
      error: null,
    };
    return this._currentRunEvent;
  }

  /**
   * Agent-facing API: the current run's id (uuidv7), or null outside an
   * active run. Lets agents tag artifacts/telemetry to the run that
   * produced them (e.g. G10 deploy-health trajectory capture).
   */
  get currentRunId() {
    return this._currentRunEvent?.run_id ?? null;
  }

  /**
   * Agent-facing API: record a named phase's duration. Idempotent —
   * calling twice with the same name overwrites (the agent owns its
   * phase semantics). Cheap no-op outside an active run.
   */
  recordPhase(name, durationMs) {
    if (!this._currentRunEvent) return;
    this._currentRunEvent.duration_phases_ms[name] = Math.round(durationMs);
  }

  /**
   * Agent-facing API: record a single model call. Accumulates into
   * models_used + totals. Pass tokens_in/out/cost_usd as numbers; the
   * runtime sums them. Cheap no-op outside an active run.
   */
  recordModelCall({ model, tokens_in = 0, tokens_out = 0, cost_usd = 0 }) {
    // Budget spend accrues on every recorded call, run event or not —
    // the budget protects the process, not just scheduled runs.
    this._spend.cost_usd += cost_usd;
    this._spend.tokens += tokens_in + tokens_out;
    if (!this._currentRunEvent) return;
    const ev = this._currentRunEvent;
    const existing = ev.models_used.find((m) => m.model === model);
    if (existing) {
      existing.tokens_in += tokens_in;
      existing.tokens_out += tokens_out;
      existing.cost_usd += cost_usd;
      existing.calls += 1;
    } else {
      ev.models_used.push({ model, tokens_in, tokens_out, cost_usd, calls: 1 });
    }
    ev.totals.tokens_in += tokens_in;
    ev.totals.tokens_out += tokens_out;
    ev.totals.cost_usd += cost_usd;
    ev.totals.calls += 1;
  }

  /**
   * Agent-facing API: append a file the agent wrote (informational
   * only — counted, not validated). Cheap no-op outside an active run.
   */
  recordFileWritten(repoRelPath) {
    if (!this._currentRunEvent) return;
    this._currentRunEvent.outputs_summary.files_written.push(repoRelPath);
  }

  /**
   * Agent-facing API: record an emitted decision/drift flag. Used by
   * Sensei (drift), Curator (rules_triggered), etc. for higher-order
   * signal in Sensei's brief without consuming the doc itself.
   */
  recordDecision({ kind, name }) {
    if (!this._currentRunEvent) return;
    const bucket = kind === 'drift' ? 'drift_flags' : 'rules_triggered';
    this._currentRunEvent.decisions[bucket].push(name);
  }
}

// Typed budget failure so agents (and runAgent's error path) can
// distinguish "out of budget" from provider/auth errors and degrade
// gracefully — ship what landed, surface the halt, never retry-loop.
export class BudgetExceededError extends Error {
  constructor(status, agentName = null) {
    const limit = status.max_cost_usd !== null
      ? `$${status.max_cost_usd}`
      : `${status.max_tokens} tokens`;
    super(
      `Budget exceeded${agentName ? ` for agent "${agentName}"` : ''}: ` +
      `spent $${status.spent_usd.toFixed(4)} / ${status.spent_tokens} tokens against a ${limit} cap.`,
    );
    this.name = 'BudgetExceededError';
    this.budget = status;
  }
}

// Authorization mode from the environment. Default 'advisory' (decide + log,
// never block) for a safe rollout; 'enforce' blocks; 'off' disables the gate.
function authzMode() {
  const m = (process.env.AGIX_AUTHZ || 'advisory').trim().toLowerCase();
  return m === 'off' || m === 'enforce' ? m : 'advisory';
}

// Typed authorization failure (Hanko deny). Carries the actor/agent/action so a
// caller can surface a clear "who was denied what, and why."
export class PermissionDeniedError extends Error {
  constructor({ actor, agent, action, reason } = {}) {
    super(`Permission denied: ${reason}${actor && actor.email ? ` (actor ${actor.email})` : ''}`);
    this.name = 'PermissionDeniedError';
    this.actor = actor && actor.actorId ? actor.actorId : null;
    this.agent = agent ?? null;
    this.action = action ?? null;
  }
}

// uuidv7 — time-ordered, Madoguchi-compatible. Native crypto.randomUUID
// returns v4 (random); we need monotonic order for run records so we
// roll a minimal v7 here. ~80 bits of randomness in the suffix is
// plenty for a single host's run collisions.
function uuidv7() {
  const ms = BigInt(Date.now());
  const random = new Uint8Array(10);
  // crypto.getRandomValues from node:crypto
  // eslint-disable-next-line no-undef
  globalThis.crypto.getRandomValues(random);
  const hex = (n) => n.toString(16).padStart(2, '0');
  const tsHex = ms.toString(16).padStart(12, '0');
  // Layout: tttttttt-tttt-7rrr-Vrrr-rrrrrrrrrrrr (RFC 9562)
  // Version nibble 7 in byte 6's high nibble; variant 10 in byte 8's high bits.
  random[0] = (random[0] & 0x0f) | 0x70;
  random[2] = (random[2] & 0x3f) | 0x80;
  return (
    tsHex.slice(0, 8) + '-' +
    tsHex.slice(8, 12) + '-' +
    hex(random[0]) + hex(random[1]) + '-' +
    hex(random[2]) + hex(random[3]) + '-' +
    [...random.slice(4, 10)].map(hex).join('')
  );
}

function readAgixVersionStatic() {
  try {
    const pkgPath = resolve(REPO_ROOT, 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Read the user-chosen workspace `data_dir` from settings.json
// (<$AGIX_CONFIG_DIR | ~/.config/agix>/settings.json), the visible workspace picked
// at onboarding. settings.json is JSON — no js-yaml dependency. Fully defensive:
// missing file / parse error / missing-or-non-string data_dir all return null so the
// caller falls through to the hidden default. A leading `~` expands to homedir().
function readConfiguredDataDir() {
  const configDir = process.env.AGIX_CONFIG_DIR || CONFIG_DIR;
  const settingsPath = resolve(configDir, 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const dir = settings?.data_dir;
    if (typeof dir !== 'string' || !dir.trim()) return null;
    const expanded = dir.startsWith('~') ? resolve(homedir(), dir.slice(1).replace(/^[/\\]/, '')) : dir;
    return resolve(expanded);
  } catch {
    return null;
  }
}

// Read a provider API key from a `~/.config/agix/<provider>.env` file
// or fall back to the matching process env var. Returns null when
// neither is present — Model.getAdapter throws lazily on first use.
function readProviderKey(envFilePath, envVarName) {
  if (existsSync(envFilePath)) {
    try {
      const env = loadEnvFile(envFilePath, true);
      if (env[envVarName]) return env[envVarName];
    } catch { /* fall through to process.env */ }
  }
  return process.env[envVarName] || null;
}

// Smoke-mode stub for Anthropic SDK. Only models.messages.create is
// implemented because that's what every agent currently uses; if a
// future agent calls a different surface in smoke mode, add it here.
function makeSmokeAnthropicStub() {
  return {
    smoke: true,
    messages: {
      create: async (req) => ({
        id: `msg_smoke_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: req?.model || 'smoke-stub',
        content: [{ type: 'text', text: '[smoke-mode canned response]' }],
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
        smoke: true,
      }),
    },
  };
}

// ─── Agent dispatcher ────────────────────────────────────────────────
//
// Agents live in three location patterns:
//   1. Shared Agix Agents Pack    — <pack>/agents/<name>/
//   2. Per-client agents          — <pack>/clients/<slug>/agents/<name>/
//   3. User-generated agents      — <userAgentsDir>/<name>/      (origin: 'user')
//
// Per-client agents (introduced 2026-05-18 per the per-client compartmentalization
// in clients/<your-client>/MIGRATION_MAP.md) ship as part of a
// client's "second brain foundation" and migrate with the client to its
// own monorepo.
//
// User-generated agents are what `agix agent new` writes on an INSTALL (where
// the pack tree is read-only / upgrade-wiped). Discovery scans the user dir too
// so a freshly-generated agent is immediately listable / runnable / smokeable.
// On a slug COLLISION the PACK agent wins (a user can't shadow a shipped agent)
// and a one-time warning is printed; this is the safer default for a marketplace
// pack whose shipped agents callers depend on.

const AGENTS_DIR = resolve(REPO_ROOT, 'agents');
const CLIENTS_DIR = resolve(REPO_ROOT, 'clients');

// Track which colliding user slugs we've already warned about so a single
// process doesn't spam the same shadow warning on every discovery call.
const _collisionWarned = new Set();

// Read an agent dir's manifest. Returns null when the dir has no manifest.yaml
// (so it isn't a real agent) or the YAML fails to parse.
function readAgentEntry(agentsRoot, name, extra) {
  const manifestPath = resolve(agentsRoot, name, 'manifest.yaml');
  if (!existsSync(manifestPath)) return null;
  let manifest = null;
  try { manifest = yaml.load(readFileSync(manifestPath, 'utf8')); } catch {}
  return { name, manifestPath, manifest, ...extra };
}

// Walk shared + per-client + user agent locations. Returns an array of
// { name, client, origin, manifestPath, manifest } — `client` is null for
// non-client agents; `origin` is 'pack' (shipped/shared), 'client', or 'user'.
async function findAllAgents() {
  const { readdir } = await import('node:fs/promises');
  const results = [];
  const packNames = new Set();   // names owned by the pack (shared + client) for collision precedence

  // 1. Shared agents at <pack>/agents/<name>/
  if (existsSync(AGENTS_DIR)) {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = readAgentEntry(AGENTS_DIR, entry.name, { client: null, origin: 'pack' });
      if (!found) continue;
      results.push(found);
      packNames.add(found.name);
    }
  }

  // 2. Per-client agents at <pack>/clients/<slug>/agents/<name>/
  if (existsSync(CLIENTS_DIR)) {
    const slugs = await readdir(CLIENTS_DIR, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const clientAgentsDir = resolve(CLIENTS_DIR, slug.name, 'agents');
      if (!existsSync(clientAgentsDir)) continue;
      const entries = await readdir(clientAgentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = readAgentEntry(clientAgentsDir, entry.name, { client: slug.name, origin: 'client' });
        if (!found) continue;
        results.push(found);
        packNames.add(found.name);
      }
    }
  }

  // 3. User-generated agents at <userAgentsDir>/<name>/. Pack wins on a slug
  //    collision — the user agent is skipped (with a one-time warning) so a
  //    shipped agent can never be silently shadowed.
  const userDir = userAgentsDir();
  if (existsSync(userDir)) {
    const entries = await readdir(userDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = readAgentEntry(userDir, entry.name, { client: null, origin: 'user' });
      if (!found) continue;
      if (packNames.has(found.name)) {
        if (!_collisionWarned.has(found.name)) {
          console.warn(
            `[agix] user agent "${found.name}" at ${found.manifestPath} is shadowed by a ` +
            `pack agent of the same name — the pack agent is used. Rename the user agent to surface it.`,
          );
          _collisionWarned.add(found.name);
        }
        continue;
      }
      results.push(found);
    }
  }

  return results;
}

// Resolve an agent name to its directory. Agent names must be unique
// across shared + per-client scopes; collisions throw.
async function resolveAgentDir(agentName) {
  const all = await findAllAgents();
  const matches = all.filter(a => a.name === agentName);
  if (matches.length === 0) {
    const available = all.map(a => a.client ? `${a.name} (${a.client})` : a.name).join(', ');
    throw new Error(`No agent named "${agentName}". Available: ${available || '(none)'}`);
  }
  if (matches.length > 1) {
    const where = matches.map(a => a.client ? `clients/${a.client}/agents/${a.name}/` : `agents/${a.name}/`).join(' AND ');
    throw new Error(`Agent name "${agentName}" is ambiguous; found in ${where}. Rename one.`);
  }
  return matches[0];
}

export async function listAgents() {
  return findAllAgents();
}

export async function loadAgentManifest(agentName) {
  const found = await resolveAgentDir(agentName);
  return found.manifest;
}

export async function runAgent(agentName, opts = {}) {
  const found = await resolveAgentDir(agentName);
  const agentDir = dirname(found.manifestPath);
  const entryPath = resolve(agentDir, 'agent.mjs');
  if (!existsSync(entryPath)) {
    throw new Error(`No agent.mjs at ${entryPath}. Manifest exists but entry point missing.`);
  }
  const manifest = found.manifest;
  const smoke = Boolean(opts.smoke);

  // ── Informed consent (AGA.Soul.1 honest-trust v1) ────────────────────
  // Trust is ADVISORY in v0.2 — declared, not sandbox-enforced. The one real
  // safety value we can offer without claiming false enforcement is informed
  // consent: warn (to stderr, non-blocking — never break scripting) before
  // running an EXECUTOR-trust agent, which can write files + run commands on
  // the user's machine. Proposer/observer agents stay quiet. Skipped on smoke
  // runs (no real side effects there).
  if (!smoke) {
    const trustLevel = manifest?.soul?.trust_level;
    if (trustLevel === 'executor') {
      process.stderr.write(
        `⚠ ${agentName} declares EXECUTOR trust — it can write files and run commands on your machine. ` +
        `Trust is advisory (declared, not sandbox-enforced in v0.2). Only run agents you trust.\n`
      );
    }
  }
  const runtime = new LocalRuntime({
    agentName,
    tenantId: opts.tenant || 'agix',
    dojoId: opts.dojo || null,
    stateBackend: opts.stateBackend || null,
    // Budget precedence: explicit opts > manifest `budget:` block > none.
    budget: opts.budget || manifest?.budget || null,
    smoke,
  });
  await runtime.ensureDirs();
  // Dynamic import requires a file:// URL on Windows (a bare `C:\...` path
  // trips ERR_UNSUPPORTED_ESM_URL_SCHEME). pathToFileURL is a no-op-safe
  // round-trip on POSIX, so this stays cross-platform.
  const mod = await import(pathToFileURL(entryPath).href);
  if (typeof mod.run !== 'function') {
    throw new Error(`${entryPath} must export an async function \`run({ runtime, opts, manifest })\`.`);
  }

  // Begin run event. Invocation classification:
  //   - smoke      → opts.smoke true
  //   - scheduled  → no TTY on stdin (launchd fires us with no terminal)
  //   - manual     → TTY on stdin (operator invoked via shell)
  const invocation = smoke ? 'smoke' : (process.stdin.isTTY ? 'manual' : 'scheduled');
  const event = runtime._beginRunEvent({ invocation });

  // Pull manifest_sha from install record when present (best-effort).
  event.manifest_sha = readInstalledManifestSha(runtime.tenantId, agentName);

  let result;
  try {
    result = await mod.run({ runtime, opts, manifest });
    event.exit_code = 0;
  } catch (err) {
    event.exit_code = 1;
    event.error = {
      class: err.constructor?.name || 'Error',
      message: String(err.message || err).slice(0, 500),
      phase: runtime._currentPhase || null,
    };
    event.finished_at = new Date().toISOString();
    event.budget = runtime.budget ? runtime.budgetStatus() : null;
    await safeWriteRunEvent(runtime, event);
    throw err;
  }

  event.finished_at = new Date().toISOString();
  event.budget = runtime.budget ? runtime.budgetStatus() : null;
  await safeWriteRunEvent(runtime, event);
  return result;
}

// Read install record's manifest_sha so the run event records *what
// the agent was installed against* (not what's on disk now — that's
// drift). Best-effort; returns null if no install record.
function readInstalledManifestSha(tenantId, agentName) {
  const path = resolve(homedir(), '.config/agix', tenantId, 'installed', `${agentName}.json`);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    return rec.manifest_sha || null;
  } catch {
    return null;
  }
}

// Write the run event to ~/.cache/agix-<agent>/runs/<run_id>.json
// and prune older records past the retention window. Defensive: any
// failure logs to stderr but does not throw — the agent's exit value
// is more important than the telemetry.
async function safeWriteRunEvent(runtime, event) {
  try {
    const runsDir = resolve(runtime.cacheDir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const eventPath = resolve(runsDir, `${event.run_id}.json`);
    await writeFile(eventPath, JSON.stringify(event, null, 2) + '\n');
    await pruneOldRunEvents(runsDir);
  } catch (err) {
    console.error(`agix-runtime: failed to emit run event: ${err.message}`);
  }
}

// Retention: keep the most recent 30 OR everything within the last
// 90 days, whichever is greater. Cheap O(N log N) on a directory that
// stays well under 1k entries in practice.
async function pruneOldRunEvents(runsDir) {
  const { readdir, stat, unlink } = await import('node:fs/promises');
  const names = (await readdir(runsDir)).filter((n) => n.endsWith('.json'));
  const entries = await Promise.all(
    names.map(async (n) => {
      const p = resolve(runsDir, n);
      const s = await stat(p);
      return { path: p, mtimeMs: s.mtimeMs };
    }),
  );
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);                  // newest first
  const ninetyDaysMs = 90 * 24 * 3600 * 1000;
  const cutoff = Date.now() - ninetyDaysMs;
  const keep = new Set();
  // Keep last 30 regardless of age.
  for (const e of entries.slice(0, 30)) keep.add(e.path);
  // Plus anything within the 90-day window.
  for (const e of entries) if (e.mtimeMs >= cutoff) keep.add(e.path);
  // Delete the rest.
  for (const e of entries) if (!keep.has(e.path)) await unlink(e.path).catch(() => {});
}
