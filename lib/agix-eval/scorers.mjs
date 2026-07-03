// agix-eval/scorers — deterministic, dependency-free scorers.
//
// Three-tier scorer taxonomy (FutureAGI / Confident AI): deterministic
// checks handle objective criteria and fail-fast; LLM-judge scorers
// (see judge.mjs) handle subjective criteria; composite scorers combine
// primitives into one weighted metric. Everything here is tier-1:
// reproducible, no model calls, safe to run on every PR.
//
// Each scorer returns { name, score (0..1), passed (bool|null), detail }.
// `passed` is null when the scorer only contributes to a weighted score
// rather than gating on its own.
//
// Grounding: wiki/research/2026-06-05-agent-evaluation-methodology.md §2.

// ─── primitives ─────────────────────────────────────────────────────

export function exactMatch(output, target, { name = 'exact_match' } = {}) {
  const score = String(output).trim() === String(target).trim() ? 1 : 0;
  return { name, score, passed: score === 1, detail: null };
}

export function contains(output, needle, { name = 'contains', ci = true } = {}) {
  const hay = ci ? String(output).toLowerCase() : String(output);
  const ndl = ci ? String(needle).toLowerCase() : String(needle);
  const score = hay.includes(ndl) ? 1 : 0;
  return { name, score, passed: score === 1, detail: score ? null : `missing "${needle}"` };
}

export function matchesRegex(output, pattern, { name = 'regex', flags = '' } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, flags);
  const score = re.test(String(output)) ? 1 : 0;
  return { name, score, passed: score === 1, detail: score ? null : `no match for ${re}` };
}

export function isJson(output, { name = 'is_json' } = {}) {
  try {
    JSON.parse(typeof output === 'string' ? output : JSON.stringify(output));
    return { name, score: 1, passed: true, detail: null };
  } catch (err) {
    return { name, score: 0, passed: false, detail: `invalid JSON: ${err.message}` };
  }
}

// ─── structure / format adherence ───────────────────────────────────

/**
 * Section-presence checklist. Supplying a machine-checkable checklist is
 * the highest-accuracy way to assess structure adherence (MS AI
 * playbook: ~79% with a structured checklist vs ~45% unstructured).
 * `required` is a list of { id, pattern } — pattern matched against the
 * output. Score = fraction present. Gates when every required item is.
 */
export function structureChecklist(output, required, { name = 'structure', mustAll = true } = {}) {
  const text = String(output);
  const results = required.map((item) => {
    const re = item.pattern instanceof RegExp ? item.pattern : new RegExp(item.pattern, item.flags || 'i');
    return { id: item.id, present: re.test(text) };
  });
  const present = results.filter((r) => r.present).length;
  const score = required.length ? present / required.length : 1;
  const missing = results.filter((r) => !r.present).map((r) => r.id);
  return {
    name,
    score,
    passed: mustAll ? missing.length === 0 : score >= 0.5,
    detail: missing.length ? `missing: ${missing.join(', ')}` : null,
  };
}

/**
 * IFEval-style verifiable constraint check (strict + loose). `checks` is
 * a list of predicate fns (output) => bool. Reports prompt-level strict
 * accuracy (all pass) and instruction-level accuracy (fraction).
 */
export function instructionFollowing(output, checks, { name = 'instruction_following' } = {}) {
  const results = checks.map((c) => {
    try {
      return { id: c.id, ok: Boolean(c.test(String(output))) };
    } catch {
      return { id: c.id, ok: false };
    }
  });
  const ok = results.filter((r) => r.ok).length;
  const instructionLevel = checks.length ? ok / checks.length : 1;
  const promptLevelStrict = ok === checks.length;
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  return {
    name,
    score: instructionLevel,
    passed: promptLevelStrict,
    detail: failed.length ? `violated: ${failed.join(', ')}` : null,
    meta: { promptLevelStrict, instructionLevel },
  };
}

/**
 * Citation-presence + grounding check for brief generators. Counts
 * markdown links / footnote refs and (optionally) verifies each cited
 * URL/anchor appears in an allow-set of known sources. This is the
 * deterministic floor under the (live-only) atomic-claim faithfulness
 * judge — it cannot confirm a claim is supported, only that citations
 * exist and point at known sources.
 */
export function citationPresence(output, { name = 'citations', minCitations = 1, knownSources = null } = {}) {
  const text = String(output);
  const urls = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
  const bareUrls = [...text.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0]);
  const all = [...new Set([...urls, ...bareUrls])];
  let grounded = all.length;
  let ungrounded = [];
  if (Array.isArray(knownSources)) {
    grounded = 0;
    for (const u of all) {
      if (knownSources.some((k) => u.includes(k))) grounded += 1;
      else ungrounded.push(u);
    }
  }
  const enough = all.length >= minCitations;
  const allGrounded = ungrounded.length === 0;
  const score = enough ? (all.length ? grounded / all.length : 0) : 0;
  return {
    name,
    score,
    passed: enough && allGrounded,
    detail: !enough
      ? `only ${all.length} citation(s), need ${minCitations}`
      : ungrounded.length
        ? `ungrounded: ${ungrounded.slice(0, 3).join(', ')}`
        : null,
    meta: { total: all.length, grounded },
  };
}

