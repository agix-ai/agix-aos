// Agix Coordinator — the fleet's spawn-gate, reborn on Bun.
//
// This is the BEHAVIOR layer; identity (trust=boundary → drone caste, public=true,
// zero secrets, zero repo writes) lives in the sibling agent.json. The Coordinator
// is a DETERMINISTIC infrastructure bee: it owns the active-agent registry and the
// spawn-gate collision check across five modes — status, check, start, end, repair.
//
// Faithful reduction of agents/coordinator/agent.mjs + lib/collisions.mjs +
// lib/schema.mjs (all ported inline below). The legacy agent used node:fs/promises
// against a local cache dir; the port keeps that exact model on Bun-native node:*
// modules (no Node runtime, no require, no .mjs). Collision + schema logic ports
// verbatim.
//
// ── NOT PORTED (honest flags — see the sibling manifest + the task notPorted[]) ──
//   1. NO governed hive call / NO verifier. The Coordinator makes ZERO
//      runtime.getModel().chat() calls in the legacy — it is pure deterministic
//      infrastructure — so there is nothing to map onto ctx.hive.run, and there is
//      no actor≠verifier verifier to certify. This is faithful, not a gap in the
//      port: a zero-intelligence agent has no governed pass. ctx.hive / ctx.comb
//      are wired by the runtime but deliberately unused.
//   2. STATE LIVES OUT OF REPO. The registry is a local cache directory
//      (~/.cache/agix-fleet/active, overridable via --state-dir or
//      AGIX_FLEET_STATE_DIR), NOT a repo file and NOT a Comb leaf. So state is
//      driven by Bun-native node:fs, not ctx.writeRepoFile (repo-bounded) or
//      ctx.comb (knowledge graph). The manifest boundary.write is [] because the
//      Coordinator writes nothing in the repo.
//   3. HUMAN STDOUT RENDERING DROPPED. The legacy --json flag and the human
//      table/help text are gone: the reborn agent returns STRUCTURED data and the
//      runner/CLI owns rendering. ctx.log carries the human summary lines.
//   4. SHELL EXIT-CODE CONTRACT (0/1/2/64) is surfaced as result.ok (+ an error
//      string), not via process.exitCode; the CLI derives the exit from the result.
//   5. AUDIT LOG (~/.cache/agix-fleet/audit.jsonl) is still Phase 1.2 — not written
//      here, exactly as in the legacy Phase 1.1 scope.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";
import { readFile, writeFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { homedir } from "node:os";

const MODES = ["status", "check", "start", "end", "repair"] as const;

// Ported from manifest.yaml defaults (behavior policy now lives beside the
// behavior, like mentor's FIRE_ALLOWLIST). Flag-overridable for calibration/tests.
const DEFAULT_STALE_AFTER_SEC = 900; // 15 min — stale but still counted for collision
const DEFAULT_REAP_AFTER_SEC = 3600; // 1 hr — repair removes the file
const SCHEMA_VERSION = 1;
const VALID_AGENT_KINDS = new Set(["session", "daemon", "cron"]);

// ─── Types (the state-file + collision shapes) ───────────────────────────────
interface StateRecord {
  schema_version: number;
  agent_id: string;
  agent_name: string;
  agent_kind: string;
  started_at: string;
  last_heartbeat_at: string;
  pid?: number;
  host?: string;
  branch?: string;
  worktree?: string;
  files?: string[];
  workstream_tags?: string[];
  spawn_source?: { kind: string; ref?: string };
}
interface Proposal {
  branch?: string;
  files: string[];
  tags: string[];
  agent_name?: string;
}
interface HardCollision {
  with_agent_id: string;
  with_agent_name: string;
  with_branch?: string;
  kind: "file-path-overlap";
  files: string[];
  started_at: string;
  last_heartbeat_at: string;
}
interface SoftCollision {
  with_agent_id: string;
  with_agent_name: string;
  with_branch?: string;
  kind: "workstream-tag-overlap";
  tags: string[];
  started_at: string;
  last_heartbeat_at: string;
}
interface CollisionResult {
  ok: boolean;
  hard: HardCollision[];
  soft: SoftCollision[];
  forced?: boolean;
}

// ─── Collision rule engine (ported verbatim from lib/collisions.mjs) ──────────
// Two classes: file-path overlap is HARD (refuse; --force cannot silence it),
// workstream-tag overlap is SOFT (warn; --force overrides). Plain set-intersection.
function detectCollisions(proposal: Proposal, activeAgents: StateRecord[]): CollisionResult {
  const hard: HardCollision[] = [];
  const soft: SoftCollision[] = [];
  const proposedFiles = new Set(proposal.files ?? []);
  const proposedTags = new Set(proposal.tags ?? []);

  for (const active of activeAgents) {
    const fileOverlap = intersect(proposedFiles, new Set(active.files ?? []));
    if (fileOverlap.length > 0) {
      hard.push({
        with_agent_id: active.agent_id,
        with_agent_name: active.agent_name,
        with_branch: active.branch,
        kind: "file-path-overlap",
        files: fileOverlap,
        started_at: active.started_at,
        last_heartbeat_at: active.last_heartbeat_at,
      });
    }
    const tagOverlap = intersect(proposedTags, new Set(active.workstream_tags ?? []));
    if (tagOverlap.length > 0) {
      soft.push({
        with_agent_id: active.agent_id,
        with_agent_name: active.agent_name,
        with_branch: active.branch,
        kind: "workstream-tag-overlap",
        tags: tagOverlap,
        started_at: active.started_at,
        last_heartbeat_at: active.last_heartbeat_at,
      });
    }
  }
  return { ok: hard.length === 0 && soft.length === 0, hard, soft };
}

// Returns null when valid, else an error message (drives the input-error contract).
function validateProposal(proposal: Proposal): string | null {
  if (!proposal || typeof proposal !== "object") return "proposal must be an object";
  const files = proposal.files ?? [];
  const tags = proposal.tags ?? [];
  if (files.length === 0 && tags.length === 0) {
    return "proposal must declare at least one of --files or --tags";
  }
  for (const f of files) if (typeof f !== "string" || f.length === 0) return `files[] entries must be non-empty strings (got: ${JSON.stringify(f)})`;
  for (const t of tags) if (typeof t !== "string" || t.length === 0) return `tags[] entries must be non-empty strings (got: ${JSON.stringify(t)})`;
  return null;
}

// --force downgrades a soft-only collision to ok; hard stays red.
function applyForce(result: CollisionResult, force: boolean): CollisionResult {
  if (!force) return result;
  if (result.hard.length > 0) return result;
  if (result.soft.length === 0) return result;
  return { ...result, ok: true, forced: true };
}

// ─── State-file schema (ported verbatim from lib/schema.mjs) ──────────────────
// Returns null when valid, else a human-readable error. Tolerant: unknown optional
// fields are ignored; only required shape + known-value sets are enforced.
function validateStateFile(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return "state file is not a JSON object";
  const o = obj as Record<string, unknown>;
  for (const field of ["schema_version", "agent_id", "agent_name", "agent_kind", "started_at", "last_heartbeat_at"]) {
    if (!(field in o)) return `missing required field: ${field}`;
  }
  if (o.schema_version !== SCHEMA_VERSION) return `unsupported schema_version: ${o.schema_version} (expected ${SCHEMA_VERSION})`;
  if (typeof o.agent_id !== "string" || o.agent_id.length === 0) return "agent_id must be a non-empty string";
  if (typeof o.agent_name !== "string" || o.agent_name.length === 0) return "agent_name must be a non-empty string";
  if (typeof o.agent_kind !== "string" || !VALID_AGENT_KINDS.has(o.agent_kind)) return `agent_kind must be one of: ${[...VALID_AGENT_KINDS].join(", ")}`;
  if (typeof o.started_at !== "string" || !isIsoUtc(o.started_at)) return "started_at must be an ISO 8601 UTC string";
  if (typeof o.last_heartbeat_at !== "string" || !isIsoUtc(o.last_heartbeat_at)) return "last_heartbeat_at must be an ISO 8601 UTC string";
  if ("files" in o && !Array.isArray(o.files)) return "files must be an array when present";
  if ("workstream_tags" in o && !Array.isArray(o.workstream_tags)) return "workstream_tags must be an array when present";
  return null;
}

// ─── The agent entrypoint ─────────────────────────────────────────────────────
export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const mode = ctx.input.mode;
  const stateDir = resolveStateDir(ctx);

  // Smoke short-circuit: exercise the surfaces ($0/offline, NO fs mutation). We
  // resolve the mode + state dir and return — no mkdir, no writes, no governed
  // pass (the Coordinator has no intelligence surface to check). Mirrors the Node
  // smoke contract "exercise the surfaces, do no real work".
  if (ctx.smoke) {
    ctx.log("smoke short-circuit · registry surface resolved (deterministic infra: no governed pass)", { mode: mode ?? null, stateDir });
    return { ok: true, smoke: true, mode: mode ?? null, stateDir };
  }

  if (!mode || mode === "help") {
    ctx.log(`modes: ${MODES.join(" | ")}`);
    return { ok: true, mode: null, help: true, modes: [...MODES] };
  }
  if (!(MODES as readonly string[]).includes(mode)) {
    ctx.log(`unknown mode "${mode}". Modes: ${MODES.join(", ")}`);
    return { ok: false, mode: null, error: "unknown-mode" };
  }

  // Idempotent: the state dir is the registry root.
  await mkdir(stateDir, { recursive: true });
  const now = new Date();
  const staleAfterSec = numOr(flagStr(ctx, "stale-after-sec"), DEFAULT_STALE_AFTER_SEC);
  const reapAfterSec = numOr(flagStr(ctx, "reap-after-sec"), DEFAULT_REAP_AFTER_SEC);
  const env = { ctx, stateDir, now, staleAfterSec, reapAfterSec };

  switch (mode) {
    case "status":
      return statusMode(env);
    case "check":
      return checkMode(env);
    case "start":
      return startMode(env);
    case "end":
      return endMode(env);
    case "repair":
      return repairMode(env);
    default:
      return { ok: false, mode: null, error: "unknown-mode" };
  }
});

