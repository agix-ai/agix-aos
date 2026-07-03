// agix-bus-cli.mjs — CLI provisioning for the Rust intra-agent bus (North Star P3).
//
// `lib/agix-bus-provision.mjs` exposes `busUp()`, which spawns the daemon as a
// CHILD of the calling process — it dies when that process exits. That is the
// right shape for an in-process runtime that owns the daemon's lifetime, but the
// wrong shape for a CLI: `agix bus up` must leave a daemon RUNNING after the CLI
// command returns.
//
// So this module spawns the same `lewis-aos-bus serve <addr>` binary
// **detached** (`detached: true` + `unref()`, stdio redirected to a logfile),
// records a small marker under the CLI's state dir, and exposes symmetric
// `down`/`status` commands that read the marker back. It reuses the binary path
// + offline-build logic from agix-bus-provision.mjs (BUS_BINARY / ensureBusBinary
// / BUS_REPO_ROOT) so the two provisioning paths stay in lockstep.
//
// Transport (cross-platform): the daemon listens on a loopback TCP port
// (127.0.0.1:<port>), so up/down/status provision and probe a PORT rather than a
// Unix socket file — dependency-free and identical on macOS, Linux, and Windows.
//
// State dir: ~/.cache/agix-bus/ — matches the CLI's per-agent cache convention
// (`~/.cache/agix-<name>/`, see lib/agix-fleet.mjs cacheDirFor + the runtime's
// `~/.cache/agix` base). The marker is keyed by port so multiple buses on
// distinct ports don't clobber each other.
//
// Surface (consumed by bin/agix):
//   busUpCommand({ port, log })     → spawn detached, print "bus is up"
//   busDownCommand({ port, log })   → SIGTERM the recorded pid
//   busStatusCommand({ port, log }) → report up/down (pid liveness + port)

import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { createBus, DEFAULT_HOST, DEFAULT_PORT } from './agix-bus.mjs';
import { ensureBusBinary, BUS_BINARY, BUS_REPO_ROOT } from './agix-bus-provision.mjs';

export const DEFAULT_BUS_PORT = DEFAULT_PORT;
export const DEFAULT_BUS_HOST = DEFAULT_HOST;

// Back-compat export: callers (e.g. bin/agix) that imported `DEFAULT_SOCKET`
// keep working — it is now the default loopback endpoint as a `host:port` string.
// The commands accept either the new `{host,port}` knobs or a legacy
// `socketPath`/`socket` string (a port, a `host:port`, or the old Unix path,
// which now resolves to the default port).
export const DEFAULT_SOCKET = `${DEFAULT_HOST}:${DEFAULT_PORT}`;

/**
 * Resolve {host, port} from the command options, tolerating the legacy
 * `socketPath`/`socket` string form. A bare number → port; `host:port` →
 * both; anything else (e.g. a stale `/tmp/...sock` path) → the default port.
 * @param {{host?:string, port?:number, socketPath?:string, socket?:string}} opts
 */
export function resolveEndpoint({ host, port, socketPath, socket } = {}) {
  let h = host ?? DEFAULT_HOST;
  let p = port;
  const legacy = socketPath ?? socket;
  if (p === undefined && typeof legacy === 'string' && legacy) {
    if (/^\d+$/.test(legacy)) {
      p = Number(legacy);
    } else {
      const m = legacy.match(/^([^:]+):(\d+)$/);
      if (m) { h = host ?? m[1]; p = Number(m[2]); }
    }
  }
  if (p === undefined) p = DEFAULT_PORT;
  return { host: h, port: p };
}

/** CLI state dir for bus markers — matches `~/.cache/agix-<name>/`. */
export const BUS_STATE_DIR = resolve(homedir(), '.cache/agix-bus');

/**
 * Marker file path for a given port. Keyed by an 8-char hash of the
 * `host:port` so distinct endpoints get distinct markers (filename-safe).
 */
export function markerPathFor(host, port) {
  const h = createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 8);
  return resolve(BUS_STATE_DIR, `bus-${h}.json`);
}

function readMarker(host, port) {
  const p = markerPathFor(host, port);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(host, port, marker) {
  mkdirSync(BUS_STATE_DIR, { recursive: true });
  writeFileSync(markerPathFor(host, port), JSON.stringify(marker, null, 2) + '\n');
}

function removeMarker(host, port) {
  try { unlinkSync(markerPathFor(host, port)); } catch { /* best-effort */ }
}

/** True if a process with this pid is alive (signal 0 = liveness probe). */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it → still alive.
    return e?.code === 'EPERM';
  }
}

