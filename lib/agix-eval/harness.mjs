// agix-eval/harness — Dataset → Solver → Scorer → Report core.
//
// Mirrors the Inspect AI primitive set (Task/Solver/Scorer) in the
// repo's dependency-free, node-native idiom — the same mould as
// scripts/stv-eval.mjs. A SUITE is a plain object describing how to
// evaluate one agent surface:
//
//   {
//     name, agent, archetype, description,
//     thresholds,                       // pre-registered acceptance bars
//     async loadCases(),                // → Case[]
//     async solve(case, ctx),           // → output (agent's REAL path)
//     async score(case, output, ctx),   // → { score, passed, ...extra }
//     aggregate(perCase, ctx),          // → { metrics, gates }
//   }
//
// `ctx` = { live, model, repoRoot, suite }. In the default run `live`
// is false and `solve` injects a ReplayModel so the agent's
// deterministic layer runs against recorded model outputs — fully
// reproducible, no API key, safe on every PR. With `--live` and a real
// model, the same suite exercises the model too and may add LLM-judge
// scorers.
//
// Pre-registration: thresholds and gate logic live in the suite and
// must be fixed BEFORE seeing results (eval-driven development).

/**
 * Run one suite. Returns a structured result; never throws on a case
 * failure (a thrown case is captured as score 0 with the error).
 */
export async function runSuite(suite, { live = false, model = null, repoRoot } = {}) {
  const ctx = { live, model, repoRoot, suite };
  const cases = await suite.loadCases(ctx);
  const perCase = [];
  for (const c of cases) {
    let rec;
    try {
      const output = await suite.solve(c, ctx);
      const scored = await suite.score(c, output, ctx);
      rec = { id: c.id, label: c.label || c.id, output, error: null, ...scored };
    } catch (err) {
      rec = {
        id: c.id,
        label: c.label || c.id,
        output: null,
        error: String(err && err.message ? err.message : err),
        score: 0,
        passed: false,
      };
    }
    perCase.push(rec);
  }
  const { metrics, gates } = await suite.aggregate(perCase, ctx);
  const allGatesPassed = Object.values(gates).every((g) => g.passed);
  return {
    name: suite.name,
    agent: suite.agent,
    archetype: suite.archetype,
    description: suite.description,
    mode: live ? 'live' : 'replay',
    n: perCase.length,
    thresholds: suite.thresholds,
    perCase,
    metrics,
    gates,
    allGatesPassed,
  };
}

/** Run a list of suites and collect a fleet-level roll-up. */
export async function runSuites(suites, opts = {}) {
  const results = [];
  for (const suite of suites) results.push(await runSuite(suite, opts));
  return {
    mode: opts.live ? 'live' : 'replay',
    suites: results,
    suitesPassed: results.filter((r) => r.allGatesPassed).length,
    suitesTotal: results.length,
    allPassed: results.every((r) => r.allGatesPassed),
  };
}

/**
 * Helper for suites: declare a pre-registered gate from a metric value
 * and a comparator. Keeps gate definitions terse and uniform.
 */
export function gate(label, value, op, bar) {
  const ops = {
    '>=': (a, b) => a >= b,
    '>': (a, b) => a > b,
    '<=': (a, b) => a <= b,
    '<': (a, b) => a < b,
    '==': (a, b) => a === b,
  };
  const passed = ops[op](value, bar);
  return { label, value, op, bar, passed };
}
