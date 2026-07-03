// Agix Version Manager — the semantics gate above the dev loop.
//
// Owns versioning SEMANTICS for the release/GTM layer
// (architecture/03-ai-ml/agent-architecture/RELEASE_GTM_MANAGEMENT.md §2.2):
// version-number assignment, the public-API/compatibility contract, the
// deprecation policy + SLA, changelog quality, and immutable artifact identity.
// It is the VERIFIER that catches a MAJOR mislabeled as a MINOR before it ships.
//
// Four deterministic cores (pure, exported, unit-tested):
//   bumpCorrectness(changeSet)        → PATCH|MINOR|MAJOR from a change descriptor;
//                                       flags a breaking change hiding in a MINOR.
//   validateChangelog(text)           → Keep-a-Changelog conformance (the six
//                                       categories, Unreleased→version).
//   checkDeprecationSLA(deps, window) → nothing removed inside its deprecation window.
//   assignScheme(artifact)            → SemVer (contracts) vs CalVer (cadenced).
//   checkArtifactIdentity(rings)      → build-once, promote-many (no rebuild across rings).
//
// Four gates (LOOP_ENGINEERED_SDLC §2 shape, on lib/agix-gate.mjs — actor ≠
// verifier, every decision recorded to the audit ledger):
//   V1 bump-correctness   — MAJOR / breaking-hidden-in-MINOR → HOLD (human co-sign);
//                           a mislabeled non-breaking bump → RECYCLE.
//   V2 changelog          — not Keep-a-Changelog conformant → RECYCLE.
//   V3 deprecation-SLA    — a removal inside its window → HOLD (escalate).
//   V4 artifact-identity  — a rebuild across rings → HOLD (escalate).
//
// Trust level: PROPOSER. It proposes the version + verifies the bump; the human
// co-signs any MAJOR/breaking bump. Every gate decision + the version_bump entry
// land in the append-only audit ledger (lib/agix-audit-ledger.mjs) — smoke runs
// use the smoke ledger store, so a smoke run touches no real system of record.
//
// Deterministic core: bumpCorrectness / validateChangelog / checkDeprecationSLA /
// assignScheme / checkArtifactIdentity are pure and run with NO API key. The LLM
// is used only for an optional narrative TL;DR behind runtime.getModel(); the
// verdicts are computed with or without it (narrator pattern).
//
// Spec / persona: agents/version-manager/PERSONA.md
// Manifest:       agents/version-manager/manifest.yaml
// Substrate:      lib/agix-audit-ledger.mjs · lib/agix-gate.mjs · lib/agix-dora.mjs

import { Gate, VERDICT } from '../../lib/agix-gate.mjs';

export const BUMP = Object.freeze({ PATCH: 'PATCH', MINOR: 'MINOR', MAJOR: 'MAJOR' });
export const CHANGELOG_CATEGORIES = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

