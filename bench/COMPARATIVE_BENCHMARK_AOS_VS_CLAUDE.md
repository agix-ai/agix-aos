---
status: benchmark design (run after the pack is installed on the terminal)
date: 2026-06-18
related:
  - bench/agix-bench.mjs                       # the existing 7-probe pipeline (bus-latency/throughput already here)
  - cli/crates/lewis-aos-bus                   # the Rust intra-agent bus
  - agents/context-warden/                     # the hallucination-management agent
---

# Comparative benchmark — local Agix AOS vs agents in Claude

> **Operator goal:** after installing the local AOS, benchmark it against the agents
> available in Claude, comparing **(1) the efficiency of the bus** and **(2) hallucination
> management.** This is the methodology + harness. It measures *structural* advantages —
> where Agix's architecture does something Claude's default agent model doesn't.

## The honest framing

We are **not** claiming Agix's *models* are better — they're the same underlying models.
We're measuring two **architectural** advantages: a real low-latency **agent-to-agent
bus** (Claude has no equivalent — subagents coordinate through the orchestrator's context),
and **active, effective-length-aware context management** (Claude auto-compacts at a % of
the *advertised* window; context-warden gauges the *effective* window and catches
conditions a threshold doesn't). Report both fairly, with the baseline clearly stated.

---

## Comparison 1 — Bus efficiency (agent-to-agent communication)

**What differs.** Agix agents exchange messages over the Rust **`lewis-aos-bus`** (p2p,
binary-framed, ~8.4µs round-trip, **zero tokens**). In Claude, "agent-to-agent" = the
orchestrator spawns a subagent via the Task tool and passes context **in tokens**, gets a
result back — an **LLM-mediated, seconds-scale, token-priced** round-trip.

**Metrics (per inter-agent message):**
| Metric | Agix bus | Claude subagent coordination |
|---|---|---|
| Round-trip latency | µs (measured) | wall-clock seconds (measured) |
| Tokens per message | 0 | input+output tokens of the handoff (measured) |
| $ per 1k messages | ~0 | tokens × rate (computed) |

**Method.**
- **Agix side (automatable now):** `bench/agix-bench.mjs` already has `bus-latency` +
  `bus-throughput` probes — run them; record µs round-trip + msgs/sec.
- **Claude side (needs Claude access):** run a minimal 2-agent handoff N times (orchestrator
  → subagent → reply) via the Task tool; measure wall-clock per handoff + tokens from the
  usage object; compute $.
- **Report:** the ratio (expected: **5–6 orders of magnitude** latency, and **bus = 0
  tokens** vs Claude's per-handoff token cost). The honest caveat: a bus message carries a
  *payload*, not *reasoning* — the fair claim is "coordination/signaling overhead," not
  "replaces an LLM call."

**Why it matters:** the swarm/fan-out pattern (many agents on one task) is *free* to
coordinate on the bus and *expensive* to coordinate through Claude's context — so Agix
scales multi-agent work the way Claude can't.

---

## Comparison 2 — Hallucination management

**What differs.** Claude's default: **auto-compaction at ~83.5% of the *advertised*
window** + context-editing. context-warden: gauges occupancy against the model's
***effective* length** (often 16–64× smaller — NoLiMa/RULER), and catches **conditions a
single threshold misses** — distractors, repetition ("losing the thread"), contradiction,
lost-in-the-middle position — intervening *early*.

**Metric:** accuracy / answer-faithfulness **maintained over a long session**, and
**how early** degradation is caught — managed (context-warden) vs native (Claude default).

**Method (planted long-session scenarios):**
1. Build a scenario set that drives a session into each degradation condition:
   over-effective-length, heavy distractors, a mid-context critical fact, a planted
   contradiction (context-poisoning).
2. **Native arm:** run the task on Claude with default context management; score answer
   faithfulness (NLI claim-grounding) + correctness at increasing length.
3. **Managed arm:** same task with context-warden active (compact-early at *effective*
   thresholds, pin critical facts, prune distractors); score the same.
4. **Report:** the faithfulness/accuracy delta + the **length at which each arm starts to
   degrade** (expected: the managed arm holds accuracy further because it acts at the
   *effective* window, not the advertised one, and catches distractor/repetition early).
   Target to beat: Anthropic's measured **+39%** (memory + context-editing) — show
   adaptive management exceeds static thresholds.

**Automatable now:** context-warden's **detection** is already benchmarked (5/5 on planted
conditions, `agents/context-warden/eval/`). The *comparative effectiveness* arm needs the
installed pack + a Claude baseline run.

**Honest caveats:** NLI faithfulness measures grounding-in-context, not truth (flags =
"verify"); effective-length values drift (refresh the table); the managed arm's
interventions must be validated per model (ordering changes can backfire).

---

## How to run it (after `brew install` / a local pack)

1. **Bus, Agix side:** `node bench/agix-bench.mjs` → read `bus-latency` + `bus-throughput`.
2. **Bus, Claude side:** time N Task-tool handoffs in Claude; record tokens; compute the ratio.
3. **Hallucination:** run the scenario set through both arms (native Claude vs
   context-warden-managed); score NLI-faithfulness + correctness vs length; plot the
   degradation onset for each.
4. **Write-up:** one table per comparison, baseline stated, ratios + deltas, honest caveats.

**Follow-on to make it one-command:** add two probes to `bench/agix-bench.mjs` —
`bus-vs-coordination` (Agix bus µs/0-tokens vs a recorded Claude-handoff baseline) and
`hallucination-managed-vs-native` (the scenario-set faithfulness delta) — so the
comparison ships in the proof pipeline alongside the existing 7.
