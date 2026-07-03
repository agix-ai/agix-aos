// Reliability harness — the NEAR-CAPACITY degradation curve (NATIVE-ONLY).
//
// WHY THIS EXISTS
// context-warden is a SESSION-HEALTH ADVISOR: after a long session it WARNS the human that
// their context is entering the degradation zone and they should switch sessions / compact.
// The warning is only justified if a frontier model ACTUALLY degrades near its capacity.
// The easy + hard managed-vs-native arms (score.mjs / hard.mjs) measured a frontier model at
// 6–14K tokens (≈1–2.4× the warden's *effective* gauge, but only ~7% of the *advertised*
// 200K window) and found it ROBUST — native 15/15 — so management showed no quality win.
// That left the real question unanswered: does the model degrade as you push context toward
// its advertised window? This arm answers it with a NATIVE-ONLY curve — no compaction arm,
// because the warden's value here is the WARNING, not a quality boost. We just need to show
// (or fail to show) native degradation as a function of size, and read off the honest
// threshold the warden should warn at.
//
// DESIGN — lost-in-the-middle needle at escalating sizes:
//   • A single verifiable needle fact is placed MID-CONTEXT (the lost-in-the-middle position,
//     the empirically worst spot) amid benign, heterogeneous infra-log filler.
//   • The question asks for exactly that fact; scoring is substring-tolerant (same scorer as
//     the other arms).
//   • Context is grown to a LADDER of target sizes — ~8K, ~32K, ~64K, ~128K, ~180K tokens —
//     capped safely under the model's advertised window.
//   • Multiple TRIALS per size (degradation is probabilistic; one shot is noise). Each trial
//     re-seeds the filler and re-randomizes the needle's mid-band position so we're measuring
//     a size effect, not one unlucky layout.
//   • Output: a curve of size (tokens, ×effective) → accuracy. The ONSET (first size where
//     accuracy drops below 100%) is the honest threshold the warden's "switch sessions" warning
//     should fire at — model-specific, read straight off the data.
//
// SPEND: identical contract to the closed-loop arms. Requires AGIX_BENCH_PAID=1 to make any
// model call. With no flag it prints the size ladder + the EXACT paid-call count + a rough $
// estimate (summed input tokens × a STATED per-Mtoken rate) and exits 0 — NO model call.
//
// MODEL: respects AGIX_BENCH_MODEL (default claude-sonnet-4-6). The max context is capped under
// the chosen model's advertised window (with headroom for the prompt scaffold + output).

import { analyzeContext } from '../../agents/context-warden/agent.mjs';
import { readFileSync } from 'node:fs';

const EFF_TABLE = JSON.parse(readFileSync(new URL('../../agents/context-warden/effective-length.json', import.meta.url)));
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

// Trials per size. Degradation is probabilistic; one shot per size is noise. 5 is a sane
// default that keeps the paid-call count modest (5 sizes × 5 = 25 calls). Override with
// AGIX_BENCH_TRIALS.
export const DEFAULT_TRIALS = Number(process.env.AGIX_BENCH_TRIALS) || 5;

// The target size ladder (tokens). Escalates toward a frontier window. Capped under the
// advertised window in buildLadder() so we never request a context that can't fit.
const TARGET_SIZES = [8000, 32000, 64000, 128000, 180000];

// Assumed input rate for the no-spend $ estimate. We deliberately use a SINGLE stated input
// rate (not the live rate-card lookup) so the estimate is transparent and self-documenting in
// the printed output — the operator sees exactly what rate was assumed. Output tokens are
// capped at 64/call (answer is a short fact) so input dominates the cost; we add a small,
// stated output allowance on top. Sonnet 4.6 published input rate is $3.00 / Mtok (see
// lib/model-adapters/rate-card.mjs).
const ASSUMED_INPUT_RATE_PER_MTOK = Number(process.env.AGIX_BENCH_RATE) || 3.00;
const ASSUMED_OUTPUT_RATE_PER_MTOK = 15.00; // sonnet output rate, for the small per-call output allowance
const MAX_OUTPUT_TOKENS = 64;

