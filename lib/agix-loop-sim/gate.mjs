// agix-loop-sim/gate — schema-agnostic, per-metric-contract gate
// (the ratchet-baseline / per-metric-contract gate doctrine).
//
// GUARDS: "a regression slipped through because the gate trusted a noisy
// signal" and "the baseline bar quietly loosened" (loop-sim/GATE). This gate
// reads a scorecard + a committed baseline by DOTTED PATH and evaluates each
// metric against its own contract:
//
//   { direction: 'lower-better'|'higher-better'|'exact',
//     tolerance: { kind: 'percent'|'absolute', value },
//     robust: bool,        // false => noisy CI signal: REPORTED, not gated
//     blocking: bool,      // false => reported, not gated
//     expected?: number,   // for 'exact' (absolute correctness target)
//     hardCeiling?: number // absolute cap regardless of baseline
//   }
//
// Doctrine:
//   • Correctness metrics  = direction 'exact', zero tolerance, blocking.
//   • Performance metrics  = relative to the committed baseline.
//   • Robustness split     = runner-noisy signals (tail latency) are
//     blocking:false — reported so a human sees drift, never CI-gating.
//   • Self-testing gate    = selfTest() plants one regression per contract
//     KIND and proves the gate flags it (ships in the module).
//   • Ratchet baseline     = ratchetBaseline() only ever TIGHTENS the bar.

/** Read a dotted path (e.g. "performance.costOfPassLearned") from an object. */
export function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Set a dotted path on a (mutable) object, creating intermediate objects. */
export function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  return obj;
}

/** Bar implied by a baseline + tolerance for a directional metric. */
function toleranceBar(baseline, direction, tolerance) {
  const kind = tolerance?.kind ?? 'percent';
  const value = tolerance?.value ?? 0;
  const delta = kind === 'percent' ? Math.abs(baseline) * value : value;
  if (direction === 'lower-better') return baseline + delta; // may go this much higher
  if (direction === 'higher-better') return baseline - delta; // may drop this much
  return baseline;
}

/**
 * Evaluate one metric against its contract.
 * @returns {{ path, value, baseline, bar, direction, pass, gated, blocking, robust, detail }}
 */
export function checkMetric(path, value, baselineValue, contract) {
  const robust = contract.robust !== false;
  const blocking = contract.blocking !== false;
  // A noisy (non-robust) signal is reported but never gates CI.
  const gated = blocking && robust;

  let pass;
  let bar;
  let detail = null;

  if (value === undefined || value === null || (typeof value === 'number' && Number.isNaN(value))) {
    return { path, value, baseline: baselineValue, bar: null, direction: contract.direction, pass: false, gated, blocking, robust, detail: 'missing metric value' };
  }

  if (contract.direction === 'exact') {
    const expected = contract.expected ?? baselineValue;
    pass = value === expected;
    bar = expected;
    if (!pass) detail = `expected ${expected}, got ${value}`;
  } else if (contract.direction === 'lower-better') {
    bar = toleranceBar(baselineValue, 'lower-better', contract.tolerance);
    pass = value <= bar + 1e-12;
    if (contract.hardCeiling !== undefined && value > contract.hardCeiling) {
      pass = false;
      detail = `${value} exceeds hard ceiling ${contract.hardCeiling}`;
    } else if (!pass) {
      detail = `${value} > allowed ${bar} (baseline ${baselineValue})`;
    }
  } else if (contract.direction === 'higher-better') {
    bar = toleranceBar(baselineValue, 'higher-better', contract.tolerance);
    pass = value >= bar - 1e-12;
    if (contract.hardCeiling !== undefined && value > contract.hardCeiling) {
      pass = false;
      detail = `${value} exceeds hard ceiling ${contract.hardCeiling}`;
    } else if (!pass) {
      detail = `${value} < required ${bar} (baseline ${baselineValue})`;
    }
  } else {
    return { path, value, baseline: baselineValue, bar: null, direction: contract.direction, pass: false, gated, blocking, robust, detail: `unknown direction "${contract.direction}"` };
  }

  return { path, value, baseline: baselineValue, bar, direction: contract.direction, pass, gated, blocking, robust, detail };
}

/**
 * Run the gate over a scorecard.
 * @param {object} scorecard
 * @param {object} baseline
 * @param {Object<string, object>} contracts  dotted-path -> contract.
 * @returns {{ results, allBlockingPassed, blockingFailures, reportedOnly }}
 */
