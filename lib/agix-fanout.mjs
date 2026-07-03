// agix-fanout — the bus fan-out primitive (PHASE_BUS_RUNTIME_1 T.1).
//
// Coordinates multi-agent work over the real lewis-aos-bus daemon: dispatch each task to a
// registered WARM worker as a 0-token bus request, gather the replies. Auto-starts the
// daemon if absent (DL.6 / Q6=A; opt out with AGIX_BUS_NO_AUTOSTART=1). Falls back to an
// in-process handler if a worker isn't registered (DL.2 / Q2=A — the in-process path stays
// the safety net).

import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBus } from './agix-bus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const DEFAULT_SOCK = '/tmp/lewis-aos-bus.sock';

// Candidate daemon locations, in priority order. The daemon (lewis-aos-bus) is a Rust build
// artifact whose location differs between layouts:
//   • DEV tree:       <repoRoot>/cli/crates/lewis-aos-bus/target/release/lewis-aos-bus
//   • INSTALLED pack: the formula `cargo build --release`s the shipped source in place
//                     (→ same dev path under libexec) AND installs the binary to
//                     <repoRoot>/bin/lewis-aos-bus. Either resolves here.
//   • $PATH:          a system-installed `lewis-aos-bus` (e.g. `cargo install`).
// Override everything with AGIX_BUS_BIN=<path>.
function daemonCandidates() {
  const c = [];
  if (process.env.AGIX_BUS_BIN) c.push(process.env.AGIX_BUS_BIN);
  c.push(resolve(REPO_ROOT, 'cli/crates/lewis-aos-bus/target/release/lewis-aos-bus')); // dev + in-place install build
  c.push(resolve(REPO_ROOT, 'bin/lewis-aos-bus'));                                     // sibling install (libexec/bin)
  return c;
}

// First existing candidate wins; null if none (caller emits the "not built" error). The bare
// `lewis-aos-bus` on $PATH is the last-resort fallback returned only when no file candidate
// exists — spawn resolves it against $PATH at exec time.
export function resolveDaemonBin() {
  for (const cand of daemonCandidates()) {
    if (cand && existsSync(cand)) return cand;
  }
  return null;
}

// Back-compat export: the first file candidate (the canonical dev path). Prefer
// resolveDaemonBin() for layout-robust resolution.
export const DAEMON_BIN = resolve(REPO_ROOT, 'cli/crates/lewis-aos-bus/target/release/lewis-aos-bus');

export function socketAlive(socketPath) {
  return new Promise((res) => {
    const c = net.createConnection({ path: socketPath });
    c.on('connect', () => { c.end(); res(true); });
    c.on('error', () => res(false));
  });
}

export async function ensureDaemon(socketPath = DEFAULT_SOCK) {
  if (await socketAlive(socketPath)) return { started: false, socketPath };
  if (process.env.AGIX_BUS_NO_AUTOSTART === '1') throw new Error(`bus daemon not running at ${socketPath} (AGIX_BUS_NO_AUTOSTART=1)`);
  // Resolve across dev + installed layouts; fall back to `lewis-aos-bus` on $PATH if no file
  // candidate exists (spawn resolves bare names against $PATH at exec). Only error when NOTHING
  // is found AND no PATH fallback would plausibly work.
  const bin = resolveDaemonBin() || 'lewis-aos-bus';
  const isPathFallback = bin === 'lewis-aos-bus' && resolveDaemonBin() === null;
  let proc;
  try {
    proc = spawn(bin, ['serve', socketPath], { detached: true, stdio: 'ignore' });
  } catch (e) {
    throw new Error(daemonNotBuiltMsg(isPathFallback));
  }
  // If a bare-name $PATH spawn fails (ENOENT), surface the clear "not built" guidance.
  let spawnErr = null;
  proc.on('error', (e) => { spawnErr = e; });
  proc.unref();
  for (let i = 0; i < 60; i++) {
    if (spawnErr) throw new Error(daemonNotBuiltMsg(isPathFallback));
    if (await socketAlive(socketPath)) return { started: true, pid: proc.pid, socketPath, bin };
    await new Promise((r) => setTimeout(r, 50));
  }
  if (spawnErr) throw new Error(daemonNotBuiltMsg(isPathFallback));
  throw new Error(`bus daemon did not come up at ${socketPath}`);
}

function daemonNotBuiltMsg(/* isPathFallback */) {
  return `bus daemon not built: looked in ${daemonCandidates().filter(Boolean).join(', ')}, and 'lewis-aos-bus' on $PATH. ` +
    `Build it (cargo build --release in cli/crates/lewis-aos-bus), set AGIX_BUS_BIN=<path>, or reinstall the pack.`;
}

// Dispatch `tasks` to a warm `worker` over the bus; gather replies (order-preserving).
// `inProcess(task)` (optional) handles a task locally if the bus request fails (no worker).
export async function fanout(tasks, { worker, socketPath = DEFAULT_SOCK, timeoutMs = 15000, inProcess = null } = {}) {
  if (!worker) throw new Error('fanout requires { worker }');
  await ensureDaemon(socketPath);
  const bus = createBus({ socketPath, agent: `orchestrator-${process.pid}`, trust: 'executor' });
  await bus.ready;
  try {
    return await Promise.all(tasks.map((t) => bus.request(worker, t, { timeoutMs }).catch((e) => {
      if (inProcess) return inProcess(t, e);
      throw e;
    })));
  } finally { bus.close(); }
}