function effectiveFor(modelId) {
  return EFF_TABLE.models?.[modelId]?.effective ?? EFF_TABLE.default.effective;
}
function advertisedFor(modelId) {
  return EFF_TABLE.models?.[modelId]?.advertised ?? EFF_TABLE.default.advertised;
}

// Estimate tokens the SAME way context-warden does, so the sizes we report match the warden's
// own occupancy math (one estimator, no divergence).
function estTokens(text) {
  return analyzeContext({ text, modelId: DEFAULT_MODEL_ID, table: EFF_TABLE, thresholds: {} }).tokens;
}

// ─── Filler generator ───────────────────────────────────────────────────────────────────────
// Heterogeneous infra-log distractor lines — varied (not one repeated line) so the body reads
// like a real growing context and doesn't collapse into a duplicate-line artifact. `seed` makes
// each trial's filler distinct. Mirrors hard.mjs's style so the two arms are comparable.
function fillerLine(seed, i) {
  const verbs = ['recorded', 'observed', 'logged', 'noted', 'reported', 'captured', 'measured', 'sampled'];
  const subjects = ['the ingest worker', 'the scheduler', 'the cache layer', 'the egress proxy', 'the metrics pipeline',
    'the replica set', 'the queue consumer', 'the build runner', 'the audit sink', 'the rate limiter'];
  const metrics = ['p50 latency', 'queue depth', 'cache hit-rate', 'error budget', 'CPU headroom', 'GC pause',
    'connection pool usage', 'retry count', 'backlog size', 'heartbeat interval'];
  const k = (i + seed * 7) % subjects.length;
  const v = (i + seed * 3) % verbs.length;
  const m = (i + seed * 5) % metrics.length;
  return `Telemetry ${seed}.${i}: ${subjects[k]} ${verbs[v]} nominal ${metrics[m]} during window ${1000 + i}; ` +
    `no anomaly on shard ${seed}-${i}, run id r${seed}${i}${i}. This line is unrelated to the question and is pure distractor padding.`;
}

// Approximate tokens contributed by one filler line (used to size the body without a per-line
// re-estimate loop). Measured once against the estimator so the math stays consistent.
const _sampleLine = fillerLine(0, 0);
const TOKENS_PER_LINE = Math.max(1, estTokens(_sampleLine + '\n'));

// The needle pool — distinct verifiable facts so different trials/sizes can use different needles
// (avoids a single fact's quirks dominating the whole curve). Each is a short, unambiguous value.
const NEEDLES = [
  { needle: 'Provisioning record: the Helios module was assigned internal license identifier HLX-7731 at onboarding.',
    question: 'What is the internal license identifier for the Helios module? Answer with only the identifier.',
    expected: 'HLX-7731', accept: ['hlx-7731', 'hlx 7731', 'hlx7731'] },
  { needle: 'Config fact: the Atlas sidecar binds and listens on TCP port 8443 in every environment.',
    question: 'On which TCP port does the Atlas sidecar listen? Answer with only the port number.',
    expected: '8443', accept: ['8443'] },
  { needle: 'Storage note: Nimbus cold storage is the GCS bucket named nimbus-cold-archive-9, set up by the platform team.',
    question: 'What is the name of the GCS bucket used for Nimbus cold storage? Answer with only the bucket name.',
    expected: 'nimbus-cold-archive-9', accept: ['nimbus-cold-archive-9', 'nimbus cold archive 9'] },
  { needle: 'Directory entry: the technical contact of record for the Vega service is priya, per the service catalog.',
    question: 'Who is listed as the technical contact for the Vega service? Answer with only the name.',
    expected: 'priya', accept: ['priya'] },
  { needle: 'Gateway setting: the Cygnus gateway client read timeout is configured to 37 seconds.',
    question: 'What is the client read timeout in seconds for the Cygnus gateway? Answer with only the number.',
    expected: '37', accept: ['37', '37s', '37 seconds'] },
  { needle: 'Registry fact: the Draco scheduler uses partition key dk-5519 for all sharded writes.',
    question: 'What partition key does the Draco scheduler use for sharded writes? Answer with only the key.',
    expected: 'dk-5519', accept: ['dk-5519', 'dk 5519', 'dk5519'] },
];

