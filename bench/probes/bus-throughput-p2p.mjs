// probe: bus-throughput-p2p — DIRECT p2p-binary throughput (closes the measurement gap).
//
// The routed `bus-throughput` probe only ever measured the ROUTED path
// (requester -> daemon -> responder -> daemon -> requester, 4 hops, central
// mutex, newline-JSON) → it plateaus near ~10K msgs/sec. But the bus's headline
// LATENCY (~7–9µs, bus-latency's p2p-binary channel) comes from the DIRECT p2p
// path — daemon brokers the intro once, then A<->B talk direct, daemon OUT of the
// message path. That path's THROUGHPUT was never measured. This probe measures it.
//
// It drives the Rust crate's `bench-throughput-p2p` subcommand (additive): each
// requester does the daemon-brokered intro once, then hammers length-prefixed
// binary frames over a DIRECT socket to its own dedicated responder (p2p is
// point-to-point, so the topology is N independent requester<->responder pairs).
// Same N / payload / barrier-gated measurement as bus-throughput EXCEPT the path.
// Running it in-binary keeps the load generator off the Node event loop.
//
// Mirrors bus-throughput's build/serve/parse/teardown + graceful-skip discipline:
// if cargo/the toolchain is unavailable, the probe SKIPS with a note (no silent
// gap) and the pipeline stays green.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// n msgs PER requester thread; concurrency = number of simultaneous requester<->responder pairs.
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
  name: 'bus-throughput-p2p',
  question:
    'How many messages/sec does the bus sustain on the DIRECT p2p-binary path (daemon out of the message path) — the path the headline ~7–9µs latency comes from, which the routed throughput bench never measured?',
  reproduce:
    'node bench/agix-bench.mjs bus-throughput-p2p  (builds + benches cli/crates/lewis-aos-bus bench-throughput-p2p)',
  async run({ repoRoot }) {
    const crate = path.join(repoRoot, 'cli', 'crates', 'lewis-aos-bus');
    if (!fs.existsSync(crate)) return { skipped: true, note: 'lewis-aos-bus crate not present' };
    if (!sh('cargo', ['--version']).stdout) return { skipped: true, note: 'cargo toolchain unavailable' };

    const bin = path.join(crate, 'target', 'release', 'lewis-aos-bus');
    if (!fs.existsSync(bin)) {
      const build = sh('cargo', ['build', '--release', '--offline'], { cwd: crate });
      if (build.status !== 0) return { skipped: true, note: 'cargo build failed (offline)' };
    }

    const sock = `/tmp/agix-bench-bus-tput-p2p-${process.pid}.sock`;
    // The daemon recreates its own socket; the bench cleans its per-pair sockets.
    try { fs.unlinkSync(sock); } catch {}

    const daemon = spawn(bin, ['serve', sock], { stdio: 'ignore' });
    try {
      if (!(await waitForSocket(sock))) {
        daemon.kill();
        return { skipped: true, note: 'bus daemon did not bind' };
      }

      const bench = sh(bin, ['bench-throughput-p2p', sock, String(N_PER_THREAD), String(CONCURRENCY)]);
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

      // scaling factor: "paired direct pairs: <x>x single-requester throughput (<p>% of linear Nx)."
      let scale = null;
      for (const line of out.split('\n')) {
        const s = line.match(/^paired direct pairs\s*:\s*([\d.]+)x.*?\((\d+)% of linear/);
        if (s) scale = `${s[1]}x baseline (${s[2]}% of linear ${CONCURRENCY}x)`;
      }
      if (scale) rows.push({ metric: `scaling (paired direct pairs, ${CONCURRENCY} requesters)`, value: scale });

      if (!rows.length) return { skipped: true, note: 'could not parse bench-throughput-p2p output' };

      // Headline: best sustained aggregate observed, anchored against the single-requester baseline.
      const peak = Math.max(0, ...Object.values(aggByLabel));
      const baseline = Object.entries(aggByLabel).find(([k]) => /baseline/i.test(k))?.[1];
      const summary = baseline
        ? `direct p2p-binary path sustains ~${Math.round(peak).toLocaleString('en-US')} msgs/sec aggregate under ${CONCURRENCY} concurrent pairs (~${Math.round(baseline).toLocaleString('en-US')}/sec single-requester) — ~${(peak / 10076).toFixed(0)}× the routed path's ~10K/sec aggregate, because the daemon is OUT of the message path (no central State mutex on the hot loop)`
        : `direct p2p-binary path sustains ~${Math.round(peak).toLocaleString('en-US')} msgs/sec aggregate under ${CONCURRENCY} concurrent pairs`;

      return {
        summary,
        rows,
        meta: {
          n_per_thread: N_PER_THREAD,
          concurrency: CONCURRENCY,
          total_msgs: N_PER_THREAD * CONCURRENCY,
          channel: 'p2p-binary (daemon brokers intro once per pair, then direct A->B->A, 2 hops; daemon OUT of message path; length-prefixed binary framing)',
          binary: 'cli/crates/lewis-aos-bus bench-throughput-p2p (Rust, v0.3.2)',
          note: 'Closes the gap the bus-throughput-investigation-2026-06-19 named: routed throughput (~10K/sec, bus-throughput probe) was the only throughput measured, but the headline ~7-9µs latency comes from this direct p2p-binary path. p2p is point-to-point, so the topology is N independent requester<->responder pairs (no shared-responder/hot-target shape — that contention is exactly what p2p removes). Synchronous req->rep (no pipelining), so each pair is still 1/latency-capped per-thread; the win over routed is that the per-pair latency is ~7µs (vs ~132µs routed) AND there is no central daemon mutex serializing the hot loop. Numbers vary with machine core count + load.',
        },
      };
    } finally {
      daemon.kill();
      try { fs.unlinkSync(sock); } catch {}
    }
  },
};
