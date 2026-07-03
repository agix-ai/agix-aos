// agix-bus-provision.mjs — start the Rust intra-agent bus daemon (North Star P3).
//
// The `runtime.getBus()` surface (lib/agix-runtime.mjs) only *connects* to the
// daemon; this helper *provisions* it — the Node-side equivalent of the CLI's
// `lewis-aos bus up`. It spawns the built `lewis-aos-bus serve <addr>` binary
// (building it with `cargo build --release --offline` if the binary is absent),
// waits until the loopback TCP port is accepting connections, and returns a
// handle with `stop()`.
//
// Transport (cross-platform): the daemon now listens on a loopback TCP port
// (127.0.0.1:<port>) rather than a Unix domain socket, so this provisions and
// probes a port — dependency-free and identical on macOS, Linux, and Windows.
//
// Modeled on the runtime's other out-of-band daemon spawns (child process +
// readiness wait), the same shape as the gbrain stdio daemon the bus seam
// mirrors (RUST_INTRA_AGENT_BUS.md §2).
//
// Usage:
//   import { busUp } from './agix-bus-provision.mjs';
//   const bus = await busUp({ port: 17645 });
//   // ... runtime.getBus() now connects ...
//   await bus.stop();

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_HOST, DEFAULT_PORT } from './agix-bus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// The Rust bus crate + its release binary (built by `cargo build --release`).
// Windows produces an `.exe`; POSIX has no extension.
export const BUS_CRATE_DIR = resolve(REPO_ROOT, 'cli/crates/lewis-aos-bus');
const BUS_BINARY_EXE = process.platform === 'win32' ? 'lewis-aos-bus.exe' : 'lewis-aos-bus';
export const BUS_BINARY = resolve(BUS_CRATE_DIR, 'target/release', BUS_BINARY_EXE);

/** Repo root the daemon is spawned from (so the CLI detach path matches busUp). */
export const BUS_REPO_ROOT = REPO_ROOT;

/**
 * Build the bus daemon if its release binary is absent.
 * Offline build — serde_json is already vendored/cached (per the crate's
 * Cargo.lock); std-only otherwise.
 * @returns {string} absolute path to the built binary
 */
export function ensureBusBinary() {
  if (existsSync(BUS_BINARY)) return BUS_BINARY;
  if (!existsSync(BUS_CRATE_DIR)) {
    throw new Error(`bus crate not found at ${BUS_CRATE_DIR}`);
  }
  const r = spawnSync('cargo', ['build', '--release', '--offline'], {
    cwd: BUS_CRATE_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) {
    throw new Error(`failed to invoke cargo to build the bus daemon: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`cargo build --release --offline failed (exit ${r.status}) in ${BUS_CRATE_DIR}`);
  }
  if (!existsSync(BUS_BINARY)) {
    throw new Error(`cargo build succeeded but no binary at ${BUS_BINARY}`);
  }
  return BUS_BINARY;
}

/** Probe the loopback TCP port: resolves true once a connection is accepted. */
function portAccepts(host, port) {
  return new Promise((res) => {
    const conn = net.createConnection({ host, port });
    const done = (ok) => { try { conn.destroy(); } catch { /* closing */ } res(ok); };
    conn.once('connect', () => done(true));
    conn.once('error', () => done(false));
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
 * Start the bus daemon and wait for its loopback TCP port to accept connections.
 * @param {{host?:string, port?:number, timeoutMs?:number}} opts
 * @returns {Promise<{host:string, port:number, pid:number, stop:()=>Promise<void>}>}
 */
export async function busUp({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 10000 } = {}) {
  const binary = ensureBusBinary();

  // The daemon binds `<host>:<port>` and panics if the port is already taken —
  // unlike a Unix socket there is no stale file to clear; a still-bound port
  // simply means another daemon is up (busUp's caller owns lifetimes).
  const child = spawn(binary, ['serve', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let exited = false;
  let exitInfo = null;
  child.once('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; });

  const ready = await waitForPort(host, port, { timeoutMs });
  if (!ready) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    const why = exited ? ` (daemon exited: code=${exitInfo?.code} signal=${exitInfo?.signal})` : '';
    throw new Error(`bus daemon ${host}:${port} did not become ready within ${timeoutMs}ms${why}`);
  }

  return {
    host,
    port,
    pid: child.pid,
    /** Stop the daemon (the loopback port releases when the process exits). */
    async stop() {
      if (!exited) {
        const stopped = new Promise((res) => child.once('exit', () => res()));
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        // Escalate if SIGTERM is ignored.
        const escalate = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        await stopped;
        clearTimeout(escalate);
      }
    },
  };
}
