// Agix GTM Advisor — the launch-tiering + go-to-market gate above the dev loop.
//
// Owns launch TIERING + GTM for the release/GTM layer
// (architecture/03-ai-ml/agent-architecture/RELEASE_GTM_MANAGEMENT.md §2.3):
// the launch tier per release, positioning & messaging drafts, the three
// readiness checklists (Product / GTM / Sales-Support), beta→GA→launch
// sequencing, the launch calendar + embargoes, and coordinated-marketing timing.
// It is the VERIFIER that the launch tier matches the actual change — a MAJOR
// can't ship as a silent Tier-4 update.
//
// Deterministic cores (pure, exported, unit-tested):
//   assignTier(release)               → Tier 0–4 from the change shape.
//   tierMatchesBump(tier, bump)       → M1: the tier must match the version bump.
//   evaluateGtmReadiness(checklist)   → M2: positioning/pricing/messaging/enablement.
//   evaluateSalesSupportReadiness(cl) → M3: sales + support readiness.
//   checkLaunchSync(plan)             → M4: marketing fires on the release/GA calendar.
//
// Four gates on lib/agix-gate.mjs (actor ≠ verifier; every decision recorded):
//   M1 tier-assignment  — tier ≠ bump → HOLD; a Tier 0/1 launch → HOLD (human).
//   M2 GTM-readiness    — an incomplete GTM checklist → RECYCLE.
//   M3 sales-support    — an incomplete sales/support checklist → RECYCLE.
//   M4 launch-sync      — marketing off the release calendar → HOLD.
//
// Trust level: PROPOSER — it drafts the tier + positioning and gates the launch;
// the human co-signs a Tier 0/1 launch + public positioning. Positioning drafts
// use runtime.getModel() (smoke → canned); the tier + gate verdicts are
// deterministic and run with NO API key. Writes `launch` ledger entries.
//
// Spec / persona: agents/gtm-advisor/PERSONA.md
// Manifest:       agents/gtm-advisor/manifest.yaml
// Substrate:      lib/agix-audit-ledger.mjs · lib/agix-gate.mjs

import { Gate, VERDICT } from '../../lib/agix-gate.mjs';

// The five launch tiers (T-shirt sizing) and the version bump each maps to.
// Tier 0 company-defining → Tier 4 technical update. "Maps 1:1 to release type"
// (RELEASE_GTM §1): Tier 4 ≈ PATCH, Tier 1 ≈ MAJOR.
export const TIERS = Object.freeze([0, 1, 2, 3, 4]);

// The set of tiers each bump may legitimately carry. A MAJOR that ships as a
// Tier-4 silent update is the headline mismatch M1 catches.
const BUMP_TO_TIERS = Object.freeze({
  MAJOR: new Set([0, 1]),
  MINOR: new Set([2, 3]),
  PATCH: new Set([3, 4]),
});

// The three readiness checklists (RELEASE_GTM §2.3). Fixed dimension sets.
export const GTM_READINESS_DIMENSIONS = Object.freeze(['positioning', 'pricing', 'messaging', 'enablement']);
export const SALES_SUPPORT_DIMENSIONS = Object.freeze(['salesTraining', 'supportRunbook', 'faq', 'escalationPath']);

// ─── Pure core 1: launch-tier assignment ─────────────────────────────
//
// release: {
//   bump: 'PATCH'|'MINOR'|'MAJOR',
//   marketDefining?: boolean,   // company-defining → Tier 0
//   majorLaunch?:    boolean,   // major → Tier 1
//   marketExpansion?:boolean,   // new market/segment → Tier 2
//   cxUpdate?:       boolean,   // customer-experience update → Tier 3
// }
export function assignTier(release = {}) {
  const bump = normalizeBump(release.bump);
  let tier;
  const reasons = [];
  if (release.marketDefining) { tier = 0; reasons.push('company-defining launch'); }
  else if (bump === 'MAJOR' || release.majorLaunch) { tier = 1; reasons.push('major launch'); }
  else if (release.marketExpansion) { tier = 2; reasons.push('market-expansion launch'); }
  else if (bump === 'MINOR' || release.cxUpdate) { tier = 3; reasons.push('customer-experience update'); }
  else { tier = 4; reasons.push('technical update'); }
  return { tier, bump, reason: reasons.join('; ') };
}