// ─── Pure core 1: bump-correctness (SemVer) ──────────────────────────
//
// Given a change descriptor, decide the SemVer bump the changes actually
// warrant, and whether the DECLARED bump hides a breaking change. This is the
// V1 gate's evidence — the anti-"MAJOR mislabeled as MINOR" control.
//
// changeSet: {
//   declared?:          'PATCH'|'MINOR'|'MAJOR'|null,  // the proposed bump
//   breaking?:          boolean,                        // any backward-incompatible change
//   removed?:           string[],                       // removed/renamed public API → breaking
//   changedSignatures?: string[],                       // incompatible signature changes → breaking
//   added?:             string[]|boolean,               // new backward-compatible surface → MINOR
//   deprecated?:        string[],                       // newly-deprecated (still present) → MINOR
//   fixed?:             string[]|boolean,               // bug fixes → PATCH
//   changed?:           string[]|boolean,               // other backward-compatible changes → PATCH
// }
export function bumpCorrectness(changeSet = {}) {
  const removed = asList(changeSet.removed);
  const changedSig = asList(changeSet.changedSignatures);
  const added = asList(changeSet.added);
  const deprecated = asList(changeSet.deprecated);
  const fixed = asList(changeSet.fixed);
  const changed = asList(changeSet.changed);

  const breaking = Boolean(changeSet.breaking) || removed.length > 0 || changedSig.length > 0;
  const hasAddition = truthy(changeSet.added) || added.length > 0 || deprecated.length > 0;
  const hasFixOrChange = truthy(changeSet.fixed) || truthy(changeSet.changed) || fixed.length > 0 || changed.length > 0;

  let correct;
  const reasons = [];
  if (breaking) {
    correct = BUMP.MAJOR;
    if (removed.length) reasons.push(`removed public surface: ${removed.join(', ')}`);
    if (changedSig.length) reasons.push(`incompatible signature change: ${changedSig.join(', ')}`);
    if (changeSet.breaking && !removed.length && !changedSig.length) reasons.push('flagged backward-incompatible');
  } else if (hasAddition) {
    correct = BUMP.MINOR;
    if (added.length) reasons.push(`added: ${added.join(', ')}`);
    if (deprecated.length) reasons.push(`deprecated (still present): ${deprecated.join(', ')}`);
    if (truthy(changeSet.added) && !added.length) reasons.push('added new backward-compatible surface');
  } else if (hasFixOrChange) {
    correct = BUMP.PATCH;
    reasons.push('bug fixes / backward-compatible changes only');
  } else {
    correct = BUMP.PATCH;
    reasons.push('no user-visible change — no-op patch');
  }

  const declared = normalizeLevel(changeSet.declared);
  const agrees = declared == null ? true : declared === correct;
  // The headline failure mode: a breaking change riding in a PATCH/MINOR label.
  const breakingHidden = correct === BUMP.MAJOR && declared != null && declared !== BUMP.MAJOR;

  return { correct, declared, agrees, breaking, breakingHidden, reasons };
}

