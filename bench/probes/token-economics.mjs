// probe: token-economics — CLI (lazy --help) vs MCP (static schema preload).
//
// A model parameterized on MEASURED inputs from the internal proving ground
// (31-tool federation: 5,109 schema tokens preloaded per call; ~270 tokens per
// `--help`). Swap CATALOG for your own catalog to re-run on a different surface —
// that reusability is the point (the proof engine, not a one-off number).
//
// Model:
//   MCP cost(ops)  = schemaTokensTotal * ops      (full catalog preloaded every call)
//   CLI cost(ops)  = cliHelpTokens   * distinct   (help paid once per distinct subcommand)
// Reproduces the proving ground's headline: 94.5% reduction / 18.3× at 5 ops.

const CATALOG = {
  source: 'internal baseline (measured 2026-06-16)',
  tools: 31,
  schemaTokensTotal: 5109, // tokens to preload the whole catalog, paid every MCP call
  cliHelpTokens: 279,      // measured avg per `--help` (5-op total was 1,394 → ~279/help)
};

function scenario(ops, distinct = ops) {
  const mcp = CATALOG.schemaTokensTotal * ops;
  const cli = CATALOG.cliHelpTokens * distinct;
  return {
    ops,
    mcp,
    cli,
    reductionPct: (1 - cli / mcp) * 100,
    ratio: mcp / cli,
  };
}

export default {
  name: 'token-economics',
  question: 'How much agent context does the CLI protocol save vs MCP static schema preload?',
  reproduce: 'node bench/agix-bench.mjs token-economics',
  async run() {
    const five = scenario(5);
    const ten = scenario(10);
    // structural moat: MCP grows O(tools) per call; CLI is O(1) in tool count.
    const catalog2x = { ...scenario(5) };
    const mcp2x = CATALOG.schemaTokensTotal * 2 * 5; // doubling the catalog doubles MCP/call
    const cli2x = CATALOG.cliHelpTokens * 5;         // CLI per-op cost unchanged by catalog size
    return {
      summary: `${five.reductionPct.toFixed(1)}% fewer tokens (${five.ratio.toFixed(1)}×) at a 5-op session; advantage is insulated from catalog growth.`,
      rows: [
        { metric: '5-op session — MCP (preload ×5)', value: `${five.mcp.toLocaleString()} tokens` },
        { metric: '5-op session — CLI (--help ×5)', value: `${five.cli.toLocaleString()} tokens` },
        { metric: '5-op reduction', value: `${five.reductionPct.toFixed(1)}% (${five.ratio.toFixed(1)}×)` },
        { metric: '10-op reduction', value: `${ten.reductionPct.toFixed(1)}% (${ten.ratio.toFixed(1)}×)` },
        { metric: 'Catalog 2× (62 tools): MCP 5-op', value: `${mcp2x.toLocaleString()} tokens (doubles)` },
        { metric: 'Catalog 2× (62 tools): CLI 5-op', value: `${cli2x.toLocaleString()} tokens (unchanged)` },
        { metric: 'Structural moat', value: 'MCP cost O(tools×ops); CLI O(1) in tools — gap widens as the surface grows' },
      ],
      meta: { ...CATALOG, model: 'MCP=schemaTokensTotal×ops; CLI=cliHelpTokens×distinct' },
    };
  },
};