// ─── Pure core 2: M1 tier ↔ bump consistency ─────────────────────────
export function tierMatchesBump(tier, bump) {
  const b = normalizeBump(bump);
  const allowed = BUMP_TO_TIERS[b];
  if (!allowed) return { matches: false, tier, bump: b, reason: `unknown bump "${bump}"` };
  const matches = allowed.has(tier);
  return {
    matches, tier, bump: b,
    allowedTiers: [...allowed],
    reason: matches
      ? `Tier ${tier} matches a ${b} bump`
      : `Tier ${tier} does not match a ${b} bump (a ${b} must be Tier ${[...allowed].join('/')}) — a ${b} cannot ship as a Tier-${tier} launch`,
  };
}

// ─── Pure core 3: M2 GTM readiness ───────────────────────────────────
export function evaluateGtmReadiness(checklist = {}) {
  const missing = GTM_READINESS_DIMENSIONS.filter((d) => !checklist[d]);
  return {
    complete: missing.length === 0,
    missing,
    present: GTM_READINESS_DIMENSIONS.filter((d) => checklist[d]),
    reason: missing.length === 0 ? 'GTM readiness complete' : `GTM gaps: ${missing.join(', ')}`,
  };
}

// ─── Pure core 4: M3 sales & support readiness ───────────────────────
export function evaluateSalesSupportReadiness(checklist = {}) {
  const missing = SALES_SUPPORT_DIMENSIONS.filter((d) => !checklist[d]);
  return {
    complete: missing.length === 0,
    missing,
    present: SALES_SUPPORT_DIMENSIONS.filter((d) => checklist[d]),
    reason: missing.length === 0 ? 'sales + support readiness complete' : `sales/support gaps: ${missing.join(', ')}`,
  };
}

// ─── Pure core 5: M4 launch-sync ─────────────────────────────────────
//
// Marketing must fire on the release/GA calendar; the embargo lift is the
// coordinated moment. All supplied dates must agree within `toleranceDays`.
//
// plan: { releaseDate, marketingDate, embargoLiftDate?, toleranceDays? }
export function checkLaunchSync(plan = {}) {
  const tolerance = numOr(plan.toleranceDays, 0);
  const release = parseDate(plan.releaseDate);
  const marketing = parseDate(plan.marketingDate);
  if (!release || !marketing) {
    return { synced: false, reason: 'missing/unparseable release or marketing date' };
  }
  const problems = [];
  const marketingGap = dayGap(release, marketing);
  if (Math.abs(marketingGap) > tolerance) problems.push(`marketing date ${plan.marketingDate} is ${marketingGap}d off the release date ${plan.releaseDate}`);
  if (plan.embargoLiftDate) {
    const embargo = parseDate(plan.embargoLiftDate);
    if (!embargo) problems.push(`unparseable embargoLiftDate ${plan.embargoLiftDate}`);
    else if (Math.abs(dayGap(release, embargo)) > tolerance) problems.push(`embargo lift ${plan.embargoLiftDate} is ${dayGap(release, embargo)}d off the release date`);
  }
  return { synced: problems.length === 0, problems, reason: problems.length === 0 ? 'marketing + embargo aligned to the release calendar' : problems.join('; ') };
}