// ─── Pure core 2: changelog conformance (Keep a Changelog) ───────────
export function validateChangelog(text = '') {
  const src = String(text || '');
  const issues = [];
  const versions = [];      // section headers: ## [x.y.z] or ## [Unreleased]
  const categories = [];    // ### Added / Changed / ...
  const invalidCategories = [];

  for (const line of src.split('\n')) {
    const vh = line.match(/^##\s+\[([^\]]+)\]/);
    if (vh) { versions.push(vh[1].trim()); continue; }
    const ch = line.match(/^###\s+(.+?)\s*$/);
    if (ch) {
      const cat = ch[1].trim();
      if (CHANGELOG_CATEGORIES.includes(cat)) categories.push(cat);
      else invalidCategories.push(cat);
    }
  }

  const hasUnreleased = versions.some((v) => /^unreleased$/i.test(v));
  const hasVersioned = versions.some((v) => /^\d+\.\d+\.\d+/.test(v) || /^\d{4}[.-]\d{2}/.test(v));

  if (!hasUnreleased && !hasVersioned) issues.push('no "## [Unreleased]" or "## [x.y.z]" section');
  if (categories.length === 0) issues.push(`no recognized category (${CHANGELOG_CATEGORIES.join('/')})`);
  if (invalidCategories.length) issues.push(`non-standard categories: ${invalidCategories.join(', ')}`);

  const valid = (hasUnreleased || hasVersioned) && categories.length > 0 && invalidCategories.length === 0;
  return { valid, hasUnreleased, hasVersioned, categories: unique(categories), invalidCategories: unique(invalidCategories), issues };
}

// ─── Pure core 3: deprecation SLA ────────────────────────────────────
//
// A removal is compliant only if the symbol was deprecated for ≥ the policy
// window (in minor cycles) AND carried a notice. Anything removed inside its
// window is a backward-compat break the V3 gate escalates.
//
// deprecations: [{ id, deprecatedInVersion, removedInVersion|null, notice?: boolean }]
// policyWindow:  { minMinorCycles: number }  (default 1)
export function checkDeprecationSLA(deprecations = [], policyWindow = {}) {
  const minCycles = Number.isFinite(policyWindow?.minMinorCycles) ? policyWindow.minMinorCycles : 1;
  const violations = [];
  let checked = 0;
  for (const d of deprecations || []) {
    if (!d || d.removedInVersion == null) continue;   // not removed yet → nothing to enforce
    checked += 1;
    const cycles = minorCycleDistance(d.deprecatedInVersion, d.removedInVersion);
    const hasNotice = d.notice !== false;              // default: assume a notice unless explicitly absent
    if (cycles == null) {
      violations.push({ id: d.id ?? '(unknown)', reason: `unparseable versions (${d.deprecatedInVersion} → ${d.removedInVersion})`, cycles: null });
    } else if (cycles < minCycles) {
      violations.push({ id: d.id ?? '(unknown)', reason: `removed after ${cycles} minor cycle(s); policy requires ≥ ${minCycles}`, cycles });
    } else if (!hasNotice) {
      violations.push({ id: d.id ?? '(unknown)', reason: 'removed without a deprecation notice', cycles });
    }
  }
  return { compliant: violations.length === 0, violations, checked, minMinorCycles: minCycles };
}

// ─── Pure core 4: versioning scheme per artifact ─────────────────────
//
// SemVer for contract-bearing artifacts (a consumer codes against them); CalVer
// for cadenced products (shipped on a calendar, no external API contract).
export function assignScheme(artifact = {}) {
  const kind = String(artifact.kind || '').toLowerCase();
  const semverKinds = new Set(['library', 'lib', 'sdk', 'api', 'cli', 'package', 'protocol', 'schema']);
  const calverKinds = new Set(['service', 'app', 'application', 'product', 'website', 'site', 'platform', 'firmware']);
  if (semverKinds.has(kind)) return { scheme: 'SemVer', reason: `${kind || 'contract'} carries a public API/compat contract` };
  if (calverKinds.has(kind)) return { scheme: 'CalVer', reason: `${kind} ships on a cadence with no external API contract` };
  // Default: a thing with a declared public API is SemVer; otherwise CalVer.
  return artifact.publicApi
    ? { scheme: 'SemVer', reason: 'declares a public API contract' }
    : { scheme: 'CalVer', reason: 'no public API contract — cadenced release' };
}

// ─── Pure core 5: build-once, promote-many artifact identity ─────────
//
// The same signed artifact must be promoted across rings (dev→canary→prod); a
// differing digest means a rebuild happened — never allowed. `rings` maps a ring
// name → artifact digest.
export function checkArtifactIdentity(rings = {}) {
  const entries = Object.entries(rings || {}).filter(([, v]) => v != null && v !== '');
  if (entries.length < 2) {
    return { identical: true, rings: entries.map(([r]) => r), digests: Object.fromEntries(entries), reason: entries.length ? 'single ring — nothing to compare' : 'no ring digests supplied' };
  }
  const first = entries[0][1];
  const identical = entries.every(([, v]) => v === first);
  const mismatched = entries.filter(([, v]) => v !== first).map(([r]) => r);
  return {
    identical,
    rings: entries.map(([r]) => r),
    digests: Object.fromEntries(entries),
    mismatched,
    reason: identical ? 'same signed artifact across every ring' : `rebuild detected — digest differs on: ${mismatched.join(', ')}`,
  };
}

// ─── Gates V1–V4 (lib/agix-gate.mjs) ─────────────────────────────────
//
// version-manager is the VERIFIER (§0: "verifies the release isn't a MAJOR
// mislabeled as a MINOR"); the actor is the change author. Criteria are captured
// at construction (the immutable verifier surface) and read their DATA from the
// evaluate() context.
export function buildVersionGates({ ledger, actor = 'dev-fleet' } = {}) {
  const verifier = 'version-manager';
  const V1 = new Gate({
    name: 'V1-bump-correctness', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => {
      const b = ctx.bump;
      if (!b) return { verdict: VERDICT.RECYCLE, reason: 'no bump analysis in context' };
      if (b.breakingHidden) return { verdict: VERDICT.HOLD, reason: `breaking change declared as ${b.declared} — a MAJOR is masquerading as ${b.declared}; human co-sign required` };
      if (b.correct === BUMP.MAJOR) return { verdict: VERDICT.HOLD, reason: 'MAJOR / breaking-change bump — human co-sign required' };
      if (b.agrees) return { verdict: VERDICT.GO, reason: `bump ${b.correct} matches the changes` };
      return { verdict: VERDICT.RECYCLE, reason: `declared ${b.declared} but the diff warrants ${b.correct} — relabel and resubmit` };
    },
  });
  const V2 = new Gate({
    name: 'V2-changelog', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => {
      const c = ctx.changelog;
      if (c?.valid) return { verdict: VERDICT.GO, reason: 'changelog is Keep-a-Changelog conformant' };
      return { verdict: VERDICT.RECYCLE, reason: `changelog not conformant: ${(c?.issues || ['missing']).join('; ')}` };
    },
  });
  const V3 = new Gate({
    name: 'V3-deprecation-sla', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => {
      const s = ctx.sla;
      if (s?.compliant) return { verdict: VERDICT.GO, reason: `${s.checked} removal(s) all honored the deprecation window` };
      return { verdict: VERDICT.HOLD, reason: `deprecation-SLA violation: ${(s?.violations || []).map((v) => `${v.id} (${v.reason})`).join('; ')}` };
    },
  });
  const V4 = new Gate({
    name: 'V4-artifact-identity', phase: 'release', actor, verifier, ledger,
    exitCriteria: (ctx) => {
      const a = ctx.identity;
      if (a?.identical) return { verdict: VERDICT.GO, reason: a.reason };
      return { verdict: VERDICT.HOLD, reason: `artifact-identity violation: ${a?.reason || 'rebuild across rings'}` };
    },
  });
  return { V1, V2, V3, V4 };
}

// ─── The agent run ───────────────────────────────────────────────────

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const actor = opts.actor || defaults.default_change_author || 'dev-fleet';
  // One tenant-scoped ledger, supplied by the runtime (getLedger) — the
  // coherence seam. Smoke runs get the sandbox store automatically.
  const ledger = runtime.getLedger();

  console.log(`Version Manager — versioning-semantics gate · ${date}${runtime.smoke ? ' · smoke' : ''}`);

  // Inputs — from flags/JSON when supplied, else a canned sample so a smoke run
  // is a faithful, no-network demonstration.
  const input = resolveInput(opts, defaults);
  const bump = bumpCorrectness(input.changeSet);
  const scheme = assignScheme(input.artifact);
  const changelog = validateChangelog(input.changelogText);
  const sla = checkDeprecationSLA(input.deprecations, defaults.deprecation_policy || { minMinorCycles: 1 });
  const identity = checkArtifactIdentity(input.rings);

  const scope = { runId: safeId(opts.releaseId || input.releaseId || `ver-${date.replace(/-/g, '')}`) };
  const gates = buildVersionGates({ ledger, actor });
  const results = {};
  results.V1 = await gates.V1.evaluate({ scope, bump });
  results.V2 = await gates.V2.evaluate({ scope, changelog });
  results.V3 = await gates.V3.evaluate({ scope, sla });
  results.V4 = await gates.V4.evaluate({ scope, identity });

  const overall = worstVerdict(Object.values(results).map((r) => r.verdict));
  const escalated = Object.values(results).filter((r) => r.verdict === VERDICT.HOLD).map((r) => r.gate);

  // The domain entry: the version-manager's own record of the bump it stamped.
  const bumpEntry = await ledger.append({
    kind: 'version_bump',
    scope,
    phase: 'release',
    actor: 'version-manager',
    verifier: actor,
    verdict: overall,
    meta: {
      correct_bump: bump.correct, declared_bump: bump.declared, agrees: bump.agrees,
      breaking_hidden: bump.breakingHidden, scheme: scheme.scheme,
      changelog_valid: changelog.valid, deprecation_compliant: sla.compliant, artifact_identical: identity.identical,
    },
  });

  console.log(
    `Gates · ${Object.entries(results).map(([k, r]) => `${k}=${r.verdict}`).join(' ')} · ` +
    `overall=${overall}${escalated.length ? ` · escalate: ${escalated.join(', ')}` : ''}`,
  );

  // Optional narrator TL;DR (never alters a verdict).
  let narrative = null;
  if (!runtime.smoke) {
    narrative = await narrate({ runtime, defaults, bump, scheme, overall, escalated }).catch((err) => {
      console.log(`  (TL;DR narration skipped: ${err.message})`);
      return null;
    });
  }

  const report = composeReport({ date, bump, scheme, changelog, sla, identity, results, overall, escalated, narrative, actor });
  const relPath = `wiki/version-manager/${date}.md`;
  const reportPath = await runtime.writeRepoFile(relPath, report);
  runtime.recordFileWritten?.(relPath);
  console.log(`✓ Report written: ${reportPath}`);

  await runtime.writeState('cursor', {
    last_run_at: new Date().toISOString(),
    last_overall: overall,
    last_bump: bump.correct,
    last_escalations: escalated,
  });
  runtime.recordDecision?.({ kind: escalated.length ? 'drift' : 'rule', name: `version-bump:${overall.toLowerCase()}` });

  return {
    overall,
    bump: bump.correct,
    declared: bump.declared,
    scheme: scheme.scheme,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.verdict])),
    version_bump_entry: bumpEntry.entry_id,
    smoke: Boolean(runtime.smoke),
  };
}

