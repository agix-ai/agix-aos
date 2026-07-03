// Reliability harness — the HARD closed-loop arm: managed-vs-native answer correctness
// in the regime where the base model ACTUALLY degrades.
//
// WHY THIS EXISTS
// The easy 4-scenario --closed-loop arm in score.mjs returned native 4/4 = managed 4/4
// (delta +0): at small N and moderate context the base model resolves contradictions on its
// own, so management shows no benefit. The benefit (if any) lives in the regime where the
// model degrades — long context, buried needles, subtle contradictions, larger N. This arm
// stresses all three so the measurement is HONEST: if management helps it will show; if it's
// neutral or HURTS, that shows just as clearly.
//
// THREE STRESS REGIMES (each has a verifiable short answer):
//   1. lost-in-the-middle  — a needle fact buried in the MIDDLE of a long distractor body
//                            (pushed well past the model's *effective* length). Tests whether
//                            dropping distractors helps the model find the needle.
//   2. marker-contradiction — an early fact, lots of filler, then a clearly-superseding line
//                            ("migrated to / supersedes / corrected to"). context-warden's
//                            deterministic marker screen SHOULD catch this.
//   3. markerless-contradiction — two statements conflict WITHOUT override words; the reader
//                            must infer which is current (from dates / ordering). The marker
//                            screen will likely MISS this — an honest test of its limits.
//
// MANAGED ARMS (we run BOTH so the central tension is exposed, not hidden):
//   • pin-recent     — exactly what ships today (wardenStep, pins the most-recent item). Right
//                      for "supersedes" cases; but for lost-in-the-middle it DROPS THE NEEDLE
//                      (the needle is in the middle, not most-recent) — a real, reported weakness.
//   • keyword-aware  — a smarter compaction: keep the lines that overlap the QUESTION's keywords
//                      PLUS the most-recent item; drop only the keyword-poor distractor filler.
//                      Designed to recover the lost-in-the-middle needle while still pinning the
//                      authoritative override. Reported separately so the delta vs pin-recent is
//                      itself a finding (does smarter compaction beat the shipped one?).
//
// HONESTY: this is SCIENCE — the goal is an honest measurement, not to make Agix look good.
// We report per-regime native-correct vs managed-correct, the delta, and a one-line read
// (helped / neutral / HURT, and why). The pin-recent-drops-the-needle tension is the headline
// caveat and is surfaced explicitly in the output.
//
// SPEND: like the easy arm, this REQUIRES AGIX_BENCH_PAID=1 to make any model call. With no
// flag it prints the scenario count + the exact paid-call count and exits 0 (no model call).

import { analyzeContext } from '../../agents/context-warden/agent.mjs';
import { wardenStep } from '../../lib/agix-warm-context.mjs';
import { readFileSync } from 'node:fs';

const EFF_TABLE = JSON.parse(readFileSync(new URL('../../agents/context-warden/effective-length.json', import.meta.url)));
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'; // effective 6000 tokens — the degrade regime starts well below this

// ─── Filler generator ───────────────────────────────────────────────────────────────────────
// Realistic, varied infra-log distractor lines. Varied (not a single repeated line) so they
// read like a real growing context rather than tripping the duplicate-line detector — these
// are LENGTH/lost-in-the-middle distractors, not duplication distractors. `seed` makes each
// scenario's filler distinct so the body is genuinely long & heterogeneous.
function fillerLines(count, seed = 0) {
  const verbs = ['recorded', 'observed', 'logged', 'noted', 'reported', 'captured', 'measured', 'sampled'];
  const subjects = ['the ingest worker', 'the scheduler', 'the cache layer', 'the egress proxy', 'the metrics pipeline',
    'the replica set', 'the queue consumer', 'the build runner', 'the audit sink', 'the rate limiter'];
  const metrics = ['p50 latency', 'queue depth', 'cache hit-rate', 'error budget', 'CPU headroom', 'GC pause',
    'connection pool usage', 'retry count', 'backlog size', 'heartbeat interval'];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const k = (i + seed * 7) % subjects.length;
    const v = (i + seed * 3) % verbs.length;
    const m = (i + seed * 5) % metrics.length;
    lines.push(
      `Telemetry ${seed}.${i}: ${subjects[k]} ${verbs[v]} nominal ${metrics[m]} during window ${1000 + i}; ` +
      `no anomaly on shard ${seed}-${i}, run id r${seed}${i}${i}. This line is unrelated to the question and is pure distractor padding.`);
  }
  return lines;
}

