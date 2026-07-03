// Agix Investigator — agent logic. The root-cause debugger for consistent quality.
//
// Invoked via `agix agent run investigator`. Given a failure signal it runs
// a structured root-cause investigation and writes a DIAGNOSIS — it FINDS
// the root cause; it never patches source. The Iron Law (the proving
// ground's dev-side twin of "pattern memory is a cache"): no fix without
// identifying the root cause first. The investigator's whole job is the
// first half of that law.
//
// One run:
//
//   1. Acquire a failure signal, in priority order:
//        a) --input <file>          an explicit log / error dump / report
//        b) the tester's latest report under wiki/tester/reports/
//        c) canned signal (smoke / --canned) so the agent runs clean with
//           no live failure to chew on.
//   2. Run a structured FOUR-PHASE pass — investigate -> analyze ->
//      hypothesize -> (diagnose). Real multi-step reasoning via
//      runtime.getModel() when a key is present; a deterministic skeleton
//      (heuristic hypotheses + the same structure) when not. Either way the
//      structure is code-owned ground truth; the LLM reasons WITHIN it.
//   3. Write a NARRATOR-pattern diagnosis to
//      wiki/investigator/diagnoses/<date>.md: a deterministic structure
//      (symptom / reproduction / ranked hypotheses / identified root cause /
//      proposed fix direction / confidence) with a cheap LLM TL;DR prepend
//      that never authors the structure.
//   4. Track each symptom by a DETERMINISTIC fingerprint (readState/
//      writeState). On a recurrence, RE-VERIFY the live signal against the
//      cached root cause; if the cause has drifted, surface
//      "this symptom's root cause has changed since last time" rather than
//      re-serving the stale cache. Pattern memory is a cache, not truth.
//
// Trust level: proposer. The investigator proposes a fix DIRECTION pinned to
// the root cause; it never proposes a concrete patch and never edits source.
// Pairing: tester SURFACES a failure -> investigator DIAGNOSES it ->
// a human/executor FIXES it (routing the fix through the normal gate).
//
// Flags:
//   --input <file>      Investigate this log / error dump / report file.
//   --canned            Use the built-in canned signal (no --input, no tester
//                       report). Implied in smoke mode.
//   --no-narrate        Skip the LLM TL;DR; write the deterministic diagnosis only.
//   --no-reason         Skip the LLM reasoning pass; use the deterministic
//                       skeleton (heuristic hypotheses) only.
//   --dry-run           Compose the diagnosis + print to stdout; write nothing,
//                       touch no state.
//   --reset             Clear the symptom tracker before this run.
//   --date <YYYY-MM-DD> Override the date in the diagnosis filename.
//
// Persona / spec: agents/investigator/PERSONA.md
// Manifest:       agents/investigator/manifest.yaml
// Lineage:        wiki/research/agentic-discoveries-2026-06-18.md
//                 (the Iron Law: no fix without root cause; pattern-memory-
//                  is-a-cache verification; the narrator pattern; recurrence).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';

const DIAGNOSIS_REL_DIR = 'wiki/investigator/diagnoses';
const SYMPTOM_STATE = 'symptoms';

// The four phases of a root-cause investigation (mirrors the /investigate
// skill's investigate -> analyze -> hypothesize -> implement, but the
// investigator STOPS before implement — that's the executor's job).
const PHASES = ['investigate', 'analyze', 'hypothesize'];

