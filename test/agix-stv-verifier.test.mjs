// agix-stv-verifier — Phase 2 verifier unit tests.
// Fixtures: test/fixtures/stv/history.json, anchors.json
// Runner: node --test test/agix-stv-verifier.test.mjs

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFeatures,
  trainVerifier,
  scoreFinding,
  evaluateAnchorGate,
} from '../lib/agix-stv-verifier.mjs';
import { buildLabeledCorpus, harvestDeployHealthAnchors } from '../lib/agix-stv-labeler.mjs';
import { main } from '../services/stv-trainer/train.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'stv');

function loadJson(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
}

const EXPECTED_NAMES = [
  'sev_critical',
  'sev_warn',
  'cat_ci_failing',
  'cat_deploy_skipped',
  'cat_apphosting_gap',
  'cat_apphosting_rollout_failed',
  'ci_fail_streak_norm',
  'apphosting_gap_norm',
  'rollout_state_bad',
  'persisted_cycles_norm',
];

// ─── extractFeatures ────────────────────────────────────────────────────────

test('extractFeatures — fixed-order names, finite values, correct one-hots', () => {
  const snapshot = {
    runId: 'r1',
    findings: [{ severity: 'critical', category: 'ci-failing', key: 'ci-failing@x' }],
    ci: {
      runs: [
        { workflowName: 'CI', conclusion: 'failure' },
        { workflowName: 'CI', conclusion: 'failure' },
        { workflowName: 'CI', conclusion: 'success' },
      ],
    },
    appHosting: { gap: 5, latestRolloutState: 'BUILDING' },
  };
  const finding = snapshot.findings[0];
  const fv = extractFeatures(snapshot, finding, [snapshot]);

  assert.deepEqual(fv.names, EXPECTED_NAMES);
  assert.equal(fv.values.length, 10);
  for (const v of fv.values) assert.ok(Number.isFinite(v), `value ${v} not finite`);

  const byName = Object.fromEntries(fv.names.map((n, i) => [n, fv.values[i]]));
  assert.equal(byName.sev_critical, 1);
  assert.equal(byName.sev_warn, 0);
  assert.equal(byName.cat_ci_failing, 1);
  assert.equal(byName.cat_deploy_skipped, 0);
  assert.equal(byName.cat_apphosting_gap, 0);
  assert.equal(byName.cat_apphosting_rollout_failed, 0);
  assert.equal(byName.ci_fail_streak_norm, 2 / 5); // 2 leading failures
  assert.equal(byName.apphosting_gap_norm, 5 / 10);
  assert.equal(byName.rollout_state_bad, 1); // BUILDING is not SUCCEEDED
  assert.equal(byName.persisted_cycles_norm, 1 / 5); // 1 occurrence
});

test('extractFeatures — warn severity, SUCCEEDED rollout, gap cap', () => {
  const snapshot = {
    runId: 'r1',
    findings: [{ severity: 'warn', category: 'apphosting-gap', key: 'k' }],
    ci: { runs: [{ workflowName: 'CI', conclusion: 'success' }] },
    appHosting: { gap: 100, latestRolloutState: 'SUCCEEDED' },
  };
  const fv = extractFeatures(snapshot, snapshot.findings[0], [snapshot]);
  const byName = Object.fromEntries(fv.names.map((n, i) => [n, fv.values[i]]));
  assert.equal(byName.sev_critical, 0);
  assert.equal(byName.sev_warn, 1);
  assert.equal(byName.cat_apphosting_gap, 1);
  assert.equal(byName.ci_fail_streak_norm, 0);
  assert.equal(byName.apphosting_gap_norm, 1); // capped
  assert.equal(byName.rollout_state_bad, 0);
});

// ─── determinism ────────────────────────────────────────────────────────────

test('trainVerifier — deterministic weights and bias', () => {
  const history = loadJson('history.json').snapshots;
  const items = loadJson('anchors.json').items;
  const corpus = buildLabeledCorpus(history, { anchors: harvestDeployHealthAnchors(items) });

  const a = trainVerifier(corpus, history, { version: 'V_0' });
  const b = trainVerifier(corpus, history, { version: 'V_0' });

  assert.deepEqual(a.model.weights, b.model.weights);
  assert.equal(a.model.bias, b.model.bias);
});

// ─── monotonic separation ───────────────────────────────────────────────────