interface Env {
  ctx: AgentContext;
  stateDir: string;
  now: Date;
  staleAfterSec: number;
  reapAfterSec: number;
}

// ─── Mode 1 · status (read-only) ──────────────────────────────────────────────
async function statusMode(env: Env): Promise<AgentResult> {
  const { active, stale, malformed } = await loadActiveSet(env);
  env.ctx.log(`${active.length} active, ${stale.length} stale${malformed.length ? `, ${malformed.length} malformed (skipped)` : ""}`, { stateDir: env.stateDir });
  return { ok: true, mode: "status", active, stale, counts: { active: active.length, stale: stale.length, malformed: malformed.length } };
}

// ─── Mode 2 · check (the spawn-gate) ──────────────────────────────────────────
async function checkMode(env: Env): Promise<AgentResult> {
  const { ctx } = env;
  const proposal: Proposal = {
    branch: flagStr(ctx, "branch"),
    files: splitCsv(flagStr(ctx, "files")),
    tags: splitCsv(flagStr(ctx, "tags")),
    agent_name: flagStr(ctx, "agent-name"),
  };
  const force = flagBool(ctx, "force");

  const inputError = validateProposal(proposal);
  if (inputError) {
    ctx.log(`check: ${inputError}`);
    return { ok: false, mode: "check", error: inputError };
  }

  // Collision uses active + stale-but-not-reaped (conservative, per spec §7).
  const { active, stale } = await loadActiveSet(env);
  const result = applyForce(detectCollisions(proposal, [...active, ...stale]), force);
  ctx.log(result.ok ? `check: clear${result.forced ? " (soft collision forced)" : ""}` : `check: ${result.hard.length} hard, ${result.soft.length} soft collision(s)`);
  return { ok: result.ok, mode: "check", hard: result.hard, soft: result.soft, forced: result.forced ?? false };
}

