// Agix Release Manager — the release-train governance gate above the dev loop.
//
// Owns the release CALENDAR + cadence for the release/GTM layer
// (architecture/03-ai-ml/agent-architecture/RELEASE_GTM_MANAGEMENT.md §2.1):
// feature-freeze & code-freeze dates, the RC cycle, the launch-readiness / PRR
// review, the rollout & rollback plan, Early Life Support, and the release
// record. It is the VERIFIER that the build is launch-ready — the human co-signs
// the go/no-go (G3).
//
// Deterministic cores (pure, exported, unit-tested):
//   computeReleaseTrain(cadence)      → freeze / code-freeze / RC / release dates.
//   checkFeatureFreeze(state)         → G1: no new scope past the freeze.
//   checkCodeFreeze(state)            → G2: RC = ship build; only blocker cherry-picks.
//   evaluateLaunchReadiness(checklist)→ G3: the Google-LCE seven-part PRR checklist.
//   checkRollout(plan)                → G4: canary %, bake time, abort criteria per ring.
//   releaseSuccessRate(entries)       → ITIL ≥90% target, from the audit ledger.
//
// Four gates on lib/agix-gate.mjs (actor ≠ verifier; every decision recorded):
//   G1 feature-freeze   — new scope after freeze → RECYCLE.
//   G2 code-freeze/RC   — a non-blocker change in the RC → RECYCLE.
//   G3 launch-readiness — PRR checklist complete → HOLD (human go/no-go); gaps → RECYCLE.
//   G4 rollout          — a rollout outside the canary/bake/abort envelope → HOLD.
//
// DORA + release-success metrics are computed from the audit ledger via
// lib/agix-dora.mjs. Trust level: PROPOSER — it plans the train and gates it;
// it never deploys (release-engineer + the CI/CD pipeline own the plumbing).
//
// Deterministic core runs with NO API key; the LLM is used only for the optional
// launch-readiness-review narrative behind runtime.getModel() (narrator pattern).
//
// Spec / persona: agents/release-manager/PERSONA.md
// Manifest:       agents/release-manager/manifest.yaml
// Substrate:      lib/agix-audit-ledger.mjs · lib/agix-gate.mjs · lib/agix-dora.mjs

import { Gate, VERDICT, composeGate } from '../../lib/agix-gate.mjs';
import { changeFailureRate, computeDora } from '../../lib/agix-dora.mjs';

// The seven-part Google launch-readiness (LCE/PRR) checklist. Fixed set — the
// launch-readiness gate requires every dimension to be present + green.
export const LCE_DIMENSIONS = Object.freeze([
  'architecture', 'capacity', 'failureModes', 'monitoring', 'security', 'dependencies', 'rollback',
]);

// ─── Pure core 1: the release train (calendar/cadence) ───────────────
//
// Apple-train shape: anchor the release to a calendar; feature-freeze then
// code-freeze/RC lead it by fixed intervals; the RC is the ship build. Given an
// anchor release date + lead intervals, compute the train's fixed dates.
//
// cadence: { anchorDate: 'YYYY-MM-DD', featureFreezeLeadDays, codeFreezeLeadDays, rcLeadDays }
export function computeReleaseTrain(cadence = {}) {
  const anchor = parseDate(cadence.anchorDate);
  if (!anchor) return { valid: false, reason: `unparseable anchorDate: ${cadence.anchorDate}` };
  const featureFreezeLead = numOr(cadence.featureFreezeLeadDays, 14);
  const codeFreezeLead = numOr(cadence.codeFreezeLeadDays, 5);
  const rcLead = numOr(cadence.rcLeadDays, 3);
  const dates = {
    featureFreezeDate: isoDay(addDays(anchor, -featureFreezeLead)),
    codeFreezeDate: isoDay(addDays(anchor, -codeFreezeLead)),
    rcDate: isoDay(addDays(anchor, -rcLead)),
    releaseDate: isoDay(anchor),
  };
  // The train is well-formed only when the milestones are monotonically ordered.
  const ordered = dates.featureFreezeDate <= dates.codeFreezeDate
    && dates.codeFreezeDate <= dates.rcDate
    && dates.rcDate <= dates.releaseDate;
  return { valid: ordered, ...dates, reason: ordered ? 'train milestones ordered' : 'lead intervals overlap — freeze after RC' };
}