test('scoreFinding — high-signal scores above low-signal after training', () => {
  // Construct a history of independent episodes: high-signal findings are
  // +1, low-signal findings are -1.
  const mkSnap = (runId, finding, ci, gap, rollout) => ({
    schema: 'agix.deploy-health.snapshot.v1',
    runId,
    headSha: runId,
    findings: finding ? [finding] : [],
    ci: { runs: ci },
    appHosting: { gap, latestSucceededSha: null, latestRolloutState: rollout },
  });

  const highFail = [
    { workflowName: 'CI', conclusion: 'failure' },
    { workflowName: 'CI', conclusion: 'failure' },
    { workflowName: 'CI', conclusion: 'failure' },
    { workflowName: 'CI', conclusion: 'failure' },
    { workflowName: 'CI', conclusion: 'failure' },
  ];
  const lowOk = [{ workflowName: 'CI', conclusion: 'success' }];

  const history = [];
  const training = [];
  // Three high-signal positive episodes (persisted twice each).
  for (let i = 0; i < 3; i++) {
    const key = `apphosting-gap@hi${i}`;
    const f = { severity: 'critical', category: 'apphosting-gap', key };
    history.push(mkSnap(`hi${i}-a`, f, highFail, 9, 'BUILDING'));
    history.push(mkSnap(`hi${i}-b`, f, highFail, 9, 'BUILDING'));
    training.push({
      envelope: 'agent.trajectory.label.v1',
      runId: `hi${i}-a`,
      findingKey: key,
      label: 1,
      confidence: 0.9,
      source: 'execution',
      heldOutForAnchor: false,
    });
  }
  // Three low-signal negative episodes.
  for (let i = 0; i < 3; i++) {
    const key = `deploy-skipped@lo${i}`;
    const f = { severity: 'warn', category: 'deploy-skipped', key };
    history.push(mkSnap(`lo${i}-a`, f, lowOk, 0, 'SUCCEEDED'));
    training.push({
      envelope: 'agent.trajectory.label.v1',
      runId: `lo${i}-a`,
      findingKey: key,
      label: -1,
      confidence: 0.6,
      source: 'execution',
      heldOutForAnchor: false,
    });
  }

  const corpus = { training, anchor: [], provenance: {} };
  const vv = trainVerifier(corpus, history, { version: 'V_0' });

  const hi = scoreFinding(vv, history[0], history[0].findings[0], history);
  const loSnap = history.find((s) => s.runId === 'lo0-a');
  const lo = scoreFinding(vv, loSnap, loSnap.findings[0], history);

  assert.ok(hi.score > lo.score, `expected ${hi.score} > ${lo.score}`);
  assert.ok(hi.rationale.length > 0);
  assert.ok(lo.rationale.length > 0);
});

// ─── fixture end-to-end ─────────────────────────────────────────────────────

test('trainVerifier — fixture corpus shapes and scoring', () => {
  const history = loadJson('history.json').snapshots;
  const items = loadJson('anchors.json').items;
  const corpus = buildLabeledCorpus(history, { anchors: harvestDeployHealthAnchors(items) });
  const vv = trainVerifier(corpus, history, { version: 'V_0' });

  assert.equal(vv.model.weights.length, 10);
  assert.equal(vv.model.standardization.mean.length, 10);
  assert.equal(vv.model.standardization.std.length, 10);

  assert.equal(vv.trainCorpus.size, 4);
  assert.equal(vv.trainCorpus.labelMix.pos, 3);
  assert.equal(vv.trainCorpus.labelMix.neg, 1);

  assert.equal(vv.anchorScores.n, 2);
  assert.ok(vv.anchorScores.agreement >= 0 && vv.anchorScores.agreement <= 1);

  // Score an actual finding from the history.
  const snap = history[0];
  const result = scoreFinding(vv, snap, snap.findings[0], history);
  assert.ok(result.score >= 0 && result.score <= 1, `score ${result.score} out of [0,1]`);
  assert.ok(result.rationale.length > 0);
});

test('evaluateAnchorGate — no usable anchors returns abstain', () => {
  const history = loadJson('history.json').snapshots;
  const corpus = buildLabeledCorpus(history, { anchors: [] });
  const vv = trainVerifier(corpus, history, { version: 'V_0' });

  const scores = evaluateAnchorGate(vv.model, [], history);
  assert.deepEqual(scores, { agreement: 0, calibrationError: 1, n: 0, gatePassed: false });
});

// ─── trainer CLI ────────────────────────────────────────────────────────────

test('main — writes a valid VerifierVersion to --out', async () => {
  const outPath = join(tmpdir(), `stv-verifier-${process.pid}-${Date.now()}.json`);
  // main() sets process.exitCode by design (1 on gate fail; the tiny
  // fixture gate does not pass). Save/restore so its side-effect does not
  // leak into the test runner's own exit status.
  const savedExitCode = process.exitCode;
  try {
    await main([
      '--history',
      join(fixtureDir, 'history.json'),
      '--anchors',
      join(fixtureDir, 'anchors.json'),
      '--out',
      outPath,
    ]);

    assert.ok(existsSync(outPath), 'out file was not written');
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(typeof written, 'object');
    assert.equal(written.envelope, 'agent.verifier.version.v1');
    assert.equal(written.model.weights.length, 10);
  } finally {
    process.exitCode = savedExitCode;
    if (existsSync(outPath)) rmSync(outPath);
  }
});