// ─── Gates M1–M4 (lib/agix-gate.mjs) ─────────────────────────────────
//
// gtm-advisor produces the tier + GTM plan (the actor); M2/M3/M4 are verified by
// the release-manager (actor ≠ verifier). M1 (tier ↔ bump) is verified against
// the version-manager's bump and is built separately by buildTierGate, because a
// Tier 0/1 launch is a hard human gate (requiresHuman) while Tier 2–4 auto-clears
// — that flag depends on the assigned tier, which is only known at run time.
export function buildGtmGates({ ledger } = {}) {
  const actor = 'gtm-advisor';
  const M2 = new Gate({
    name: 'M2-gtm-readiness', phase: 'release', actor, verifier: 'release-manager', ledger,
    exitCriteria: (ctx) => {
      const r = ctx.gtmReadiness;
      if (r?.complete) return { verdict: VERDICT.GO, reason: r.reason };
      return { verdict: VERDICT.RECYCLE, reason: r?.reason || 'GTM readiness incomplete' };
    },
  });
  const M3 = new Gate({
    name: 'M3-sales-support', phase: 'release', actor, verifier: 'release-manager', ledger,
    exitCriteria: (ctx) => {
      const r = ctx.salesSupport;
      if (r?.complete) return { verdict: VERDICT.GO, reason: r.reason };
      return { verdict: VERDICT.RECYCLE, reason: r?.reason || 'sales/support readiness incomplete' };
    },
  });
  const M4 = new Gate({
    name: 'M4-launch-sync', phase: 'release', actor, verifier: 'release-manager', ledger,
    exitCriteria: (ctx) => {
      const s = ctx.launchSync;
      if (s?.synced) return { verdict: VERDICT.GO, reason: s.reason };
      return { verdict: VERDICT.HOLD, reason: `launch off the calendar: ${s?.reason || 'unknown'}` };
    },
  });
  return { M2, M3, M4 };
}

// M1 (tier ↔ bump) — built against the assigned tier because requiresHuman routes
// EVERY GO to HOLD, and only a Tier 0/1 launch is a human gate; Tier 2–4 must
// auto-clear. A tier↔bump mismatch returns HOLD directly (escalate) at any tier.
export function buildTierGate({ ledger, tier } = {}) {
  const humanGated = tier === 0 || tier === 1;
  return new Gate({
    name: 'M1-tier-assignment', phase: 'release', actor: 'gtm-advisor', verifier: 'version-manager',
    requiresHuman: humanGated, ledger,
    exitCriteria: (ctx) => {
      const m = ctx.tierMatch;
      if (!m) return { verdict: VERDICT.RECYCLE, reason: 'no tier↔bump analysis in context' };
      if (!m.matches) return { verdict: VERDICT.HOLD, reason: m.reason };
      return {
        verdict: VERDICT.GO,
        reason: humanGated ? `${m.reason} — Tier ${tier} launch requires human sign-off` : m.reason,
      };
    },
  });
}