export function runGate(scorecard, baseline, contracts) {
  const results = [];
  for (const [path, contract] of Object.entries(contracts)) {
    const value = getPath(scorecard, path);
    const baselineValue = contract.direction === 'exact' ? (contract.expected ?? getPath(baseline, path)) : getPath(baseline, path);
    results.push(checkMetric(path, value, baselineValue, contract));
  }
  const blockingFailures = results.filter((r) => r.gated && !r.pass);
  const reportedOnly = results.filter((r) => !r.gated);
  return {
    results,
    allBlockingPassed: blockingFailures.length === 0,
    blockingFailures,
    reportedOnly,
  };
}

/**
 * Ratchet a baseline: performance metrics move ONLY toward tighter bars
 * (lower for lower-better, higher for higher-better). Exact/correctness
 * metrics are absolute and are copied as-is. Never loosens a bar.
 *
 * @returns {object} a NEW baseline object.
 */
export function ratchetBaseline(baseline, scorecard, contracts) {
  const next = JSON.parse(JSON.stringify(baseline ?? {}));
  for (const [path, contract] of Object.entries(contracts)) {
    const observed = getPath(scorecard, path);
    if (observed === undefined || observed === null || Number.isNaN(observed)) continue;
    const current = getPath(next, path);
    if (contract.direction === 'exact') {
      if (current === undefined) setPath(next, path, observed);
      continue;
    }
    if (current === undefined) {
      setPath(next, path, observed);
      continue;
    }
    if (contract.direction === 'lower-better') {
      if (observed < current) setPath(next, path, observed);
    } else if (contract.direction === 'higher-better') {
      if (observed > current) setPath(next, path, observed);
    }
  }
  return next;
}

/**
 * Self-test: prove the gate flags a planted regression for EACH contract
 * kind. Deterministic, no I/O. Returns { passed, cases }.
 *
 * This is the self-testing-gate doctrine made executable — a gate that
 * cannot demonstrate it fails is not trustworthy.
 */
export function selfTest() {
  const cases = [];
  const record = (name, shouldFail, gateResult) => {
    const flagged = !gateResult.allBlockingPassed;
    cases.push({ name, expectedFail: shouldFail, flagged, ok: shouldFail === flagged });
  };

  // exact correctness — a nonzero violation count must fail.
  record(
    'exact: violation count > 0 fails',
    true,
    runGate({ c: { v: 1 } }, {}, { 'c.v': { direction: 'exact', expected: 0, blocking: true, robust: true } }),
  );
  record(
    'exact: violation count == 0 passes',
    false,
    runGate({ c: { v: 0 } }, {}, { 'c.v': { direction: 'exact', expected: 0, blocking: true, robust: true } }),
  );

  // lower-better performance — a cost above baseline+tol must fail.
  const perfContract = { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 }, blocking: true, robust: true };
  record(
    'lower-better: cost regressed beyond tolerance fails',
    true,
    runGate({ p: { cost: 1.2 } }, { p: { cost: 1.0 } }, { 'p.cost': perfContract }),
  );
  record(
    'lower-better: cost within tolerance passes',
    false,
    runGate({ p: { cost: 1.03 } }, { p: { cost: 1.0 } }, { 'p.cost': perfContract }),
  );

  // higher-better performance — savings dropping below baseline-tol fails.
  const savingsContract = { direction: 'higher-better', tolerance: { kind: 'absolute', value: 0.02 }, blocking: true, robust: true };
  record(
    'higher-better: savings collapsed fails',
    true,
    runGate({ p: { delta: 0.1 } }, { p: { delta: 0.3 } }, { 'p.delta': savingsContract }),
  );

  // hard ceiling — absolute cap trips regardless of baseline.
  record(
    'hard ceiling: absolute cap trips',
    true,
    runGate({ p: { lat: 9999 } }, { p: { lat: 100 } }, { 'p.lat': { direction: 'lower-better', tolerance: { kind: 'percent', value: 5 }, hardCeiling: 5000, blocking: true, robust: true } }),
  );

  // robustness split — a NON-robust metric regressing is reported, NOT gated.
  record(
    'non-robust signal regressing does NOT gate',
    false,
    runGate({ p: { tail: 5000 } }, { p: { tail: 100 } }, { 'p.tail': { direction: 'lower-better', tolerance: { kind: 'percent', value: 0.05 }, blocking: true, robust: false } }),
  );

  const passed = cases.every((c) => c.ok);
  return { passed, cases };
}