// Estimate tokens the same way context-warden does, so the "how long is this" numbers we
// report match the warden's own occupancy math (no second, divergent estimator).
function estTokens(text) {
  const a = analyzeContext({ text, modelId: DEFAULT_MODEL_ID, table: EFF_TABLE, thresholds: {} });
  return a.tokens;
}

// ─── Scenario corpus — 15 scenarios across the three regimes ──────────────────────────────────
//
// Each scenario is a list of `items` (oldest → newest), mirroring a warm-worker's accumulated
// context. `needleIndex` marks WHERE the authoritative fact lives (middle for lost-in-the-middle,
// last for the contradiction regimes) — used only for reporting/diagnostics, never fed to the model.
// `expected` is the single correct current value; `accept` is the set of accepted answer forms.

// Lost-in-the-middle: the needle sits in the MIDDLE of a long filler body. There is NO later
// contradiction — the needle is simply the only relevant line, buried. The current correct answer
// IS the needle. pin-recent compaction will DROP it (it's not most-recent); keyword-aware should keep it.
function lostInMiddle({ id, question, expected, accept, needle, preFiller, postFiller, seed }) {
  const pre = fillerLines(preFiller, seed);
  const post = fillerLines(postFiller, seed + 100);
  const items = [...pre, needle, ...post];
  return { id, regime: 'lost-in-the-middle', question, expected, accept, items, needleIndex: pre.length };
}

// Marker contradiction: early fact, long filler, then an EXPLICIT override line (supersedes /
// migrated to / corrected to). The current correct answer is the override (most-recent) value.
function markerContradiction({ id, question, expected, accept, early, filler, override, seed }) {
  const items = [early, ...fillerLines(filler, seed), override];
  return { id, regime: 'marker-contradiction', question, expected, accept, items, needleIndex: 1 + filler };
}

// Markerless contradiction: two conflicting statements with NO override words. The reader must
// infer the current value from DATES or ORDERING (the later-dated / later-positioned one wins).
// context-warden's marker screen will MISS this (no override markers) — that's the honest test.
function markerlessContradiction({ id, question, expected, accept, earlyDated, filler, lateDated, seed }) {
  const items = [earlyDated, ...fillerLines(filler, seed), lateDated];
  return { id, regime: 'markerless-contradiction', question, expected, accept, items, needleIndex: 1 + filler };
}