export async function run({ runtime, opts = {}, manifest } = {}) {
  const defaults = manifest?.defaults || {};

  const o = {
    input: typeof opts.input === 'string' ? opts.input : null,
    canned: Boolean(opts.canned) || Boolean(runtime.smoke),
    noNarrate: Boolean(opts.noNarrate),
    noReason: Boolean(opts.noReason),
    dryRun: Boolean(opts.dryRun),
    reset: Boolean(opts.reset),
    date: opts.date || new Date().toISOString().slice(0, 10),
  };

  const REASON_MODEL = defaults.reason_model || 'claude-sonnet-4-6';
  const NARRATOR_MODEL = defaults.narrator_model || 'claude-haiku-4-5';
  const TESTER_REPORTS_DIR = defaults.tester_reports_dir || 'wiki/tester/reports';
  const RECURRENCE_THRESHOLD = Number(defaults.recurrence_threshold ?? 3);

  // ── Smoke short-circuit ──────────────────────────────────────────
  // A real investigation may legitimately reason at length, so smoke must
  // not depend on the live reasoning loop. Exercise the model surface (so
  // the ledger path is verified), run the deterministic root-cause skeleton
  // against a canned signal (no live model dependency for correctness),
  // compose the diagnosis against the smoke write-root, round-trip the
  // symptom state, and return a synthetic pass. Mirrors tester/git-orch.
  if (runtime.smoke) {
    const smokeModel = runtime.getModel();
    for (const capability of ['default-quality', 'cheap-classification']) {
      await smokeModel.chat({
        capability,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'smoke' }],
        agent: 'investigator',
      });
    }

    const signal = cannedSignal();
    const analysis = deterministicAnalysis(signal);
    const fp = fingerprintSymptom(signal);
    const symptomRec = {
      fingerprint: fp,
      slug: slugForSignal(signal),
      signature: normalizeSignature(signal.summary),
      first_seen: o.date,
      last_seen: o.date,
      hit_count: 1,
      status: 'tentative_1',
      identified_root_cause: analysis.rootCause.cause,
      confidence: analysis.rootCause.confidence,
    };
    const diagnosis = composeDiagnosis({
      date: o.date,
      signal,
      analysis,
      narrative: '_(smoke — narrator skipped)_',
      symptomRec,
      drift: null,
      reasoned: false,
    });
    await runtime.writeRepoFile(`${DIAGNOSIS_REL_DIR}/${o.date}.md`, diagnosis);

    // Exercise the state round-trip on the sandboxed smoke path.
    await runtime.writeState(SYMPTOM_STATE, { symptoms: { [fp]: symptomRec } });
    await runtime.readState(SYMPTOM_STATE, { symptoms: {} });

    console.log(
      `[smoke] investigator short-circuit · model + deterministic root-cause pass ` +
      `(${analysis.hypotheses.length} hypotheses) + diagnosis composition + state round-trip verified`,
    );
    return { diagnosed: true, root_cause_identified: Boolean(analysis.rootCause.cause), smoke: true };
  }

  // ── 1. Acquire the failure signal ────────────────────────────────
  const signal = await acquireSignal(runtime, o, TESTER_REPORTS_DIR);
  console.log(`Investigator — signal: ${signal.source} · "${truncate(signal.summary, 80)}"`);

  // ── 2. Structured four-phase root-cause pass ─────────────────────
  // The deterministic skeleton always runs (it owns the structure +
  // heuristic hypotheses); the LLM reasoning enriches it when available.
  let analysis = deterministicAnalysis(signal);
  let reasoned = false;
  if (!o.noReason) {
    try {
      const reasoned_ = await reasonRootCause(runtime, REASON_MODEL, signal, analysis);
      if (reasoned_) { analysis = reasoned_; reasoned = true; }
    } catch (err) {
      console.warn(`Reasoning pass errored (continuing with deterministic skeleton): ${err.message}`);
    }
  }
  console.log(
    `Analysis · ${analysis.hypotheses.length} ranked hypothesis(es) · ` +
    `root cause: ${analysis.rootCause.cause ? `"${truncate(analysis.rootCause.cause, 60)}"` : 'NOT YET IDENTIFIED'} ` +
    `· confidence ${analysis.rootCause.confidence}`,
  );

  // ── 3. Symptom tracking + cache-drift re-verification ────────────
  let symptomRec = null;
  let drift = null;
  if (!o.dryRun) {
    const tracked = await trackSymptom(runtime, signal, analysis, o, RECURRENCE_THRESHOLD);
    symptomRec = tracked.record;
    drift = tracked.drift;
    if (drift) {
      console.log(
        `! cache drift on \`${symptomRec.slug}\` (seen ${symptomRec.hit_count}x): ` +
        `cached root cause "${truncate(drift.cached || '(none)', 50)}" ` +
        `diverged from live "${truncate(drift.observed || '(none)', 50)}" — surfacing the change, not re-serving the cache`,
      );
    }
  } else {
    // Dry-run still computes the record shape (for the report) without persisting.
    symptomRec = projectSymptomRecord(signal, analysis, o.date);
  }

  // ── 4. Narrator TL;DR (cheap LLM prepend; never authors the structure) ─
  let narrative = '_(narrator skipped)_';
  if (!o.noNarrate) {
    try {
      narrative = await narrateTldr(runtime.getModel(), signal, analysis, symptomRec, drift, NARRATOR_MODEL);
    } catch (err) {
      console.warn(`Narrator pass errored (continuing with deterministic diagnosis only): ${err.message}`);
      narrative = `_(narrator pass failed: ${escapeMd(err.message)} — deterministic diagnosis below is authoritative)_`;
    }
  }

  // ── 5. Compose + write the diagnosis ─────────────────────────────
  const diagnosis = composeDiagnosis({
    date: o.date, signal, analysis, narrative, symptomRec, drift, reasoned,
  });

  if (o.dryRun) {
    console.log('\n────────── DIAGNOSIS (dry-run, not written) ──────────\n');
    console.log(diagnosis);
    return { diagnosed: true, root_cause_identified: Boolean(analysis.rootCause.cause), dryRun: true };
  }

  const relPath = `${DIAGNOSIS_REL_DIR}/${o.date}.md`;
  await runtime.writeRepoFile(relPath, diagnosis);
  runtime.recordFileWritten?.(relPath);
  if (drift) runtime.recordDecision?.({ kind: 'drift', name: `cache-drift:${symptomRec.slug}` });
  console.log(`✓ Diagnosis written: ${relPath}`);

  return {
    diagnosed: true,
    root_cause_identified: Boolean(analysis.rootCause.cause),
    confidence: analysis.rootCause.confidence,
    hypotheses: analysis.hypotheses.length,
    symptom_hit_count: symptomRec?.hit_count ?? 1,
    cache_drift: Boolean(drift),
  };
}

