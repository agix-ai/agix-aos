// agix-dora — DORA + agentic gate metrics, pure over audit-ledger entries.
//
// The read side of the L2 umbrella loop (LOOP_ENGINEERED_SDLC §4 + §5): the five
// DORA metrics plus the agentic extensions the append-only ledger uniquely
// enables — gate-rejection rate per phase/agent, first-pass gate yield, and the
// deployment rework rate. Every function here is pure: it takes an array of
// ledger entries (the shape emitted by agix-audit-ledger.mjs) and returns
// numbers. No I/O, no clock, no randomness — deterministic on a fixture ledger,
// which is exactly what the umbrella loop needs to compute priors reproducibly.
//
// Entry → metric mapping (ledger kinds, LOOP_ENGINEERED_SDLC §2):
//   kind='release'  → a deployment (deploy freq, change-fail, recovery).
//   kind='merge'    → the Integrate stamp (lead-time start).
//   kind='verdict' / 'gate_decision' with a Stage-Gate verdict → gate metrics.
// Deployments are matched to their originating merge by the deepest shared scope
// segment (mandateId, else runId) so lead time is per-change, not global.

// Parse an ISO-8601 ts to epoch ms. Returns NaN on a missing/garbage ts (callers
// filter those out) — no bare Date.now(), only Date.parse over recorded data.
function tsMs(entry) {
  return entry && entry.ts ? Date.parse(entry.ts) : NaN;
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// The scope key a change is grouped by: the deepest present segment identifies
// "one change" across its merge → release lifecycle.
function changeKey(entry) {
  const s = entry.scope || {};
  return s.mandateId || s.runId || null;
}

// A release counts as a failure when its own verdict is a kill/fail, or a human
// reversed it, or the caller flagged it (meta.failed / meta.rollback).
function isFailedRelease(entry) {
  if (entry.verdict === 'KILL' || entry.verdict === 'fail') return true;
  if (entry.overridden_by_human) return true;
  const m = entry.meta || {};
  return Boolean(m.failed || m.rollback);
}

// ─── The five DORA metrics ─────────────────────────────────────────────

// 1. Deployment frequency: count of releases, plus a per-day rate over the
// observed span (first→last release). Rate is null with <2 releases (no span).
export function deploymentFrequency(entries) {
  const releases = entries.filter((e) => e.kind === 'release');
  const times = releases.map(tsMs).filter(Number.isFinite).sort((a, b) => a - b);
  let perDay = null;
  if (times.length >= 2) {
    const spanMs = times[times.length - 1] - times[0];
    const spanDays = spanMs / 86_400_000;
    perDay = spanDays > 0 ? releases.length / spanDays : null;
  }
  return { count: releases.length, perDay };
}

// 2. Change lead time: median ms from a change's merge stamp to its release.
// Matched by changeKey; unmatched merges/releases are ignored.
export function changeLeadTime(entries) {
  const mergeByChange = new Map();
  for (const e of entries) {
    if (e.kind !== 'merge') continue;
    const key = changeKey(e);
    const t = tsMs(e);
    if (!key || !Number.isFinite(t)) continue;
    // Earliest merge for the change is the lead-time start.
    if (!mergeByChange.has(key) || t < mergeByChange.get(key)) mergeByChange.set(key, t);
  }
  const leads = [];
  for (const e of entries) {
    if (e.kind !== 'release') continue;
    const key = changeKey(e);
    const rel = tsMs(e);
    if (!key || !Number.isFinite(rel) || !mergeByChange.has(key)) continue;
    leads.push(rel - mergeByChange.get(key));
  }
  return { medianMs: median(leads), samples: leads.length };
}

// 3. Change failure rate: failed releases / total releases (0..1).
export function changeFailureRate(entries) {
  const releases = entries.filter((e) => e.kind === 'release');
  if (releases.length === 0) return { rate: null, failed: 0, total: 0 };
  const failed = releases.filter(isFailedRelease).length;
  return { rate: failed / releases.length, failed, total: releases.length };
}

// 4. Failed-deployment recovery time: for each failed release, median ms to the
// next successful release (any change). A trailing unrecovered failure is
// excluded from the median but counted as unrecovered.
export function failedDeploymentRecoveryTime(entries) {
  const releases = entries
    .filter((e) => e.kind === 'release' && Number.isFinite(tsMs(e)))
    .slice()
    .sort((a, b) => tsMs(a) - tsMs(b));
  const recoveries = [];
  let unrecovered = 0;
  for (let i = 0; i < releases.length; i++) {
    if (!isFailedRelease(releases[i])) continue;
    const failT = tsMs(releases[i]);
    let recoveredAt = null;
    for (let j = i + 1; j < releases.length; j++) {
      if (!isFailedRelease(releases[j])) { recoveredAt = tsMs(releases[j]); break; }
    }
    if (recoveredAt === null) unrecovered += 1;
    else recoveries.push(recoveredAt - failT);
  }
  return { medianMs: median(recoveries), recovered: recoveries.length, unrecovered };
}

// 5. Deployment rework rate: RECYCLE verdicts / total gate verdicts (0..1) — the
// fraction of gate passes that were sent back to the actor (LOOP_ENGINEERED_SDLC
// §4, the compounding-quality signal's inverse).
export function deploymentReworkRate(entries) {
  const gateVerdicts = entries.filter(
    (e) => (e.kind === 'verdict' || e.kind === 'gate_decision') &&
      ['GO', 'KILL', 'HOLD', 'RECYCLE'].includes(e.verdict),
  );
  if (gateVerdicts.length === 0) return { rate: null, recycled: 0, total: 0 };
  const recycled = gateVerdicts.filter((e) => e.verdict === 'RECYCLE').length;
  return { rate: recycled / gateVerdicts.length, recycled, total: gateVerdicts.length };
}

// All five in one call.
export function computeDora(entries) {
  return {
    deploymentFrequency: deploymentFrequency(entries),
    changeLeadTime: changeLeadTime(entries),
    changeFailureRate: changeFailureRate(entries),
    failedDeploymentRecoveryTime: failedDeploymentRecoveryTime(entries),
    deploymentReworkRate: deploymentReworkRate(entries),
  };
}

// ─── Agentic gate metrics (what the ledger uniquely enables) ───────────

// Gate rejection rate grouped by phase or by actor: (KILL + RECYCLE) over all
// gate verdicts in the group — where the loop catches things (the L0 health
// signal, §4). `by` ∈ {'phase','actor'}.
export function gateRejectionRate(entries, { by = 'phase' } = {}) {
  const field = by === 'actor' ? 'actor' : 'phase';
  const groups = {};
  for (const e of entries) {
    if (e.kind !== 'verdict' && e.kind !== 'gate_decision') continue;
    if (!['GO', 'KILL', 'HOLD', 'RECYCLE'].includes(e.verdict)) continue;
    const key = e[field] ?? '(none)';
    const g = groups[key] || (groups[key] = { total: 0, rejected: 0 });
    g.total += 1;
    if (e.verdict === 'KILL' || e.verdict === 'RECYCLE') g.rejected += 1;
  }
  const out = {};
  for (const [key, g] of Object.entries(groups)) {
    out[key] = { rate: g.total ? g.rejected / g.total : null, rejected: g.rejected, total: g.total };
  }
  return out;
}

// First-pass gate yield: fraction of (change, phase) gate sequences whose FIRST
// verdict was GO — the compounding-quality curve (§4). A change re-entering a
// phase (RECYCLE→…→GO) does not count as first-pass.
export function firstPassGateYield(entries) {
  const seq = new Map();  // `${changeKey}|${phase}` → first verdict (by ts, then order)
  const indexed = entries
    .map((e, i) => ({ e, i, t: tsMs(e) }))
    .filter(({ e }) => (e.kind === 'verdict' || e.kind === 'gate_decision') &&
      ['GO', 'KILL', 'HOLD', 'RECYCLE'].includes(e.verdict))
    .sort((a, b) => {
      const ta = Number.isFinite(a.t) ? a.t : 0;
      const tb = Number.isFinite(b.t) ? b.t : 0;
      return ta - tb || a.i - b.i;
    });
  for (const { e } of indexed) {
    const key = `${changeKey(e) ?? '(none)'}|${e.phase ?? '(none)'}`;
    if (!seq.has(key)) seq.set(key, e.verdict);  // first verdict wins
  }
  const total = seq.size;
  let firstPass = 0;
  for (const v of seq.values()) if (v === 'GO') firstPass += 1;
  return { rate: total ? firstPass / total : null, firstPass, total };
}

// All gate metrics in one call.
export function gateMetrics(entries) {
  return {
    rejectionRateByPhase: gateRejectionRate(entries, { by: 'phase' }),
    rejectionRateByActor: gateRejectionRate(entries, { by: 'actor' }),
    firstPassGateYield: firstPassGateYield(entries),
  };
}