export const hardScenarios = [
  // ── Regime 1: lost-in-the-middle (needle buried mid-body; long context) ──────────────────────
  lostInMiddle({
    id: 'lim-license-key-id', seed: 1,
    question: 'What is the internal license identifier for the Helios module? Answer with only the identifier.',
    expected: 'HLX-7731', accept: ['hlx-7731', 'hlx 7731', 'hlx7731'],
    needle: 'Provisioning record: the Helios module was assigned internal license identifier HLX-7731 at onboarding.',
    preFiller: 120, postFiller: 120,
  }),
  lostInMiddle({
    id: 'lim-port-number', seed: 2,
    question: 'On which TCP port does the Atlas sidecar listen? Answer with only the port number.',
    expected: '8443', accept: ['8443'],
    needle: 'Config fact: the Atlas sidecar binds and listens on TCP port 8443 in every environment.',
    preFiller: 150, postFiller: 90,
  }),
  lostInMiddle({
    id: 'lim-bucket-name', seed: 3,
    question: 'What is the name of the GCS bucket used for Nimbus cold storage? Answer with only the bucket name.',
    expected: 'nimbus-cold-archive-9', accept: ['nimbus-cold-archive-9', 'nimbus cold archive 9'],
    needle: 'Storage note: Nimbus cold storage is the GCS bucket named nimbus-cold-archive-9, set up by the platform team.',
    preFiller: 200, postFiller: 60,
  }),
  lostInMiddle({
    id: 'lim-owner-name', seed: 4,
    question: 'Who is listed as the technical contact for the Vega service? Answer with only the name.',
    expected: 'priya', accept: ['priya'],
    needle: 'Directory entry: the technical contact of record for the Vega service is priya, per the service catalog.',
    preFiller: 100, postFiller: 140,
  }),
  lostInMiddle({
    id: 'lim-timeout-value', seed: 5,
    question: 'What is the client read timeout in seconds for the Cygnus gateway? Answer with only the number.',
    expected: '37', accept: ['37', '37s', '37 seconds'],
    needle: 'Gateway setting: the Cygnus gateway client read timeout is configured to 37 seconds.',
    preFiller: 130, postFiller: 130,
  }),

  // ── Regime 2: marker contradiction (explicit supersede; warden SHOULD catch) ─────────────────
  markerContradiction({
    id: 'mc-region', seed: 11,
    question: 'What is the CURRENT deployment region for cluster Orion? Answer with only the region code.',
    expected: 'eu-central-1', accept: ['eu-central-1', 'eu central 1', 'eucentral1'],
    early: 'Infra note: cluster Orion runs in region us-west-3 per the original provisioning ticket.',
    override: 'MIGRATION 2026-05: cluster Orion was migrated to eu-central-1, which supersedes the earlier us-west-3 value. eu-central-1 is now the live region.',
    filler: 140,
  }),
  markerContradiction({
    id: 'mc-endpoint', seed: 12,
    question: 'What is the CURRENT API endpoint path for the billing service? Answer with only the path.',
    expected: '/v2/billing', accept: ['/v2/billing', 'v2/billing'],
    early: 'Spec draft: the billing service is reachable at /v1/billing.',
    override: 'Correction: the billing endpoint was changed to /v2/billing; the old /v1/billing path is no longer valid and returns 410.',
    filler: 160,
  }),
  markerContradiction({
    id: 'mc-owner', seed: 13,
    question: 'Who is the CURRENT owner of the payments component? Answer with only the name.',
    expected: 'bob', accept: ['bob'],
    early: 'Org chart: the payments component owner is alice.',
    override: 'UPDATE: ownership of payments was handed off — it now points to bob, which overrides the earlier owner.',
    filler: 120,
  }),
  markerContradiction({
    id: 'mc-threshold', seed: 14,
    question: 'What is the CURRENT autoscaler CPU target percentage for the web tier? Answer with only the number.',
    expected: '65', accept: ['65', '65%', '65 percent'],
    early: 'Runbook: the web-tier autoscaler CPU target is set to 80.',
    override: 'Revised: the web-tier CPU target was changed to 65; disregard the previous 80 value.',
    filler: 180,
  }),
  markerContradiction({
    id: 'mc-secret-rotation', seed: 15,
    question: 'What is the CURRENT signing-key alias for the token service? Answer with only the alias.',
    expected: 'sigkey-v4', accept: ['sigkey-v4', 'sigkey v4', 'sigkeyv4'],
    early: 'Key registry: the token service signs with alias sigkey-v2.',
    override: 'Rotation complete: the token service signing key was rotated to sigkey-v4; sigkey-v2 is retired and must not be used.',
    filler: 150,
  }),

  // ── Regime 3: markerless contradiction (no override words; infer from dates/order) ───────────
  markerlessContradiction({
    id: 'ml-version-by-date', seed: 21,
    question: 'What is the production version of the Pulsar service as of the latest note? Answer with only the version.',
    expected: '3.2.0', accept: ['3.2.0', 'v3.2.0'],
    earlyDated: 'Release log 2026-01-10: Pulsar production is running version 2.8.1.',
    lateDated: 'Release log 2026-06-02: Pulsar production is running version 3.2.0.',
    filler: 150,
  }),
  markerlessContradiction({
    id: 'ml-quota-by-date', seed: 22,
    question: 'What is the current monthly API quota for the partner tier? Answer with only the number.',
    expected: '500000', accept: ['500000', '500,000', '500k'],
    earlyDated: 'Pricing memo dated 2025-11: the partner-tier monthly API quota is 200000 requests.',
    lateDated: 'Pricing memo dated 2026-05: the partner-tier monthly API quota is 500000 requests.',
    filler: 170,
  }),
  markerlessContradiction({
    id: 'ml-contact-by-order', seed: 23,
    question: 'Per the most recent on-call entry, who is the on-call engineer for the storage team? Answer with only the name.',
    expected: 'dana', accept: ['dana'],
    earlyDated: 'On-call rotation entry (week 1): the storage team on-call engineer is sam.',
    lateDated: 'On-call rotation entry (week 9, most recent): the storage team on-call engineer is dana.',
    filler: 130,
  }),
  markerlessContradiction({
    id: 'ml-host-by-date', seed: 24,
    question: 'What is the current database host for the analytics warehouse as of the newest entry? Answer with only the hostname.',
    expected: 'warehouse-db-02', accept: ['warehouse-db-02', 'warehouse db 02'],
    earlyDated: 'Infra inventory 2026-02: the analytics warehouse uses database host warehouse-db-01.',
    lateDated: 'Infra inventory 2026-06: the analytics warehouse uses database host warehouse-db-02.',
    filler: 160,
  }),
  markerlessContradiction({
    id: 'ml-replicas-by-date', seed: 25,
    question: 'What is the current replica count for the search index as of the latest capacity review? Answer with only the number.',
    expected: '12', accept: ['12'],
    earlyDated: 'Capacity review Q1 2026: the search index runs with 6 replicas.',
    lateDated: 'Capacity review Q3 2026 (latest): the search index runs with 12 replicas.',
    filler: 140,
  }),
];