// ─── tool / action-set correctness (BFCL / DeepEval style) ──────────

/**
 * Set-comparison of called vs expected discrete actions (tool calls,
 * classifier verbs, emitted finding rule_ids). Deterministic — no judge.
 * Mirrors DeepEval ToolCorrectness + BFCL's structural checking.
 * Items are compared as canonical strings; supply a `key` fn to project
 * objects to their comparable identity.
 *
 * @returns scorer result whose `meta` carries precision/recall/F1.
 */
export function setCorrectness(predicted, expected, { name = 'set_correctness', key = (x) => String(x) } = {}) {
  const predSet = new Set(predicted.map(key));
  const goldSet = new Set(expected.map(key));
  let tp = 0;
  for (const p of predSet) if (goldSet.has(p)) tp += 1;
  const fp = predSet.size - tp;
  const fn = goldSet.size - tp;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const exact = fp === 0 && fn === 0;
  return {
    name,
    score: f1,
    passed: exact,
    detail: exact ? null : `tp=${tp} fp=${fp} fn=${fn}`,
    meta: { precision, recall, f1, tp, fp, fn, exact },
  };
}

// ─── classification metrics (intent classifier eval) ────────────────

/**
 * Multi-class classification report over a flat list of
 * { gold, pred } string labels. Computes a confusion matrix,
 * per-class precision/recall/F1, accuracy, and macro-F1.
 *
 * Macro-F1 is the headline because it weights every class equally —
 * a dominant class cannot mask failure on a rare one (the standard
 * intent-classification headline metric; CLINC-150 / Banking77).
 *
 * Use the label "_none_" on either side to represent an absent
 * prediction/gold so spurious and missed labels are scored.
 */
export function classificationReport(pairs, { labels = null } = {}) {
  const classes = labels
    ? [...labels]
    : [...new Set(pairs.flatMap((p) => [p.gold, p.pred]))].filter((l) => l !== '_none_').sort();
  const confusion = {};
  for (const a of [...classes, '_none_']) {
    confusion[a] = {};
    for (const b of [...classes, '_none_']) confusion[a][b] = 0;
  }
  for (const { gold, pred } of pairs) {
    const g = classes.includes(gold) ? gold : '_none_';
    const p = classes.includes(pred) ? pred : '_none_';
    confusion[g][p] += 1;
  }
  const perClass = {};
  for (const c of classes) {
    let tp = confusion[c][c];
    let fp = 0;
    let fn = 0;
    for (const other of [...classes, '_none_']) {
      if (other !== c) {
        fp += confusion[other]?.[c] || 0;
        fn += confusion[c]?.[other] || 0;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[c] = { precision, recall, f1, support: tp + fn, tp, fp, fn };
  }
  const correct = classes.reduce((s, c) => s + confusion[c][c], 0);
  const total = pairs.length;
  const accuracy = total ? correct / total : 0;
  const macroF1 = classes.length ? mean(classes.map((c) => perClass[c].f1)) : 0;
  const macroPrecision = classes.length ? mean(classes.map((c) => perClass[c].precision)) : 0;
  const macroRecall = classes.length ? mean(classes.map((c) => perClass[c].recall)) : 0;
  return { classes, confusion, perClass, accuracy, macroF1, macroPrecision, macroRecall, total };
}

function mean(xs) {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

// ─── composite ──────────────────────────────────────────────────────

/**
 * Weighted assertion bundle with a per-case threshold (promptfoo's
 * model): the combined weighted score must clear `threshold` for the
 * case to pass. Deterministic asserts that hard-fail (passed===false
 * AND marked `gating`) veto the case regardless of weighted score —
 * fail-fast on objective violations (invalid JSON, schema breach).
 *
 * @param {Array<{result, weight?, gating?}>} parts
 */
export function weightedBundle(parts, { threshold = 0.5, name = 'bundle' } = {}) {
  let wsum = 0;
  let acc = 0;
  let vetoed = null;
  for (const part of parts) {
    const w = part.weight ?? 1;
    wsum += w;
    acc += w * part.result.score;
    if (part.gating && part.result.passed === false) vetoed = part.result.name;
  }
  const score = wsum ? acc / wsum : 0;
  const passed = vetoed ? false : score >= threshold;
  return {
    name,
    score,
    passed,
    threshold,
    vetoed,
    parts: parts.map((p) => p.result),
    detail: vetoed ? `vetoed by ${vetoed}` : null,
  };
}
