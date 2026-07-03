// Reliability harness — corpus-based DETECTION benchmark for context-warden,
// plus the closed-loop MANAGED-vs-NATIVE answer-correctness arm (key-gated).
//
// Scores how well context-warden's deterministic analysis flags degradation conditions
// across a LABELED scenario corpus (precision / recall / accuracy), not just the unit eval.
// This is the runnable half of Comparison-2 (detection). The closed-loop arm — managed
// vs native answer-correctness under contradictory/degraded context — is wired in
// `runManagedVsNative()` below and runs a real model WHEN a key is configured.
//
//   node bench/reliability/score.mjs                    # detection benchmark (no key needed)
//   node bench/reliability/score.mjs --closed-loop      # + easy managed-vs-native arm (needs ANTHROPIC_API_KEY)
//   node bench/reliability/score.mjs --closed-loop-hard # + HARD arm (degrade regime; long ctx, buried needles, subtle contradictions)
//   node bench/reliability/score.mjs --capacity         # + NATIVE-ONLY near-capacity degradation curve (escalating sizes toward the advertised window)
//
// The closed-loop + capacity arms are all gated on a model key: with no key they print a clear
// "skipped" message and exit 0 (CI-safe), they never throw. Provider defaults to Anthropic; set
// AGIX_PROVIDER=openai|gemini (plus the matching key) to route elsewhere. The HARD arm lives in
// the sibling `bench/reliability/hard.mjs` (wired via --closed-loop-hard); the CAPACITY arm lives
// in `bench/reliability/capacity.mjs` (wired via --capacity).

import { analyzeContext } from '../../agents/context-warden/agent.mjs';
import { wardenStep } from '../../lib/agix-warm-context.mjs';
import { Model } from '../../lib/agix-model.mjs';
import { readFileSync } from 'node:fs';
import { runHardManagedVsNative, printHardReadyMessage, printHardResults } from './hard.mjs';
import { runCapacityCurve, printCapacityReadyMessage, printCapacityResults } from './capacity.mjs';

const table = JSON.parse(readFileSync(new URL('../../agents/context-warden/effective-length.json', import.meta.url)));
const model = 'claude-sonnet-4-6'; // effective 6000
const thresholds = { warn_at: 0.5, compact_at: 0.8 };

const varied = (n) => Array.from({ length: n }, (_, i) =>
  `Sentence ${i}: a distinct point about topic_${i} with words alpha${i} beta${i} gamma${i} delta${i}.`).join(' ');

// Labeled corpus. risky=true → a degradation condition the warden SHOULD flag.
const corpus = [
  // healthy (must NOT flag) — false-positive guards
  { id: 'clean-1', risky: false, text: 'A short, clean task description with a single clear goal.' },
  { id: 'clean-2', risky: false, text: varied(20) },
  { id: 'clean-long-3', risky: false, text: varied(100) },   // long but clean
  { id: 'clean-empty', risky: false, text: '' },
  { id: 'clean-list', risky: false, text: '1. do this\n2. then that\n3. finally this other thing\n4. report' },
  // over-effective-length
  { id: 'over-1', risky: true, want: 'over-effective-length', text: varied(360) },
  { id: 'over-2', risky: true, want: 'over-effective-length', text: varied(420) },
  // repetition ("losing the thread")
  { id: 'rep-1', risky: true, want: 'repetition-loop', text: 'the cat sat on the mat '.repeat(40) },
  { id: 'rep-2', risky: true, want: 'repetition-loop', text: 'please continue please continue please continue '.repeat(30) },
  // distractor / duplication
  { id: 'dist-1', risky: true, want: 'distractor-duplication', text: Array(20).fill('A duplicated distractor line repeated many times in context.').join('\n') },
  { id: 'dist-2', risky: true, want: 'distractor-duplication', text: Array(15).fill('Identical low-signal log line that should be pruned.').join('\n') },
  // contradiction / poisoning (the empirically biggest risk — incl. low-occupancy)
  { id: 'contra-1', risky: true, want: 'contradiction-suspected', text: 'The region is us-west-3. UPDATE: it was migrated to eu-central-1, which supersedes the earlier value.' },
  { id: 'contra-2', risky: true, want: 'contradiction-suspected', text: 'Endpoint is /v1/old. Correction: changed to /v2/new; the old path is no longer valid.' },
  { id: 'contra-3', risky: true, want: 'contradiction-suspected', text: varied(30) + ' NOTE: the owner was alice, now it points to bob which overrides the above.' },
  // mixed
  { id: 'mixed-1', risky: true, want: 'over-effective-length', text: Array(400).fill('Identical distractor padding an over-long window now.').join('\n') },
];