// ─── Pure core 2: G1 feature-freeze ──────────────────────────────────
//
// No new scope past the feature freeze. `newScopeAfterFreeze` is the list of
// features/tickets added after the freeze date; any entry trips the gate.
export function checkFeatureFreeze(state = {}) {
  const frozen = state.frozen !== false;   // default: the freeze is in effect
  const added = asList(state.newScopeAfterFreeze);
  if (!frozen) return { ok: true, verdict: VERDICT.GO, reason: 'feature freeze not yet in effect' };
  if (added.length === 0) return { ok: true, verdict: VERDICT.GO, reason: 'no new scope since feature freeze' };
  return { ok: false, verdict: VERDICT.RECYCLE, added, reason: `new scope added after feature freeze: ${added.join(', ')} — defer to the next train` };
}

// ─── Pure core 3: G2 code-freeze / RC ────────────────────────────────
//
// The RC is the ship build; only blocker cherry-picks are allowed in. Any
// non-blocker change in the RC window trips the gate.
export function checkCodeFreeze(state = {}) {
  const changes = asList(state.rcChanges);        // [{ id, blocker: boolean }]
  const nonBlockers = changes.filter((c) => !(c && c.blocker));
  if (nonBlockers.length === 0) {
    return { ok: true, verdict: VERDICT.GO, isShipBuild: true, reason: `RC is a clean ship build (${changes.length} blocker cherry-pick(s))` };
  }
  return {
    ok: false, verdict: VERDICT.RECYCLE, isShipBuild: false,
    nonBlockers: nonBlockers.map((c) => c.id ?? '(unknown)'),
    reason: `non-blocker change(s) in the RC: ${nonBlockers.map((c) => c.id ?? '(unknown)').join(', ')} — an RC only takes blocker cherry-picks`,
  };
}

// ─── Pure core 4: G3 launch-readiness (Google LCE / PRR) ─────────────
//
// The seven-part PRR checklist. `checklist` maps each LCE_DIMENSIONS key to a
// truthy value (ready) or falsy (gap). Returns the verdict material; the gate
// then routes a complete checklist to a human go/no-go (HOLD).
export function evaluateLaunchReadiness(checklist = {}) {
  const missing = LCE_DIMENSIONS.filter((d) => !checklist[d]);
  const complete = missing.length === 0;
  return {
    complete,
    missing,
    present: LCE_DIMENSIONS.filter((d) => checklist[d]),
    reason: complete
      ? 'all seven PRR dimensions ready — route to human go/no-go'
      : `PRR gaps: ${missing.join(', ')} — close before the readiness review`,
  };
}

// ─── Pure core 5: G4 rollout envelope ────────────────────────────────
//
// A staged rollout must stay inside the canary %, meet the bake time, and have
// its abort criteria armed per ring. Outside the envelope → escalate.
//
// plan: { canaryPercent, bakeMinutes, abortCriteriaMet, maxCanaryPercent?, minBakeMinutes? }
export function checkRollout(plan = {}) {
  const maxCanary = numOr(plan.maxCanaryPercent, 5);
  const minBake = numOr(plan.minBakeMinutes, 30);
  const canary = numOr(plan.canaryPercent, maxCanary);
  const bake = numOr(plan.bakeMinutes, 0);
  const abortArmed = plan.abortCriteriaMet !== false;
  const problems = [];
  if (canary > maxCanary) problems.push(`canary ${canary}% exceeds the ${maxCanary}% ceiling`);
  if (bake < minBake) problems.push(`bake ${bake}m below the ${minBake}m minimum`);
  if (!abortArmed) problems.push('abort criteria not armed');
  return {
    withinEnvelope: problems.length === 0,
    canaryPercent: canary, bakeMinutes: bake, abortArmed,
    problems,
    reason: problems.length === 0 ? `canary ${canary}% · bake ${bake}m · abort armed` : problems.join('; '),
  };
}

