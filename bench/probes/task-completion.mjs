// probe: task-completion — CLI task completion vs an MCP baseline.
//
// The white paper's reasoning-headroom thesis (see reasoning-headroom probe)
// predicts that the context an agent reclaims from protocol overhead shows up as
// higher task-completion. This probe tracks that claim — HONESTLY labeled, because
// the two figures it compares are NOT the same kind of evidence:
//
//   • MCP baseline 72% — an EXTERNAL CITATION (Steinberger et al.; an
//     industry-reported MCP-only agent task-completion figure). It is NOT a
//     internal-baseline measurement.
//   • CLI 100% — a PROXY: the CLI contract test-suite passes 100%. This is
//     a contract-coverage proxy for task completion, NOT a live agent benchmark.
//     Presenting it as a live agent measurement would overstate it — so we don't.
//
// The honesty IS the point (North Star P2): the report carries the +28pp delta but
// flags exactly what each number is. A reader who wants a fair comparison knows to
// discount the proxy until a live A/B agent run replaces it.
//
// This is a MODEL/tracking probe, not a live measurement; sources are in `meta`.

const COMPLETION = {
  mcpBaselinePct: 72, // external citation — MCP-only agent task completion
  mcpBaselineKind: 'CITATION',
  mcpBaselineSource: 'Steinberger et al. (industry-reported MCP-only agent task completion)',
  cliPct: 100, // proxy — CLI contract test-suite pass rate stands in for task completion
  cliKind: 'PROXY',
  cliSource: 'CLI contract test-suite pass rate (proxy for task completion, NOT a live agent A/B)',
  note: 'CITATION vs PROXY are different evidence classes — do NOT read the proxy as a live agent measurement',
};

export default {
  name: 'task-completion',
  question: 'Does the CLI protocol complete more agent tasks than an MCP baseline — and what kind of evidence is each number?',
  reproduce: 'node bench/agix-bench.mjs task-completion',
  async run() {
    const deltaPp = COMPLETION.cliPct - COMPLETION.mcpBaselinePct;
    return {
      summary: `CLI ${COMPLETION.cliPct}% (PROXY: contract-suite) vs MCP ${COMPLETION.mcpBaselinePct}% (CITATION: external) → +${deltaPp}pp. The proxy is NOT a live agent A/B — flagged so the gain isn't overstated.`,
      rows: [
        { metric: `MCP-only task completion (${COMPLETION.mcpBaselineKind})`, value: `${COMPLETION.mcpBaselinePct}% — ${COMPLETION.mcpBaselineSource}` },
        { metric: `CLI task completion (${COMPLETION.cliKind})`, value: `${COMPLETION.cliPct}% — ${COMPLETION.cliSource}` },
        { metric: 'Delta', value: `+${deltaPp}pp (CLI over MCP)` },
        { metric: 'Evidence honesty', value: 'CITATION vs PROXY — different evidence classes; replace proxy with a live agent A/B to harden' },
      ],
      meta: {
        ...COMPLETION,
        model: 'tracking probe — pairs an external citation with an internal proxy and labels each',
        kind: 'mixed-evidence (citation + proxy), NOT a live agent measurement',
        provingGroundCheck: 'MCP 72% / CLI 100% / +28pp',
      },
    };
  },
};