// ── Detection benchmark (deterministic; no model key needed) ──────────────────────────────
export function runDetection() {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const rows = [];
  for (const c of corpus) {
    const a = analyzeContext({ text: c.text, modelId: model, table, thresholds });
    const flagged = a.flags.length > 0;
    const wantHit = !c.want || a.flags.includes(c.want);
    if (c.risky && flagged && wantHit) tp++;
    else if (c.risky && (!flagged || !wantHit)) { fn++; }
    else if (!c.risky && flagged) fp++;
    else tn++;
    const ok = c.risky ? (flagged && wantHit) : !flagged;
    rows.push(`  ${ok ? '✓' : '✗'} ${c.id.padEnd(14)} risky=${String(c.risky).padEnd(5)} → [${a.flags.join(',') || 'none'}]`);
  }
  const prec = tp + fp ? tp / (tp + fp) : 1;
  const rec = tp + fn ? tp / (tp + fn) : 1;
  const acc = (tp + tn) / corpus.length;
  console.log(rows.join('\n'));
  console.log(`\nReliability detection — n=${corpus.length}  TP=${tp} FP=${fp} TN=${tn} FN=${fn}`);
  console.log(`  precision=${(prec * 100).toFixed(0)}%  recall=${(rec * 100).toFixed(0)}%  accuracy=${(acc * 100).toFixed(0)}%`);
  const passed = fp === 0 && fn === 0;
  console.log(passed ? '✓ perfect detection on the corpus' : `✗ ${fp} false-positive(s), ${fn} miss(es)`);
  return { passed, tp, fp, tn, fn, precision: prec, recall: rec, accuracy: acc };
}

// ─── Closed-loop scenario corpus (verifiable answers under degraded context) ────────────────
//
// Each scenario plants ONE needle fact, buries it among distractors, then a later
// line SUPERSEDES it (a migration / correction / rotation). The CURRENT correct answer
// is the SUPERSEDED (newer) value — exactly the contradiction-accumulation condition the
// QUALITY_UNDER_CONTEXT study found destabilizes answers, and that context-warden's
// contradiction screen + wardenStep compaction target. `items` is the accumulated context
// as discrete turns (oldest → newest), mirroring a warm-worker's growing context; the
// authoritative fact is always the most-recent item, so pin-most-recent compaction keeps it.
const closedLoopScenarios = [
  {
    id: 'region-migration',
    question: 'What is the CURRENT deployment region for cluster Orion? Answer with only the region code.',
    expected: 'eu-central-1',
    accept: ['eu-central-1', 'eu central 1', 'eucentral1'],
    items: [
      'Infra note: cluster Orion runs in region us-west-3 per the original provisioning ticket.',
      distractorBlock('region', ['us-east-1', 'us-east-2', 'us-central-1', 'ap-south-1', 'eu-west-2']),
      'Capacity log: Orion p95 latency nominal across the quarter; no incidents recorded.',
      'MIGRATION 2026-05: cluster Orion was migrated to eu-central-1, which supersedes the earlier us-west-3 value. eu-central-1 is now the live region.',
    ],
  },
  {
    id: 'endpoint-correction',
    question: 'What is the CURRENT API endpoint path for the billing service? Answer with only the path.',
    expected: '/v2/billing',
    accept: ['/v2/billing', 'v2/billing'],
    items: [
      'Spec draft: the billing service is reachable at /v1/billing.',
      distractorBlock('path', ['/v1/orders', '/v1/users', '/v1/auth', '/internal/health', '/v1/legacy']),
      'Changelog: rate limits unchanged this release; SLA target still 99.9%.',
      'Correction: the billing endpoint changed to /v2/billing; the old /v1/billing path is no longer valid and returns 410.',
    ],
  },
  {
    id: 'owner-handoff',
    question: 'Who is the CURRENT owner of the payments component? Answer with only the name.',
    expected: 'bob',
    accept: ['bob'],
    items: [
      'Org chart: the payments component owner is alice.',
      distractorBlock('name', ['carol', 'dave', 'erin', 'frank', 'grace']),
      'Standup: payments deploy pipeline is green; no blockers.',
      'UPDATE: ownership of payments was handed off — it now points to bob, which overrides the earlier owner.',
    ],
  },
  {
    id: 'threshold-revision',
    question: 'What is the CURRENT autoscaler CPU target percentage for the web tier? Answer with only the number.',
    expected: '65',
    accept: ['65', '65%', '65 percent'],
    items: [
      'Runbook: the web-tier autoscaler CPU target is set to 80.',
      distractorBlock('number', ['40', '50', '70', '75', '90']),
      'Note: memory target left at default; min replicas unchanged.',
      'Revised: the web-tier CPU target was changed to 65; disregard the previous 80 value.',
    ],
  },
];