// ─── Pure core 6: release success rate (ITIL ≥90%) ───────────────────
//
// Reuses the DORA change-failure computation over the audit ledger's release
// entries. success = 1 − change-failure-rate. Null with no releases recorded.
export function releaseSuccessRate(entries = []) {
  const cf = changeFailureRate(entries);
  if (cf.total === 0) return { rate: null, successes: 0, total: 0, meetsItilTarget: null };
  const rate = 1 - cf.rate;
  return { rate, successes: cf.total - cf.failed, total: cf.total, meetsItilTarget: rate >= 0.9 };
}

// ─── Gates G1–G4 (lib/agix-gate.mjs) ─────────────────────────────────
//
// release-manager is the VERIFIER that the build is launch-ready; the actor is
// the dev fleet / release-engineer. G3 is a hard human gate (requiresHuman → a
// complete checklist yields HOLD, not an auto-GO).
export function buildReleaseGates({ ledger, actor = 'release-engineer' } = {}) {
  const verifier = 'release-manager';
  const G1 = new Gate({
    name: 'G1-feature-freeze', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => ctx.freeze,   // { verdict, reason } from checkFeatureFreeze
  });
  const G2 = new Gate({
    name: 'G2-code-freeze-rc', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => ctx.codeFreeze,  // { verdict, reason } from checkCodeFreeze
  });
  // G3 — the hard human go/no-go. composeGate wires the §2 release-phase registry
  // (verifier canary-eval, requiresHuman) and we override the actor to the fleet
  // and the verifier to release-manager. A complete PRR checklist returns GO,
  // which requiresHuman routes to HOLD (the human issues the real go).
  const G3 = composeGate('release', {
    ledger,
    overrides: { name: 'G3-launch-readiness', actor, verifier, requiresHuman: true },
    criteria: {
      exitCriteria: (ctx) => {
        const r = ctx.readiness;
        if (r?.complete) return { verdict: VERDICT.GO, reason: r.reason };
        return { verdict: VERDICT.RECYCLE, reason: r?.reason || 'PRR checklist incomplete' };
      },
    },
  });
  const G4 = new Gate({
    name: 'G4-rollout', phase: 'operate', actor, verifier, ledger,
    exitCriteria: (ctx) => {
      const r = ctx.rollout;
      if (r?.withinEnvelope) return { verdict: VERDICT.GO, reason: r.reason };
      return { verdict: VERDICT.HOLD, reason: `rollout outside envelope: ${r?.reason || 'unknown'}` };
    },
  });
  return { G1, G2, G3, G4 };
}