// ─── Managed compaction strategies ─────────────────────────────────────────────────────────────
//
// pin-recent: the SHIPPED policy (wardenStep). Compacts on a warden trip, keeping only the
// most-recent item. Correct for supersede cases; DROPS a mid-body needle (the honest weakness).
export function compactPinRecent(items, modelId = DEFAULT_MODEL_ID) {
  const step = wardenStep(items, { modelId });
  return {
    strategy: 'pin-recent',
    compacted: step.shouldCompact,
    kept: step.shouldCompact ? step.kept : items,
    dropped: step.shouldCompact ? step.dropped : 0,
    flags: step.flags,
    tier: step.tier,
  };
}

// keyword-aware: a SMARTER compaction. Same warden TRIGGER (compact when the warden trips), but
// instead of blindly pinning the most-recent, it keeps every line that overlaps the QUESTION's
// content keywords PLUS the most-recent item (the likely authoritative override), and drops only
// the keyword-poor distractor filler. Goal: recover the lost-in-the-middle needle while still
// keeping the supersede line. We report it SEPARATELY so "does smarter compaction beat the shipped
// pin-recent?" is itself a measured finding — not an assumption.
//
// SINGLE SOURCE OF TRUTH (2026-06): the relevance-aware compaction now LIVES in wardenStep — the
// warm worker (`agix agent serve`) and this benchmark exercise the exact same algorithm. We pass
// the question as the `query` hint and wardenStep does the word-boundary keyword retention UNION
// the most-recent item internally. So "keyword-aware" is no longer a benchmark-only experiment:
// it IS the shipped wardenStep behavior when a query is supplied. The word-boundary matcher (so
// 'note' does not false-match 'noted' in filler — a real pitfall we hit, substring kept ~19 noise
// lines) and the stopword list moved into lib/agix-warm-context.mjs with the algorithm.
export function compactKeywordAware(items, question, modelId = DEFAULT_MODEL_ID) {
  const step = wardenStep(items, { modelId, query: question });
  return {
    strategy: 'keyword-aware',
    compacted: step.shouldCompact,
    kept: step.shouldCompact ? step.kept : items,
    dropped: step.shouldCompact ? step.dropped : 0,
    flags: step.flags,
    tier: step.tier,
  };
}