// ─── Mode 3 · start (register / heartbeat) ────────────────────────────────────
async function startMode(env: Env): Promise<AgentResult> {
  const { ctx, stateDir, now } = env;
  const agentId = flagStr(ctx, "agent-id");
  if (!agentId) {
    ctx.log("start: --agent-id is required");
    return { ok: false, mode: "start", error: "missing-agent-id" };
  }
  const filePath = resolvePath(stateDir, `${agentId}.json`);
  const heartbeat = flagBool(ctx, "heartbeat");

  if (heartbeat) {
    // Heartbeat-only: bump last_heartbeat_at on an existing file (refuse if absent,
    // per the narrow Phase 1.1 posture — issue a full start first).
    if (!existsSync(filePath)) {
      ctx.log(`start --heartbeat: no active file for ${agentId} (issue a full start first)`);
      return { ok: false, mode: "start", heartbeat: true, error: "no-active-file" };
    }
    const existing = await readJson<StateRecord>(filePath);
    if (!existing) {
      ctx.log(`start --heartbeat: ${filePath} is unreadable`);
      return { ok: false, mode: "start", heartbeat: true, error: "unreadable" };
    }
    existing.last_heartbeat_at = isoNow(now);
    const err = validateStateFile(existing);
    if (err) {
      ctx.log(`start --heartbeat: existing file fails validation: ${err}`);
      return { ok: false, mode: "start", heartbeat: true, error: err };
    }
    await atomicWriteJson(filePath, existing);
    ctx.log(`heartbeat ${agentId} @ ${existing.last_heartbeat_at}`);
    return { ok: true, mode: "start", heartbeat: true, agent_id: agentId, last_heartbeat_at: existing.last_heartbeat_at };
  }

  // Full start — agent-name, agent-kind, branch are required (per spec §Mode 3).
  for (const [flag, field] of [["agent-name", "agent_name"], ["agent-kind", "agent_kind"], ["branch", "branch"]] as const) {
    if (!flagStr(ctx, flag)) {
      ctx.log(`start: --${flag} is required`);
      return { ok: false, mode: "start", error: `missing-${flag}` };
    }
  }

  // Refuse a second start with the same id unless the existing file is past reap.
  if (existsSync(filePath)) {
    const existing = await readJson<StateRecord>(filePath);
    if (existing?.last_heartbeat_at) {
      const ageSec = (now.getTime() - new Date(existing.last_heartbeat_at).getTime()) / 1000;
      if (ageSec <= env.reapAfterSec) {
        ctx.log(`start: agent_id "${agentId}" already active (last heartbeat ${Math.round(ageSec)}s ago). Pick a different id.`);
        return { ok: false, mode: "start", error: "duplicate-agent-id" };
      }
    }
  }

  const nowIso = isoNow(now);
  const record: StateRecord = {
    schema_version: SCHEMA_VERSION,
    agent_id: agentId,
    agent_name: flagStr(ctx, "agent-name")!,
    agent_kind: flagStr(ctx, "agent-kind")!,
    started_at: nowIso,
    last_heartbeat_at: nowIso,
  };
  const pid = flagStr(ctx, "pid");
  if (pid !== undefined) record.pid = Number(pid);
  if (flagStr(ctx, "host")) record.host = flagStr(ctx, "host");
  if (flagStr(ctx, "branch")) record.branch = flagStr(ctx, "branch");
  if (flagStr(ctx, "worktree")) record.worktree = flagStr(ctx, "worktree");
  const files = splitCsv(flagStr(ctx, "files"));
  if (files.length > 0) record.files = files;
  const tags = splitCsv(flagStr(ctx, "tags"));
  if (tags.length > 0) record.workstream_tags = tags;
  if (flagStr(ctx, "spawn-source")) {
    record.spawn_source = { kind: flagStr(ctx, "spawn-source")! };
    if (flagStr(ctx, "spawn-ref")) record.spawn_source.ref = flagStr(ctx, "spawn-ref");
  }

  const validationError = validateStateFile(record);
  if (validationError) {
    ctx.log(`start: would write invalid state file: ${validationError}`);
    return { ok: false, mode: "start", error: validationError };
  }

  await atomicWriteJson(filePath, record);
  ctx.log(`started ${agentId} → ${filePath}`);
  return { ok: true, mode: "start", agent_id: agentId, file: filePath };
}

