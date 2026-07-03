# Agix research / benchmark pipeline (North Star pillar P2)

> **"Proven by our own research."** The North Star says we don't *claim* Agix is
> the best AOS — we **prove** it with reproducible benchmarks, and keep proving it
> as the field moves. This directory is that proof engine: a repeatable
> measure → report loop, not one-off numbers.

This is the credibility flywheel behind the competitive thesis (Hermes/OpenClaw
ship features with vendor-published numbers; Agix ships **reproducible** ones).
It is also the generalized form of the measure→predict→confirm loop the
intra-agent-bus spike ran four times (`cli/crates/lewis-aos-bus`, spec
`architecture/03-ai-ml/agent-architecture/RUST_INTRA_AGENT_BUS.md`).

## Run it

```bash
node bench/agix-bench.mjs                 # run every probe, write the report
node bench/agix-bench.mjs token-economics # run one probe by name
```

Output:
- `bench/results/<date>.json` — structured results (machine-readable record).
- `wiki/research/benchmarks/<date>.md` — the report (the **narrator data layer**:
  deterministically generated; a narrator routine may prepend a TL;DR + anomaly
  callouts but must never edit the numbers — per the narrator-pattern doctrine).

## Add a probe

Drop a file in `bench/probes/<name>.mjs` that default-exports:

```js
export default {
  name: 'my-probe',
  question: 'What does this measure and why does it matter?',
  reproduce: 'node bench/agix-bench.mjs my-probe',
  async run({ stats, repoRoot }) {
    // ... measure ...
    return {
      summary: 'one-line headline',
      rows: [{ metric: 'X', value: 'Y' }],   // the data table
      meta: { /* params / provenance */ },
      // or: { skipped: true, note: 'why' }  — skip gracefully; the pipeline stays green
    };
  },
};
```

`stats(samples)` (from the runner) returns `{n, mean, p50, p99, max}` for
sample-based probes.

## Probes shipped (inaugural)

| Probe | Measures | Self-contained? |
|---|---|---|
| `token-economics` | CLI (`--help`) vs MCP (schema preload) context cost; reproduces the proving ground's **94.5% / 18.3×**, parameterized so you can swap in your own catalog | yes (instant) |
| `bus-latency` | Rust intra-agent bus vs in-process vs file-ledger coordination latency; builds + benches `cli/crates/lewis-aos-bus`, **skips gracefully** without a Rust toolchain | drives the Rust spike |

## Design principles (why it's shaped this way)

- **Narrator-pattern output.** The report is a deterministic data layer; the LLM
  narrative is a separable, cheaply-re-runnable prepend that never recomputes the
  numbers. Independently verifiable, gracefully degrading.
- **No silent skips.** A probe that can't run says so in the report (toolchain
  missing, parse failed) rather than vanishing — so a green report never
  overstates coverage.
- **Reproduce-line on every probe.** Every number carries the exact command that
  regenerates it. A reader re-runs, they don't trust.
- **Honest models are labeled.** A probe that computes from measured inputs (vs
  measuring live) records its params + provenance in `meta`.

## Roadmap

Future probes worth wiring (each a North-Star claim to keep honest): reasoning-budget
headroom (RTR across context windows), task-completion vs an MCP baseline, scale/cost
projections by fleet size, and the bus **v3** constant-factor work (binary framing +
async reactor) measured against the v2 baseline this pipeline already records.