// ─── Diagnostics computable WITHOUT a model (verifiable in the no-spend path) ───────────────────
// For each scenario, did each managed strategy KEEP the authoritative needle line? This is the
// crux of the pin-recent tension and we can prove it deterministically, with zero spend.
export function describeScenarios(scenarios = hardScenarios, modelId = DEFAULT_MODEL_ID) {
  return scenarios.map((sc) => {
    const fullText = sc.items.join('\n\n');
    const tokens = estTokens(fullText);
    const needle = sc.items[sc.needleIndex];
    const pin = compactPinRecent(sc.items, modelId);
    const kwa = compactKeywordAware(sc.items, sc.question, modelId);
    const pinKeepsNeedle = pin.kept.includes(needle);
    const kwaKeepsNeedle = kwa.kept.includes(needle);
    return {
      id: sc.id, regime: sc.regime, expected: sc.expected,
      items: sc.items.length, tokens,
      effective: EFF_TABLE.models?.[modelId]?.effective ?? EFF_TABLE.default.effective,
      occupancyX: +(tokens / (EFF_TABLE.models?.[modelId]?.effective ?? EFF_TABLE.default.effective)).toFixed(1),
      flags: pin.flags,
      pin: { compacted: pin.compacted, kept: pin.kept.length, dropped: pin.dropped, keepsNeedle: pinKeepsNeedle },
      kwa: { compacted: kwa.compacted, kept: kwa.kept.length, dropped: kwa.dropped, keepsNeedle: kwaKeepsNeedle },
    };
  });
}

// ─── The paid arm — runs ONLY when a model adapter is provided AND spend is acknowledged ────────
// Three model calls per scenario: native, managed/pin-recent, managed/keyword-aware.
export async function runHardManagedVsNative({ model, scenarios = hardScenarios, modelId = DEFAULT_MODEL_ID } = {}) {
  if (!model) return { ran: false, reason: 'no model adapter — provide one to measure the hard managed-vs-native delta' };

  const perScenario = [];
  for (const sc of scenarios) {
    const nativeContext = sc.items.join('\n\n');
    const nativeAns = await askModel(model, modelId, nativeContext, sc.question);
    const nativeOk = scoreAnswer(nativeAns, sc.accept);

    const pin = compactPinRecent(sc.items, modelId);
    const pinAns = await askModel(model, modelId, pin.kept.join('\n\n'), sc.question);
    const pinOk = scoreAnswer(pinAns, sc.accept);

    const kwa = compactKeywordAware(sc.items, sc.question, modelId);
    const kwaAns = await askModel(model, modelId, kwa.kept.join('\n\n'), sc.question);
    const kwaOk = scoreAnswer(kwaAns, sc.accept);

    perScenario.push({
      id: sc.id, regime: sc.regime, expected: sc.expected,
      native: { answer: clip(nativeAns), correct: nativeOk },
      pin: { answer: clip(pinAns), correct: pinOk, compacted: pin.compacted, dropped: pin.dropped },
      kwa: { answer: clip(kwaAns), correct: kwaOk, compacted: kwa.compacted, dropped: kwa.dropped },
    });
  }
  return { ran: true, n: scenarios.length, perScenario, byRegime: aggregateByRegime(perScenario) };
}

