// probe: bus-latency — intra-agent coordination latency across channels.
//
// Drives the Rust `lewis-aos-bus` spike (cli/crates/lewis-aos-bus): builds it if
// needed (offline), starts the daemon on a temp socket, runs its `bench`, parses
// the per-channel means, and tears down. If the toolchain/binary is unavailable,
// the probe SKIPS gracefully (the pipeline stays green) — and says so, per the
// "no silent caps" discipline.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ITERS = 20000;

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
  name: 'bus-latency',
  question: 'How does the Rust intra-agent bus compare to in-process and the file-ledger for coordination latency?',
  reproduce: 'node bench/agix-bench.mjs bus-latency  (builds + benches cli/crates/lewis-aos-bus)',
  async run({ repoRoot }) {
    const crate = path.join(repoRoot, 'cli', 'crates', 'lewis-aos-bus');
    if (!fs.existsSync(crate)) return { skipped: true, note: 'lewis-aos-bus crate not present' };
    if (!sh('cargo', ['--version']).stdout) return { skipped: true, note: 'cargo toolchain unavailable' };

    const bin = path.join(crate, 'target', 'release', 'lewis-aos-bus');
    if (!fs.existsSync(bin)) {
      const build = sh('cargo', ['build', '--release', '--offline'], { cwd: crate });
      if (build.status !== 0) return { skipped: true, note: 'cargo build failed (offline)' };
    }

    const sock = `/tmp/agix-bench-bus-${process.pid}.sock`;
    for (const f of [sock, `${sock}.echo-p2p.sock`, `${sock}.ledger`]) { try { fs.unlinkSync(f); } catch {} }

    const daemon = spawn(bin, ['serve', sock], { stdio: 'ignore' });
    try {
      if (!(await waitForSocket(sock))) { daemon.kill(); return { skipped: true, note: 'bus daemon did not bind' }; }
      const bench = sh(bin, ['bench', sock, String(ITERS)]);
      const out = bench.stdout || '';
      // parse lines like: "<label>  n=20000  mean=72.392µs  p50=... p99=... max=..."
      const rows = [];
      let summary = 'bus benchmark ran';
      // Generic: capture ANY channel label (everything before "  n="), so new
      // channels (p2p-json, p2p-binary, and future ones) are picked up without
      // editing the probe — the label is whatever the Rust bench prints.
      for (const line of out.split('\n')) {
        const m = line.match(/^(\S.*?)\s+n=\d+\s+mean=(\S+)\s+p50=(\S+)\s+p99=(\S+)\s+max=(\S+)/);
        if (m) rows.push({ metric: `${m[1].trim()} — mean / p99 / max`, value: `${m[2]} / ${m[4]} / ${m[5]}` });
      }
      const headline = out.split('\n').find((l) => /faster than|recover|binary/i.test(l));
      if (headline) summary = headline.trim();
      if (!rows.length) return { skipped: true, note: 'could not parse bench output' };
      return {
        summary,
        rows,
        meta: { iters: ITERS, binary: 'cli/crates/lewis-aos-bus (Rust spike v3)', note: 'p2p-binary = v3 length-prefixed framing, direct (2 hops); routed = 4 hops' },
      };
    } finally {
      daemon.kill();
      for (const f of [sock, `${sock}.echo-p2p.sock`, `${sock}.ledger`]) { try { fs.unlinkSync(f); } catch {} }
    }
  },
};