// ─── Mode 4 · end ─────────────────────────────────────────────────────────────
async function endMode(env: Env): Promise<AgentResult> {
  const { ctx, stateDir } = env;
  const agentId = flagStr(ctx, "agent-id");
  if (!agentId) {
    ctx.log("end: --agent-id is required");
    return { ok: false, mode: "end", error: "missing-agent-id" };
  }
  const reason = flagStr(ctx, "reason") || "completed";
  const filePath = resolvePath(stateDir, `${agentId}.json`);

  if (!existsSync(filePath)) {
    ctx.log(`end: no active file for ${agentId} (no-op; audit log lands in Phase 1.2)`);
    return { ok: true, mode: "end", noop: true, agent_id: agentId, reason };
  }
  await unlink(filePath);
  ctx.log(`ended ${agentId} (reason: ${reason})`);
  return { ok: true, mode: "end", agent_id: agentId, reason };
}

// ─── Mode 5 · repair (reap stale-past-reap entries) ───────────────────────────
async function repairMode(env: Env): Promise<AgentResult> {
  const { ctx } = env;
  const { active, stale, reapable, malformed } = await scanActiveDir(env);
  const reaped: { agent_id: string; age_sec: number }[] = [];
  for (const r of reapable) {
    try {
      await unlink(r.path);
      reaped.push({ agent_id: r.record.agent_id, age_sec: Math.round(r.ageSec) });
    } catch (e) {
      ctx.log(`repair: failed to unlink ${r.path}: ${(e as Error).message}`);
    }
  }
  const summary = {
    scanned: active.length + stale.length + reapable.length + malformed.length,
    healthy: active.length,
    stale_flagged: stale.length,
    reaped: reaped.length,
    malformed: malformed.length,
  };
  ctx.log(`${summary.reaped} reaped, ${summary.stale_flagged} flagged, ${summary.healthy} healthy`);
  return { ok: true, mode: "repair", ...summary, reapedList: reaped };
}