// Build ONE trial context for a target token size: filler, with the needle inserted in the
// MIDDLE band (lost-in-the-middle). The needle's exact index is jittered within the mid third
// per trial so we measure a size effect, not one fixed layout. Returns the assembled context +
// the chosen needle/question + the measured token count.
function buildTrialContext(targetTokens, seed, modelId) {
  const needleSpec = NEEDLES[seed % NEEDLES.length];
  const needleTokens = estTokens(needleSpec.needle + '\n');
  const bodyTokens = Math.max(0, targetTokens - needleTokens);
  const lineCount = Math.max(2, Math.round(bodyTokens / TOKENS_PER_LINE));

  const lines = [];
  for (let i = 0; i < lineCount; i++) lines.push(fillerLine(seed, i));

  // Insert the needle in the MIDDLE third, jittered by seed (deterministic per trial).
  const lo = Math.floor(lineCount / 3);
  const hi = Math.floor((2 * lineCount) / 3);
  const span = Math.max(1, hi - lo);
  const insertAt = lo + ((seed * 31) % span);
  lines.splice(insertAt, 0, needleSpec.needle);

  const context = lines.join('\n');
  return {
    context,
    question: needleSpec.question,
    accept: needleSpec.accept,
    expected: needleSpec.expected,
    needleId: needleSpec.expected,
    tokens: estTokens(context),
    needlePositionPct: +(insertAt / lines.length).toFixed(2),
  };
}

// Build the full ladder of (targetSize → trials[]) plans, capped under the advertised window.
// We reserve headroom for the prompt scaffold (instruction + question) + the output budget.
export function buildLadder({ modelId = DEFAULT_MODEL_ID, trials = DEFAULT_TRIALS } = {}) {
  const advertised = advertisedFor(modelId);
  // Headroom: keep the largest TARGET a safe margin under the advertised window. The 180K target
  // measures ~192K (TOKENS_PER_LINE is an estimate + the warden's estimator biases CONSERVATIVE,
  // i.e. it over-counts — so the real API token count is lower, never higher), and the prompt
  // scaffold (~50 tok) + 64-token output budget add a little. A 10% target margin → 180K max
  // target → ~192K measured + scaffold ≈ 192.7K, leaving ~7K headroom under the 200K window.
  const cap = Math.floor(advertised * 0.90);
  const sizes = TARGET_SIZES.filter((s) => s <= cap);
  // If even the smallest target exceeds the cap (tiny-window model), fall back to a single
  // sub-cap size so the harness still produces a curve.
  if (!sizes.length) sizes.push(Math.floor(cap * 0.5));

  const ladder = sizes.map((targetTokens) => {
    const plans = [];
    for (let t = 0; t < trials; t++) {
      // Seed combines size + trial so every (size, trial) cell is a distinct, reproducible layout.
      const seed = (targetTokens % 9973) + t * 101 + 1;
      plans.push(buildTrialContext(targetTokens, seed, modelId));
    }
    const measured = plans.map((p) => p.tokens);
    const avgTokens = Math.round(measured.reduce((a, b) => a + b, 0) / measured.length);
    return {
      targetTokens,
      avgTokens,
      occupancyX: +(avgTokens / effectiveFor(modelId)).toFixed(1),
      advertisedPct: +(avgTokens / advertised).toFixed(3),
      trials: plans,
    };
  });
  return { modelId, effective: effectiveFor(modelId), advertised, trials, ladder };
}