// ─── narrator (optional LLM prepend) ─────────────────────────────────

async function narrate({ runtime, defaults, bump, scheme, overall, escalated }) {
  const model = runtime.getModel?.();
  if (!model) return null;
  const summary = [
    `Overall version verdict: ${overall}.`,
    `Correct SemVer bump: ${bump.correct}${bump.declared ? ` (declared ${bump.declared})` : ''}.`,
    `Scheme: ${scheme.scheme}.`,
    escalated.length ? `Escalated gates: ${escalated.join(', ')}.` : 'No human escalations.',
  ].join('\n');
  const resp = await model.chat({
    capability: 'cheap-classification',
    model: defaults.tldr_model,
    max_tokens: 200,
    system: 'You are a release versioning steward. In <=3 sentences, state the bump and whether a human co-sign is required and why. Use only the data given. No em dashes.',
    messages: [{ role: 'user', content: summary }],
    agent: 'version-manager',
  });
  const text = (resp?.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!text || /\[smoke-mode/.test(text)) return null;
  return text;
}

// ─── report ──────────────────────────────────────────────────────────

function composeReport({ date, bump, scheme, changelog, sla, identity, results, overall, escalated, narrative, actor }) {
  const icon = { GO: '✅', RECYCLE: '🔁', HOLD: '⏸️', KILL: '🔴' };
  const L = [];
  L.push('---');
  L.push(`date: ${date}`);
  L.push('agent: version-manager');
  L.push(`overall: ${overall}`);
  L.push(`bump: ${bump.correct}`);
  L.push(`declared: ${bump.declared ?? 'none'}`);
  L.push(`scheme: ${scheme.scheme}`);
  L.push(`escalations: ${escalated.length}`);
  L.push('---');
  L.push('');
  L.push(`# Version Semantics — ${icon[overall] || ''} ${overall} · ${date}`);
  L.push('');
  if (narrative) {
    L.push('## TL;DR');
    L.push('');
    L.push(`> ${narrative.replace(/\n+/g, '\n> ')}`);
    L.push('');
    L.push('_(Narrative summary — generated. The deterministic gate table below is the source of truth.)_');
    L.push('');
  }
  L.push('## Bump correctness (V1)');
  L.push('');
  L.push(`- Correct bump: **${bump.correct}**${bump.declared ? ` · declared: ${bump.declared} · agree: ${bump.agrees ? 'yes' : 'NO'}` : ''}`);
  if (bump.breakingHidden) L.push(`- ⏸️ **Breaking change hidden in a ${bump.declared}** — routed to a human co-sign.`);
  for (const r of bump.reasons) L.push(`  - ${r}`);
  L.push('');
  L.push('## Gate verdicts');
  L.push('');
  L.push('| Gate | Verdict | Reason |');
  L.push('|---|---|---|');
  for (const [k, r] of Object.entries(results)) {
    L.push(`| \`${r.gate}\` | ${icon[r.verdict] || ''} ${r.verdict} | ${escapeCell(r.reason || '')} |`);
  }
  L.push('');
  L.push('## Semantics');
  L.push('');
  L.push(`- Scheme: **${scheme.scheme}** — ${scheme.reason}`);
  L.push(`- Changelog: ${changelog.valid ? '✅ conformant' : `🔁 ${changelog.issues.join('; ')}`}`);
  L.push(`- Deprecation SLA: ${sla.compliant ? `✅ ${sla.checked} removal(s) honored` : `⏸️ ${sla.violations.map((v) => v.id).join(', ')}`}`);
  L.push(`- Artifact identity: ${identity.identical ? '✅ build-once/promote-many' : `⏸️ ${identity.reason}`}`);
  L.push('');
  if (escalated.length) {
    L.push('## ⏸️ Escalations to human');
    L.push('');
    for (const [, r] of Object.entries(results)) {
      if (r.verdict === VERDICT.HOLD) L.push(`- **\`${r.gate}\`** — ${r.reason}`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`_Emitted by the Agix **version-manager** (proposer trust; verifier of the change author \`${actor}\`). Any MAJOR / breaking bump, deprecation-SLA breach, or artifact rebuild routes to a human co-sign. Every decision is an append-only audit-ledger entry. See \`agents/version-manager/PERSONA.md\`._`);
  L.push('');
  return L.join('\n') + '\n';
}

// ─── helpers ─────────────────────────────────────────────────────────

// A canned sample release (a clean MINOR) so a smoke/no-input run demonstrates
// the full path with no network and no real pipeline data.
function resolveInput(opts, defaults) {
  if (opts.changeSetJson) {
    try {
      const parsed = JSON.parse(opts.changeSetJson);
      return { ...cannedInput(), ...parsed };
    } catch { /* fall through to canned */ }
  }
  return cannedInput();
}

function cannedInput() {
  return {
    releaseId: 'ver-sample',
    changeSet: { declared: 'MINOR', added: ['search_brain endpoint'], fixed: ['canary probe timeout'] },
    artifact: { name: 'agix-cli', kind: 'cli', publicApi: true },
    changelogText: [
      '# Changelog',
      '',
      '## [Unreleased]',
      '### Added',
      '- search_brain endpoint',
      '### Fixed',
      '- canary probe timeout',
      '',
    ].join('\n'),
    deprecations: [
      { id: 'legacy_health_path', deprecatedInVersion: '0.1.0', removedInVersion: '0.3.0', notice: true },
    ],
    rings: { dev: 'sha256:abc', canary: 'sha256:abc', prod: 'sha256:abc' },
  };
}

function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  return [];
}
function truthy(v) {
  return v === true || (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0);
}
function normalizeLevel(v) {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  return [BUMP.PATCH, BUMP.MINOR, BUMP.MAJOR].includes(s) ? s : null;
}
function parseSemver(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}
// Distance in minor cycles between two versions. A major increment counts as
// (at least) a full cycle so a same-major minor gap is the common case.
function minorCycleDistance(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return null;
  if (b.major > a.major) return (b.major - a.major) * 1000 + (b.minor - a.minor);
  if (b.major < a.major) return 0;
  return b.minor - a.minor;
}
function unique(xs) {
  return [...new Set(xs)];
}
const VERDICT_RANK = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts) {
  let worst = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v) {
  return String(v).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128) || 'ver-unknown';
}
function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}