// ─── 1. Signal acquisition ───────────────────────────────────────────
//
// Priority: explicit --input file > the tester's latest report > canned.
// A signal is { source, summary, raw, failures }. `summary` is the
// one-line headline used for fingerprinting; `raw` is the body the
// reasoning pass reads; `failures` is a best-effort list of named failures
// pulled from a tester report (so a multi-failure report becomes a
// multi-clue signal).

async function acquireSignal(runtime, o, testerReportsDir) {
  if (o.canned) return cannedSignal();

  if (o.input) {
    const raw = await readInputFile(runtime, o.input);
    return {
      source: `--input ${o.input}`,
      summary: firstMeaningfulLine(raw) || `failure signal from ${o.input}`,
      raw: raw.slice(0, 16_000),
      failures: extractNamedFailures(raw),
    };
  }

  const latest = findLatestTesterReport(runtime, testerReportsDir);
  if (latest) {
    const raw = await runtime.readRepoFile(latest.relPath);
    const failures = extractNamedFailures(raw);
    return {
      source: `tester report ${latest.relPath}`,
      summary: failures.length
        ? `${failures.length} failing test(s) in ${latest.relPath}: ${failures[0]}`
        : `tester report ${latest.relPath}`,
      raw: raw.slice(0, 16_000),
      failures,
    };
  }

  // Nothing to investigate — degrade to the canned signal so the run is
  // clean and the operator gets a "no live signal" diagnosis frame.
  const c = cannedSignal();
  c.source = 'no live signal (no --input, no tester report) — canned demo signal';
  return c;
}

async function readInputFile(runtime, inputPath) {
  // Accept absolute paths and repo-relative paths.
  if (inputPath.startsWith('/') && existsSync(inputPath)) {
    return readFile(inputPath, 'utf8');
  }
  const full = runtime.resolveRepoPath(inputPath);
  if (!existsSync(full)) {
    throw new Error(`--input file not found: ${inputPath} (resolved ${full})`);
  }
  return readFile(full, 'utf8');
}

// Find the most recent dated report under the tester's reports dir. Names
// are <YYYY-MM-DD>.md, so lexical sort == chronological.
function findLatestTesterReport(runtime, relDir) {
  const full = runtime.resolveRepoPath(relDir);
  if (!existsSync(full)) return null;
  let names;
  try { names = readdirSync(full); } catch { return null; }
  const dated = names
    .filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort();
  if (dated.length === 0) return null;
  const name = dated[dated.length - 1];
  return { relPath: `${relDir}/${name}`, name };
}

// Pull named failures out of a tester report or a raw log. Recognizes the
// tester report's `### N. \`name\`` failure headers and classic `not ok`
// TAP lines, then falls back to lines that look like errors.
export function extractNamedFailures(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (const line of lines) {
    let m = line.match(/^###\s+\d+\.\s+`([^`]+)`/);          // tester report failure header
    if (m) { out.push(m[1].trim()); continue; }
    m = line.match(/^not ok\s+\d+\s*-?\s*(.+)$/);            // TAP failure
    if (m && !/#\s*(SKIP|TODO)\b/i.test(m[1])) { out.push(m[1].trim()); continue; }
  }
  // De-dupe, cap.
  return [...new Set(out)].slice(0, 20);
}

function firstMeaningfulLine(text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('---') || t.startsWith('#')) continue;
    return t.slice(0, 200);
  }
  return null;
}

// ─── 2. Deterministic root-cause skeleton ────────────────────────────
//
// The code-owned ground truth: a structured analysis the LLM reasons
// WITHIN, never replaces. Even with no model key this produces a usable
// diagnosis frame — ranked heuristic hypotheses keyed off the signal text,
// plus a root-cause slot that stays honest ("not yet identified") unless
// the evidence supports a specific cause.
//
// Shape: { phases: {investigate, analyze, hypothesize}, hypotheses: [
//   { rank, hypothesis, evidence, test, likelihood } ], rootCause:
//   { cause, evidence, confidence } }.