function aggregateByRegime(perScenario) {
  const groups = {};
  for (const r of perScenario) {
    const g = (groups[r.regime] ||= { regime: r.regime, n: 0, native: 0, pin: 0, kwa: 0 });
    g.n++; if (r.native.correct) g.native++; if (r.pin.correct) g.pin++; if (r.kwa.correct) g.kwa++;
  }
  return Object.values(groups).map((g) => ({
    ...g,
    deltaPin: g.pin - g.native,
    deltaKwa: g.kwa - g.native,
    readPin: honestRead(g.pin - g.native),
    readKwa: honestRead(g.kwa - g.native),
  }));
}

function honestRead(delta) { return delta > 0 ? 'helped' : delta < 0 ? 'HURT' : 'neutral'; }

// Ask the model a question grounded in a context block; return the trimmed text answer.
// Mirrors score.mjs askModel — same neutral "most-recent is current" instruction.
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
    agent: 'reliability-bench-hard',
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Correct iff any accepted form appears in the answer (case-insensitive, punctuation-tolerant).
function scoreAnswer(answer, accept) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
  const a = norm(answer);
  return accept.some((form) => a.includes(norm(form)));
}

function clip(s, n = 80) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Calls one paid arm makes: native + pin-recent + keyword-aware per scenario.
export const PAID_CALLS_PER_SCENARIO = 3;
export function paidCallCount(scenarios = hardScenarios) { return scenarios.length * PAID_CALLS_PER_SCENARIO; }

// ─── Printers (shared by the sibling --closed-loop-hard flag in score.mjs) ──────────────────────

// No-spend diagnostics: prints the scenario design + the deterministic needle-retention table,
// then the spend-gate "ready — N paid calls" message. Makes NO model call.
export function printHardReadyMessage({ provider = 'anthropic', scenarios = hardScenarios, modelId = DEFAULT_MODEL_ID } = {}) {
  const rows = describeScenarios(scenarios, modelId);
  const byRegime = {};
  for (const r of rows) (byRegime[r.regime] ||= []).push(r);

  console.log('\n── Hard closed-loop arm (managed vs native — degrade regime) ──');
  console.log(`scenarios: ${scenarios.length}  ·  model ${modelId} (effective ${rows[0]?.effective} tokens)  ·  3 arms: native, managed/pin-recent, managed/keyword-aware\n`);

  for (const [regime, list] of Object.entries(byRegime)) {
    const minTok = Math.min(...list.map((r) => r.tokens));
    const maxTok = Math.max(...list.map((r) => r.tokens));
    console.log(`  ${regime}  (n=${list.length}, context ${minTok}–${maxTok} tok ≈ ${list[0].occupancyX}–${Math.max(...list.map((r) => r.occupancyX))}× effective)`);
    for (const r of list) {
      console.log(
        `    ${r.id.padEnd(22)} ${String(r.tokens).padStart(6)} tok  flags=[${r.flags.join(',') || 'none'}]` +
        `  pin:${r.pin.compacted ? `compact -${r.pin.dropped}` : 'no-compact'}/needle=${r.pin.keepsNeedle ? 'KEPT' : 'DROPPED'}` +
        `  kwa:${r.kwa.compacted ? `compact -${r.kwa.dropped}` : 'no-compact'}/needle=${r.kwa.keepsNeedle ? 'KEPT' : 'DROPPED'}`);
    }
  }

  // The deterministic crux — provable with zero spend: where does naive pin-recent drop the
  // needle, and does the relevance-aware wardenStep (query-hinted) now KEEP it? This is the bug
  // fixed: wardenStep with a query is relevance-aware, so the buried needle survives compaction.
  const pinDropsNeedle = rows.filter((r) => r.pin.compacted && !r.pin.keepsNeedle);
  const kwaKeepsWherePinDrops = pinDropsNeedle.filter((r) => r.kwa.keepsNeedle);
  console.log(`\n  [deterministic, no-spend] naive pin-recent DROPS the needle in ${pinDropsNeedle.length}/${scenarios.length} scenarios` +
    `${pinDropsNeedle.length ? ` (${pinDropsNeedle.map((r) => r.id).join(', ')})` : ''}.`);
  console.log(`  [deterministic, no-spend] relevance-aware wardenStep(query=…) KEEPS the needle in ${kwaKeepsWherePinDrops.length}/${pinDropsNeedle.length} of those — the lost-in-the-middle bug is FIXED at the source.`);
  const markerless = rows.filter((r) => r.regime === 'markerless-contradiction');
  const markerlessNoFlag = markerless.filter((r) => !r.flags.includes('contradiction-suspected'));
  console.log(`  [deterministic, no-spend] warden's marker screen MISSES the contradiction in ${markerlessNoFlag.length}/${markerless.length} markerless scenarios (no override words) — an honest limit of the deterministic screen.`);

  const n = paidCallCount(scenarios);
  console.log(
    `\nready — provider="${provider}" key configured; this arm makes ~${n} paid API calls ` +
    `(${scenarios.length} scenarios × ${PAID_CALLS_PER_SCENARIO} arms).\n` +
    `  Re-run to spend:  AGIX_BENCH_PAID=1 node bench/reliability/score.mjs --closed-loop-hard`);
}

