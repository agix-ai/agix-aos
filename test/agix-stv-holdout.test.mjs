// agix-stv-holdout — proves the shared held-out generalization lib is the
// single source of truth: the eval harness and the offline trainer both
// produce the same model-free Phase-3 numbers from it.
// Runner: node --test test/agix-stv-holdout.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSyntheticCorpus, runEval } from '../scripts/stv-eval.mjs';
import { computeHoldoutGeneralization } from '../lib/agix-stv-holdout.mjs';
import { trainVerifier, DEFAULT_THRESHOLDS } from '../lib/agix-stv-verifier.mjs';
import { buildLabeledCorpus, harvestDeployHealthAnchors } from '../lib/agix-stv-labeler.mjs';
import { main } from '../services/stv-trainer/train.mjs';

test('computeHoldoutGeneralization matches runEval phase3 on the seed-42 pipeline', async () => {
  // Rebuild the seed-42 pipeline exactly as runEval does.
  const { fitHistory, valHistory, testHistory, anchors } = generateSyntheticCorpus({ seed: 42 });
  const anchorLabels = harvestDeployHealthAnchors(anchors);
  const corpus = buildLabeledCorpus(fitHistory, { anchors: anchorLabels });
  const v0 = trainVerifier(corpus, fitHistory, { version: 'V_0', thresholds: DEFAULT_THRESHOLDS });

  const holdout = computeHoldoutGeneralization(v0, { valHistory, testHistory });
  const ref = await runEval({ seed: 42 });

  assert.deepEqual(holdout.gated, ref.phase3.gated);
  assert.deepEqual(holdout.unfiltered, ref.phase3.unfiltered);
  assert.equal(holdout.f1Delta, ref.phase3.f1Delta);
});

test('trainer emits an agix.stv.holdout.v1 JSONL record when splits are passed', async () => {
  const { fitHistory, valHistory, testHistory, anchors } = generateSyntheticCorpus({ seed: 42 });
  const dir = mkdtempSync(join(tmpdir(), 'stv-holdout-'));
  const fitPath = join(dir, 'fit.json');
  const valPath = join(dir, 'val.json');
  const testPath = join(dir, 'test.json');
  const anchorsPath = join(dir, 'anchors.json');
  const outPath = join(dir, 'verifier.json');

  writeFileSync(fitPath, JSON.stringify({ snapshots: fitHistory }));
  writeFileSync(valPath, JSON.stringify({ snapshots: valHistory }));
  writeFileSync(testPath, JSON.stringify({ snapshots: testHistory }));
  writeFileSync(anchorsPath, JSON.stringify(anchors));

  const lines = [];
  const origLog = console.log;
  const prevExitCode = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await main([
      '--history', fitPath,
      '--anchors', anchorsPath,
      '--out', outPath,
      '--val', valPath,
      '--holdout', testPath,
    ]);
  } finally {
    console.log = origLog;
    // main() sets process.exitCode from the anchor gate (gatePassed=false on
    // this synthetic data); restore it so the test runner isn't marked failed.
    process.exitCode = prevExitCode;
    rmSync(dir, { recursive: true, force: true });
  }

  const records = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.schema === 'agix.stv.holdout.v1');

  assert.equal(records.length, 1, 'exactly one holdout JSONL record');
  assert.equal(typeof records[0].holdout.f1Delta, 'number');
  assert.ok(Number.isFinite(records[0].holdout.f1Delta));
});