function deterministicAnalysis(signal) {
  const sig = `${signal.summary}\n${signal.raw || ''}`.toLowerCase();

  // Heuristic hypothesis catalog — each entry pattern-matches the signal
  // and contributes a candidate cause with a likelihood. This is NOT the
  // answer; it is the structured starting frame an investigation refines.
  const catalog = [
    {
      match: /heap|out of memory|oom|allocation failed|fatal.*memory/,
      hypothesis: 'Memory exhaustion — the process ran out of heap.',
      evidence: 'Signal mentions heap / OOM / allocation failure.',
      test: 'Re-run with increased heap and capture peak RSS; bisect the input size that crosses the limit.',
      likelihood: 'high',
    },
    {
      match: /timed out|timeout|hung|deadline exceeded|etimedout|did not finish/,
      hypothesis: 'A wait exceeded its deadline — a hang or a slow dependency, not a logic error.',
      evidence: 'Signal mentions a timeout / hang / exceeded deadline.',
      test: 'Add timing around each await; identify which step never resolves; check for a missing await or an unresolved promise.',
      likelihood: 'high',
    },
    {
      match: /behind main|stale|out of date|update-branch|merge.*conflict|not up to date/,
      hypothesis: 'Stale branch — the failure is environmental drift, not the change under test.',
      evidence: 'Signal mentions being behind main / stale / out of date.',
      test: 'Rebase / update-branch onto the latest target and re-run; if green, the cause is drift, not the diff.',
      likelihood: 'medium',
    },
    {
      match: /undefined is not|cannot read propert|null pointer|typeerror|referenceerror|is not a function/,
      hypothesis: 'A null/undefined access — a contract assumption was violated upstream.',
      evidence: 'Signal carries a TypeError / null-access shape.',
      test: 'Trace the value back to its producer; assert the contract at the boundary; identify which caller passed the bad shape.',
      likelihood: 'medium',
    },
    {
      match: /econnrefused|connection refused|503|502|network|dns|unreachable|socket hang up/,
      hypothesis: 'A dependency was unreachable — a network / service availability failure, not the code.',
      evidence: 'Signal mentions a connection / network / 5xx failure.',
      test: 'Probe the dependency directly; check service health + the env config pointing at it; distinguish flaky from down.',
      likelihood: 'medium',
    },
    {
      match: /permission|forbidden|401|403|unauthor|access denied|credential/,
      hypothesis: 'An authorization / credential failure — missing or expired scope, not a logic bug.',
      evidence: 'Signal mentions a 401 / 403 / permission / credential failure.',
      test: 'Verify the credential is present and unexpired; diff the required scope against the granted scope.',
      likelihood: 'medium',
    },
    {
      match: /flak|intermittent|sometimes|race|nondeterministic|order-dependent/,
      hypothesis: 'A nondeterministic failure — ordering / shared-state pollution between units.',
      evidence: 'Signal mentions flakiness / intermittence / a race.',
      test: 'Run the failing unit in isolation and in a loop; if it only fails alongside others, suspect shared state / ordering.',
      likelihood: 'medium',
    },
  ];

  const hypotheses = [];
  for (const c of catalog) {
    if (c.match.test(sig)) {
      hypotheses.push({
        hypothesis: c.hypothesis, evidence: c.evidence, test: c.test, likelihood: c.likelihood,
      });
    }
  }

  // Always include a residual hypothesis so the frame is never empty — the
  // honest "we don't have enough signal yet" branch.
  if (hypotheses.length === 0) {
    hypotheses.push({
      hypothesis: 'Insufficient signal to localize the cause from the text alone.',
      evidence: 'No known failure shape matched the signal.',
      test: 'Reproduce locally with verbose logging; capture the full stack + the failing input; narrow to the smallest repro.',
      likelihood: 'unknown',
    });
  }

  // Rank: high > medium > low/unknown, stable within a tier.
  const tier = { high: 0, medium: 1, low: 2, unknown: 3 };
  hypotheses.sort((a, b) => (tier[a.likelihood] ?? 3) - (tier[b.likelihood] ?? 3));
  hypotheses.forEach((h, i) => { h.rank = i + 1; });

  // The Iron Law slot. A single high-likelihood hypothesis backed by a
  // matched shape is promoted to a tentative root cause with bounded
  // confidence; otherwise the cause stays NOT identified. The deterministic
  // pass never claims high confidence — that requires the reasoning pass or
  // a human to confirm against a real reproduction.
  const top = hypotheses[0];
  const highCount = hypotheses.filter(h => h.likelihood === 'high').length;
  const rootCause = (top && top.likelihood === 'high' && highCount === 1)
    ? { cause: top.hypothesis, evidence: top.evidence, confidence: 'low-medium (heuristic; confirm against a live reproduction)' }
    : { cause: null, evidence: 'No single dominant cause from the signal text; needs reproduction or deeper reasoning.', confidence: 'none (not yet identified)' };

  return {
    phases: {
      investigate: `Acquired the signal (${signal.source}) and extracted ${signal.failures?.length || 0} named failure(s). Read the summary + raw body for known failure shapes.`,
      analyze: `Pattern-matched the signal against ${catalog.length} known failure shapes; ${hypotheses.length} candidate(s) survived.`,
      hypothesize: `Ranked the candidates by likelihood and selected ${rootCause.cause ? 'a tentative root cause' : 'no dominant cause yet'}.`,
    },
    hypotheses,
    rootCause,
    proposedFixDirection: deriveFixDirection(rootCause, top),
  };
}

// The fix DIRECTION (never a concrete patch). Pinned to the root cause when
// identified; otherwise it points at the next investigative step.
function deriveFixDirection(rootCause, topHypothesis) {
  if (rootCause.cause) {
    return `Address the identified root cause, not the symptom: ${topHypothesis.test} Once the cause is confirmed against a live reproduction, route the concrete fix through the normal review gate. (Direction only — the investigator does not write the patch.)`;
  }
  return `Do NOT patch yet — the root cause is not yet identified (the Iron Law). Next step: ${topHypothesis?.test || 'reproduce locally with verbose logging and narrow to the smallest repro.'} Re-run the investigator on the richer signal.`;
}

