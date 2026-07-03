// agix-fleet — install / uninstall / smoke utilities for the agent fleet.
//
// Phase 1.5 of architecture/03-ai-ml/agent-architecture/AGENT_RUNTIME_ARCHITECTURE.md
// § Fleet Lifecycle Protocol. Local-only (launchd).
//
// Surface:
//   discoverAgents()                              → fleet enumeration
//   cronToLaunchdIntervals(cron)                  → cron expression to plist dicts
//   generatePlistXml({...})                       → deterministic plist XML
//   manifestSha(manifestPath)                     → sha256 of manifest file bytes
//   loadTenantConfig(tenantId)                    → tenant.yaml or defaults
//   resolveTenantPlaceholders(manifest, cfg)      → substitute ${tenant.*}
//   installAgent({name, tenantId, dryRun})        → orchestrated install
//   uninstallAgent({name, tenantId})              → symmetric
//   installRecordPath({tenantId, name})           → ~/.config path helper
//   readInstallRecord({tenantId, name})           → null if missing
//
// Out of scope (deferred per the protocol doc):
//   - Cloud runtime (Phase 3, A8/A9)
//   - Multi-tenant plist naming (Phase 3, A8)
//   - Host-asleep heuristic in doctor (deferred to A7-2 if at all)
//   - Telemetry wire format (A9)

import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AGENTS_DIR = resolve(REPO_ROOT, 'agents');
const LAUNCH_AGENTS_DIR = resolve(homedir(), 'Library/LaunchAgents');
const CONFIG_DIR = resolve(homedir(), '.config/agix');

// ─── Manifest discovery ─────────────────────────────────────────────

/**
 * Walk agents/ and report every directory's agent status.
 * - { name, status: 'ok', manifest, manifestPath, agentMjsPath } — fully installable
 * - { name, status: 'missing-manifest', ... } — yellow flag per the protocol doc
 * - { name, status: 'missing-agent-mjs', ... } — yellow flag
 * - Anything missing both is treated as not-an-agent and omitted.
 */
export async function discoverAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = resolve(AGENTS_DIR, e.name);
    const manifestPath = resolve(dir, 'manifest.yaml');
    const agentMjsPath = resolve(dir, 'agent.mjs');
    const hasManifest = existsSync(manifestPath);
    const hasAgent = existsSync(agentMjsPath);

    // Genuinely not-an-agent: skip silently.
    if (!hasManifest && !hasAgent) continue;

    // Half-built: yellow flag.
    if (!hasManifest) {
      out.push({ name: e.name, status: 'missing-manifest', dir, agentMjsPath });
      continue;
    }
    if (!hasAgent) {
      out.push({ name: e.name, status: 'missing-agent-mjs', dir, manifestPath });
      continue;
    }

    let manifest = null;
    let parseError = null;
    try {
      manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      parseError = err.message;
    }

    if (parseError) {
      out.push({ name: e.name, status: 'invalid-manifest', dir, manifestPath, parseError });
      continue;
    }

    out.push({ name: e.name, status: 'ok', dir, manifestPath, agentMjsPath, manifest });
  }
  return out;
}

