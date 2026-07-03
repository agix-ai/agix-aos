// agix-stv-deploy-health — Self-Trained Verification substrate for the
// Director deploy-health proof agent (G10).
//
// Two jobs, both deterministic and side-effect-light:
//   1. findingKey()      — stable cross-cycle identity for a finding.
//   2. buildSnapshot()   — map checkDeployHealth() output onto the
//                          agix.deploy-health.snapshot.v1 envelope.
//   3. append/read       — bounded per-agent history via runtime state.
//
// Capture is purely additive telemetry: an agent that never calls
// appendDeployHealthSnapshot() behaves exactly as before (Rule-of-Two
// safe — no new outward side-effects).
//
// Plan: docs/dev-backlog/2026-05-30-self-trained-verification-plan.md
// Sketch: docs/dev-backlog/2026-05-30-g10-phase1-labeler-sketch.md

const HISTORY_KEY = 'deploy-health-history';
const HISTORY_MAX = 400; // ~100 days at 4×/day

/**
 * Head SHA of the most recent CI workflow run in a snapshot's ci.runs,
 * used to scope ci-failing / deploy-skipped finding keys to the break.
 * @returns {string} 12-char sha or '' when unknown.
 */
export function ciHeadSha(snapshot) {
  const runs = snapshot?.ci?.runs ?? [];
  const ciRun = runs.find((r) => r.workflowName === 'CI' || r.name === 'CI') || runs[0];
  return (ciRun?.headSha || '').slice(0, 12);
}

/**
 * Deterministic identity for a deploy-health finding so it can be
 * tracked across cycles. Singleton categories key on the flagged HEAD;
 * CI categories key on the failing CI head sha. Tooling-failure
 * categories (`*-unavailable`) are not gradable and return null.
 * @returns {string|null}
 */
export function findingKey(finding, snapshot) {
  const head = (snapshot?.headSha || '').slice(0, 12);
  switch (finding.category) {
    case 'apphosting-gap':
    case 'apphosting-rollout-failed':
      return `${finding.category}@${head}`;
    case 'ci-failing':
      return `ci-failing@${ciHeadSha(snapshot)}`;
    case 'deploy-skipped':
      return `deploy-skipped@${ciHeadSha(snapshot) || head}`;
    default:
      return null; // ci-gh-unavailable, apphosting-unavailable, unknown
  }
}

/**
 * Map a checkDeployHealth() result onto the snapshot envelope, stamping
 * a findingKey onto each finding. Pure.
 * @param {object} health  - { findings, ci, appHosting, latestCommit }
 * @param {{ runId: string, capturedAt?: string }} meta
 * @returns {import('@agix/types').DeployHealthSnapshot}
 */
export function buildSnapshot(health, { runId, capturedAt } = {}) {
  const snapshot = {
    schema: 'agix.deploy-health.snapshot.v1',
    runId: runId || '',
    capturedAt: capturedAt || new Date().toISOString(),
    headSha: health?.latestCommit?.sha || '',
    findings: [],
    ci: { runs: (health?.ci?.runs ?? []).slice(0, 20) },
    appHosting: {
      gap: health?.appHosting?.gap ?? null,
      latestSucceededSha: health?.appHosting?.latestSucceededSha ?? null,
      latestRolloutState: health?.appHosting?.latestRolloutState ?? null,
    },
  };
  snapshot.findings = (health?.findings ?? []).map((f) => ({
    ...f,
    key: findingKey(f, snapshot),
  }));
  return snapshot;
}

/**
 * Append a snapshot to the bounded per-agent history (runtime state).
 * Best-effort: telemetry must never break the agent, so callers should
 * not depend on the return value beyond the written path.
 */
export async function appendDeployHealthSnapshot(runtime, snapshot) {
  const current = (await runtime.readState(HISTORY_KEY, { snapshots: [] })) || { snapshots: [] };
  const snapshots = Array.isArray(current.snapshots) ? current.snapshots : [];
  snapshots.push(snapshot);
  if (snapshots.length > HISTORY_MAX) snapshots.splice(0, snapshots.length - HISTORY_MAX);
  return runtime.writeState(HISTORY_KEY, { snapshots });
}

/**
 * Read the captured history (time-ordered as appended).
 * @returns {Promise<import('@agix/types').DeployHealthSnapshot[]>}
 */
export async function readDeployHealthHistory(runtime) {
  const current = (await runtime.readState(HISTORY_KEY, { snapshots: [] })) || { snapshots: [] };
  return Array.isArray(current.snapshots) ? current.snapshots : [];
}

/**
 * Locate the (snapshot, finding) a label refers to, so feature
 * extraction can rebuild the verifier input from a label. Pure.
 * @returns {{ snapshot: object, finding: object }|null}
 */
export function resolveFinding(history, runId, findingKey) {
  for (const snapshot of history) {
    if (snapshot.runId !== runId) continue;
    const finding = (snapshot.findings || []).find((f) => f.key === findingKey);
    if (finding) return { snapshot, finding };
  }
  // Fall back to the first occurrence of the key anywhere (labels are
  // emitted against the first episode snapshot).
  for (const snapshot of history) {
    const finding = (snapshot.findings || []).find((f) => f.key === findingKey);
    if (finding) return { snapshot, finding };
  }
  return null;
}

export const STV_HISTORY_KEY = HISTORY_KEY;