// ─── 2b. LLM reasoning pass (enriches the skeleton) ──────────────────
//
// Real multi-step reasoning: the model walks the four phases over the
// signal and returns a structured analysis in the SAME shape as the
// deterministic skeleton. The structure is fixed by us (strict JSON
// contract); the model fills it with evidence-grounded reasoning. If the
// model output is unparseable or smoke-canned, we keep the deterministic
// skeleton — the structure is never at the LLM's mercy.

async function reasonRootCause(runtime, modelId, signal, skeleton) {
  const model = runtime.getModel();
  const sys = `You are the Agix Investigator's reasoning core — a forensic debugger. You investigate a failure signal and identify its ROOT CAUSE. You do NOT write fixes. The Iron Law: no fix without identifying the root cause first; your job is the FIND, not the fix.

Work the four phases, then return them:
1. investigate — what the signal actually says (the symptom), restated precisely. Distinguish symptom from cause.
2. analyze — what the evidence implies; what is consistent and what is contradicted.
3. hypothesize — 2-5 candidate root causes, each RANKED, each with the specific evidence for it and a concrete TEST that would confirm or refute it.
4. root cause — the single most-supported cause IF the evidence supports one. If it does not, say so honestly: leave the cause null and explain what evidence is missing. NEVER assert a cause you cannot tie to evidence in the signal.

Hard rules:
- A symptom is a clue, not a cause. The proposed fix DIRECTION must follow the cause, never the symptom.
- State confidence honestly: high only when a test would clearly confirm it; otherwise medium/low/none.
- Propose a fix DIRECTION (what to change conceptually), never a concrete patch or code.
- No em dashes. No filler. Builder-to-builder. Use ONLY evidence present in the signal.

Return strict JSON only, this exact shape:
{
  "phases": { "investigate": "<1-3 sentences>", "analyze": "<1-3 sentences>", "hypothesize": "<1 sentence overview>" },
  "hypotheses": [ { "rank": <int>, "hypothesis": "<one line>", "evidence": "<what in the signal supports it>", "test": "<how to confirm/refute>", "likelihood": "high|medium|low|unknown" } ],
  "rootCause": { "cause": "<the identified root cause, or null>", "evidence": "<the supporting evidence, or what is missing>", "confidence": "high|medium|low|none" },
  "proposedFixDirection": "<the direction a fix should take, pinned to the cause; NOT a patch>"
}`;

  const namedFailures = (signal.failures || []).length
    ? `\nNamed failures extracted:\n${signal.failures.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';

  const user = `Failure signal source: ${signal.source}
Summary: ${signal.summary}${namedFailures}

Raw signal (truncated):
${signal.raw || '(no raw body)'}

Heuristic hypotheses from a deterministic first pass (for reference; refine, confirm, or overturn them with the actual evidence):
${skeleton.hypotheses.map(h => `- (${h.likelihood}) ${h.hypothesis} — test: ${h.test}`).join('\n')}

Work the four phases and return the strict JSON.`;

  const resp = await model.chat({
    capability: 'default-quality',
    model: modelId,
    max_tokens: 1500,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'investigator',
  });
  const text = (resp.content || []).map(b => (b.type === 'text' ? b.text : '')).join('');
  // Smoke / canned -> keep the deterministic skeleton.
  if (!text || /\[smoke-mode/.test(text)) return null;

  const parsed = parseAnalysisJson(text);
  if (!parsed) return null;
  return normalizeAnalysis(parsed, skeleton);
}

function parseAnalysisJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Coerce a parsed LLM analysis into the canonical shape; fall back to the
// skeleton's fields where the model omitted them. The structure is ours.
function normalizeAnalysis(parsed, skeleton) {
  const hypotheses = Array.isArray(parsed.hypotheses) && parsed.hypotheses.length
    ? parsed.hypotheses
        .filter(h => h && typeof h.hypothesis === 'string')
        .map((h, i) => ({
          rank: Number.isInteger(h.rank) ? h.rank : i + 1,
          hypothesis: String(h.hypothesis),
          evidence: String(h.evidence || '(no evidence stated)'),
          test: String(h.test || '(no test stated)'),
          likelihood: ['high', 'medium', 'low', 'unknown'].includes(h.likelihood) ? h.likelihood : 'unknown',
        }))
        .sort((a, b) => a.rank - b.rank)
    : skeleton.hypotheses;

  const rc = parsed.rootCause || {};
  const causeRaw = rc.cause;
  const cause = (causeRaw && causeRaw !== 'null' && String(causeRaw).trim()) ? String(causeRaw).trim() : null;
  const confidence = ['high', 'medium', 'low', 'none'].includes(rc.confidence) ? rc.confidence : (cause ? 'medium' : 'none');

  return {
    phases: {
      investigate: String(parsed.phases?.investigate || skeleton.phases.investigate),
      analyze: String(parsed.phases?.analyze || skeleton.phases.analyze),
      hypothesize: String(parsed.phases?.hypothesize || skeleton.phases.hypothesize),
    },
    hypotheses,
    rootCause: {
      cause,
      evidence: String(rc.evidence || (cause ? '(evidence not restated)' : 'Root cause not identified; insufficient evidence in the signal.')),
      confidence,
    },
    proposedFixDirection: String(
      parsed.proposedFixDirection ||
      deriveFixDirection({ cause, confidence }, hypotheses[0]),
    ),
  };
}

// ─── 3. Symptom tracking (deterministic fingerprint + cache verification) ─
//
// State shape: { symptoms: { <fingerprint>: { slug, signature, first_seen,
// last_seen, hit_count, status, identified_root_cause, confidence } } }.
// A fingerprint is a sha256 of the NORMALIZED signal summary (IDs / SHAs /
// timestamps / numbers stripped) so the same logical symptom collapses to
// one key across runs.
//
// THE CACHE DISCIPLINE: on a recurrence, we re-verify the live signal's
// freshly-derived root cause against the cached one. If they diverge, we
// record the drift and surface "this symptom's root cause has changed" —
// we do NOT silently re-serve the stale cache. Pattern memory is a cache,
// not ground truth (the proving ground's PR #570 -> #588 lesson).

async function trackSymptom(runtime, signal, analysis, o, threshold) {
  const state = o.reset ? { symptoms: {} } : (await runtime.readState(SYMPTOM_STATE, null)) || { symptoms: {} };
  if (!state.symptoms) state.symptoms = {};

  const fp = fingerprintSymptom(signal);
  const observedCause = analysis.rootCause.cause || null;
  const prior = state.symptoms[fp];

  let drift = null;
  let record;
  if (prior) {
    prior.hit_count = (prior.hit_count || 1) + 1;
    prior.last_seen = o.date;
    prior.status = ladderStatus(prior.hit_count, threshold, prior.status);

    // Cache-drift check: only meaningful when BOTH a cached and a live
    // cause are present and they differ materially.
    const cachedCause = prior.identified_root_cause || null;
    if (observedCause && cachedCause && observedCause !== cachedCause) {
      drift = { cached: cachedCause, observed: observedCause };
      prior.cache_drift = true;
      // The live evidence wins — re-serving the stale cause is the bug.
      prior.identified_root_cause = observedCause;
      prior.confidence = analysis.rootCause.confidence;
      prior.status = 'amended_cache_drift';
    } else if (observedCause && !cachedCause) {
      // We finally identified a cause for a previously-unexplained symptom.
      prior.identified_root_cause = observedCause;
      prior.confidence = analysis.rootCause.confidence;
    }
    record = prior;
  } else {
    record = {
      fingerprint: fp,
      slug: slugForSignal(signal),
      signature: normalizeSignature(signal.summary),
      first_seen: o.date,
      last_seen: o.date,
      hit_count: 1,
      status: 'tentative_1',
      identified_root_cause: observedCause,
      confidence: analysis.rootCause.confidence,
      cache_drift: false,
    };
    state.symptoms[fp] = record;
  }

  await runtime.writeState(SYMPTOM_STATE, state);
  return { record, drift };
}

// Dry-run projection (no persistence) so the report can show the would-be record.
function projectSymptomRecord(signal, analysis, date) {
  return {
    fingerprint: fingerprintSymptom(signal),
    slug: slugForSignal(signal),
    signature: normalizeSignature(signal.summary),
    first_seen: date,
    last_seen: date,
    hit_count: 1,
    status: 'tentative_1',
    identified_root_cause: analysis.rootCause.cause || null,
    confidence: analysis.rootCause.confidence,
    cache_drift: false,
  };
}

function fingerprintSymptom(signal) {
  const canonical = normalizeSignature(signal.summary || '');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Strip volatile tokens so two occurrences of the same symptom match.
function normalizeSignature(sig) {
  return String(sig)
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')              // git SHAs / hex ids
    .replace(/\b\d{4}-\d{2}-\d{2}t?[\d:.]*z?\b/gi, '<ts>') // ISO dates/timestamps
    .replace(/#\d+/g, '#<n>')                             // PR/issue numbers
    .replace(/\bpr[-_ ]?\d+\b/gi, 'pr<n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m|min|mb|kb|gb)\b/gi, '<dur>') // durations/sizes
    .replace(/\b\d+\b/g, '<n>')                           // bare numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function slugForSignal(signal) {
  const base = normalizeSignature(signal.summary || 'symptom')
    .replace(/<[a-z]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return (base || 'symptom').slice(0, 60);
}

// Status ladder mirrors the proving-ground recurrence rule. A drift status
// is set explicitly in trackSymptom and is never downgraded here.
function ladderStatus(hitCount, threshold, prev) {
  if (prev === 'amended_cache_drift' || prev === 'resolved') return prev;
  if (hitCount >= threshold) return 'recurring_3+';
  if (hitCount === 2) return 'confirmed_2+';
  return 'tentative_1';
}

// ─── 4. Narrator TL;DR (cheap LLM prepend) ───────────────────────────

async function narrateTldr(model, signal, analysis, symptomRec, drift, modelId) {
  const sys = `You are the Investigator agent's narrator. You write a SHORT TL;DR that sits above a deterministic root-cause diagnosis. Hard rules:

- Use ONLY the facts given to you. Never invent a root cause, a hypothesis, or a confidence the data does not state.
- 2-4 sentences. State the symptom in one line, then whether a root cause was identified and at what confidence.
- If the root cause was NOT identified, say so plainly and name the next investigative step — do NOT manufacture a cause. The Iron Law: no fix without a root cause.
- If a cache drift was detected (the cached root cause changed), call it out first: this symptom's cause is not what it was last time.
- NEVER propose a concrete code fix. At most restate the fix DIRECTION.
- Voice: direct, builder-to-builder. No em dashes. No filler. No "crucial/robust/comprehensive".
- Output plain prose only. No headings, no preamble like "Here is".`;

  const user = `Diagnosis facts (authoritative — do not change them):
- symptom: ${signal.summary}
- signal source: ${signal.source}
- root cause identified: ${analysis.rootCause.cause ? 'YES' : 'NO'}
- root cause: ${analysis.rootCause.cause || '(not yet identified)'}
- confidence: ${analysis.rootCause.confidence}
- ranked hypotheses: ${analysis.hypotheses.length}
- top hypothesis: ${analysis.hypotheses[0]?.hypothesis || '(none)'}
- symptom seen: ${symptomRec?.hit_count ?? 1}x (status ${symptomRec?.status || 'tentative_1'})
- cache drift this run: ${drift ? `YES — cached cause "${drift.cached}" changed to "${drift.observed}"` : 'no'}
- proposed fix direction: ${analysis.proposedFixDirection}

Write the TL;DR.`;

  const resp = await model.chat({
    capability: 'cheap-classification',
    model: modelId,
    max_tokens: 350,
    system: sys,
    messages: [{ role: 'user', content: user }],
    agent: 'investigator',
  });
  const text = (resp.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!text || /\[smoke-mode/.test(text)) return '_(narrator returned empty; deterministic diagnosis below is authoritative)_';
  return text;
}

// ─── 5. Diagnosis composition (deterministic data layer) ─────────────

function composeDiagnosis({ date, signal, analysis, narrative, symptomRec, drift, reasoned }) {
  const identified = Boolean(analysis.rootCause.cause);
  const icon = identified ? '🎯' : '🔍';

  const lines = [];
  // Frontmatter — machine-scannable, mirrors tester/git-orchestrator convention.
  lines.push('---');
  lines.push(`date: ${date}`);
  lines.push('agent: investigator');
  lines.push('type: diagnosis');
  lines.push(`signal_source: ${jsonScalar(signal.source)}`);
  lines.push(`root_cause_identified: ${identified}`);
  lines.push(`confidence: ${jsonScalar(analysis.rootCause.confidence)}`);
  lines.push(`hypotheses: ${analysis.hypotheses.length}`);
  if (symptomRec) {
    lines.push('symptom:');
    lines.push(`  fingerprint: ${symptomRec.fingerprint}`);
    lines.push(`  slug: ${jsonScalar(symptomRec.slug)}`);
    lines.push(`  hit_count: ${symptomRec.hit_count}`);
    lines.push(`  status: ${symptomRec.status}`);
  }
  lines.push(`cache_drift: ${Boolean(drift)}`);
  lines.push(`reasoned: ${Boolean(reasoned)}`);
  lines.push('tags: [investigator, root-cause, iron-law, narrator-pattern, proposer]');
  lines.push('---');
  lines.push('');
  lines.push(`# Investigator Diagnosis · ${date}`);
  lines.push('');

  // ── Narrator TL;DR (LLM half — labeled, never the source of truth) ──
  lines.push('## TL;DR');
  lines.push('');
  lines.push(narrative || '_(none)_');
  lines.push('');

  // ── Cache-drift banner (surfaced FIRST when present) ──
  if (drift) {
    lines.push('> ⚠️ **Cache drift.** This symptom recurred, but its root cause has');
    lines.push('> CHANGED since last time. Pattern memory is a cache, not ground truth.');
    lines.push(`> - Cached cause (prior run): \`${escapeCell(drift.cached || '(none)')}\``);
    lines.push(`> - Live cause (this run): \`${escapeCell(drift.observed || '(none)')}\``);
    lines.push('> The live evidence wins; the cached cause was retired. Do not act on the');
    lines.push('> stale interpretation.');
    lines.push('');
  }

  // ── Deterministic diagnosis (the ground truth) ──
  lines.push('## Diagnosis (deterministic)');
  lines.push('');
  lines.push(`**Outcome**: ${icon} ${identified ? 'Root cause identified' : 'Root cause NOT yet identified'}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Signal source | ${escapeCell(signal.source)} |`);
  lines.push(`| Symptom | ${escapeCell(signal.summary)} |`);
  lines.push(`| Root cause identified | ${identified ? 'yes' : 'no'} |`);
  lines.push(`| Confidence | ${escapeCell(analysis.rootCause.confidence)} |`);
  lines.push(`| Ranked hypotheses | ${analysis.hypotheses.length} |`);
  lines.push(`| Reasoning pass | ${reasoned ? 'LLM (enriched)' : 'deterministic skeleton'} |`);
  if (symptomRec) lines.push(`| Symptom recurrence | seen ${symptomRec.hit_count}x · \`${escapeCell(symptomRec.status)}\` |`);
  lines.push('');

  // ── Phase 1: symptom + reproduction ──
  lines.push('## 1. Symptom (what failed)');
  lines.push('');
  lines.push(escapeMdBlock(analysis.phases.investigate));
  lines.push('');
  if (signal.failures && signal.failures.length) {
    lines.push('Named failures extracted from the signal:');
    lines.push('');
    for (const f of signal.failures.slice(0, 10)) lines.push(`- \`${escapeCell(f)}\``);
    lines.push('');
  }
  lines.push('**Reproduction**: re-run against the signal source above with verbose logging; narrow to the smallest input that still reproduces before acting on any hypothesis.');
  lines.push('');

  // ── Phase 2/3: ranked hypotheses ──
  lines.push('## 2. Ranked hypotheses');
  lines.push('');
  lines.push(escapeMdBlock(analysis.phases.analyze));
  lines.push('');
  lines.push('| # | Likelihood | Hypothesis | Evidence | Test to confirm/refute |');
  lines.push('|---|---|---|---|---|');
  for (const h of analysis.hypotheses) {
    lines.push(
      `| ${h.rank} | ${h.likelihood} | ${escapeCell(h.hypothesis)} | ${escapeCell(h.evidence)} | ${escapeCell(h.test)} |`,
    );
  }
  lines.push('');

  // ── Phase 4: identified root cause (the Iron Law slot) ──
  lines.push('## 3. Identified root cause');
  lines.push('');
  if (identified) {
    lines.push(`**Root cause**: ${escapeMd(analysis.rootCause.cause)}`);
    lines.push('');
    lines.push(`**Evidence**: ${escapeMd(analysis.rootCause.evidence)}`);
    lines.push('');
    lines.push(`**Confidence**: ${escapeMd(analysis.rootCause.confidence)}`);
  } else {
    lines.push('> The root cause is **NOT yet identified**. Per the Iron Law, no fix lands');
    lines.push('> until the cause is found — a fix proposed against an unidentified cause');
    lines.push('> is a guess. The hypotheses above are the investigation frame, not the answer.');
    lines.push('');
    lines.push(`**Why not yet**: ${escapeMd(analysis.rootCause.evidence)}`);
  }
  lines.push('');

  // ── Proposed fix DIRECTION (never a patch) ──
  lines.push('## 4. Proposed fix direction');
  lines.push('');
  lines.push('> Direction only. The investigator does NOT write the patch and does NOT edit source.');
  lines.push('> A human / executor takes the fix from here through the normal review gate.');
  lines.push('');
  lines.push(escapeMdBlock(analysis.proposedFixDirection));
  lines.push('');

  // ── Footer ──
  lines.push('---');
  lines.push('');
  lines.push('_Investigator is a `proposer` (Phase 1): it FINDS the root cause and proposes a ' +
    'direction; it never edits source to make a failure go away. The Iron Law: no fix without ' +
    'identifying the root cause first. Pattern memory is a cache, not ground truth — recurring ' +
    'symptoms are re-verified against the live signal each run. Pairs with the tester (which ' +
    'surfaces the failure) and a human/executor (who fixes it)._');
  lines.push('');

  return lines.join('\n');
}

