# Agix Research Brief — 2026-06-08

> Week of 2026-06-08. 16 sources scanned. 50 items above the relevance threshold.

## 1. New techniques worth tracking (≤3)

### Permutation-calibrated judging
Aggregating judge scores over balanced order permutations cancels latent position bias even in pointwise rubrics.
**Why for Agix:** Hardens our LLM-as-judge before it gates anything.

### Clustered standard errors for evals
When eval questions cluster (several per document), naive SEs understate uncertainty up to ~3×.
**Why for Agix:** Our briefs cluster cases per source — report clustered CIs.

### pass^k reliability metric
All-of-k success exposes that a 90% pass@1 agent is only ~57% reliable at k=8.
**Why for Agix:** The right headline for any agent we promote to autonomous.

## 2. Reframe an Agix assumption (1)

We treated accuracy as the bar; the literature treats accuracy-without-error-bars as not decision-grade.

## 3. "If Agix built this" opportunity (1)

A judge-calibration harness that reports Cohen's κ against a small human-labeled set. Underbuilt across vendors; Agix's onboarding interview already produces human labels.

## 4. New failure modes / risks surfaced this week

Self-preference bias: judges favor low-perplexity (familiar) text regardless of authorship — never let a model grade its own family.

## 5. Source log

- [G-Eval](https://ar5iv.labs.arxiv.org/html/2303.16634)
- [Self-preference bias](https://arxiv.org/abs/2410.21819)
- [tau-bench](https://arxiv.org/abs/2406.12045)
- [IFEval](https://arxiv.org/pdf/2311.07911)

## 6. Self-grade (dogfooding the eval rubric)

Faithfulness: high. Novelty: medium — consolidates known results into an actionable judge spec.