// ─── Active-set scanning ──────────────────────────────────────────────────────
interface Scan {
  active: StateRecord[];
  stale: StateRecord[];
  reapable: { path: string; record: StateRecord; ageSec: number }[];
  malformed: { path: string; reason: string }[];
}

// Bucket every state file into active / stale / reapable / malformed. Pure read.
async function scanActiveDir(env: Env): Promise<Scan> {
  const active: StateRecord[] = [];
  const stale: StateRecord[] = [];
  const reapable: Scan["reapable"] = [];
  const malformed: Scan["malformed"] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(env.stateDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { active, stale, reapable, malformed };
    throw e;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const filePath = resolvePath(env.stateDir, entry);
    const record = await readJson<StateRecord>(filePath);
    if (!record) {
      malformed.push({ path: filePath, reason: "parse-error" });
      continue;
    }
    const schemaError = validateStateFile(record);
    if (schemaError) {
      malformed.push({ path: filePath, reason: schemaError });
      continue;
    }
    const ageSec = (env.now.getTime() - new Date(record.last_heartbeat_at).getTime()) / 1000;
    if (ageSec > env.reapAfterSec) reapable.push({ path: filePath, record, ageSec });
    else if (ageSec > env.staleAfterSec) stale.push(record);
    else active.push(record);
  }
  return { active, stale, reapable, malformed };
}

// status + check see reapable entries too (the user has not run repair yet —
// conservative collision detection). Only repair separates the reapable bucket.
async function loadActiveSet(env: Env): Promise<{ active: StateRecord[]; stale: StateRecord[]; malformed: Scan["malformed"] }> {
  const { active, stale, reapable, malformed } = await scanActiveDir(env);
  return { active, stale: [...stale, ...reapable.map((r) => r.record)], malformed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolveStateDir(ctx: AgentContext): string {
  const raw = flagStr(ctx, "state-dir") || Bun.env.AGIX_FLEET_STATE_DIR || "~/.cache/agix-fleet/active";
  if (raw.startsWith("~/")) return resolvePath(homedir(), raw.slice(2));
  if (raw === "~") return homedir();
  return resolvePath(raw);
}

function flagStr(ctx: AgentContext, name: string): string | undefined {
  const v = ctx.input.flags[name];
  return typeof v === "string" ? v : undefined;
}
function flagBool(ctx: AgentContext, name: string): boolean {
  return ctx.input.flags[name] === true || ctx.input.flags[name] === "true";
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function numOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function isoNow(date: Date): string {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function isIsoUtc(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}
// Write-then-rename atomic write (per spec §4).
async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = path + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, path);
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const item of a) if (b.has(item)) out.push(item);
  return out;
}
