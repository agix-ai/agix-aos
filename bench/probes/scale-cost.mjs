// probe: scale-cost — annual cost savings of the CLI protocol by fleet size.
//
// A model parameterized on MEASURED inputs from the internal proving ground
// (measured baseline). Per call, MCP re-preloads the 31-tool catalog
// (5,109 tokens) that the CLI replaces with a lazy ~279-token `--help` — a net
// 4,830 tokens the CLL avoids EVERY call. Priced at Sonnet 4.6's blended
// ~$6.60/MTok over a year at 50 calls/agent/day, that net reduction is the
// annual savings:
//
//   callsPerYear     = agents × callsPerAgentPerDay × daysPerYear
//   netTokensSaved   = callsPerYear × (mcpPreloadTokens − cliHelpTokens)
//   annualSavingsUSD  = netTokensSaved / 1e6 × blendedUsdPerMTok
//
// Reproduces the white-paper curve: ~$12,217/yr at 21 agents → ~$122,172 at 210
// → ~$1,221,724 at 2,100 (linear in fleet size), held at a constant 18.3× ROI
// (the token-economics headline ratio). 21 agents check: 21 × 50 × 365 = 383,250
// calls × 4,830 net tokens = 1,851,097,500 tokens = 1,851.10 MTok × $6.60 = $12,217.
//
// This is a MODEL: every dollar figure is an ESTIMATE; all params live in `meta`.

const PARAMS = {
  source: 'internal proving ground (measured baseline) (measured 2026-06-16)',
  mcpPreloadTokens: 5109,        // MCP catalog preload avoided per call (token-economics CATALOG)
  cliHelpTokens: 279,            // CLI lazy --help paid per op instead (token-economics CATALOG)
  callsPerAgentPerDay: 50,       // white-paper assumption
  daysPerYear: 365,
  blendedUsdPerMTok: 6.60,       // Sonnet 4.6 blended input/output rate
  roi: 18.3,                     // constant ROI multiple (token-economics 5-op headline ratio)
  note: 'savings = net tokens avoided per call (mcpPreload − cliHelp) × calls/yr × blended $/MTok; ESTIMATE',
};

const FLEET_SIZES = [21, 210, 2100];
const netTokensPerCall = PARAMS.mcpPreloadTokens - PARAMS.cliHelpTokens; // 4,830

function annualSavingsUsd(agents) {
  const callsPerYear = agents * PARAMS.callsPerAgentPerDay * PARAMS.daysPerYear;
  const netTokens = callsPerYear * netTokensPerCall;
  return (netTokens / 1e6) * PARAMS.blendedUsdPerMTok;
}

function usd(n) {
  return '$' + Math.round(n).toLocaleString();
}

export default {
  name: 'scale-cost',
  question: 'How much does the CLI protocol save per year as the agent fleet grows — and at what ROI?',
  reproduce: 'node bench/agix-bench.mjs scale-cost',
  async run() {
    const rows = [];
    let ref = null; // 21-agent reference point that reproduces the white-paper headline
    for (const agents of FLEET_SIZES) {
      const savings = annualSavingsUsd(agents);
      rows.push({
        metric: `${agents.toLocaleString()} agents — est. annual savings (ROI ${PARAMS.roi}×)`,
        value: `${usd(savings)}/yr (ESTIMATE)`,
      });
      if (agents === 21) ref = savings;
    }

    return {
      summary: `Est. ${usd(ref)}/yr saved at a 21-agent fleet (avoiding ${netTokensPerCall.toLocaleString()} MCP tokens/call), scaling linearly to ${usd(annualSavingsUsd(2100))}/yr at 2,100 agents — held at a constant ${PARAMS.roi}× ROI. All figures ESTIMATES.`,
      rows: [
        { metric: 'Net tokens avoided per call', value: `${netTokensPerCall.toLocaleString()} (MCP ${PARAMS.mcpPreloadTokens.toLocaleString()} − CLI ${PARAMS.cliHelpTokens})` },
        ...rows,
        { metric: 'Scaling shape', value: 'linear in fleet size — per-agent savings is fixed; total grows with headcount' },
      ],
      meta: {
        ...PARAMS,
        fleetSizes: FLEET_SIZES,
        netTokensPerCall,
        model: 'annualSavingsUSD = agents × callsPerAgentPerDay × daysPerYear × (mcpPreload − cliHelp) / 1e6 × blendedUsdPerMTok',
        kind: 'model-derived ESTIMATE (not billed actuals)',
        provingGroundCheck: '~$12,217/yr @ 21 → ~$122,172 @ 210 → ~$1,221,724 @ 2,100; 18.3× ROI',
      },
    };
  },
};