// ─── Cost accounting for the no-spend estimate ──────────────────────────────────────────────
// Sum the input tokens across every planned call, add a small per-call output allowance, and
// price both at the STATED rates. Returns the call count + the $ estimate so the no-spend path
// can print exactly what a paid run would cost.
export function estimateSpend(plan) {
  let totalInputTokens = 0;
  let calls = 0;
  for (const rung of plan.ladder) {
    for (const trial of rung.trials) {
      // Input ≈ the context tokens + a small scaffold (instruction + question). The scaffold is
      // ~60 tokens; include it so the estimate isn't an under-count.
      totalInputTokens += trial.tokens + 60;
      calls++;
    }
  }
  const totalOutputTokens = calls * MAX_OUTPUT_TOKENS;
  const inputCost = (totalInputTokens / 1_000_000) * ASSUMED_INPUT_RATE_PER_MTOK;
  const outputCost = (totalOutputTokens / 1_000_000) * ASSUMED_OUTPUT_RATE_PER_MTOK;
  return {
    calls,
    totalInputTokens,
    totalOutputTokens,
    inputRate: ASSUMED_INPUT_RATE_PER_MTOK,
    outputRate: ASSUMED_OUTPUT_RATE_PER_MTOK,
    estUsd: +(inputCost + outputCost).toFixed(2),
  };
}

// ─── No-spend printer — the design + ladder + exact paid-call count + $ estimate ────────────
export function printCapacityReadyMessage({ modelId = DEFAULT_MODEL_ID, trials = DEFAULT_TRIALS } = {}) {
  const plan = buildLadder({ modelId, trials });
  const spend = estimateSpend(plan);

  console.log('\n── Capacity degradation arm (NATIVE-ONLY near-capacity curve) ──');
  console.log(
    `model ${modelId}  ·  effective ${plan.effective} tok  ·  advertised ${plan.advertised} tok  ·  ` +
    `${trials} trials/size  ·  lost-in-the-middle needle\n`);
  console.log('  target     avg measured     ×effective   % advertised   trials');
  console.log('  ' + '─'.repeat(64));
  for (const rung of plan.ladder) {
    console.log(
      `  ${String(rung.targetTokens).padStart(7)} tok  ${String(rung.avgTokens).padStart(8)} tok` +
      `   ${(rung.occupancyX + '×').padStart(8)}   ${(Math.round(rung.advertisedPct * 100) + '%').padStart(10)}` +
      `   ${String(rung.trials.length).padStart(4)}`);
  }
  console.log('  ' + '─'.repeat(64));
  console.log(
    `\n  Design: one verifiable needle placed MID-CONTEXT (lost-in-the-middle) amid benign infra-log\n` +
    `  filler, at ${plan.ladder.length} escalating sizes capped under the ${plan.advertised}-tok advertised window.\n` +
    `  Native answer-correctness per size → a curve; ONSET (first size below 100%) = the honest\n` +
    `  threshold the warden's "switch sessions / compact" warning should fire at.`);
  console.log(
    `\nready — this arm makes ${spend.calls} paid API calls ` +
    `(${plan.ladder.length} sizes × ${trials} trials), NO model call made in this no-spend run.\n` +
    `  cost estimate ≈ $${spend.estUsd}  ` +
    `(Σ input ≈ ${spend.totalInputTokens.toLocaleString()} tok @ $${spend.inputRate}/Mtok` +
    ` + ${spend.totalOutputTokens.toLocaleString()} output tok @ $${spend.outputRate}/Mtok)\n` +
    `  Re-run to spend:  AGIX_BENCH_PAID=1 node bench/reliability/score.mjs --capacity`);
}

