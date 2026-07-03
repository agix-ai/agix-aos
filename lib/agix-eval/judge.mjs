// agix-eval/judge — bias-mitigated LLM-as-judge. LIVE ONLY (needs a
// real model); never invoked in the default deterministic harness run.
//
// Every mitigation here is load-bearing and traces to the judge-design
// checklist in wiki/research/2026-06-05-agent-evaluation-methodology.md §4:
//   • Pointwise/absolute scoring by default — pairwise flips ~35% under
//     perturbation vs ~9% pointwise; we offer pairwise but force
//     both-order evaluation and treat order-dependent verdicts as ties.
//   • One dimension per judge call (Anthropic isolation principle) —
//     no single judge scoring everything at once.
//   • Forced chain-of-thought BEFORE the score (G-Eval form-filling),
//     extracted via a fixed GRADE token so the verdict is parseable.
//   • Explicit abstain ("UNKNOWN") to curb hallucinated verdicts.
//   • Pinned low temperature for reproducibility.
//   • Binary/anchored rubric mapped to a fixed score in [0,1].
//
// A judge is itself a system under test: calibrate against a human-
// labeled subset (target Cohen's κ > 0.8) before trusting it to gate.

const JUDGE_TEMPERATURE = 0; // pinned for reproducibility

const GRADE_RE = /GRADE:\s*([A-D]|UNKNOWN)/i;
const GRADE_TO_SCORE = { A: 1, B: 0.66, C: 0.33, D: 0 };

function buildSystemPrompt({ dimension, criteria, anchors }) {
  const anchorLines = anchors
    ? anchors.map((a) => `  ${a.grade} — ${a.meaning}`).join('\n')
    : `  A — fully satisfies the criterion
  B — mostly satisfies it, minor issues
  C — partially satisfies it, notable gaps
  D — fails the criterion`;
  return `You are an evaluation judge scoring ONE dimension only: ${dimension}.

Criterion:
${criteria}

Procedure (follow exactly):
1. Reason step by step about how the output meets or misses the criterion.
   Cite specific evidence from the output. Ignore length and formatting;
   judge substance, not verbosity or style.
2. If the input is too under-specified to judge this dimension, output
   "GRADE: UNKNOWN" and stop — do not guess.
3. Otherwise end with EXACTLY one line:  GRADE: <A|B|C|D>
   where:
${anchorLines}

Do not score any dimension other than "${dimension}".`;
}

function parseGrade(text) {
  const m = String(text).match(GRADE_RE);
  if (!m) return { grade: null, score: null, abstained: false, parseError: true };
  const g = m[1].toUpperCase();
  if (g === 'UNKNOWN') return { grade: 'UNKNOWN', score: null, abstained: true, parseError: false };
  return { grade: g, score: GRADE_TO_SCORE[g], abstained: false, parseError: false };
}

/**
 * Pointwise single-dimension rubric judge.
 * @param {object} a
 * @param {object} a.model  a live Model (runtime.getModel())
 * @param {string} a.dimension  e.g. "faithfulness to the source brief"
 * @param {string} a.criteria   plain-English criterion text
 * @param {string} a.input      the agent's input/context (may be '')
 * @param {string} a.output     the agent output under evaluation
 * @param {Array<{grade,meaning}>} [a.anchors]  custom A–D anchors
 * @returns {{ name, score, passed, grade, abstained, reasoning }}
 */
export async function pointwiseJudge({ model, dimension, criteria, input = '', output, anchors = null, threshold = 0.66, judgeModel = null }) {
  const system = buildSystemPrompt({ dimension, criteria, anchors });
  const user = `INPUT / CONTEXT:\n${input || '(none provided)'}\n\nOUTPUT TO EVALUATE:\n${output}`;
  const resp = await model.chat({
    capability: judgeModel ? undefined : 'default-quality',
    model: judgeModel || undefined,
    temperature: JUDGE_TEMPERATURE,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
    agent: 'eval-judge',
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const parsed = parseGrade(text);
  return {
    name: `judge:${dimension}`,
    score: parsed.score ?? 0,
    // Abstentions and parse failures never silently pass a gate.
    passed: parsed.abstained || parsed.parseError ? null : parsed.score >= threshold,
    grade: parsed.grade,
    abstained: parsed.abstained,
    parseError: parsed.parseError,
    reasoning: text,
  };
}

/**
 * Pairwise judge run in BOTH orders. If the verdict depends on order
 * (a position-bias flip — ~44% average flip rate across judges), we
 * return a tie. Use only when you genuinely need a ranking; prefer
 * pointwise otherwise.
 * @returns {{ winner: 'A'|'B'|'tie', flipped: boolean }}
 */
export async function pairwiseJudge({ model, dimension, criteria, a, b, judgeModel = null }) {
  const ask = async (first, second) => {
    const system = `You compare two outputs on ONE dimension only: ${dimension}.
Criterion:\n${criteria}\nReason step by step ignoring length/formatting/order, then end with EXACTLY:  WINNER: <FIRST|SECOND|TIE>`;
    const resp = await model.chat({
      capability: judgeModel ? undefined : 'default-quality',
      model: judgeModel || undefined,
      temperature: JUDGE_TEMPERATURE,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: `FIRST:\n${first}\n\nSECOND:\n${second}` }],
      agent: 'eval-judge',
    });
    const text = resp.content.map((x) => (x.type === 'text' ? x.text : '')).join('');
    const m = text.match(/WINNER:\s*(FIRST|SECOND|TIE)/i);
    return m ? m[1].toUpperCase() : 'TIE';
  };
  // Order 1: a=FIRST, b=SECOND. Order 2: b=FIRST, a=SECOND.
  const v1 = await ask(a, b);
  const v2 = await ask(b, a);
  const winner1 = v1 === 'FIRST' ? 'A' : v1 === 'SECOND' ? 'B' : 'tie';
  const winner2 = v2 === 'FIRST' ? 'B' : v2 === 'SECOND' ? 'A' : 'tie';
  if (winner1 === winner2) return { winner: winner1, flipped: false };
  return { winner: 'tie', flipped: true };
}

export { GRADE_TO_SCORE, parseGrade };
