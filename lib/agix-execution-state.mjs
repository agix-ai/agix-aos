// agix-execution-state — P1 of the execution-state memory layer.
//
// A per-agent, per-tenant, per-task structured record of work in
// progress: task status, intermediate results (by reference), and
// branching history. Retrieval is DETERMINISTIC key lookup, never
// similarity search — this is the substrate the semantic/vector store
// is structurally mismatched to serve.
//
// Design + rationale:
//   architecture/03-ai-ml/agent-architecture/MEMORY_EXECUTION_STATE.md (§2.1)
// Origin: wiki/research/2026-06-06-brief.md §2 (assumption reframe).
//
// Storage rides the existing tenant-keyed runtime state contract — one
// state document named `execution-state` holding `{ tasks: [...] }` at
// ~/.cache/agix-<agent>/execution-state.json (cloud adapter: Firestore
// tenants/<tenant>/agents/<agent>/execution-state). NO new datastore,
// NO new dependency. The read-modify-write pattern mirrors
// `upsertQueueItem` in lib/agix-director-queue.mjs.
//
// P1 scope: schema + accessors only. No agent wires this in yet (no
// behaviour change). P2 migrates the Director queue + Onboarding cursors
// onto this schema.

const STATE_KEY = 'execution-state';

// Task lifecycle (§2.1). Explicit status — agents read it, never
// re-derive "did I already do X?" from fuzzy recall.
export const STATUSES = ['pending', 'active', 'blocked', 'done', 'abandoned'];
const DEFAULT_STATUS = 'pending';

// Per-step outcome vocabulary.
export const STEP_OUTCOMES = ['success', 'failure', 'partial', 'skipped'];

function assertStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new Error(
      `execution-state: invalid status '${status}' (expected one of ${STATUSES.join(', ')})`,
    );
  }
}

function assertOutcome(outcome) {
  // outcome is optional on a step (a step may be recorded before it
  // resolves); only validate when present.
  if (outcome != null && !STEP_OUTCOMES.includes(outcome)) {
    throw new Error(
      `execution-state: invalid step outcome '${outcome}' (expected one of ${STEP_OUTCOMES.join(', ')})`,
    );
  }
}

// ─── Store I/O (read-modify-write over the tenant-keyed state doc) ───

async function readAll(runtime) {
  const doc = (await runtime.readState(STATE_KEY, { tasks: [] })) || { tasks: [] };
  return Array.isArray(doc.tasks) ? doc.tasks : [];
}