// ─── Answer scoring (mirrors score.mjs / hard.mjs) ──────────────────────────────────────────
function scoreAnswer(answer, accept) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
  const a = norm(answer);
  return accept.some((form) => a.includes(norm(form)));
}
function clip(s, n = 60) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Ask the model a needle-retrieval question grounded in the context block. Native-only — no
// compaction. Same neutral instruction shape as the other arms.
async function askModel(m, modelId, context, question) {
  const resp = await m.chat({
    model: modelId || undefined,
    capability: modelId ? undefined : 'default-quality',
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    messages: [{
      role: 'user',
      content:
        `Use ONLY the context below to answer. Answer concisely.\n\n` +
        `--- CONTEXT ---\n${context}\n--- END CONTEXT ---\n\n${question}`,
    }],
    agent: 'reliability-bench-capacity',
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// ─── The paid arm — runs ONLY when a model adapter is provided AND spend is acknowledged ─────
// One model call per (size, trial). Returns per-size accuracy + the identified onset threshold.
export async function runCapacityCurve({ model, modelId = DEFAULT_MODEL_ID, trials = DEFAULT_TRIALS } = {}) {
  if (!model) return { ran: false, reason: 'no model adapter — provide one to measure the capacity curve' };

  const plan = buildLadder({ modelId, trials });
  const rows = [];
  for (const rung of plan.ladder) {
    let correct = 0;
    const perTrial = [];
    for (const trial of rung.trials) {
      const ans = await askModel(model, modelId, trial.context, trial.question);
      const ok = scoreAnswer(ans, trial.accept);
      if (ok) correct++;
      perTrial.push({ needle: trial.needleId, positionPct: trial.needlePositionPct, answer: clip(ans), correct: ok });
    }
    rows.push({
      targetTokens: rung.targetTokens,
      avgTokens: rung.avgTokens,
      occupancyX: rung.occupancyX,
      advertisedPct: rung.advertisedPct,
      trials: rung.trials.length,
      correct,
      accuracy: +(correct / rung.trials.length).toFixed(3),
      perTrial,
    });
  }
  // Onset = the first size where accuracy < 100%.
  const onset = rows.find((r) => r.accuracy < 1) || null;
  return { ran: true, modelId, effective: plan.effective, advertised: plan.advertised, trials, rows, onset };
}

// ─── Paid result printer — the curve + the honest threshold read ────────────────────────────
export function printCapacityResults(out) {
  console.log('\n── Capacity degradation arm (NATIVE-ONLY near-capacity curve) ──');
  console.log(`model ${out.modelId}  ·  effective ${out.effective} tok  ·  advertised ${out.advertised} tok  ·  ${out.trials} trials/size\n`);
  console.log('  target      avg tok   ×effective   % advertised   accuracy        per-trial');
  console.log('  ' + '─'.repeat(78));
  for (const r of out.rows) {
    const trialMarks = r.perTrial.map((t) => (t.correct ? '✓' : '✗')).join('');
    console.log(
      `  ${String(r.targetTokens).padStart(7)} tok  ${String(r.avgTokens).padStart(7)}` +
      `   ${(r.occupancyX + '×').padStart(8)}   ${(Math.round(r.advertisedPct * 100) + '%').padStart(10)}` +
      `   ${(r.correct + '/' + r.trials).padStart(6)} ${(Math.round(r.accuracy * 100) + '%').padStart(5)}   ${trialMarks}`);
  }
  console.log('  ' + '─'.repeat(78));
  if (out.onset) {
    console.log(
      `\n  ONSET: native accuracy first drops below 100% at ~${out.onset.targetTokens} tok ` +
      `(${out.onset.occupancyX}× effective, ${Math.round(out.onset.advertisedPct * 100)}% of advertised) → ` +
      `${out.onset.correct}/${out.onset.trials}.`);
    console.log(
      `  HONEST READ: the warden's "switch sessions / compact" warning is justified once a session\n` +
      `  approaches ~${out.onset.targetTokens} tok for ${out.modelId} — that's the model-specific threshold to set.`);
  } else {
    console.log(
      `\n  NO ONSET observed: native stayed 100% across the full ladder (up to ` +
      `${out.rows[out.rows.length - 1]?.targetTokens} tok). HONEST READ: at these sizes the model does NOT\n` +
      `  degrade on this needle style — the warden's warning threshold can't be pinned from this run.\n` +
      `  Try more trials, a weaker model (AGIX_BENCH_MODEL=claude-haiku-4-5), or harder needles.`);
  }
  console.log(
    `\n  CAVEAT: needle-style sensitive (a single buried fact retrieval; real degradation is multi-faceted)\n` +
    `  and the threshold is model-specific. This is a NATIVE-only curve — no compaction arm, because the\n` +
    `  warden's value here is the WARNING, not a quality boost.`);
}
