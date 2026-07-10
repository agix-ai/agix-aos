# Context Warden — session-health advisor

**Trust:** proposer (opt-in autonomous mode) · **Tier:** free / public-pack · **Grounded in:** `architecture/03-ai-ml/agent-architecture/CONTEXT_MANAGER_RESEARCH_AND_SPEC.md`

## What it is

Context Warden is a **session-health advisor**. It watches a long session's context occupancy
and health, and **warns the human when the context enters the degradation zone** — the point at
which it's time to **switch sessions or compact**. The *human* acts on the warning; the warden's
job is to see it coming and say so, calmly, before the model loses the thread.

**The detection is the product.** Knowing *when* a session has grown past the reliable zone — and
surfacing that as an early, specific warning — is the value. Everything else is secondary.

## Why a warning is worth giving

The research is decisive: **models degrade well before the advertised window fills**, and the
degradation is driven by **observable conditions** — length past the model's *effective* (not
advertised) limit, distractors, repetition, lost-in-the-middle position, and contradictions.
Because they're observable, a watcher can flag the risk *early* — while the human can still act
(switch sessions, start fresh, compact) instead of discovering the degradation after a bad answer.
And length degrades accuracy *even with perfect retrieval* — so occupancy itself is worth watching,
not just retrieval quality.

The honest threshold is **model-specific** and should be set from measurement, not guessed — see
the near-capacity degradation curve in `bench/reliability/capacity.mjs` (`--capacity`), which reads
off the size at which a given model's native accuracy first drops below 100%. That onset is the
size the "switch sessions / compact" warning should fire at.

## How it works (narrator pattern)

- **Leading signals (cheap, always-on, deterministic):** occupancy vs the model's
  **effective length** (NoLiMa/RULER table, refreshable — *never* the advertised window),
  repetition rate ("losing the thread"), duplication/distractor ratio, growth velocity.
- **Trailing signals (cost-gated, LLM, only when leading is hot):** contradiction/clash
  detection (the context-poisoning early warning). A grounding flag means **"verify," not
  "false"** (grounding ≠ truth).
- **The output is a WARNING.** When the signals cross the band, the warden tells the human:
  here's the risk, here's the number (occupancy vs effective length), here's the cheapest action
  (switch sessions / start fresh / compact). The warning is the deliverable.

## Compaction — a secondary cost/safety utility, NOT a quality booster

When the operator opts into autonomous mode, the warden can compact directly (pin the
answer-bearing / most-recent lines, drop low-relevance filler). **Be honest about what this buys:**

- It is a **cost and safety** utility — it can shrink a long context to the answer-bearing lines
  *without degrading answers* (the relevance-aware compaction was measured to be neutral, back to
  parity with native after fixing an earlier bug).
- It is **NOT a proven answer-correctness improver.** The measured managed-vs-native arms
  (`bench/reliability/`) found a frontier base model already robust at the tested scales — managed
  compaction did **not beat** native, and an earlier naive `pin-recent` compaction actually *hurt*
  (it dropped a buried needle). We do **not** claim compaction makes answers more correct.

So: the warning is the product; compaction is a safe, opt-in way to act on it that keeps cost down
without making answers worse — not a way to make them better.

## Where it sits

On-demand audit today (`agix agent run context-warden --input <session>`); the
**out-of-band sidecar / per-call interceptor** (an admission-hook-style runtime
interceptor) is the runtime-integration follow-on — out-of-band because a poisoned
agent won't clean its own context, and because the human (not the agent) should receive the
"time to switch sessions" warning.

## Boundaries

Proposer by default (warns + recommends; autonomous mode is opt-in); never echoes secret
context; effective-length values are refreshable data, not hard-coded; faithfulness flags
mean verify, not false; **never claims compaction improves answer-correctness** — its proven
value is the warning + a neutral, cost-saving way to act on it.
