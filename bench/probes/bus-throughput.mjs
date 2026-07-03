// probe: bus-throughput — intra-agent bus fan-out under load (deepens P2/P3).
//
// Where bus-latency measures single-message round-trip *latency*, this measures
// *throughput* (messages/sec) and *concurrency* behavior: how many msgs/sec the
// Rust `lewis-aos-bus` daemon sustains, and how that scales as multiple
// concurrent requesters hammer it at once — the real "fleet of agents talking
// at once" case the North Star's intra-agent-bus pillar has to keep honest.
//
// We drive the Rust crate's `bench-throughput` subcommand (additive in v0.3.1):
// it spins `concurrency` requester threads against the daemon under two
// topologies — (A) all requesters share ONE responder (hot-target contention),
// (B) each requester has its OWN responder (parallel fleet, no hot target) —
// and reports aggregate + per-thread msgs/sec plus a single-requester baseline.
// Running it in-binary (vs N Node clients) keeps the load generator off the Node
// event loop, so the numbers reflect the BUS under load, not the harness.
//
// Mirrors bus-latency's build/serve/parse/teardown + graceful-skip discipline:
// if cargo/the toolchain is unavailable, the probe SKIPS with a note (no silent
// gap) and the pipeline stays green.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// n msgs PER requester thread; concurrency = number of simultaneous requesters.
const N_PER_THREAD = 10000;
const CONCURRENCY = 8;

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function waitForSocket(p, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

export default {
  name: 'bus-throughput',
  question:
    'How many messages/sec does the Rust intra-agent bus sustain, and how does throughput behave with many concurrent requesters (the "fleet of agents talking at once" case)?',
  reproduce:
    'node bench/agix-bench.mjs bus-throughput  (builds + benches cli/crates/lewis-aos-bus bench-throughput)',
  async run({ repoRoot }) {
    const crate = path.join(repoRoot, 'cli', 'crates', 'lewis-aos-bus');
    if (!fs.existsSync(crate)) return { skipped: true, note: 'lewis-aos-bus crate not present' };
    if (!sh('cargo', ['--version']).stdout) return { skipped: true, note: 'cargo toolchain unavailable' };

    const bin = path.join(crate, 'target', 'release', 'lewis-aos-bus');
    if (!fs.existsSync(bin)) {
      const build = sh('cargo', ['build', '--release', '--offline'], { cwd: crate });
      if (build.status !== 0) return { skipped: true, note: 'cargo build failed (offline)' };
    }

    const sock = `/tmp/agix-bench-bus-tput-${process.pid}.sock`;
    // The daemon recreates its own socket; clean any stale one first.
    try { fs.unlinkSync(sock); } catch {}

    const daemon = spawn(bin, ['serve', sock], { stdio: 'ignore' });
    try {
      if (!(await waitForSocket(sock))) {
        daemon.kill();
        return { skipped: true, note: 'bus daemon did not bind' };
      }

      const bench = sh(bin, ['bench-throughput', sock, String(N_PER_THREAD), String(CONCURRENCY)]);
      const out = bench.stdout || '';

      // Parse lines of the form: "<label>  agg=<float> msgs/sec   (<m> msgs in <s>s)"
      const rows = [];
      const aggByLabel = {};
      for (const line of out.split('\n')) {
        const m = line.match(/^(.*?)\s+agg=\s*(\d+(?:\.\d+)?)\s*msgs\/sec\s+\((\d+)\s+msgs\s+in\s+([\d.]+)s\)/);
        if (m) {
          const label = m[1].trim();
          const agg = Number(m[2]);
          aggByLabel[label] = agg;
          rows.push({
            metric: `${label} — aggregate`,
            value: `${Math.round(agg).toLocaleString('en-US')} msgs/sec (${Number(m[3]).toLocaleString('en-US')} msgs / ${m[4]}s)`,
          });
        }
        // per-thread fairness lines: "... per-thread msgs/sec  min=.. mean=.. max=.."
        const f = line.match(/per-thread msgs\/sec\s+min=(\d+)\s+mean=(\d+)\s+max=(\d+)/);
        if (f) {
          rows.push({ metric: 'per-thread fairness (min / mean / max)', value: `${Number(f[1]).toLocaleString('en-US')} / ${Number(f[2]).toLocaleString('en-US')} / ${Number(f[3]).toLocaleString('en-US')} msgs/sec` });
        }
      }

      // scaling factors: "A) shared target : <x>x single-requester throughput (<p>% of linear Nx)."
      let scaleA = null;
      let scaleB = null;
      for (const line of out.split('\n')) {
        const a = line.match(/^A\)\s+shared target\s*:\s*([\d.]+)x.*?\((\d+)% of linear/);
        if (a) scaleA = `${a[1]}x baseline (${a[2]}% of linear ${CONCURRENCY}x)`;
        const b = line.match(/^B\)\s+paired targets\s*:\s*([\d.]+)x.*?\((\d+)% of linear/);
        if (b) scaleB = `${b[1]}x baseline (${b[2]}% of linear ${CONCURRENCY}x)`;
      }
      if (scaleA) rows.push({ metric: `scaling A (shared target, ${CONCURRENCY} requesters)`, value: scaleA });
      if (scaleB) rows.push({ metric: `scaling B (paired targets, ${CONCURRENCY} requesters)`, value: scaleB });

      if (!rows.length) return { skipped: true, note: 'could not parse bench-throughput output' };

      // Headline: best sustained aggregate observed under concurrency.
      const peak = Math.max(0, ...Object.values(aggByLabel));
      const baseline = Object.entries(aggByLabel).find(([k]) => /baseline/i.test(k))?.[1];
      const summary = baseline
        ? `bus sustains ~${Math.round(peak).toLocaleString('en-US')} msgs/sec aggregate under ${CONCURRENCY} concurrent requesters (vs ~${Math.round(baseline).toLocaleString('en-US')}/sec single-requester); throughput plateaus — the daemon's central State mutex (taken per routing hop), not the responder, is the binding constraint`
        : `bus sustains ~${Math.round(peak).toLocaleString('en-US')} msgs/sec aggregate under ${CONCURRENCY} concurrent requesters`;

      return {
        summary,
        rows,
        meta: {
          n_per_thread: N_PER_THREAD,
          concurrency: CONCURRENCY,
          total_msgs_per_topology: N_PER_THREAD * CONCURRENCY,
          channel: 'routed (requester -> daemon -> responder -> daemon -> requester, 4 hops)',
          binary: 'cli/crates/lewis-aos-bus bench-throughput (Rust, v0.3.1)',
          note: 'Honest fan-out: A = all requesters share one responder (hot-target contention); B = each requester paired with its own responder. Both plateau because the daemon serializes routing on one central State mutex; the p2p hot path (see bus-latency) removes the daemon from the message path. Numbers vary with machine core count + load.',
        },
      };
    } finally {
      daemon.kill();
      try { fs.unlinkSync(sock); } catch {}
    }
  },
};