/** sha256 hex of manifest file bytes — used as the drift signal. */
export function manifestSha(manifestPath) {
  const bytes = readFileSync(manifestPath);
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── Cron → launchd intervals ───────────────────────────────────────

/**
 * Parse one cron field (minute | hour | day-of-month | month | day-of-week)
 * into an explicit sorted array of integers, or `null` for the wildcard `*`.
 *
 * Supported syntax: number (`5`), list (`1,5,15`), range (`0-30`), and
 * combinations (`0-5,10,20-25`). Step syntax (the slash form like
 * `star-slash-5`) is intentionally not supported in v1 — launchd's
 * StartCalendarInterval doesn't model it natively, and the existing
 * manifests don't use it.
 */
export function parseCronField(field) {
  if (field === '*') return null;
  if (field.includes('/')) {
    throw new Error(`cron step syntax not supported in v1: "${field}"`);
  }
  const out = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`cron field token unparseable: "${part}"`);
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    if (hi < lo) throw new Error(`cron range hi<lo: "${part}"`);
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Convert a cron expression to the launchd StartCalendarInterval dict array.
 * `0 7,16 * * 1-5` → 10 dicts (2 hours × 5 weekdays), each with explicit
 * Hour/Minute and (when day-of-week is constrained) Weekday.
 *
 * launchd treats fields inside one dict as AND. Two dicts at the top level
 * are OR. So a cron expression with N independent expansions becomes
 * cartesian product across the constrained fields → that many dicts.
 *
 * Weekday normalization: cron uses 0 and 7 for Sunday; launchd uses 0
 * canonically. We normalize 7 → 0 before emitting.
 */
export function cronToLaunchdIntervals(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5-field cron expression, got ${parts.length}: "${cron}"`);
  }
  const [minStr, hourStr, domStr, monStr, dowStr] = parts;
  const minutes = parseCronField(minStr) ?? [null];
  const hours = parseCronField(hourStr) ?? [null];
  const doms = parseCronField(domStr) ?? [null];
  const months = parseCronField(monStr) ?? [null];
  const dows = parseCronField(dowStr) ?? [null];

  // Bounds sanity check on constrained fields.
  const bounds = [
    { values: minutes, lo: 0, hi: 59, name: 'minute' },
    { values: hours, lo: 0, hi: 23, name: 'hour' },
    { values: doms, lo: 1, hi: 31, name: 'day-of-month' },
    { values: months, lo: 1, hi: 12, name: 'month' },
    { values: dows, lo: 0, hi: 7, name: 'day-of-week' },
  ];
  for (const b of bounds) {
    if (b.values[0] === null) continue;
    for (const v of b.values) {
      if (v < b.lo || v > b.hi) {
        throw new Error(`cron ${b.name} out of range [${b.lo},${b.hi}]: ${v}`);
      }
    }
  }

  const dicts = [];
  for (const m of minutes)
    for (const h of hours)
      for (const d of doms)
        for (const M of months)
          for (const w of dows) {
            const dict = {};
            if (m !== null) dict.Minute = m;
            if (h !== null) dict.Hour = h;
            if (d !== null) dict.Day = d;
            if (M !== null) dict.Month = M;
            if (w !== null) dict.Weekday = w === 7 ? 0 : w;
            dicts.push(dict);
          }

  return dicts;
}

/**
 * Compute the most-recent moment a cron schedule *should* have fired
 * before `now`. Used by doctor's "last fire after most recent scheduled
 * fire" check. Returns a Date.
 *
 * The implementation expands the cron to launchd intervals, then walks
 * backward from `now` one minute at a time looking for the first match.
 * This is O(60×24×7) at worst (one week of misses) and is fine for
 * doctor's once-per-brief invocation frequency. A future smarter
 * implementation can compute analytically.
 */
export function mostRecentScheduledFire(cron, now = new Date()) {
  const intervals = cronToLaunchdIntervals(cron);
  if (intervals.length === 0) return null;
  const probe = new Date(now);
  probe.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    for (const d of intervals) {
      if (d.Minute !== undefined && d.Minute !== probe.getMinutes()) continue;
      if (d.Hour !== undefined && d.Hour !== probe.getHours()) continue;
      if (d.Day !== undefined && d.Day !== probe.getDate()) continue;
      if (d.Month !== undefined && d.Month !== probe.getMonth() + 1) continue;
      if (d.Weekday !== undefined && d.Weekday !== probe.getDay()) continue;
      return probe;
    }
    probe.setMinutes(probe.getMinutes() - 1);
  }
  return null; // no match in past week — caller treats as "never scheduled"
}

// ─── Plist generation ───────────────────────────────────────────────

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Deterministic launchd plist XML from a structured spec. Same inputs
 * always produce identical bytes (no timestamps, no nondeterministic
 * ordering) so manifest_sha is the only drift signal.
 */
export function generatePlistXml({
  label,
  programArgs,
  workingDirectory,
  intervals,
  stdoutPath,
  stderrPath,
  envPath,
  runAtLoad = false,
}) {
  const argLines = programArgs
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');

  const intervalDicts = intervals
    .map((d) => {
      const entries = Object.entries(d)
        .map(
          ([k, v]) =>
            `            <key>${k}</key>\n            <integer>${v}</integer>`,
        )
        .join('\n');
      return `        <dict>\n${entries}\n        </dict>`;
    })
    .join('\n');

  const intervalSection =
    intervals.length > 0
      ? `    <key>StartCalendarInterval</key>\n    <array>\n${intervalDicts}\n    </array>\n`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argLines}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(envPath)}</string>
    </dict>
${intervalSection}    <key>RunAtLoad</key>
    <${runAtLoad ? 'true' : 'false'}/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

// ─── Tenant config ──────────────────────────────────────────────────

/**
 * Load tenant config from `~/.config/agix/<tenant_id>/tenant.yaml`.
 * In Phase 1.5 the file is optional — when missing, returns defaults
 * tied to the implicit `agix` tenant. The defaults are encoded here so
 * a fresh `git clone + agix agent install --all` works without manual
 * config beyond the existing `~/.config/agix/*.env` files.
 *
 * Bootstrap of a real per-tenant `tenant.yaml` is A8 scope (multi-tenant).
 */
export function loadTenantConfig(tenantId = 'agix') {
  const path = resolve(CONFIG_DIR, tenantId, 'tenant.yaml');
  if (existsSync(path)) {
    try {
      const cfg = yaml.load(readFileSync(path, 'utf8')) || {};
      return { source: path, ...defaultsForTenant(tenantId), ...cfg };
    } catch (err) {
      throw new Error(`Malformed tenant.yaml at ${path}: ${err.message}`);
    }
  }
  return { source: '<defaults>', ...defaultsForTenant(tenantId) };
}

function defaultsForTenant(tenantId) {
  // Phase 1.5 defaults — applied when no tenant.yaml exists.
  // Read operator_email from ~/.config/agix/smtp.env if present so it
  // stays in lock-step with the existing single-tenant setup.
  let operatorEmail = 'operator@example.com';
  const smtpEnv = resolve(CONFIG_DIR, 'smtp.env');
  if (existsSync(smtpEnv)) {
    const txt = readFileSync(smtpEnv, 'utf8');
    const m = txt.match(/^\s*SMTP_USER\s*=\s*(\S+)/m) || txt.match(/^\s*AGIX_OPERATOR_EMAIL\s*=\s*(\S+)/m);
    if (m) operatorEmail = m[1];
  }
  return {
    tenant_id: tenantId,
    timezone: 'America/Denver',
    operator_email: operatorEmail,
    workspace_admin_email: operatorEmail,
  };
}

/**
 * Substitute ${tenant.X} placeholders in any value (string, object, array).
 * Returns a deep clone with substitutions applied. Throws if a placeholder
 * cannot be resolved (with the exact key path), unless the value is the
 * sentinel `null` (manifest's `auth: null` and similar).
 */
export function resolveTenantPlaceholders(value, tenantCfg) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(/\$\{tenant\.([a-zA-Z0-9_]+)\}/g, (_, key) => {
      if (!(key in tenantCfg)) {
        throw new Error(`Unresolved tenant placeholder: \${tenant.${key}} (tenant config keys: ${Object.keys(tenantCfg).join(', ')})`);
      }
      return tenantCfg[key];
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTenantPlaceholders(v, tenantCfg));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTenantPlaceholders(v, tenantCfg);
    return out;
  }
  return value;
}

// ─── Install record (config, not cache) ─────────────────────────────

export function installRecordPath({ tenantId = 'agix', name }) {
  return resolve(CONFIG_DIR, tenantId, 'installed', `${name}.json`);
}

export function readInstallRecord({ tenantId = 'agix', name }) {
  const path = installRecordPath({ tenantId, name });
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeInstallRecord({ tenantId, name, record }) {
  const path = installRecordPath({ tenantId, name });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + '\n');
  return path;
}

async function deleteInstallRecord({ tenantId, name }) {
  const path = installRecordPath({ tenantId, name });
  if (existsSync(path)) await unlink(path);
}

// ─── Platform guard (launchd is macOS-only) ─────────────────────────
//
// The fleet lifecycle (install / uninstall / doctor) is built on launchd
// (`launchctl` + `~/Library/LaunchAgents/*.plist`). That substrate is
// macOS-only. On any other platform `spawnSync('launchctl', …)` returns
// `{ status: null, stdout: undefined }` (ENOENT), and the first
// `r.stdout.split(…)` throws an opaque TypeError. Guard the launchd
// entry points so non-macOS hosts get a CLEAR, actionable message
// instead of a crash. The rest of the CLI (`agent run/list/new/smoke`,
// `swarm`, `serve`, `init`, `soul`) is cross-platform and is NOT gated.
export const LAUNCHD_SUPPORTED = process.platform === 'darwin';

// Human-readable message returned (not thrown) by the guarded entry
// points when scheduled/background agents can't be installed on this OS.
export function unsupportedPlatformMessage(subject = 'Scheduled/background agents') {
  return (
    `${subject}: launchd scheduling is macOS-only in Agix v0.2 (current platform: ${process.platform}).\n` +
    `  • Run an agent directly:    agix agent run <name>\n` +
    `  • Wire your own scheduler:  cron / systemd timers (native Linux scheduling is on the roadmap)\n` +
    `launchd install was skipped — nothing was changed on this host.`
  );
}

// ─── Plist paths + launchctl helpers ────────────────────────────────

/**
 * Phase 1.5 plist naming: `io.agix.<name>.plist`. Multi-tenant naming
 * (`io.agix.tenants.<tenant_id>.<name>.plist`) is deferred to A8 per
 * the spec.
 */
export function plistLabel(name) {
  return `io.agix.${name}`;
}

export function plistPath(name) {
  return resolve(LAUNCH_AGENTS_DIR, `${plistLabel(name)}.plist`);
}

export function cacheDirFor(name) {
  return resolve(homedir(), `.cache/agix-${name}`);
}

function uid() {
  return spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
}

function launchctlList(label) {
  const r = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return r.stdout.split('\n').some((line) => line.endsWith(`\t${label}`));
}

function launchctlBootout(label) {
  const r = spawnSync('launchctl', ['bootout', `gui/${uid()}/${label}`], { encoding: 'utf8' });
  // bootout exits non-zero if not loaded; that's fine for an idempotent uninstall.
  return { status: r.status, stderr: r.stderr };
}

function launchctlBootstrap(plistPath) {
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

// ─── Install / uninstall ────────────────────────────────────────────

const REPO_BIN_AGIX = resolve(REPO_ROOT, 'bin/agix');

/**
 * Build the plist spec from a (placeholder-resolved) manifest. Returns
 * the full spec object ready to hand to generatePlistXml. Pure: no
 * side-effects.
 */
export function buildPlistSpec({ name, manifest, repoRoot = REPO_ROOT, nodePath = process.execPath }) {
  const intervals = [];
  for (const entry of manifest.schedule || []) {
    if (!entry.cron) continue;
    // Manifest may declare an `enabled: false` cron (e.g. madoguchi's repair).
    if (entry.enabled === false) continue;
    intervals.push(...cronToLaunchdIntervals(entry.cron));
  }

  const cacheDir = cacheDirFor(name);
  const envPath = `${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  return {
    label: plistLabel(name),
    programArgs: [nodePath, REPO_BIN_AGIX, 'agent', 'run', name],
    workingDirectory: repoRoot,
    intervals,
    stdoutPath: resolve(cacheDir, 'launchd.out.log'),
    stderrPath: resolve(cacheDir, 'launchd.err.log'),
    envPath,
    runAtLoad: false,
  };
}

/**
 * Install an agent end-to-end:
 *   1. Load + validate manifest (manifest_sha computed from file bytes).
 *   2. Resolve ${tenant.*} placeholders against tenant config (defaults
 *      apply when tenant.yaml is missing in Phase 1.5).
 *   3. Generate plist XML deterministically.
 *   4. Write plist to ~/Library/LaunchAgents/.
 *   5. launchctl bootout (idempotent) + bootstrap.
 *   6. Run smoke (unless --skip-smoke). Smoke failure → rollback.
 *   7. Write install record to ~/.config/agix/<tenant>/installed/<name>.json.
 *
 * Returns { ok: true, record } on success, { ok: false, error, rolledBack }
 * on failure. Idempotent: running twice produces the same end state.
 */
export async function installAgent({
  name,
  tenantId = 'agix',
  dryRun = false,
  skipSmoke = false,
  runSmokeFn,           // injected by the CLI; signature: (name, { tenantId }) => Promise<{exit, durationMs}>
  log = () => {},
}) {
  // 0. Platform guard — launchd install is macOS-only.
  if (!LAUNCHD_SUPPORTED) {
    return { ok: false, name, unsupportedPlatform: true, error: unsupportedPlatformMessage(`Installing agent "${name}"`) };
  }

  // 1. Discover + validate
  const all = await discoverAgents();
  const found = all.find((a) => a.name === name);
  if (!found) {
    return { ok: false, name, error: `agent not found in agents/${name}/` };
  }
  if (found.status !== 'ok') {
    return { ok: false, name, error: `agent ${name} is ${found.status}` };
  }
  const { manifest, manifestPath } = found;
  const mSha = manifestSha(manifestPath);
  log(`  ✓ manifest loaded · sha=${mSha.slice(0, 12)}`);

  // 2. Validate that schedule entries are literal (no placeholders to
  //    resolve). The install path only reads `schedule:` from the
  //    manifest; auth + outputs placeholders are the agent's concern at
  //    run time, not install time. If anyone adds a placeholder to a
  //    cron string later, we surface it loudly here rather than
  //    silently generating a malformed plist.
  for (const entry of manifest.schedule || []) {
    if (entry.cron && entry.cron.includes('${')) {
      return { ok: false, name, error: `schedule.cron contains unresolved placeholder: ${entry.cron}` };
    }
  }

  // 3. Build plist spec + XML
  const spec = buildPlistSpec({ name, manifest });
  const xml = generatePlistXml(spec);
  const targetPlist = plistPath(name);
  log(`  ✓ plist composed · ${spec.intervals.length} interval(s)`);

  if (dryRun) {
    return { ok: true, name, dryRun: true, plistPath: targetPlist, plistXml: xml, intervals: spec.intervals };
  }

  // 4. Write plist
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(cacheDirFor(name), { recursive: true });
  await writeFile(targetPlist, xml);
  log(`  ✓ plist written · ${targetPlist}`);

  // 5. launchctl bootout (idempotent) + bootstrap
  const bootout = launchctlBootout(plistLabel(name));
  if (bootout.status === 0) log(`  ✓ existing launchd entry booted out`);
  const bootstrap = launchctlBootstrap(targetPlist);
  if (bootstrap.status !== 0) {
    await unlink(targetPlist).catch(() => {});
    return {
      ok: false,
      name,
      error: `launchctl bootstrap failed (exit ${bootstrap.status}): ${bootstrap.stderr.trim()}`,
      rolledBack: true,
    };
  }
  log(`  ✓ launchd bootstrapped`);

  // 6. Smoke
  let smoke = { skipped: true };
  if (!skipSmoke) {
    if (typeof runSmokeFn !== 'function') {
      return {
        ok: false,
        name,
        error: 'install: runSmokeFn required (smoke not skipped)',
      };
    }
    log(`  → running smoke…`);
    const startedAt = Date.now();
    try {
      const result = await runSmokeFn(name, { tenantId });
      smoke = { skipped: false, exit: result.exit ?? 0, durationMs: Date.now() - startedAt };
    } catch (err) {
      smoke = { skipped: false, exit: 1, durationMs: Date.now() - startedAt, error: err.message };
    }
    if (smoke.exit !== 0) {
      // Rollback: unload + remove plist
      launchctlBootout(plistLabel(name));
      await unlink(targetPlist).catch(() => {});
      return {
        ok: false,
        name,
        error: `smoke failed (exit ${smoke.exit}${smoke.error ? `: ${smoke.error}` : ''})`,
        rolledBack: true,
        smoke,
      };
    }
    log(`  ✓ smoke passed · ${smoke.durationMs}ms`);
  }

  // 7. Write install record
  const record = {
    installed_at: new Date().toISOString(),
    manifest_sha: mSha,
    manifest_path: manifestPath,
    plist_path: targetPlist,
    plist_label: plistLabel(name),
    smoke_exit: smoke.skipped ? null : smoke.exit,
    smoke_duration_ms: smoke.skipped ? null : smoke.durationMs,
    smoke_skipped: smoke.skipped,
    runtime: 'local',
    tenant_id: tenantId,
    agix_version: readAgixVersion(),
  };
  const recordPath = await writeInstallRecord({ tenantId, name, record });
  log(`  ✓ install record · ${recordPath}`);

  return { ok: true, name, record, plistPath: targetPlist, intervals: spec.intervals };
}

export async function uninstallAgent({
  name,
  tenantId = 'agix',
  log = () => {},
}) {
  // Platform guard — there is nothing launchd-shaped to remove off macOS.
  if (!LAUNCHD_SUPPORTED) {
    return { ok: true, name, unsupportedPlatform: true, alreadyAbsent: true };
  }

  const label = plistLabel(name);
  const target = plistPath(name);

  // Idempotent: missing-everything = success.
  if (!launchctlList(label) && !existsSync(target) && !readInstallRecord({ tenantId, name })) {
    log(`  ✓ already absent`);
    return { ok: true, name, alreadyAbsent: true };
  }

  const bootout = launchctlBootout(label);
  if (bootout.status === 0) log(`  ✓ booted out`);

  if (existsSync(target)) {
    await unlink(target);
    log(`  ✓ plist removed`);
  }

  await deleteInstallRecord({ tenantId, name });
  log(`  ✓ install record removed`);

  return { ok: true, name };
}

// ─── --all wrapper ──────────────────────────────────────────────────

/**
 * Best-effort, continue-on-failure across the fleet. Each agent's
 * install is independent; smoke failure rolls back that agent only and
 * proceeds to the next. Returns { results: [...], allOk }.
 */
export async function installAll({ tenantId = 'agix', skipSmoke = false, runSmokeFn, log = () => {} }) {
  // Platform guard — launchd install is macOS-only.
  if (!LAUNCHD_SUPPORTED) {
    return {
      results: [],
      allOk: false,
      unsupportedPlatform: true,
      error: unsupportedPlatformMessage('Installing the agent fleet'),
      fleet: await discoverAgents(),
      summary: { installable: 0, ok: 0, failed: 0, skipped: 0 },
    };
  }

  const all = await discoverAgents();
  const installable = all.filter((a) => a.status === 'ok');
  const results = [];
  for (const a of installable) {
    log(`\n→ ${a.name}`);
    const r = await installAgent({ name: a.name, tenantId, skipSmoke, runSmokeFn, log });
    results.push(r);
  }
  const allOk = results.every((r) => r.ok);
  return {
    results,
    allOk,
    fleet: all,
    summary: {
      installable: installable.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      skipped: all.length - installable.length,
    },
  };
}

export async function uninstallAll({ tenantId = 'agix', log = () => {} }) {
  // Platform guard — nothing launchd-shaped to remove off macOS.
  if (!LAUNCHD_SUPPORTED) {
    return { results: [], allOk: true, unsupportedPlatform: true };
  }

  const all = await discoverAgents();
  const results = [];
  for (const a of all) {
    if (a.status !== 'ok') continue;
    log(`\n→ ${a.name}`);
    const r = await uninstallAgent({ name: a.name, tenantId, log });
    results.push(r);
  }
  return { results, allOk: results.every((r) => r.ok) };
}

// ─── Doctor ─────────────────────────────────────────────────────────

const TOLERANCE_MS = 15 * 60 * 1000;       // 15 min per the protocol spec

/**
 * Doctor — verify the installed fleet is healthy.
 *
 * For each agent: runs the 7 checks defined in the protocol spec
 * (loaded / binary-exists / manifest-unchanged / last-fire / last-exit /
 * next-fire / email-contract) and rolls up to green/yellow/red/skipped.
 *
 * Returns a structured report:
 *   {
 *     doctor_schema_version: '0.1',
 *     ran_at: <ISO timestamp>,
 *     host: <os.hostname()>,
 *     agents: [
 *       { agent, status, checks: [{name, status, detail, remediation?}], remediation? }
 *     ],
 *     summary: { green, yellow, red, skipped, total }
 *   }
 *
 * Single-agent invocation: pass `name` to constrain to one agent.
 */
export async function doctor({ name = null } = {}) {
  const ran_at = new Date().toISOString();
  const { hostname } = await import('node:os');

  // Platform guard — doctor inspects launchd state (launchctl + plists),
  // which only exists on macOS. Return a clean unsupported report rather
  // than crashing on the first `launchctl` ENOENT.
  if (!LAUNCHD_SUPPORTED) {
    return {
      doctor_schema_version: '0.1',
      ran_at,
      host: hostname(),
      unsupportedPlatform: true,
      message: unsupportedPlatformMessage('Fleet doctor (launchd health checks)'),
      agents: [],
      summary: { green: 0, yellow: 0, red: 0, skipped: 0, total: 0 },
    };
  }

  const all = await discoverAgents();

  // Apply single-agent filter if requested.
  const targets = name ? all.filter((a) => a.name === name) : all;

  const reportAgents = [];
  for (const a of targets) {
    if (a.status === 'missing-manifest' || a.status === 'missing-agent-mjs') {
      reportAgents.push({
        agent: a.name,
        status: 'yellow',
        checks: [
          { name: 'manifest_discovery', status: 'yellow', detail: `agent directory present but ${a.status === 'missing-manifest' ? 'manifest.yaml missing' : 'agent.mjs missing'}` },
        ],
        remediation: a.status === 'missing-manifest'
          ? `add agents/${a.name}/manifest.yaml or remove the half-built directory`
          : `add agents/${a.name}/agent.mjs or remove the half-built directory`,
      });
      continue;
    }
    if (a.status === 'invalid-manifest') {
      reportAgents.push({
        agent: a.name,
        status: 'red',
        checks: [
          { name: 'manifest_discovery', status: 'red', detail: `manifest YAML parse error: ${a.parseError}` },
        ],
        remediation: `fix agents/${a.name}/manifest.yaml YAML syntax`,
      });
      continue;
    }
    // status === 'ok' — run the full check matrix
    reportAgents.push(await doctorOneAgent(a));
  }

  const summary = { green: 0, yellow: 0, red: 0, skipped: 0, total: reportAgents.length };
  for (const r of reportAgents) summary[r.status] = (summary[r.status] || 0) + 1;

  return {
    doctor_schema_version: '0.1',
    ran_at,
    host: hostname(),
    agents: reportAgents,
    summary,
  };
}

async function doctorOneAgent(a) {
  const checks = [];
  const tenantId = 'agix'; // Phase 1.5
  const installRecord = readInstallRecord({ tenantId, name: a.name });

  // Check 1: install record present
  if (!installRecord) {
    checks.push({
      name: 'install_record',
      status: 'red',
      detail: `no install record at ~/.config/agix/${tenantId}/installed/${a.name}.json`,
      remediation: `agix agent install ${a.name}`,
    });
    return rollup(a.name, checks, `agix agent install ${a.name}`);
  }
  checks.push({ name: 'install_record', status: 'green', detail: `installed_at: ${installRecord.installed_at}` });

  // Check 2: loaded in launchctl
  const label = plistLabel(a.name);
  const isLoaded = launchctlList(label);
  checks.push(
    isLoaded
      ? { name: 'loaded', status: 'green', detail: `${label} loaded` }
      : { name: 'loaded', status: 'red', detail: `${label} not loaded`, remediation: `agix agent install ${a.name}` },
  );

  // Check 3: binary exists (the node path the plist points at)
  const programPath = launchctlProgram(label) || installRecord.plist_path
    ? existsSync(installRecord.plist_path) ? readPlistProgram(installRecord.plist_path) : null
    : null;
  if (programPath) {
    checks.push(
      existsSync(programPath)
        ? { name: 'binary_exists', status: 'green', detail: programPath }
        : { name: 'binary_exists', status: 'red', detail: `${programPath} does not exist`, remediation: `agix agent install ${a.name}` },
    );
  } else {
    checks.push({ name: 'binary_exists', status: 'yellow', detail: 'could not read program path from plist' });
  }

  // Check 4: manifest unchanged since install
  const currentSha = manifestSha(a.manifestPath);
  if (installRecord.manifest_sha === currentSha) {
    checks.push({ name: 'manifest_unchanged', status: 'green', detail: `sha=${currentSha.slice(0, 12)}` });
  } else {
    checks.push({
      name: 'manifest_unchanged',
      status: 'red',
      detail: `manifest changed since install (${installRecord.manifest_sha?.slice(0, 12)} → ${currentSha.slice(0, 12)})`,
      remediation: `agix agent install ${a.name}`,
    });
  }

  // Determine if this agent has a schedule. Agents without one are
  // manual-only — last-fire / next-fire checks don't apply.
  const cronEntries = (a.manifest.schedule || []).filter((s) => s.cron && s.enabled !== false);
  const hasSchedule = cronEntries.length > 0;

  // Check 5: last fire after most recent scheduled fire
  if (hasSchedule) {
    const mostRecentExpected = mostRecentExpectedAcrossSchedules(cronEntries);
    const lastRun = await readMostRecentRun(a.name);
    if (mostRecentExpected) {
      if (!lastRun) {
        checks.push({
          name: 'last_fire_after_scheduled',
          status: 'red',
          detail: `no run record exists; most recent scheduled fire was at ${mostRecentExpected.toISOString()}`,
          remediation: `wait for next scheduled fire, or invoke manually: agix agent run ${a.name}`,
        });
      } else {
        const lastStartedAt = new Date(lastRun.started_at);
        const okIfAfter = new Date(mostRecentExpected.getTime() - TOLERANCE_MS);
        if (lastStartedAt >= okIfAfter) {
          checks.push({
            name: 'last_fire_after_scheduled',
            status: 'green',
            detail: `last fire at ${lastStartedAt.toISOString()} (after expected ${mostRecentExpected.toISOString()})`,
          });
        } else {
          // Host-asleep heuristic per the protocol spec: if expected
          // fire pre-dates host_uptime, the host was off — yellow not red.
          const uptimeMs = await hostUptimeMs();
          const hostBootAt = new Date(Date.now() - uptimeMs);
          if (mostRecentExpected < hostBootAt) {
            checks.push({
              name: 'last_fire_after_scheduled',
              status: 'yellow',
              detail: `host was off during expected window (booted ${hostBootAt.toISOString()})`,
            });
          } else {
            const ageMin = Math.round((Date.now() - lastStartedAt.getTime()) / 60000);
            checks.push({
              name: 'last_fire_after_scheduled',
              status: 'red',
              detail: `stale — last fire ${ageMin} min ago; most recent scheduled fire was at ${mostRecentExpected.toISOString()}`,
              remediation: `agix agent run ${a.name}  (then investigate why scheduled fire was skipped)`,
            });
          }
        }
      }
    }
    // Check 6: last fire exit 0
    if (lastRun) {
      checks.push(
        lastRun.exit_code === 0
          ? { name: 'last_fire_exit_0', status: 'green', detail: `exit_code: 0` }
          : { name: 'last_fire_exit_0', status: 'red', detail: `last run exited ${lastRun.exit_code} at ${lastRun.finished_at}`, remediation: `inspect ~/.cache/agix-${a.name}/runs/${lastRun.run_id}.json` },
      );
    }
  } else {
    checks.push({ name: 'last_fire_after_scheduled', status: 'skipped', detail: 'agent has no schedule (manual-only)' });
    checks.push({ name: 'last_fire_exit_0', status: 'skipped', detail: 'agent has no schedule (manual-only)' });
  }

  // Check 7: next fire scheduled (launchctl print shows a future calendar entry)
  if (hasSchedule) {
    const hasFuture = launchctlHasFutureFire(label);
    checks.push(
      hasFuture
        ? { name: 'next_fire_scheduled', status: 'green', detail: 'launchctl has future calendar entry' }
        : { name: 'next_fire_scheduled', status: 'yellow', detail: 'no future calendar entry visible (may be a launchctl timing artifact)' },
    );
  } else {
    checks.push({ name: 'next_fire_scheduled', status: 'skipped', detail: 'agent has no schedule (manual-only)' });
  }

  // Check 8: email-contract compliance
  const declaresEmail = (a.manifest.outputs || []).some((o) => o.kind === 'email');
  if (declaresEmail) {
    const violations = await scanEmailContractViolations(a.dir);
    checks.push(
      violations.length === 0
        ? { name: 'email_contract', status: 'green', detail: 'no forbidden patterns found' }
        : { name: 'email_contract', status: 'red', detail: `violations: ${violations.join(', ')}`, remediation: 'see architecture/03-ai-ml/agent-architecture/EMAIL_OUTPUT_CONTRACT.md' },
    );
  } else {
    checks.push({ name: 'email_contract', status: 'skipped', detail: 'agent does not declare kind: email' });
  }

  return rollup(a.name, checks, suggestRemediation(checks));
}

function rollup(name, checks, remediation) {
  const statuses = checks.map((c) => c.status);
  let status = 'green';
  if (statuses.includes('red')) status = 'red';
  else if (statuses.includes('yellow')) status = 'yellow';
  else if (statuses.every((s) => s === 'skipped')) status = 'skipped';
  return { agent: name, status, checks, remediation };
}

function suggestRemediation(checks) {
  const red = checks.find((c) => c.status === 'red' && c.remediation);
  return red?.remediation || null;
}

// Walk multiple cron entries, return the most recent expected fire
// across all of them. Used for last-fire-after-scheduled.
function mostRecentExpectedAcrossSchedules(cronEntries, now = new Date()) {
  let best = null;
  for (const entry of cronEntries) {
    const t = mostRecentScheduledFire(entry.cron, now);
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

async function readMostRecentRun(name) {
  const runsDir = resolve(cacheDirFor(name), 'runs');
  if (!existsSync(runsDir)) return null;
  const names = (await readdir(runsDir)).filter((n) => n.endsWith('.json'));
  if (names.length === 0) return null;
  // Read mtimes to find most recent. Could also sort by started_at
  // inside the record, but mtime is cheaper and we wrote the file at
  // event emit time so they're equivalent.
  let best = null;
  let bestMtime = -Infinity;
  for (const n of names) {
    const p = resolve(runsDir, n);
    const s = await stat(p);
    if (s.mtimeMs > bestMtime) {
      bestMtime = s.mtimeMs;
      best = p;
    }
  }
  try {
    const rec = JSON.parse(await readFile(best, 'utf8'));
    // Only count "real" runs for last-fire — smoke fires are tests,
    // not legitimate scheduled fires.
    if (rec.invocation === 'smoke') return null;
    return rec;
  } catch {
    return null;
  }
}

async function hostUptimeMs() {
  const r = spawnSync('uptime', [], { encoding: 'utf8' });
  // Fallback if uptime output is unparseable — return a large value
  // (system was up forever) so heuristic never triggers a false yellow.
  if (r.status !== 0) return Infinity;
  // macOS uptime: "  9:58  up  4 days, 14:01, ..."
  const m = r.stdout.match(/up\s+(?:(\d+)\s+days?,\s+)?(\d+):(\d+)/);
  if (!m) {
    // Try compact "up XX:YY"
    const m2 = r.stdout.match(/up\s+(\d+):(\d+)/);
    if (!m2) return Infinity;
    return (Number(m2[1]) * 3600 + Number(m2[2]) * 60) * 1000;
  }
  const days = m[1] ? Number(m[1]) : 0;
  const h = Number(m[2]);
  const mins = Number(m[3]);
  return (days * 86400 + h * 3600 + mins * 60) * 1000;
}

// Read the program path from a plist file (ProgramArguments[0]).
function readPlistProgram(plistPath) {
  if (!existsSync(plistPath)) return null;
  const xml = readFileSync(plistPath, 'utf8');
  const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : null;
}

function launchctlProgram(label) {
  const r = spawnSync('launchctl', ['print', `gui/${uid()}/${label}`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/program\s*=\s*(\S+)/);
  return m ? m[1] : null;
}

function launchctlHasFutureFire(label) {
  // launchctl print includes a "next launch" line for calendar-scheduled
  // jobs. If we can't find one, fall back to: a calendar interval was
  // configured (presence of `com.apple.launchd.calendarinterval` stream).
  const r = spawnSync('launchctl', ['print', `gui/${uid()}/${label}`], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  if (/com\.apple\.launchd\.calendarinterval/.test(r.stdout)) return true;
  return false;
}

// Email-contract violations per EMAIL_OUTPUT_CONTRACT.md. Grep-based;
// the structural enforcement (lib/_internal/ move + lint rule) lands
// in a follow-up.
async function scanEmailContractViolations(agentDir) {
  const violations = new Set();
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(p);
        continue;
      }
      if (!(e.name.endsWith('.mjs') || e.name.endsWith('.js') || e.name.endsWith('.ts'))) continue;
      const content = await readFile(p, 'utf8');
      if (/import\s+[^;]+from\s+['"][^'"]*lib\/agix-send/.test(content)) violations.add('direct-lib-agix-send-import');
      if (/smtp\.gmail\.com/.test(content)) violations.add('outbound-smtp-gmail');
      // Raw <html> string is too noisy as a check (agents legitimately
      // pass HTML body content); skip for v1.
    }
  };
  if (existsSync(agentDir)) await walk(agentDir);
  return [...violations];
}

// ─── Misc ───────────────────────────────────────────────────────────

function readAgixVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