// Build a benign distractor block: many similar-shaped values that are NOT the answer.
function distractorBlock(kind, values) {
  const noise = Array.from({ length: 6 }, (_, i) =>
    `Unrelated ${kind} reference ${i}: ${values[i % values.length]} appears in an archived note with no bearing on the current value.`);
  return noise.join('\n');
}

// ── The closed-loop arm (managed vs native answer correctness) — runs when a model is wired ──
//
// For each scenario (needle + distractors + a superseding correction):
//   native arm  → send the raw accumulated context + question; score the answer
//   managed arm → run wardenStep over the accumulated items; if it flags compaction
//                 (contradiction-suspected / over-effective-length), COMPACT — pin the
//                 most-recent (authoritative) items, drop the stale accumulation — then
//                 send the compacted context + question; score the answer
// Report native-correct vs managed-correct + the delta. Needs a live model adapter.
export async function runManagedVsNative({ model: m, scenarios = closedLoopScenarios, modelId } = {}) {
  if (!m) return { ran: false, reason: 'no model adapter — provide one to measure the managed-vs-native delta' };

  const results = [];
  let nativeCorrect = 0, managedCorrect = 0;
  for (const sc of scenarios) {
    // Native arm: the model sees the full, degraded, contradictory context.
    const nativeContext = sc.items.join('\n\n');
    const nativeAns = await askModel(m, modelId, nativeContext, sc.question);
    const nativeOk = scoreAnswer(nativeAns, sc.accept);

    // Managed arm: context-warden decides whether to compact first.
    const step = wardenStep(sc.items, { modelId: modelId || 'claude-sonnet-4-6' });
    const managedItems = step.shouldCompact ? step.kept : sc.items;
    const managedContext = managedItems.join('\n\n');
    const managedAns = await askModel(m, modelId, managedContext, sc.question);
    const managedOk = scoreAnswer(managedAns, sc.accept);

    if (nativeOk) nativeCorrect++;
    if (managedOk) managedCorrect++;
    results.push({
      id: sc.id, expected: sc.expected,
      native: { answer: clip(nativeAns), correct: nativeOk },
      managed: { answer: clip(managedAns), correct: managedOk, compacted: step.shouldCompact, dropped: step.dropped, flags: step.flags },
    });
  }
  return {
    ran: true,
    n: scenarios.length,
    nativeCorrect,
    managedCorrect,
    delta: managedCorrect - nativeCorrect,
    results,
  };
}

