// probe: reasoning-headroom — Reasoning Token Ratio (RTR) across context windows.
//
// A model parameterized on MEASURED protocol overheads from the internal proving
// ground (measured baseline). RTR is the fraction of a context window
// left for actual reasoning after the protocol's session overhead is paid:
//
//   RTR = (window − sessionOverhead) / window
//
// MCP preloads the whole 31-tool catalog (5,109 tokens, the token-economics
// CATALOG figure) on EVERY call; the CLI pays only a lazy ~279-token `--help` per
// op. Over a representative session (the proving ground's reference is a 5-op
// session) the overheads accumulate to:
//
//   MCP overhead  = mcpPreloadTokens × ops  = 5,109 × 5 = 25,545 ≈ 25,600 tokens
//   CLI overhead  = cliHelpTokens    × ops  =   279 × 5 =  1,395 ≈  1,400 tokens
//
// At a 200K window that yields MCP RTR ≈ 87.2% vs CLI RTR ≈ 99.3% → +12.1pp,
// reclaiming ~24,200 reasoning tokens — the white-paper headline. (This is the
// same model + same measured inputs as the token-economics probe, viewed as
// "headroom left" rather than "tokens spent" — they reconcile by construction.)
//
// This is a MODEL derived from measured overheads, not a live measurement: the
// overheads are recorded in `meta` and the RTR formula is closed-form.

const OVERHEAD = {
  source: 'internal proving ground (measured baseline) (measured 2026-06-16)',
  mcpPreloadTokens: 5109, // full 31-tool MCP catalog schema, preloaded per call (token-economics CATALOG)
  cliHelpTokens: 279,     // CLI lazy ~279-token --help per op (token-economics CATALOG)
  ops: 5,                 // representative session size — the proving ground's reference point
  note: 'session overhead = per-op protocol cost × ops; MCP re-preloads the catalog per call, CLI pays a lazy per-op help',
};

// Windows to project across (tokens). 200K is the proving-ground reference point.
const WINDOWS = [50_000, 100_000, 200_000, 1_000_000];

const mcpOverhead = OVERHEAD.mcpPreloadTokens * OVERHEAD.ops;
const cliOverhead = OVERHEAD.cliHelpTokens * OVERHEAD.ops;
const reclaimed = mcpOverhead - cliOverhead; // reasoning tokens the CLI buys back (window-independent in absolute terms)

function rtr(window, overhead) {
  return (window - overhead) / window;
}

function pp(x) {
  return (x * 100).toFixed(1); // percent to 1 decimal
}

export default {
  name: 'reasoning-headroom',
  question: 'How much of the context window is left for actual reasoning after protocol overhead — CLI vs MCP — across context windows (Reasoning Token Ratio)?',
  reproduce: 'node bench/agix-bench.mjs reasoning-headroom',
  async run() {
    const rows = [];
    let ref = null; // the 200K reference point that reproduces the white-paper headline
    for (const w of WINDOWS) {
      const mcp = rtr(w, mcpOverhead);
      const cli = rtr(w, cliOverhead);
      const deltaPp = (cli - mcp) * 100;
      rows.push({
        metric: `${(w / 1000).toLocaleString()}K window — MCP RTR / CLI RTR / Δ`,
        value: `${pp(mcp)}% / ${pp(cli)}% / +${deltaPp.toFixed(1)}pp (+${reclaimed.toLocaleString()} reasoning tokens)`,
      });
      if (w === 200_000) ref = { mcp, cli, deltaPp };
    }

    const summary = `At a 200K window: MCP RTR ${pp(ref.mcp)}% vs CLI RTR ${pp(ref.cli)}% → +${ref.deltaPp.toFixed(1)}pp (~${reclaimed.toLocaleString()} more reasoning tokens reclaimed). Δpp narrows as windows grow (the fixed session overhead amortizes), but the absolute tokens reclaimed stay constant.`;

    return {
      summary,
      rows,
      meta: {
        ...OVERHEAD,
        windows: WINDOWS,
        sessionOverheadMcp: mcpOverhead,
        sessionOverheadCli: cliOverhead,
        reasoningTokensReclaimed: reclaimed,
        model: 'RTR = (window − perOp×ops) / window; ΔRTR = RTR_cli − RTR_mcp; reclaimed = (mcpPreload − cliHelp) × ops',
        kind: 'model-derived (closed-form from measured overheads, not a live measurement)',
        provingGroundCheck: '200K: MCP ~87.2% / CLI ~99.3% / +12.1pp / ~24,200 tokens',
      },
    };
  },
};
