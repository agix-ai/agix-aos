---
corpus: agix-aos
type: benchmark-study
layer: L2
status: RATIFIED — Part A (learned efficiency) + Part B phases 1–7 (endurance/memory/context/fleet/anomaly-0/ablation) all verified
date: 2026-07-03
provenance: >
  Methodology synthesized from four 2026-07-03 research sweeps (long-horizon/context,
  memory/forgetting, multi-agent/reliability, eval/simulation). Part A results from the
  verified foundation `feat/synthetic-loop-tuning` @ 8971a19. Part B results from
  `feat/ecosystem-sim` (deterministic synthetic simulation, phases 1–7).
companion:
  - docs/strategy/2026-07-03-ecosystem-sim-test-design.md   # the grounded test design
  - docs/strategy/2026-07-03-agix-aos-launch-plan.md         # the launch wedge
indexable_by: [knowledge_fabric]
---

# Agix AOS — Endurance & Efficiency Benchmark Study

> **What this measures:** the reliability and efficiency of the Agix AOS's *own coordination,
> memory, context, and model-routing mechanisms* under a **deterministic synthetic load** — a
> single leader steering a fleet over a long horizon. It is the empirical spine of the claim
> that agix-aos is the *most efficient, most reliable* way to run an agent fleet.

## 0. What this is — and is NOT (read first)

This is an honest study; the framing is load-bearing.

- **It IS** a *methodology* benchmark of the AOS substrate: coordination overhead, context-use
  efficiency, memory hygiene (capture + forgetting), and learned-efficiency routing — measured
  where we are the legitimate source of truth because we measure *our own overhead*, not the
  underlying model's capability.
- **It is NOT** a self-graded *capability* benchmark. We do not publish a SWE-bench-style score
  we ran ourselves — that benchmark is contaminated and such numbers are rightly dismissed by
  technical buyers. Capability comparisons cite third-party leaderboards; here we own only the
  *efficiency and reliability of the orchestration layer*.
- **The load is SYNTHETIC and DETERMINISTIC.** Every result is a seeded, byte-for-byte
  reproducible artifact — no live model, **zero token spend**, no account impact. The "30-hour"
  horizon is a *simulated clock* the sim fast-forwards through in seconds of wall-clock.
- **Real-model calibration is deferred.** The synthetic per-step distributions will later be
  grounded against a *local/free model (Gemma via ollama) or a cheap model*, with short
  recordings replayed thereafter — never a real 30-hour live run. Until then, Part B is a
  *mechanism-validation* result, not a live-performance result, and is labeled as such.

## 1. Executive summary

**The claim:** a single leader can steer a 32-agent fleet over a 30h+ horizon with **bounded
working context**, **anomaly-free coordination**, and **clean, self-curating memory** — and it
gets **cheaper over time** as it learns which model tiers are efficient. Reproducibly, not by
luck.

| Result | Status | Headline |
|---|---|---|
| **A. Learned efficiency** | ✅ RATIFIED | Auto-tiering cut cost-of-pass **−65.7% mean / −38.8% worst** at equal quality across an 8-seed sweep |
| **A. Determinism** | ✅ RATIFIED | Byte-identical same-seed replay (8/8 seed fingerprints stable) |
| **A. Falsifiable safety** | ✅ RATIFIED | 4 safety invariants hold; 4 planted-violation negative controls all caught; gate self-test flags all 7 planted regressions |
| **B. Bounded context over 30h** | ✅ RATIFIED | `C(t)` slope **0.000 tok/step** (plateau) at **6.1%** utilization (knee 0.45) |
| **B. Memory (FAMA)** | ✅ RATIFIED | MPA **1.0** (no over-forgetting) · FAA **1.0** · FAMA **1.0** · **~5–6× record reduction** |
| **B. Collapse decoupled from context** | ✅ RATIFIED | healthy \|r\|=**0.28** vs coupled \|r\|=**0.95** — the forgetting-works signal (Vending-Bench ref 0.167) |
| **B. Anomaly-0 at 32-way concurrency** | ✅ RATIFIED | **0 anomalies** (MAST-14 + collapse, worst-of 8 seeds) · coord tax **1.15×** · pass^k **1.0** · preflight caught all planted faults |
| **B. Ablation (causal proof)** | ✅ RATIFIED | only **both** offload+forgetting keeps `C(t)` bounded AND anomaly-0 (no-offload → 5 anomalies; no-forgetting → collapse @27h, 16) |

## 2. Methodology

The design is grounded in the frontier literature (four research sweeps; full citations in the
test-design companion). The five pillars:

1. **Determinism from record/replay, not from a sampling parameter.** Reproducibility can never
   come from `temperature` — temp-0 diverges on FP/batch effects, and reasoning/extended-thinking
   models ignore or pin it. One seeded PRNG stream (mulberry32) drives the *entire* synthetic
   world; a seeded clock replaces wall-time. **Byte-identical replay across two runs of a seed is
   itself a hard gate** — any nondeterminism is an anomaly.
