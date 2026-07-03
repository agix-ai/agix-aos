// bus-e2e — the live end-to-end coordination measurement (PHASE_BUS_RUNTIME_1 T.4).
//
// The SAME work (N agent smoke-runs) done two ways:
//   FRESH  — N subprocess `agix agent smoke <agent>` spawns (Claude-fan-out analog: each
//            re-pays the full process + runtime + agent load).
//   WARM   — one `agix agent serve <agent>` worker (load paid ONCE), then N dispatches over
//            the real lewis-aos-bus.
// Reports per-task + total wall-clock and the process count. Model-free → the delta is the
// pure coordination/setup overhead the bus removes (the AOS analog of the 75K-token tax).
//
//   node bench/bus-e2e/measure.mjs [agent=context-warden] [N=5]

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDaemon, fanout } from '../../lib/agix-fanout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const AGIX = resolve(REPO_ROOT, 'bin/agix');
const AGENT = process.argv[2] || 'context-warden';
const N = Number(process.argv[3] || 5);
const SOCK = '/tmp/agix-bus-e2e.sock';
const mean = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);

function spawnSmoke() {
  return new Promise((res) => {
    const t0 = Date.now();
    spawn('node', [AGIX, 'agent', 'smoke', AGENT], { stdio: 'ignore' }).on('exit', () => res(Date.now() - t0));
  });
}

async function main() {
  await ensureDaemon(SOCK);
  console.error(`bus-e2e: agent=${AGENT} N=${N}\n`);

  // FRESH — N subprocess smoke spawns (sequential, per-task timed).
  const freshPer = [];
  const fT0 = Date.now();
  for (let i = 0; i < N; i++) freshPer.push(await spawnSmoke());
  const freshTotal = Date.now() - fT0;

  // WARM — one serve worker (startup paid once), then N bus dispatches of the same smoke op.
  const sT0 = Date.now();
  const worker = spawn('node', [AGIX, 'agent', 'serve', AGENT, '--socket', SOCK], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    // Require a REAL worker reply (ok:true) — the daemon error-replies immediately for an
    // unregistered target, which must NOT count as "the worker is up".
    try { const r = await fanout([{ op: 'ping' }], { worker: AGENT, socketPath: SOCK, timeoutMs: 800 }); if (r[0]?.ok === true) up = true; } catch { /* not up yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const serveStartup = Date.now() - sT0;
  if (!up) { worker.kill('SIGINT'); throw new Error(`warm worker ${AGENT} never registered — aborting (no bogus numbers)`); }

  const warmPer = [];
  const wT0 = Date.now();
  for (let i = 0; i < N; i++) { const t0 = Date.now(); await fanout([{ op: 'smoke' }], { worker: AGENT, socketPath: SOCK }); warmPer.push(Date.now() - t0); }
  const warmTotal = Date.now() - wT0;
  worker.kill('SIGINT');

  const result = {
    benchmark: 'bus-e2e-coordination', agent: AGENT, n: N,
    fresh_spawn: { processes: N, total_ms: freshTotal, per_task_ms_mean: mean(freshPer), note: 'each task re-pays Node + runtime + agent load' },
    warm_worker: { processes: 1, startup_ms: serveStartup, dispatch_total_ms: warmTotal, per_task_ms_mean: mean(warmPer), note: 'load paid once; per-task = bus round-trip + the agent work' },
    result: {
      per_task_speedup: +(mean(freshPer) / Math.max(1, mean(warmPer))).toFixed(1),
      processes_fresh: N, processes_warm: 1,
      coordination_overhead_removed_ms_per_task: mean(freshPer) - mean(warmPer),
    },
    honest_caveats: [
      'Model-free (smoke op) → isolates process/runtime SETUP overhead, the AOS analog of the per-spawn token tax; it is NOT a token measurement.',
      'Warm arm amortizes one startup over N tasks; at N=1 there is no win. The win grows with N (the fan-out case).',
      'Per-task warm includes the actual agent work (smoke run) + an ~8.6us bus hop; the dominant saved cost is the avoided per-task process+load.',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