async function writeAll(runtime, tasks) {
  return runtime.writeState(STATE_KEY, { tasks });
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Reads ───────────────────────────────────────────────────────────

// Deterministic O(n) lookup by task_id. Returns the record or null.
export async function getTask(runtime, taskId) {
  if (!taskId) throw new Error('getTask: task_id required');
  const tasks = await readAll(runtime);
  return tasks.find((t) => t.task_id === taskId) || null;
}

// List records, optionally filtered by status and/or agent. No
// similarity, no ranking — a plain indexed scan over the tenant-scoped
// store.
export async function listTasks(runtime, { status, agent } = {}) {
  if (status != null) assertStatus(status);
  const tasks = await readAll(runtime);
  return tasks.filter((t) => {
    if (status != null && t.status !== status) return false;
    if (agent != null && t.agent !== agent) return false;
    return true;
  });
}

// ─── Writes ──────────────────────────────────────────────────────────

// Upsert a task: read store, shallow-merge `patch` onto the existing
// record (or onto a freshly-initialised record), stamp updated_at, write
// back. Returns the merged record. `tenant_id` and `agent` default from
// the runtime; `status` defaults to 'pending'. Mirrors upsertQueueItem.
export async function putTask(runtime, taskId, patch = {}) {
  if (!taskId) throw new Error('putTask: task_id required');
  if (patch.status != null) assertStatus(patch.status);

  const tasks = await readAll(runtime);
  const idx = tasks.findIndex((t) => t.task_id === taskId);
  const isNew = idx < 0;

  const base = isNew
    ? {
        task_id: taskId,
        tenant_id: runtime.tenantId,
        agent: runtime.agentName ?? null,
        goal: '',
        status: DEFAULT_STATUS,
        created_at: nowIso(),
        steps: [],
        branches: [],
        pending: [],
      }
    : tasks[idx];

  const merged = {
    ...base,
    ...patch,
    // Identity + structural invariants always win over patch noise.
    task_id: taskId,
    tenant_id: base.tenant_id,
    created_at: base.created_at,
    // Preserve array substrates unless the caller explicitly replaces them.
    steps: patch.steps ?? base.steps ?? [],
    branches: patch.branches ?? base.branches ?? [],
    pending: patch.pending ?? base.pending ?? [],
    updated_at: nowIso(),
  };

  if (isNew) tasks.push(merged);
  else tasks[idx] = merged;
  await writeAll(runtime, tasks);
  return merged;
}

// Internal: load a task or throw — the typed mutators below operate on
// existing tasks (creating one is putTask's job, explicitly).
async function requireTask(tasks, taskId) {
  const idx = tasks.findIndex((t) => t.task_id === taskId);
  if (idx < 0) throw new Error(`execution-state: task '${taskId}' not found`);
  return idx;
}

// Append a step to a task's execution trace. `result_ref` should point at
// an artifact (path / Firestore doc / URL) — NOT inline the blob. step_id
// and ts are stamped if absent. Returns the updated task.
export async function appendStep(runtime, taskId, step = {}) {
  if (!taskId) throw new Error('appendStep: task_id required');
  assertOutcome(step.outcome);
  const tasks = await readAll(runtime);
  const idx = await requireTask(tasks, taskId);
  const task = tasks[idx];
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const entry = {
    step_id: step.step_id ?? `s${steps.length + 1}`,
    intent: step.intent ?? '',
    outcome: step.outcome ?? null,
    result_ref: step.result_ref ?? null,
    ts: step.ts ?? nowIso(),
  };
  task.steps = [...steps, entry];
  task.updated_at = nowIso();
  tasks[idx] = task;
  await writeAll(runtime, tasks);
  return task;
}

// Transition a task's status (validated). Returns the updated task.
export async function setStatus(runtime, taskId, status) {
  assertStatus(status);
  const tasks = await readAll(runtime);
  const idx = await requireTask(tasks, taskId);
  tasks[idx] = { ...tasks[idx], status, updated_at: nowIso() };
  await writeAll(runtime, tasks);
  return tasks[idx];
}

// Record a branch in the task's branching history (an alternative
// explored). Returns the updated task.
export async function addBranch(runtime, taskId, branch = {}) {
  if (!taskId) throw new Error('addBranch: task_id required');
  const tasks = await readAll(runtime);
  const idx = await requireTask(tasks, taskId);
  const task = tasks[idx];
  const branches = Array.isArray(task.branches) ? task.branches : [];
  task.branches = [
    ...branches,
    {
      from_step: branch.from_step ?? null,
      reason: branch.reason ?? '',
      chosen: branch.chosen ?? false,
    },
  ];
  task.updated_at = nowIso();
  tasks[idx] = task;
  await writeAll(runtime, tasks);
  return task;
}

// Add an open sub-goal to `pending` (deduped). Returns the updated task.
export async function addPending(runtime, taskId, item) {
  if (!item) throw new Error('addPending: item required');
  const tasks = await readAll(runtime);
  const idx = await requireTask(tasks, taskId);
  const task = tasks[idx];
  const pending = Array.isArray(task.pending) ? task.pending : [];
  if (!pending.includes(item)) task.pending = [...pending, item];
  task.updated_at = nowIso();
  tasks[idx] = task;
  await writeAll(runtime, tasks);
  return task;
}

// Resolve (remove) a sub-goal from `pending`. No-op if absent. Returns
// the updated task.
export async function resolvePending(runtime, taskId, item) {
  const tasks = await readAll(runtime);
  const idx = await requireTask(tasks, taskId);
  const task = tasks[idx];
  const pending = Array.isArray(task.pending) ? task.pending : [];
  task.pending = pending.filter((p) => p !== item);
  task.updated_at = nowIso();
  tasks[idx] = task;
  await writeAll(runtime, tasks);
  return task;
}

export const EXECUTION_STATE_KEY = STATE_KEY;