// ─── Small helpers ───────────────────────────────────────────────────

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\n/g, ' ');
}
function escapeMd(s) {
  return String(s).replace(/[*_`|]/g, c => '\\' + c);
}
// Block-level text (paragraph) — keep punctuation readable; only collapse newlines.
function escapeMdBlock(s) {
  return String(s).replace(/\n+/g, ' ').trim();
}
function jsonScalar(s) {
  const str = String(s);
  return /[:#&*?{}[\],]/.test(str) ? JSON.stringify(str) : str;
}

// ─── Canned signal (smoke + --canned demo) ───────────────────────────
//
// A realistic failure signal drawn from the proving-ground pattern memory
// (a vitest heap regression that turned out to be a stale-branch drift —
// the PR #570 -> #588 cautionary tale where the symptom matched a cache but
// the real cause was different). It carries enough shape that the
// deterministic pass produces ranked hypotheses + a tentative cause, so the
// diagnosis render is meaningful out of the box with no model key.
function cannedSignal() {
  return {
    source: 'canned demo signal (smoke / --canned)',
    summary: 'vitest unit-tests step hung 18m then runner shutdown; heap exhausted on PR #500',
    raw: [
      'TAP version 13',
      'not ok 1 - DeepFLDPortal renders coverage layer',
      '  ---',
      '  error: JavaScript heap out of memory',
      '  duration_ms: 1080000',
      '  ...',
      '# the unit-tests step ran for 18m then the runner was shut down',
      '# note: the PR branch is behind main, which carried a vitest heap-size bump',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    ].join('\n'),
    failures: ['DeepFLDPortal renders coverage layer'],
  };
}
