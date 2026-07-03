// agix-stv-eval — end-to-end integration test for the G10 pipeline.
// Asserts the full self-trained-verification eval clears every
// pre-registered gate, and that the Phase 3 win holds across seeds.
// Runner: node --test test/agix-stv-eval.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runEval, runRobustness, generateSyntheticCorpus } from '../scripts/stv-eval.mjs';

test('runEval — all pre-registered gates pass on seed 42', async () => {
  const r = await runEval({ seed: 42 });
  for (const [name, passed] of Object.entries(r.gates)) {
    assert.equal(passed, true, `gate ${name} should pass`);
  }
  assert.equal(r.allGatesPassed, true);
});

test('runEval — Phase 3 gated emission beats unfiltered by the registered margin', async () => {
  const r = await runEval({ seed: 42 });
  assert.ok(r.phase3.f1Delta >= 0.05, `F1 delta ${r.phase3.f1Delta} should be >= 0.05`);
  assert.ok(r.phase3.gated.precision > r.phase3.unfiltered.precision, 'gated precision should beat unfiltered');
  assert.ok(r.phase3.maxRevisePerFinding <= 1, 'revise budget <= 1 pass/finding');
});

test('runEval — deterministic across two runs (same seed)', async () => {
  const a = await runEval({ seed: 7 });
  const b = await runEval({ seed: 7 });
  assert.equal(a.phase3.f1Delta, b.phase3.f1Delta);
  assert.equal(a.phase2.agreement, b.phase2.agreement);
});

test('runEval — Phase 1 anchors are disjoint from training', async () => {
  const r = await runEval({ seed: 42 });
  assert.equal(r.phase1.disjoint, true);
  assert.ok(r.phase1.anchor > 0);
  assert.equal(r.phase1.anchorOverrides, r.phase1.anchor); // every anchor overrode a training key here
});

test('runRobustness — win holds across multiple seeds (no cherry-pick)', async () => {
  const rob = await runRobustness([1, 2, 3, 4, 5]);
  assert.equal(rob.allSeedsPass, true);
  assert.ok(rob.minDelta >= 0.05, `worst-case F1 delta ${rob.minDelta} should clear 0.05`);
});

test('generateSyntheticCorpus — deterministic and split-clean', () => {
  const a = generateSyntheticCorpus({ seed: 3 });
  const b = generateSyntheticCorpus({ seed: 3 });
  assert.equal(JSON.stringify(a.meta), JSON.stringify(b.meta));
  assert.ok(a.fitHistory.length > 0 && a.valHistory.length > 0 && a.testHistory.length > 0);
  // Anchors are harvested only from fit-split episodes.
  const fitKeys = new Set(a.meta.filter((m) => m.split === 'fit').map((m) => m.key));
  for (const item of a.anchors) assert.ok(fitKeys.has(item.finding_key));
});