2. **The pass criterion is a distribution, not an event.** "0 anomalies on one run" is a lucky
   pass under a constant per-step hazard. We report **0 anomalies across an N-seed sweep, the
   *worst* run, a rule-of-three bound (0 in N ⇒ true rate < 3/N at 95%), and pass^k** (all-k
   repeats clean).
3. **Negative-control preflight — the crux of rigor.** Before trusting any result, null, random,
   and planted-violation agents are run against the harness; if any scores "anomaly-0," the
   harness is broken, not passing. Every detector has a matching planted fault it is verified to
   catch (a CI ratchet). Metrics carry a **robust-vs-noisy contract** so shared-runner jitter
   (tail latency) reports without gating, while invariant signals gate absolutely.
4. **Context modeled as a reservoir with four separable hazards.** `C(t+1) = C(t) + inflow −
   offload − prune`, with a rot-knee where per-step success degrades past ~40–50% utilization.
   Bounded context is *necessary but not sufficient* — the four long-horizon failure modes
   (context-rot, goal-drift, compounding-error, planning-error) are modeled as distinct hazards,
   and offload+forgetting only fixes two; recitation, verification gates, and re-planning address
   the rest. Honest by construction.
5. **Memory scored on presence AND absence (FAMA).** `FAMA = max(0, MPA − λ·(1 − FAA))`, with
   **MPA (valid facts recalled) hard-gated at 1.0** so the score can only drop from *failing to
   forget*, never from over-forgetting a provenance-tagged fact.

**Fleet model (Part B):** three-tier tree (director → middle-managers → workers; a mesh at 32
agents would be 496 channels), Magentic-One Task/Progress ledgers with a stall→re-plan loop,
CoAgent rank-serialized coordination (provably deadlock-free), and **actor ≠ verifier** (no agent
certifies its own work). Anomaly schema = the MAST-14 taxonomy + long-horizon collapse
signatures.

## 3. Part A — Learned Efficiency & Reliability (RATIFIED)

Source: `feat/synthetic-loop-tuning` @ 8971a19 (`node scripts/agix-loop-sim.mjs`, 8-seed sweep).
Independently re-verified: sim exit 0, 33/33 tests pass.

- **Learned auto-tiering lowers cost-of-pass at equal quality.** The AOS aggregates the model
  ledger into a per-task-class efficiency profile (cost-of-pass = spend per *verified* success)
  and routes each fanout subtask to the tier with the best learned cost-of-pass that still clears
  the quality floor. Result across 8 seeds: efficiency delta **+65.7% mean, +38.8% min (worst),
  +83.2% max**, spread 0.44 — every seed positive, and *both* the learned and baseline paths
  clear the quality floor, so the win is genuine cost reduction, not a quality trade.
- **Determinism.** Same-seed reruns are byte-identical (fingerprints stable across all 8 seeds);
  the whole scorecard reproduces across two full runs. `repeatabilitySpread` is classified
  `noisy` (reported, not gated) — the robust-vs-noisy discipline working.
- **Falsifiable safety (each with a negative control that is caught):** trust never promotes
  before an incident its signals hadn't flagged (caught when rules are mis-tuned symmetric);
  catastrophe freezes trust (caught when freeze disabled); auto-tiering never routes a high-risk
  task below the safety floor (caught by a naive cheapest-recommender); the autonomy gate never
  relaxes a HITL floor (caught by a broken adjust). The gate's self-test flags all **7 planted
  regressions**, including the robustness split.

**Interpretation:** the token-efficiency claim (the launch wedge) is real and self-improving on
synthetic data — and, crucially, *proven falsifiable*: the safety properties survive because the
detectors that would catch their violation are themselves verified to fire.

## 4. Part B — Long-Horizon Endurance & Context Efficiency (RATIFIED, phases 1–3)

Source: `feat/ecosystem-sim` @ e4c4e53 (`node scripts/agix-ecosystem-sim.mjs`, worst-of an 8-seed
sweep, 30h simulated horizon). Independently re-verified: sim exit 0, "ALL GATES PASSED", 37/37
tests. Pre-registered metrics (fixed before results, per eval-driven development). **100%
synthetic/deterministic — zero token spend; 30h is a simulated clock completing in seconds.**

- **Bounded context over 30h** — working-set `C(t)` trend slope **0.000 tok/step** (a flat
  plateau, not growth toward the rot-knee); peak utilization **6.1%** (knee 0.45 — never
  approaches degradation); useful-work-per-token slope ≈ 0 (non-declining). Endurance held with
  **no collapse in 30h** (min hours-to-collapse 30.0; separately verified stable to 120h). *This
  is the headline: a bounded working context sustained across the full horizon.*
- **Memory hygiene (FAMA)** — **MPA = 1.0** (exact hard gate — not one valid/provenance-tagged
  fact over-forgotten), **FAA = 1.0** (stale facts correctly absent), **FAMA = 1.0**; routing
  confusion-matrix on-diagonal 1.0 (capture lands in the right tier); cross-tier leakage **0**;
  provenance-shield breaches **0**; retrieved-twin reinforced (retrieval resets decay). Record
  reduction **≥ 5.02× worst (~6× mean)** vs add-all.