// ─── The agent run ───────────────────────────────────────────────────

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const actor = opts.actor || defaults.default_actor || 'release-engineer';
  // One tenant-scoped ledger, supplied by the runtime (getLedger) — the
  // coherence seam. Smoke runs get the sandbox store automatically.
  const ledger = runtime.getLedger();

  console.log(`Release Manager — release-train governance gate · ${date}${runtime.smoke ? ' · smoke' : ''}`);

  const input = resolveInput(opts, defaults);
  const train = computeReleaseTrain(input.cadence);
  const freeze = checkFeatureFreeze(input.featureFreeze);
  const codeFreeze = checkCodeFreeze(input.codeFreeze);
  const readiness = evaluateLaunchReadiness(input.readiness);
  const rollout = checkRollout(input.rollout);

  const scope = { runId: safeId(opts.releaseId || input.releaseId || `rel-${date.replace(/-/g, '')}`) };
  const gates = buildReleaseGates({ ledger, actor });
  const results = {};
  results.G1 = await gates.G1.evaluate({ scope, freeze });
  results.G2 = await gates.G2.evaluate({ scope, codeFreeze });
  results.G3 = await gates.G3.evaluate({ scope, readiness });
  results.G4 = await gates.G4.evaluate({ scope, rollout });

  const overall = worstVerdict(Object.values(results).map((r) => r.verdict));
  const escalated = Object.values(results).filter((r) => r.verdict === VERDICT.HOLD).map((r) => r.gate);

  // The release record: the release-manager's own stamp for this train.
  const releaseEntry = await ledger.append({
    kind: 'release',
    scope,
    phase: 'release',
    actor: 'release-manager',
    verifier: actor,
    verdict: overall,
    meta: {
      release_date: train.releaseDate ?? null,
      rc_is_ship_build: codeFreeze.isShipBuild ?? null,
      prr_complete: readiness.complete,
      rollout_within_envelope: rollout.withinEnvelope,
      // A held (not-cleared) launch does not count as a successful deployment
      // for DORA; a GO record does.
      rollback: overall === VERDICT.HOLD || overall === VERDICT.KILL ? true : undefined,
    },
  });

  // Release-success + DORA over the ledger's history (this run included).
  const historyEntries = await ledger.read({});
  const success = releaseSuccessRate(historyEntries);
  const dora = computeDora(historyEntries);

  console.log(
    `Gates · ${Object.entries(results).map(([k, r]) => `${k}=${r.verdict}`).join(' ')} · ` +
    `overall=${overall}${escalated.length ? ` · escalate: ${escalated.join(', ')}` : ''}`,
  );

  let narrative = null;
  if (!runtime.smoke) {
    narrative = await narrate({ runtime, defaults, overall, readiness, escalated }).catch((err) => {
      console.log(`  (readiness-review narration skipped: ${err.message})`);
      return null;
    });
  }

  const report = composeReport({ date, train, freeze, codeFreeze, readiness, rollout, results, overall, escalated, success, dora, narrative, actor });
  const relPath = `wiki/release-manager/${date}.md`;
  const reportPath = await runtime.writeRepoFile(relPath, report);
  runtime.recordFileWritten?.(relPath);
  console.log(`✓ Report written: ${reportPath}`);

  await runtime.writeState('cursor', {
    last_run_at: new Date().toISOString(),
    last_overall: overall,
    last_release_date: train.releaseDate ?? null,
    last_escalations: escalated,
  });
  runtime.recordDecision?.({ kind: escalated.length ? 'drift' : 'rule', name: `release-train:${overall.toLowerCase()}` });

  return {
    overall,
    release_date: train.releaseDate ?? null,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.verdict])),
    release_success_rate: success.rate,
    release_entry: releaseEntry.entry_id,
    smoke: Boolean(runtime.smoke),
  };
}

// ─── narrator (optional LLM prepend) ─────────────────────────────────