// ─── The agent run ───────────────────────────────────────────────────

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  // One tenant-scoped ledger, supplied by the runtime (getLedger) — the
  // coherence seam. Smoke runs get the sandbox store automatically.
  const ledger = runtime.getLedger();

  console.log(`GTM Advisor — launch-tiering + go-to-market gate · ${date}${runtime.smoke ? ' · smoke' : ''}`);

  const input = resolveInput(opts, defaults);
  const tierDecision = assignTier(input.release);
  const tierMatch = tierMatchesBump(tierDecision.tier, input.release.bump);
  const gtmReadiness = evaluateGtmReadiness(input.gtmReadiness);
  const salesSupport = evaluateSalesSupportReadiness(input.salesSupport);
  const launchSync = checkLaunchSync(input.launchSync);

  const scope = { runId: safeId(opts.launchId || input.launchId || `gtm-${date.replace(/-/g, '')}`) };
  // M1 is human-gated only for Tier 0/1 — build it against the assigned tier.
  const M1 = buildTierGate({ ledger, tier: tierDecision.tier });
  const rest = buildGtmGates({ ledger });
  const results = {};
  results.M1 = await M1.evaluate({ scope, tierMatch, tier: tierDecision.tier });
  results.M2 = await rest.M2.evaluate({ scope, gtmReadiness });
  results.M3 = await rest.M3.evaluate({ scope, salesSupport });
  results.M4 = await rest.M4.evaluate({ scope, launchSync });

  const overall = worstVerdict(Object.values(results).map((r) => r.verdict));
  const escalated = Object.values(results).filter((r) => r.verdict === VERDICT.HOLD).map((r) => r.gate);

  // Positioning/messaging draft (LLM; smoke → canned, deterministic core stands
  // without it).
  const positioning = await draftPositioning({ runtime, defaults, tierDecision, input }).catch(() => cannedPositioning(tierDecision));

  // The launch record: the gtm-advisor's own stamp for this launch.
  const launchEntry = await ledger.append({
    kind: 'launch',
    scope,
    phase: 'release',
    actor: 'gtm-advisor',
    verifier: 'version-manager',
    verdict: overall,
    meta: {
      tier: tierDecision.tier, bump: tierMatch.bump, tier_matches_bump: tierMatch.matches,
      gtm_ready: gtmReadiness.complete, sales_support_ready: salesSupport.complete, launch_synced: launchSync.synced,
    },
  });

  console.log(
    `Tier ${tierDecision.tier} · Gates · ${Object.entries(results).map(([k, r]) => `${k}=${r.verdict}`).join(' ')} · ` +
    `overall=${overall}${escalated.length ? ` · escalate: ${escalated.join(', ')}` : ''}`,
  );

  const report = composeReport({ date, tierDecision, tierMatch, gtmReadiness, salesSupport, launchSync, positioning, results, overall, escalated });
  const relPath = `wiki/gtm-advisor/${date}.md`;
  const reportPath = await runtime.writeRepoFile(relPath, report);
  runtime.recordFileWritten?.(relPath);
  console.log(`✓ Report written: ${reportPath}`);

  await runtime.writeState('cursor', {
    last_run_at: new Date().toISOString(),
    last_overall: overall,
    last_tier: tierDecision.tier,
    last_escalations: escalated,
  });
  runtime.recordDecision?.({ kind: escalated.length ? 'drift' : 'rule', name: `launch-tier-${tierDecision.tier}:${overall.toLowerCase()}` });

  return {
    overall,
    tier: tierDecision.tier,
    tier_matches_bump: tierMatch.matches,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.verdict])),
    launch_entry: launchEntry.entry_id,
    smoke: Boolean(runtime.smoke),
  };
}

// ─── positioning draft (optional LLM; canned in smoke) ───────────────

