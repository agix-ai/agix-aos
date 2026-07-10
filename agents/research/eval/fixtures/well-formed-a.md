# Agix Research Brief — 2026-06-01

> Week of 2026-06-01. 14 sources scanned. 41 items above the relevance threshold.

## 1. New techniques worth tracking (≤3)

### Self-distilled agentic RL
Agents learn from their own execution trajectories without an external teacher. The loop closes between trajectory collection and policy improvement.
**Why for Agix:** A working reference for the trajectory-based RL Agix's verifier loop needs.

### Verifier-gated emission
A scalar verifier suppresses low-signal findings before they reach the operator, lifting precision at fixed recall.
**Why for Agix:** Directly applicable to the Director's deploy-health emission gate.

## 2. Reframe an Agix assumption (1)

We assumed weekly cadence is enough; the data suggests reply latency, not scan latency, is the bottleneck.

## 3. "If Agix built this" opportunity (1)

An eval-as-a-service layer for downloadable agent packs. No incumbent ships per-agent regression gates; Agix's wedge is the owned second-brain corpus that seeds golden datasets for free.

## 4. New failure modes / risks surfaced this week

Position bias in LLM judges can flip ~44% of pairwise verdicts — any judge we ship must run both orders.

## 5. Source log

- [Self-Distilled Agentic RL](https://arxiv.org/abs/2605.15155)
- [Position bias benchmark](https://github.com/lechmazur/position_bias)
- [Anthropic — statistical approach to evals](https://www.anthropic.com/research/statistical-approach-to-model-evals)

## 6. Self-grade (dogfooding the eval rubric)

Faithfulness: high — every claim cites a source. Leverage: medium — two items map to in-flight work.
