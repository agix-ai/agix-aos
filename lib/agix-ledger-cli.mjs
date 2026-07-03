// agix-ledger-cli — human-readable renderers for the governance audit ledger.
//
// The READ-ONLY view layer behind `agix ledger show`, `agix ledger stats`, and
// `agix dora`. Pure + dependency-light: every function takes the plain data
// shapes the AuditLedger already produces (entry records from `ledger.read()`,
// the rollup from `ledger.stats()`) and returns a string. No I/O, no clock, no
// ledger construction here — bin/agix builds the tenant-scoped ledger (via
// runtime.getLedger()) and hands the data in, so this module stays trivially
// testable and never writes anything.
//
// Metrics come from lib/agix-dora.mjs (computeDora + gateMetrics), surfaced by
// AuditLedger.stats(); this module only formats them. Works with an EMPTY
// ledger — every renderer degrades to a clear "no entries yet" line rather than
// throwing or printing NaN.

// ─── helpers ───────────────────────────────────────────────────────────

// Compact one entry's governance scope (users/roles/mandates/runs) for a line.
function fmtScope(scope) {
  if (!scope || typeof scope !== 'object') return '';
  const parts = [];
  for (const key of ['userId', 'roleId', 'mandateId', 'runId']) {
    if (scope[key] != null) parts.push(`${key.replace(/Id$/, '')}=${scope[key]}`);
  }
  return parts.join(' ');
}

// A short, one-line summary of an entry's meta (the extra fields ride under
// `meta`), truncated so a `show` line stays scannable.
function fmtMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'object') continue;   // skip nested detail objects on the summary line
    parts.push(`${k}=${v}`);
  }
  const line = parts.join(' ');
  return line.length > 100 ? line.slice(0, 97) + '…' : line;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function pct(rate) {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function ms(v) {
  if (v == null) return '—';
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ─── agix ledger show ────────────────────────────────────────────────────

// Render recent ledger entries (already filtered by the caller) as a human
// table. `filters` is echoed in the header so the operator sees what scope
// produced this view. Newest last (append order) — the tail is the freshest.
export function renderLedgerShow(entries, filters = {}) {
  const L = [];
  const scopeHint = fmtScope(filters.scope);
  const bits = [
    `tenant=${filters.enterpriseId || 'agix'}`,
    filters.kind ? `kind=${filters.kind}` : null,
    filters.since ? `since=${filters.since}` : null,
    scopeHint || null,
  ].filter(Boolean).join(' · ');
  L.push(`agix ledger · ${bits}`);
  L.push('');
  if (!entries || entries.length === 0) {
    L.push('  no entries yet');
    return L.join('\n') + '\n';
  }
  for (const e of entries) {
    const verdict = e.verdict ? pad(e.verdict, 8) : pad('', 8);
    const scope = fmtScope(e.scope);
    const head =
      `${e.ts}  ${pad(e.kind, 14)} ${verdict} ${pad(`phase=${e.phase ?? '-'}`, 18)} ${pad(`actor=${e.actor ?? '-'}`, 22)}` +
      (scope ? ` ${scope}` : '');
    L.push(head);
    const meta = fmtMeta(e.meta);
    if (meta) L.push(`    ↳ ${meta}`);
  }
  L.push('');
  L.push(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);
  return L.join('\n') + '\n';
}

// ─── agix ledger stats / agix dora ───────────────────────────────────────

// Render the DORA five + the agentic gate metrics from a `ledger.stats()`
// rollup. `stats` is { total, byKind, byVerdict, byPhase, dora, gates }.
export function renderDora(stats, { enterpriseId = 'agix' } = {}) {
  const L = [];
  L.push(`agix dora · tenant=${enterpriseId} · ${stats?.total ?? 0} ledger entries`);
  L.push('');
  if (!stats || stats.total === 0) {
    L.push('  no entries yet — run a governance agent (version-manager / release-manager /');
    L.push('  gtm-advisor) or a gate to populate the ledger, then re-run `agix dora`.');
    return L.join('\n') + '\n';
  }

  const d = stats.dora || {};
  const df = d.deploymentFrequency || {};
  const lt = d.changeLeadTime || {};
  const cf = d.changeFailureRate || {};
  const rt = d.failedDeploymentRecoveryTime || {};
  const rw = d.deploymentReworkRate || {};

  L.push('DORA');
  L.push(`  Deployment frequency        ${df.count ?? 0} release(s)` +
    (df.perDay != null ? ` · ${df.perDay.toFixed(2)}/day` : ''));
  L.push(`  Change lead time (median)   ${ms(lt.medianMs)}` +
    (lt.samples ? ` · ${lt.samples} sample(s)` : ' · no merge→release pairs'));
  L.push(`  Change failure rate         ${pct(cf.rate)}` +
    (cf.total ? ` · ${cf.failed}/${cf.total} release(s)` : ' · no releases'));
  L.push(`  Failed-deploy recovery      ${ms(rt.medianMs)}` +
    (rt.recovered || rt.unrecovered ? ` · ${rt.recovered} recovered · ${rt.unrecovered} open` : ''));
  L.push(`  Deployment rework rate      ${pct(rw.rate)}` +
    (rw.total ? ` · ${rw.recycled}/${rw.total} gate verdict(s)` : ' · no gate verdicts'));
  L.push('');

  const g = stats.gates || {};
  const fp = g.firstPassGateYield || {};
  L.push('Agentic gate metrics');
  L.push(`  First-pass gate yield       ${pct(fp.rate)}` +
    (fp.total ? ` · ${fp.firstPass}/${fp.total} (change,phase) sequence(s)` : ' · no gate sequences'));

  const byPhase = g.rejectionRateByPhase || {};
  const phaseKeys = Object.keys(byPhase);
  if (phaseKeys.length) {
    L.push('  Gate rejection rate by phase');
    for (const k of phaseKeys) {
      const r = byPhase[k];
      L.push(`    ${pad(k, 16)} ${pct(r.rate)} · ${r.rejected}/${r.total}`);
    }
  } else {
    L.push('  Gate rejection rate by phase  — no gate verdicts');
  }

  const byActor = g.rejectionRateByActor || {};
  const actorKeys = Object.keys(byActor);
  if (actorKeys.length) {
    L.push('  Gate rejection rate by actor');
    for (const k of actorKeys) {
      const r = byActor[k];
      L.push(`    ${pad(k, 16)} ${pct(r.rate)} · ${r.rejected}/${r.total}`);
    }
  }
  return L.join('\n') + '\n';
}

// Render the full `agix ledger stats` view: the kind/verdict/phase counts plus
// the DORA + gate block (renderDora). Superset of `agix dora`.
export function renderLedgerStats(stats, { enterpriseId = 'agix' } = {}) {
  const L = [];
  L.push(`agix ledger stats · tenant=${enterpriseId}`);
  L.push('');
  if (!stats || stats.total === 0) {
    L.push('  no entries yet');
    L.push('');
    L.push(renderDora(stats, { enterpriseId }).trimEnd());
    return L.join('\n') + '\n';
  }
  L.push(`Total entries: ${stats.total}`);
  const counts = (label, obj) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return;
    L.push('');
    L.push(label);
    for (const k of keys.sort()) L.push(`  ${pad(k, 16)} ${obj[k]}`);
  };
  counts('By kind', stats.byKind);
  counts('By verdict', stats.byVerdict);
  counts('By phase', stats.byPhase);
  L.push('');
  L.push(renderDora(stats, { enterpriseId }).trimEnd());
  return L.join('\n') + '\n';
}