async function draftPositioning({ runtime, defaults, tierDecision, input }) {
  if (runtime.smoke) return cannedPositioning(tierDecision);
  const model = runtime.getModel?.();
  if (!model) return cannedPositioning(tierDecision);
  const resp = await model.chat({
    capability: 'default-quality',
    model: defaults.positioning_model,
    max_tokens: 300,
    system: 'You are a product marketing manager. In 2-3 sentences draft crisp positioning for this launch: who it is for and the one durable value. Buyer language, no insider jargon. No em dashes.',
    messages: [{ role: 'user', content: `Tier ${tierDecision.tier} launch (${tierDecision.reason}). Release: ${JSON.stringify(input.release)}.` }],
    agent: 'gtm-advisor',
  });
  const text = (resp?.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!text || /\[smoke-mode/.test(text)) return cannedPositioning(tierDecision);
  return text;
}

function cannedPositioning(tierDecision) {
  return `Tier ${tierDecision.tier} launch (${tierDecision.reason}). Positioning draft is generated at run time behind runtime.getModel(); the tier decision + gate verdicts are deterministic and stand without it.`;
}

// ─── report ──────────────────────────────────────────────────────────

function composeReport({ date, tierDecision, tierMatch, gtmReadiness, salesSupport, launchSync, positioning, results, overall, escalated }) {
  const icon = { GO: '✅', RECYCLE: '🔁', HOLD: '⏸️', KILL: '🔴' };
  const L = [];
  L.push('---');
  L.push(`date: ${date}`);
  L.push('agent: gtm-advisor');
  L.push(`overall: ${overall}`);
  L.push(`tier: ${tierDecision.tier}`);
  L.push(`bump: ${tierMatch.bump}`);
  L.push(`tier_matches_bump: ${tierMatch.matches}`);
  L.push(`escalations: ${escalated.length}`);
  L.push('---');
  L.push('');
  L.push(`# Launch GTM — ${icon[overall] || ''} ${overall} · Tier ${tierDecision.tier} · ${date}`);
  L.push('');
  L.push('## Tier decision (M1)');
  L.push('');
  L.push(`- Assigned: **Tier ${tierDecision.tier}** — ${tierDecision.reason}`);
  L.push(`- Version bump: **${tierMatch.bump}** · ${tierMatch.matches ? '✅ tier matches bump' : `⏸️ ${tierMatch.reason}`}`);
  L.push('');
  L.push('## Positioning (draft)');
  L.push('');
  L.push(`> ${String(positioning).replace(/\n+/g, '\n> ')}`);
  L.push('');
  L.push('## Gate verdicts');
  L.push('');
  L.push('| Gate | Verdict | Reason |');
  L.push('|---|---|---|');
  for (const [, r] of Object.entries(results)) {
    L.push(`| \`${r.gate}\` | ${icon[r.verdict] || ''} ${r.verdict} | ${escapeCell(r.reason || '')} |`);
  }
  L.push('');
  L.push('## Readiness checklists');
  L.push('');
  L.push(`**GTM (M2):** ${gtmReadiness.complete ? '✅ complete' : `🔁 gaps: ${gtmReadiness.missing.join(', ')}`}`);
  for (const d of GTM_READINESS_DIMENSIONS) L.push(`- ${gtmReadiness.present.includes(d) ? '✅' : '⬜'} ${d}`);
  L.push('');
  L.push(`**Sales & Support (M3):** ${salesSupport.complete ? '✅ complete' : `🔁 gaps: ${salesSupport.missing.join(', ')}`}`);
  for (const d of SALES_SUPPORT_DIMENSIONS) L.push(`- ${salesSupport.present.includes(d) ? '✅' : '⬜'} ${d}`);
  L.push('');
  L.push(`**Launch-sync (M4):** ${launchSync.synced ? '✅ aligned to the release calendar' : `⏸️ ${launchSync.reason}`}`);
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
  L.push('_Emitted by the Agix **gtm-advisor** (proposer trust; verifier that the launch tier matches the version bump). A Tier 0/1 launch + public positioning is a human co-sign. Every decision is an append-only audit-ledger entry. See `agents/gtm-advisor/PERSONA.md`._');
  L.push('');
  return L.join('\n') + '\n';
}

// ─── helpers ─────────────────────────────────────────────────────────


function resolveInput(opts, defaults) {
  if (opts.launchJson) {
    try { return { ...cannedInput(), ...JSON.parse(opts.launchJson) }; } catch { /* canned */ }
  }
  return cannedInput();
}

// A canned sample launch. A MINOR release correctly assigned Tier 3 with
// readiness complete + marketing on the calendar → a clean set of GO verdicts.
function cannedInput() {
  return {
    launchId: 'gtm-sample',
    release: { bump: 'MINOR', cxUpdate: true },
    gtmReadiness: { positioning: true, pricing: true, messaging: true, enablement: true },
    salesSupport: { salesTraining: true, supportRunbook: true, faq: true, escalationPath: true },
    launchSync: { releaseDate: '2026-07-17', marketingDate: '2026-07-17', embargoLiftDate: '2026-07-17', toleranceDays: 0 },
  };
}

function normalizeBump(v) {
  const s = String(v || '').toUpperCase();
  return ['PATCH', 'MINOR', 'MAJOR'].includes(s) ? s : 'PATCH';
}
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function parseDate(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t) : null; }
function dayGap(a, b) { return Math.round((b.getTime() - a.getTime()) / 86_400_000); }
const VERDICT_RANK = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts) {
  let worst = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v) { return String(v).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128) || 'gtm-unknown'; }
function escapeCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' '); }
