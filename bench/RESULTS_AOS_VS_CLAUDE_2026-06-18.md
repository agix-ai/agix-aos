---
status: comparative benchmark — first run (Comparison 1 measured; Comparison 2 in progress)
date: 2026-06-18
method: bench/COMPARATIVE_BENCHMARK_AOS_VS_CLAUDE.md
---

# Comparative benchmark results — local AOS vs Claude (2026-06-18)

## Comparison 1 — Bus efficiency — ⚠️ HEADLINE WITHDRAWN, see the corrected case study

> An earlier version of this file led with "**~170,000× / ~14,800×**" ratios. **Those are
> withdrawn as a category error** (transport latency ÷ LLM-inference latency). Adversarial
> review + deep research established the honest picture. Authoritative corrected analysis:
> `wiki/research/CASE_STUDY_BENCHMARK_AOS_VS_CLAUDE_2026-06-18.md` §2.3–2.5.

**What's actually true (every bus number is path-labeled — there are two paths):**
- **Latency.** The bus measures **8.571µs round-trip on the p2p-binary path** (direct,
  daemon out of the message path) — **ordinary socket-class IPC** (Unix domain socket band;
  10–30× slower than the fast shared-memory tier), a **0-compute byte echo** (transport
  floor). The **routed** path (4 hops via the daemon) is **136.61µs** (≈16× slower).
- **Throughput** (10,000 msgs/thread, single + 8 concurrent, same machine):
  - **p2p-binary (direct, daemon out): ~117,388/sec single-requester, ~158,812/sec aggregate.**
  - routed (4 hops via daemon): ~7,394/sec single-requester, ~9,862/sec aggregate.
  - The p2p throughput is **~16× the routed aggregate** because the daemon (and its central
    `State` mutex) is OUT of the hot loop. The p2p single-requester rate (~117K/sec) lands
    inside the ~116–145K/sec ceiling the 8.5µs latency implies — the latency and throughput
    numbers are consistent **once you state which path each belongs to**.
- The Claude subagent (1.37s / ~75K tokens, N=4 hand-recorded — *not yet a committed
  reproducible artifact*) is an **LLM inference**, a different layer. Comparing the two as
  a speedup is invalid.
- **Defensible, Claude-scoped claim:** Claude's only agent-to-agent mechanism is spawning a
  subagent (an LLM call); Agix's non-LLM signaling primitive can skip that round-trip for
  coordination steps that don't need reasoning → avoids the **communication tax**. The
  honest metric = **round-trips + tokens on a real workflow done both ways** (not yet run).
- **Red flag RESOLVED (2026-06-19):** the earlier "~10,076 msgs/sec is far below what 8.5µs
  implies" was a **path mismatch**, not a defect — ~10K/sec was the *routed* path's
  throughput; 8.5µs is the *p2p-binary* path's latency. The p2p path's throughput is now
  measured (`bench-throughput-p2p` subcommand + probe): ~117K/sec single, ~159K/sec
  aggregate — consistent with the 8.5µs latency. Investigation:
  `wiki/queries/bus-throughput-investigation-2026-06-19.md`.

## Comparison 2 — Hallucination management (Agix side measured; comparative arm pending)

- **Agix side (measured):** `context-warden` detection benchmark = **5/5** on planted
  conditions (over-effective-length, approaching, repetition, distractor, clean), and a
  real run on a degraded context returned `compact · flags: repetition-loop` + the right
  recommendations. It gauges the **effective** window (e.g. ~4–8K for current models),
  where Claude's auto-compaction triggers at ~83.5% of the **advertised** window.
- **Comparative arm (pending the scenario set):** a long-session faithfulness delta
  (managed vs Claude-native) per `COMPARATIVE_BENCHMARK_AOS_VS_CLAUDE.md` §2 — target:
  beat Anthropic's measured +39%. Needs the planted-scenario corpus + a paired run.

## Honest caveats
- The bus/subagent comparison is *coordination overhead*, not "Agix replaces Claude calls."
- 75,244 tokens is the realistic floor for *spawning* a coordination subagent (full context
  inheritance); a same-context tool call is cheaper — but still not microseconds/zero.
- Comparison 2's comparative number is not yet measured; only context-warden's detection is.