/** Probe the loopback TCP port: resolves true once a connection is accepted. */
function portAccepts(host, port, { timeoutMs = 1000 } = {}) {
  return new Promise((res) => {
    const conn = net.createConnection({ host, port });
    const done = (ok) => { try { conn.destroy(); } catch { /* closing */ } res(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    conn.once('connect', () => { clearTimeout(timer); done(true); });
    conn.once('error', () => { clearTimeout(timer); done(false); });
  });
}

/** Poll the port until it accepts, or time out. */
async function waitForPort(host, port, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepts(host, port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Connect to the bus and confirm it answers HELLO with `ok`.
 * Resolves true if the daemon completed the handshake within `timeoutMs`.
 */
function busHandshakeOk(host, port, { timeoutMs = 1500 } = {}) {
  return new Promise((res) => {
    let bus;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { bus?.close(); } catch { /* closing */ }
      res(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      bus = createBus({ host, port, agent: 'agix-bus-cli', trust: 'observer' });
      bus.ready.then(() => finish(true)).catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * `agix bus up` — provision the daemon detached so it survives CLI exit.
 *
 * Detach mechanism: spawn the built `lewis-aos-bus serve <socket>` binary with
 * `detached: true` (new session/process group, no longer tied to the CLI's
 * controlling terminal) + `child.unref()` (so the CLI's event loop can exit
 * without waiting on it) + stdio redirected to a logfile (a detached child must
 * NOT share the parent's stdio fds, or it would keep the CLI's stdout open).
 * The pid + socket are recorded in a marker under the state dir for `down`.
 *
 * @returns {Promise<{exit:number, host:string, port:number, pid?:number, alreadyRunning?:boolean}>}
 */
export async function busUpCommand({ log = console.log, timeoutMs = 15000, ...endpoint } = {}) {
  const { host, port } = resolveEndpoint(endpoint);
  // Already running on this port? Don't double-bind (the daemon would panic).
  if (await portAccepts(host, port) && await busHandshakeOk(host, port)) {
    const existing = readMarker(host, port);
    log(`bus already up · ${host}:${port}${existing?.pid ? ` · pid ${existing.pid}` : ''}`);
    return { exit: 0, host, port, socketPath: `${host}:${port}`, pid: existing?.pid, alreadyRunning: true };
  }

  // Build the binary if absent (offline; same logic as busUp()). May throw —
  // bin/agix's top-level catch reports it.
  const binary = ensureBusBinary();
  if (binary !== BUS_BINARY) {
    // Defensive: ensureBusBinary always returns BUS_BINARY, but guard anyway.
    throw new Error(`unexpected bus binary path: ${binary}`);
  }

  // Loopback TCP: no socket file to clear — a still-bound port just means a
  // daemon is already up (handled by the early-return above).

  mkdirSync(BUS_STATE_DIR, { recursive: true });
  const logPath = resolve(BUS_STATE_DIR, 'bus.log');
  const out = openSync(logPath, 'a');

  const child = spawn(binary, ['serve', String(port)], {
    cwd: BUS_REPO_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  // Wait for the port to accept before declaring success — so `up` fails
  // loudly if the daemon couldn't bind, rather than reporting a phantom pid.
  const ready = await waitForPort(host, port, { timeoutMs });
  if (!ready) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
    return { exit: 1, host, port, socketPath: `${host}:${port}`, pid: child.pid };
  }

  writeMarker(host, port, {
    pid: child.pid,
    host,
    port,
    binary,
    startedAt: new Date().toISOString(),
    logPath,
  });

  log(`addr    ${host}:${port}`);
  log(`pid     ${child.pid}`);
  log(`log     ${logPath}`);
  log('bus is up');
  return { exit: 0, host, port, socketPath: `${host}:${port}`, pid: child.pid };
}

/**
 * `agix bus down` — stop the recorded daemon.
 * Reads the marker for the pid; SIGTERMs it (escalating to SIGKILL); removes the
 * marker. The loopback port releases when the process exits — no socket file to
 * unlink. Idempotent — reports "not running" if already down.
 *
 * @returns {Promise<{exit:number, host:string, port:number, stopped:boolean}>}
 */
export async function busDownCommand({ log = console.log, ...endpoint } = {}) {
  const { host, port } = resolveEndpoint(endpoint);
  const marker = readMarker(host, port);
  const pid = marker?.pid;

  if (!pid || !pidAlive(pid)) {
    // Nothing live recorded — clean up any stale marker.
    removeMarker(host, port);
    log(`bus not running · ${host}:${port}`);
    return { exit: 0, host, port, stopped: false };
  }

  try { process.kill(pid, 'SIGTERM'); } catch { /* may have just died */ }

  // Wait for the process to exit (poll), escalate to SIGKILL after a grace.
  const deadline = Date.now() + 3000;
  let escalated = false;
  while (Date.now() < deadline && pidAlive(pid)) {
    if (!escalated && Date.now() > deadline - 1000) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      escalated = true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  removeMarker(host, port);

  log(`bus stopped · pid ${pid} · ${host}:${port}`);
  return { exit: 0, host, port, stopped: true };
}

/**
 * `agix bus status` — report whether the bus is up.
 * Up = the port accepts a connection AND completes the HELLO handshake (so a
 * dead daemon reads as DOWN). Cross-references the recorded pid for context.
 *
 * @returns {Promise<{exit:number, up:boolean, host:string, port:number, pid?:number, json?:object}>}
 */
export async function busStatusCommand({ log = console.log, json = false, ...endpoint } = {}) {
  const { host, port } = resolveEndpoint(endpoint);
  const marker = readMarker(host, port);
  const pid = marker?.pid;
  const portOk = await portAccepts(host, port);
  const handshakeOk = portOk ? await busHandshakeOk(host, port) : false;
  const pidIsAlive = pidAlive(pid);
  const up = portOk && handshakeOk;

  const report = {
    up,
    host,
    port,
    pid: pid ?? null,
    pidAlive: pidIsAlive,
    portAccepts: portOk,
    handshake: handshakeOk,
    startedAt: marker?.startedAt ?? null,
  };

  if (json) {
    log(JSON.stringify(report, null, 2));
  } else if (up) {
    log(`bus up   · ${host}:${port}${pid ? ` · pid ${pid}${pidIsAlive ? '' : ' (marker pid not alive)'}` : ''}`);
  } else {
    const why = portOk && !handshakeOk ? ' (port open but no HELLO — stale?)' : '';
    log(`bus down · ${host}:${port}${why}`);
  }

  // Exit 0 when up, 3 when down — lets scripts gate on `agix bus status`.
  return { exit: up ? 0 : 3, up, host, port, pid, json: report };
}