// Ask the model a question grounded in a context block; return the trimmed text answer.
async function askModel(m, modelId, context, question) {
  const resp = await m.chat({
    model: modelId || undefined,
    capability: modelId ? undefined : 'default-quality',
    max_tokens: 64,
    temperature: 0,
    messages: [{
      role: 'user',
      content:
        `Use ONLY the context below to answer. If a fact was later superseded/corrected/migrated, ` +
        `the CURRENT value is the most-recent one.\n\n` +
        `--- CONTEXT ---\n${context}\n--- END CONTEXT ---\n\n${question}`,
    }],
    agent: 'reliability-bench',
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Correct iff any accepted form appears in the model's answer (case-insensitive,
// punctuation-tolerant). Substring match keeps short-answer scoring robust to trailing prose.
function scoreAnswer(answer, accept) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
  const a = norm(answer);
  return accept.some((form) => a.includes(norm(form)));
}

function clip(s, n = 80) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ─── Build a key-gated Model directly from env (no full runtime needed for the bench) ──────
// Mirrors agix-runtime's readProviderKey precedence: ~/.config/agix/<provider>.env first,
// then process.env. Returns null when the chosen provider has no key configured so the
// closed-loop arm can skip cleanly instead of throwing.
function loadProviderKeys() {
  return {
    anthropic: readKeyFromConfigOrEnv('anthropic', 'ANTHROPIC_API_KEY'),
    openai:    readKeyFromConfigOrEnv('openai',    'OPENAI_API_KEY'),
    gemini:    readKeyFromConfigOrEnv('gemini',    'GEMINI_API_KEY'),
  };
}

function readKeyFromConfigOrEnv(provider, envVar) {
  const home = process.env.HOME || '';
  if (home) {
    try {
      const path = `${home}/.config/agix/${provider}.env`;
      const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith(`${envVar}=`));
      if (line) {
        const v = line.slice(envVar.length + 1).trim().replace(/^["']|["']$/g, '');
        if (v) return v;
      }
    } catch { /* no config file (or unreadable) — fall through to process.env */ }
  }
  return process.env[envVar] || null;
}

// ─── CLI entry ─────────────────────────────────────────────────────────────────────────────
const closedLoop = process.argv.includes('--closed-loop');
const closedLoopHard = process.argv.includes('--closed-loop-hard');
const capacity = process.argv.includes('--capacity');

// Detection always runs (it's the baseline; the closed-loop + capacity arms run it as a prelude too).
const det = runDetection();

if (!closedLoop && !closedLoopHard && !capacity) {
  process.exit(det.passed ? 0 : 1);
}

// Shared key gate (both arms read the same provider/key config + spend guard).
const provider = (process.env.AGIX_PROVIDER || 'anthropic').toLowerCase();
const keys = loadProviderKeys();
const providerKeyVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[provider];
const modelByProvider = { anthropic: undefined, openai: 'gpt-4o', gemini: 'gemini-2.5-flash' };

// ── CAPACITY arm (native-only near-capacity degradation curve) — same key-gate + spend-guard. ──
// With no key → skip (CI-safe). With key but no AGIX_BENCH_PAID=1 → print the size ladder +
// EXACT paid-call count + $ estimate and exit (NO model call). With key + AGIX_BENCH_PAID=1 →
// run the paid native curve. Respects AGIX_BENCH_MODEL (default sonnet); caps context under the
// model's advertised window inside capacity.mjs.
if (capacity) {
  if (!providerKeyVar) {
    console.log(`\nskipped — unknown AGIX_PROVIDER="${provider}". Use anthropic | openai | gemini.`);
    process.exit(det.passed ? 0 : 1);
  }
  const capacityModelId = process.env.AGIX_BENCH_MODEL || modelByProvider[provider] || 'claude-sonnet-4-6';
  if (!keys[provider]) {
    console.log(
      `\n── Capacity degradation arm (native-only near-capacity curve) ──\n` +
      `skipped — set ANTHROPIC_API_KEY (and optionally AGIX_PROVIDER=openai|gemini with the matching key) ` +
      `to run the capacity arm. Provider="${provider}" has no key configured (~/.config/agix/${provider}.env or $${providerKeyVar}).`);
    process.exit(det.passed ? 0 : 1);   // CI-safe: no key is not a failure.
  }
  // Spend guard — identical contract to the closed-loop arms: paid calls must be EXPLICIT.
  if (process.env.AGIX_BENCH_PAID !== '1') {
    printCapacityReadyMessage({ modelId: capacityModelId });   // prints design + ladder + call count + $ estimate, NO model call
    process.exit(det.passed ? 0 : 1);                          // not spending is not a failure
  }
  try {
    const model = new Model({ keys });
    const out = await runCapacityCurve({ model, modelId: capacityModelId });
    if (!out.ran) {
      console.log(`\nskipped — ${out.reason}`);
      process.exit(det.passed ? 0 : 1);
    }
    printCapacityResults(out);
    process.exit(det.passed ? 0 : 1);   // measurement, not a hard gate — CI semantics stay on detection
  } catch (err) {
    console.log(`\ncapacity arm error (non-fatal): ${err.message}`);
    process.exit(det.passed ? 0 : 1);
  }
}

// ── HARD closed-loop arm (degrade regime) — same key-gate + spend-guard as the easy arm. ──
// Runs the sibling hard.mjs. With no key → skip; with key but no AGIX_BENCH_PAID=1 → print the
// scenario design + deterministic needle-retention diagnostics + "ready — N paid calls" and exit
// (NO model call); with key + AGIX_BENCH_PAID=1 → run the paid arm.
if (closedLoopHard) {
  if (!providerKeyVar) {
    console.log(`\nskipped — unknown AGIX_PROVIDER="${provider}". Use anthropic | openai | gemini.`);
    process.exit(det.passed ? 0 : 1);
  }
  if (!keys[provider]) {
    console.log(
      `\n── Hard closed-loop arm (managed vs native — degrade regime) ──\n` +
      `skipped — set ANTHROPIC_API_KEY (and optionally AGIX_PROVIDER=openai|gemini with the matching key) ` +
      `to run the hard arm. Provider="${provider}" has no key configured (~/.config/agix/${provider}.env or $${providerKeyVar}).`);
    process.exit(det.passed ? 0 : 1);   // CI-safe: no key is not a failure.
  }
  // Spend guard — identical contract to the easy arm: paid calls must be EXPLICIT.
  if (process.env.AGIX_BENCH_PAID !== '1') {
    printHardReadyMessage({ provider });   // prints design + diagnostics + "ready — N paid calls", NO model call
    process.exit(det.passed ? 0 : 1);      // not spending is not a failure
  }
  try {
    const model = new Model({ keys });
    // AGIX_BENCH_MODEL overrides the answering model AND (via the same id) the warden's
    // effective-length gauge — so e.g. AGIX_BENCH_MODEL=claude-haiku-4-5 tests the regime
    // where a weaker model actually degrades (eff=4000 vs sonnet 6000).
    const out = await runHardManagedVsNative({ model, modelId: process.env.AGIX_BENCH_MODEL || modelByProvider[provider] });
    if (!out.ran) {
      console.log(`\nskipped — ${out.reason}`);
      process.exit(det.passed ? 0 : 1);
    }
    console.log('\n── Hard closed-loop arm (managed vs native — degrade regime) ──');
    printHardResults(out, { provider });
    process.exit(det.passed ? 0 : 1);      // measurement, not a hard gate — CI semantics stay on detection
  } catch (err) {
    console.log(`\nhard closed-loop arm error (non-fatal): ${err.message}`);
    process.exit(det.passed ? 0 : 1);
  }
}

// Closed-loop arm (easy) — gated on a model key.
console.log('\n── Closed-loop arm (managed vs native answer correctness) ──');

if (!providerKeyVar) {
  console.log(`skipped — unknown AGIX_PROVIDER="${provider}". Use anthropic | openai | gemini.`);
  process.exit(det.passed ? 0 : 1);
}
if (!keys[provider]) {
  console.log(
    `skipped — set ANTHROPIC_API_KEY (and optionally AGIX_PROVIDER=openai|gemini with the matching key) ` +
    `to run the closed-loop arm. Provider="${provider}" has no key configured (~/.config/agix/${provider}.env or $${providerKeyVar}).`);
  process.exit(det.passed ? 0 : 1);   // CI-safe: no key is not a failure.
}

// Spend guard (fleet-leader hardening): a key is present, but making paid API calls must be
// EXPLICIT — never an accidental side effect of running the benchmark. Require AGIX_BENCH_PAID=1.
// (Added after a verify run inadvertently spent ~8 calls against a pre-configured key.)
if (process.env.AGIX_BENCH_PAID !== '1') {
  console.log(
    `ready — provider="${provider}" key configured; this arm makes ~${closedLoopScenarios.length * 2} paid API calls.\n` +
    `  Re-run to spend:  AGIX_BENCH_PAID=1 node bench/reliability/score.mjs --closed-loop`);
  process.exit(det.passed ? 0 : 1);   // not spending is not a failure
}

// A key is present + spend acknowledged → run the paid arm. Pick the model for the chosen provider.
const closedLoopModelId = modelByProvider[provider];   // undefined → default-quality capability route
try {
  const model = new Model({ keys });
  const out = await runManagedVsNative({ model, modelId: closedLoopModelId });
  if (!out.ran) {
    console.log(`skipped — ${out.reason}`);
    process.exit(det.passed ? 0 : 1);
  }
  for (const r of out.results) {
    const tag = (ok) => (ok ? '✓' : '✗');
    console.log(
      `  ${r.id.padEnd(20)} expected=${r.expected.padEnd(14)} ` +
      `native ${tag(r.native.correct)} (${r.native.answer})  |  ` +
      `managed ${tag(r.managed.correct)}${r.managed.compacted ? ` [compacted -${r.managed.dropped}]` : ''} (${r.managed.answer})`);
  }
  console.log(
    `\nClosed-loop — provider=${provider} n=${out.n}  ` +
    `native-correct=${out.nativeCorrect}/${out.n}  managed-correct=${out.managedCorrect}/${out.n}  ` +
    `delta=${out.delta >= 0 ? '+' : ''}${out.delta}`);
  console.log(out.delta > 0
    ? '✓ context-warden management improved answer correctness under degraded context'
    : out.delta === 0
      ? '= no measurable delta on this corpus (try larger N / longer context)'
      : '✗ management did not help on this corpus — investigate compaction policy');
  // Closed-loop correctness is a measurement, not a hard gate — the exit code stays
  // tied to the deterministic detection benchmark so CI semantics are stable.
  process.exit(det.passed ? 0 : 1);
} catch (err) {
  console.log(`closed-loop arm error (non-fatal): ${err.message}`);
  process.exit(det.passed ? 0 : 1);
}