- **Endurance & collapse decoupling** — **collapse ⟂ context fill: healthy |r| = 0.28 vs a
  coupled control |r| = 0.95** → structurally decoupled (Vending-Bench reference r≈0.167). This is
  the forgetting-works signal: when capture+forgetting hold the working set flat, coherence
  survival stops tracking context size — the failure Vending-Bench showed is *not* context
  exhaustion, and our sim reproduces the decoupling.
- **Determinism** — byte-identical replay (phase-1 fingerprint `2ae69e11`, ecosystem `af85ae34`,
  per-seed memory/context fingerprints all stable across runs). A divergent replay is itself a
  gated anomaly.
- **Falsifiable safety** — all **15 invariants** (3 record/replay + 8 FAMA + 4 context) hold, each
  with a **negative control that is caught** (8/8 + 4/4); the gate self-test flags all 7 planted
  regressions. The safety properties are proven *falsifiable*, not merely observed passing.

**Honest note on record reduction (a deliberate, documented choice):** the target was framed as
the external ~10× (add-all 2,400 → selective 248). We gate at 4.5× and *achieve ~5–6.5×* — because
holding **MPA at exactly 1.0** (keep every valid fact) structurally bounds how much can be pruned
at this horizon/mix. Reduction climbs toward the ceiling at longer horizons (more repetition →
more NOOPs; more decay → more prunes). We chose the honestly-achieved floor over the aspirational
figure — the whole study's credibility depends on that discipline.

### Part B (the multi-agent fleet) — RATIFIED (phases 4–7)
Source: `feat/ecosystem-sim` @ a8a993b (`node scripts/agix-ecosystem-sim.mjs`, worst-of an 8-seed
sweep, 30h). Independently re-verified: sim exit 0, `--ablation` exit 0, 60/60 tests.

- **Anomaly-0 at 32-way concurrency** — a **1 director → 4 managers → 32 workers** tree (36
  channels vs a 496-channel mesh) with Magentic-One Task/Progress ledgers + stall→re-plan, CoAgent
  MTPO rank-serialized coordination (provably deadlock-free), and structural **actor ≠ verifier**.
  Worst-of-sweep **anomalies = 0 across all MAST-14 classes + collapse signatures** (17 detectors,
  each a checker + probe + **caught** planted-violation negative control reading ground-truth
  events, not self-report). **Coordination token-tax 1.154× worst / 1.138× mean** (CoAgent ≈1.15×
  target). **pass^k = 1.000** (5 repeats × 8 seeds, all clean); rule-of-three bound: true anomaly
  rate < 0.375 at 95%. **Negative-control preflight PASS** — null (435 flags), random (129), and
  planted (29, tripping 17/17 modes) agents all detected; none scored anomaly-0, so the gate is
  proven to *fire*, not merely to pass.
- **The ablation (causal proof) — PASS.** Three arms at a 200h horizon: `no-offload` → `C(t)` slope
  0.334, crosses the rot-knee (unbounded), 5 anomalies; `no-forgetting` → slope 577, collapses at
  27h, 16 anomalies; **`both` → slope 0.000, bounded, survived, 0 anomalies.** Only *both*
  mechanisms together keep context bounded AND anomaly-0 — the causal claim that offload + forgetting
  jointly produce the endurance, not either alone.

## 5. Honest caveats

- **Synthetic, not live.** These validate the AOS *mechanisms* under modeled load; live-model
  calibration is deferred (local/cheap model, short recordings). Do not read Part B as
  live-production performance until calibrated.
- **Efficiency, on a fixed model.** The efficiency delta isolates *our routing/coordination
  overhead* holding the model constant — it is not a claim that any model is better.
- **30h is simulated.** A simulated-clock horizon fast-forwarded in seconds; it demonstrates the
  mechanism's behavior over the horizon, not a wall-clock 30h live run.
- **No capability claim.** Nothing here asserts agix-aos writes better code or answers better than
  any competitor. It asserts it *coordinates a fleet more cheaply and more reliably*.

## 6. Reproducibility

Every result is a seeded, byte-for-byte replayable artifact. Part A: `node
scripts/agix-loop-sim.mjs` (deterministic, no API key, exit 0). Part B: `node
scripts/agix-ecosystem-sim.mjs --seeds N --hours 30` (deterministic, no API key). Baselines are
committed and ratchet-only (they may only shrink). The seed corpus is not published (sidesteps
contamination by construction). Determinism is a hard gate: a divergent replay is an anomaly.

## 7. Provenance & sources

Methodology synthesized 2026-07-03 from four research sweeps (Anthropic context engineering +
memory tool; METR time-horizons; Chroma context-rot; Vending-Bench; τ-bench pass^k; MAST failure
taxonomy; Magentic-One ledgers; CoAgent concurrency control; Mem0/Letta/Zep memory; Memora/FAMA;
Berkeley negative-control benchmarking). Full citations in
`docs/strategy/2026-07-03-ecosystem-sim-test-design.md`. Part A data: `feat/synthetic-loop-tuning`
@ 8971a19. This study is *living* — Part B ratifies when the ecosystem sim completes its seed
sweep and ablation.