async function narrate({ runtime, defaults, overall, readiness, escalated }) {
  const model = runtime.getModel?.();
  if (!model) return null;
  const summary = [
    `Overall release verdict: ${overall}.`,
    `Launch-readiness: ${readiness.complete ? 'complete' : `gaps in ${readiness.missing.join(', ')}`}.`,
    escalated.length ? `Escalated to human: ${escalated.join(', ')}.` : 'No human escalations.',
  ].join('\n');
  const resp = await model.chat({
    capability: 'cheap-classification',
    model: defaults.tldr_model,
    max_tokens: 220,
    system: 'You are a release manager. In <=4 sentences, state the go/no-go posture, the single most important readiness gap (if any), and whether a human go/no-go is required. Use only the data given. No em dashes.',
    messages: [{ role: 'user', content: summary }],
    agent: 'release-manager',
  });
  const text = (resp?.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!text || /\[smoke-mode/.test(text)) return null;
  return text;
}

// ─── report ──────────────────────────────────────────────────────────

function composeReport({ date, train, freeze, codeFreeze, readiness, rollout, results, overall, escalated, success, dora, narrative, actor }) {
  const icon = { GO: '✅', RECYCLE: '🔁', HOLD: '⏸️', KILL: '🔴' };
  const L = [];
  L.push('---');
  L.push(`date: ${date}`);
  L.push('agent: release-manager');
  L.push(`overall: ${overall}`);
  L.push(`release_date: ${train.releaseDate ?? 'n/a'}`);
  L.push(`prr_complete: ${readiness.complete}`);
  L.push(`escalations: ${escalated.length}`);
  L.push('---');
  L.push('');
  L.push(`# Release Train — ${icon[overall] || ''} ${overall} · ${date}`);
  L.push('');
  if (narrative) {
    L.push('## TL;DR');
    L.push('');
    L.push(`> ${narrative.replace(/\n+/g, '\n> ')}`);
    L.push('');
    L.push('_(Narrative summary — generated. The deterministic gate table below is the source of truth.)_');
    L.push('');
  }
  L.push('## Calendar');
  L.push('');
  if (train.valid) {
    L.push(`- Feature freeze: **${train.featureFreezeDate}**`);
    L.push(`- Code freeze: **${train.codeFreezeDate}**`);
    L.push(`- RC (ship build): **${train.rcDate}**`);
    L.push(`- Release: **${train.releaseDate}**`);
  } else {
    L.push(`- ⚠️ Train not well-formed: ${train.reason}`);
  }
  L.push('');
  L.push('## Gate verdicts');
  L.push('');
  L.push('| Gate | Verdict | Reason |');
  L.push('|---|---|---|');
  for (const [, r] of Object.entries(results)) {
    L.push(`| \`${r.gate}\` | ${icon[r.verdict] || ''} ${r.verdict} | ${escapeCell(r.reason || '')} |`);
  }
  L.push('');
  L.push('## Launch-readiness (PRR / Google-LCE)');
  L.push('');
  for (const d of LCE_DIMENSIONS) {
    L.push(`- ${readiness.present.includes(d) ? '✅' : '⬜'} ${d}`);
  }
  L.push('');
  L.push('## Rollout');
  L.push('');
  L.push(`- ${rollout.withinEnvelope ? '✅' : '⏸️'} ${rollout.reason}`);
  L.push('');
  L.push('## Metrics (from the audit ledger)');
  L.push('');
  L.push(`- Release success rate: ${success.rate == null ? 'n/a (no releases recorded yet)' : `${(success.rate * 100).toFixed(0)}% (${success.successes}/${success.total})${success.meetsItilTarget ? ' ✅ ≥90% ITIL target' : ' ⚠️ below 90%'}`}`);
  L.push(`- Change-failure rate (DORA): ${dora.changeFailureRate.rate == null ? 'n/a' : `${(dora.changeFailureRate.rate * 100).toFixed(0)}%`}`);
  L.push(`- Deployment rework rate (DORA): ${dora.deploymentReworkRate.rate == null ? 'n/a' : `${(dora.deploymentReworkRate.rate * 100).toFixed(0)}%`}`);
  L.push('');
  if (escalated.length) {
    L.push('## ⏸️ Escalations to human');
    L.push('');
    for (const [, r] of Object.entries(results)) {
      if (r.verdict === VERDICT.HOLD) L.push(`- **\`${r.gate}\`** — ${r.reason}${r.routedToHuman ? ' _(human co-sign)_' : ''}`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`_Emitted by the Agix **release-manager** (proposer trust; verifier of the dev fleet \`${actor}\`). It plans + gates the release train; it never deploys — release-engineer + the CI/CD pipeline own the plumbing. G3 launch-readiness is a human go/no-go. Every decision is an append-only audit-ledger entry. See \`agents/release-manager/PERSONA.md\`._`);
  L.push('');
  return L.join('\n') + '\n';
}

// ─── helpers ─────────────────────────────────────────────────────────

function resolveInput(opts, defaults) {
  if (opts.releaseJson) {
    try { return { ...cannedInput(), ...JSON.parse(opts.releaseJson) }; } catch { /* canned */ }
  }
  return cannedInput();
}

// A canned sample release train (clean — RC is a ship build, PRR complete,
// rollout in-envelope) so smoke is a faithful, no-network demonstration. The
// canned run lands on G3=HOLD because a complete PRR is a human go/no-go.
function cannedInput() {
  return {
    releaseId: 'rel-sample',
    cadence: { anchorDate: '2026-07-17', featureFreezeLeadDays: 14, codeFreezeLeadDays: 5, rcLeadDays: 3 },
    featureFreeze: { frozen: true, newScopeAfterFreeze: [] },
    codeFreeze: { rcChanges: [{ id: 'canary-timeout-fix', blocker: true }] },
    readiness: { architecture: true, capacity: true, failureModes: true, monitoring: true, security: true, dependencies: true, rollback: true },
    rollout: { canaryPercent: 5, bakeMinutes: 60, abortCriteriaMet: true, maxCanaryPercent: 5, minBakeMinutes: 30 },
  };
}

function asList(v) { return Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []; }
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function parseDate(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t) : null; }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function isoDay(d) { return d.toISOString().slice(0, 10); }
const VERDICT_RANK = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts) {
  let worst = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v) { return String(v).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128) || 'rel-unknown'; }
function escapeCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' '); }