// Paid result printer — per-scenario rows + per-regime aggregate + honest reads.
export function printHardResults(out, { provider = 'anthropic' } = {}) {
  const tag = (ok) => (ok ? '✓' : '✗');
  for (const r of out.perScenario) {
    console.log(
      `  ${r.id.padEnd(22)} [${r.regime}] expected=${r.expected}\n` +
      `      native ${tag(r.native.correct)} (${r.native.answer})\n` +
      `      pin    ${tag(r.pin.correct)}${r.pin.compacted ? ` [-${r.pin.dropped}]` : ''} (${r.pin.answer})\n` +
      `      kwa    ${tag(r.kwa.correct)}${r.kwa.compacted ? ` [-${r.kwa.dropped}]` : ''} (${r.kwa.answer})`);
  }
  console.log(`\nHard closed-loop — provider=${provider}  n=${out.n}\n`);
  console.log('  regime                      n  native  pin   kwa   Δpin  Δkwa  read(pin)  read(kwa)');
  console.log('  ' + '─'.repeat(86));
  let tN = 0, tNat = 0, tPin = 0, tKwa = 0;
  for (const g of out.byRegime) {
    tN += g.n; tNat += g.native; tPin += g.pin; tKwa += g.kwa;
    console.log(
      `  ${g.regime.padEnd(26)} ${String(g.n).padStart(2)}  ${String(g.native).padStart(5)}  ` +
      `${String(g.pin).padStart(4)}  ${String(g.kwa).padStart(4)}  ` +
      `${(g.deltaPin >= 0 ? '+' : '') + g.deltaPin}`.padStart(5) + `  ` +
      `${(g.deltaKwa >= 0 ? '+' : '') + g.deltaKwa}`.padStart(5) + `  ` +
      `${g.readPin.padEnd(9)}  ${g.readKwa}`);
  }
  console.log('  ' + '─'.repeat(86));
  console.log(
    `  ${'TOTAL'.padEnd(26)} ${String(tN).padStart(2)}  ${String(tNat).padStart(5)}  ` +
    `${String(tPin).padStart(4)}  ${String(tKwa).padStart(4)}  ` +
    `${(tPin - tNat >= 0 ? '+' : '') + (tPin - tNat)}`.padStart(5) + `  ` +
    `${(tKwa - tNat >= 0 ? '+' : '') + (tKwa - tNat)}`.padStart(5));
  console.log('\n  Honest read: management HELPS only where it preserves the answer-bearing line AND the');
  console.log('  native model would otherwise lose it. pin-recent helps supersede cases but can HURT');
  console.log('  lost-in-the-middle (it drops the mid-body needle); keyword-aware is the attempt to fix that.');
}
