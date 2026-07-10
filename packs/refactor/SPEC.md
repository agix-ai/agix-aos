# Refactoring Pack — Spec

> Status: **tools wired (9e029a9).** The Go fs + metric tools landed — the seam this
> pack reasoned around — and all four agents are now wired onto them: `smell-scout`
> forages via `metric`+`walk`+`read`+`grep`, `refactor-surgeon` mutates `repo/` via
> the `write` tool, `behavior-guard` certifies via `metric` + the tester,
> `refactor-lead` grounds its plan on the metric report. Green (`bun test`).
> Remaining: **(1) commit authority** — `git-orchestrator` is inspect-only
> (push/merge/deploy denied), so the branch/commit ceremony is an open fork; **(2)**
> wire the metric report into the loop's before/after re-measure; **(3)** a real
> end-to-end run on a live provider. See §5 + `docs/reborn/tool-seam-spec.md`.

A drop-in governed swarm that autonomously refactors and cleans up **another**
codebase from a sidecar. It is authored for the reborn TS-on-Bun agent runtime
(`agents/<name>/{agent.json,agent.ts}`, `ctx.hive.run`, the Comb) and runs the
same governed shape as the rest of the fleet: a Queen decomposes, workers forage,
and a **distinct verifier certifies** (actor≠verifier).

---

## 1. The ask

> "Ingest this information about agentic refactoring and build this process into
> our ADK pack, so I can run it as a sidecar and drop those agents into another
> codebase to autonomously refactor and clean it up."

Plus the thesis that makes it an Agix product and not a script:

> "The Gemma sidecar should learn commonalities in the codebases we refactor over
> time to make our hive mind stronger and more reliable... KM + AOS + Gemma
> compound on themselves into a living agentic organism that I lead."

So this pack has two jobs. The near one: **clean up a target codebase safely and
autonomously.** The far one — the moat — : **turn every codebase it touches into
training signal** for the local hive (Section 4).

---

## 2. What agentic refactoring actually is (ingested)

The seed is IBM/Martin Keen's explainer ["What Is AI Code Refactoring? Agentic AI
& Safe Code Changes"](https://www.youtube.com/watch?v=f84XbvASkk4). The substance
lives in its sources — most importantly the first large-scale **empirical study**
of AI-agent refactoring (Horikawa et al., Nov 2025, arXiv:2511.04824 — 15,451
refactorings across 12,256 PRs / 14,998 commits).

### 2.1 The gap is the moat

Coding agents today are **code janitors, not architects**:

- Refactoring is **26.1%** of agentic commits — common and *intentional*. When an
  agent states refactoring intent it does **far** more of it (large effect,
  Cliff's δ = 0.84).
- But it skews **low-level**: Change Variable Type 11.8%, Rename Parameter 10.4%,
  Rename Variable 8.5%. Agents do **fewer** high-level structural refactorings
  than humans (43.0% vs 54.9%) and **more** low-level ones (35.8% vs 24.4%).
- Motivation is overwhelmingly **maintainability (52.5%) + readability (28.1%)** —
  over 80%. Design-level work is nearly absent: duplication removal **1.1%**,
  repurpose/reuse **4.6%** (humans: 13.7% / 12.9%). It's the inverse of humans.
- **The reveal:** all that low-level churn yields improvements that are
  *statistically significant but practically negligible* and **does not reduce
  design or implementation smells**. The measurable wins come almost entirely from
  **structural decomposition** — the refactorings agents rarely attempt:

  | Refactoring        | Class-LOC Δ | WMC Δ | Note |
  |--------------------|------------:|------:|------|
  | **Extract Subclass** | **−87.5** | **−11.5** | biggest payoff |
  | **Extract Class**    | large      | large | distributes responsibility |
  | **Split Class**      | **−16.0**  | **−4.0** | |
  | Rename / type change | ~0         | ~0    | clarity only, no structural gain |

  (Median Δ after − before; negative = improvement. Table 7 + Finding #11.)

**Conclusion → our emphasis.** We deliberately target the **high-level structural
refactorings agents are worst at**, because that is exactly where the quality
payoff and the whitespace are. Everyone ships the rename bot. Nobody ships the
one that safely extracts a subclass.

### 2.2 The safety contract

Refactoring = **change internal structure, leave observable behavior unchanged.**
That invariant is the whole game, and three practices enforce it:

1. **Characterization tests.** A behavior test net is the safety belt. No
   refactoring without one; if the touched surface has no tests, generate them
   *first* (they pin current behavior, bugs and all), then refactor.
2. **actor ≠ verifier.** The bee that applies the change is never the bee that
   certifies it. This is already the fleet's Iron Law; the refactoring pack just
   points it at behavior-preservation.
3. **No tangled commits.** The #1 failure mode of agentic refactoring is a feature
   or a bug fix smuggled into a "refactor" diff — it defeats review and hides
   regressions. Refactoring commits are **refactoring-only, atomic, reversible.**

### 2.3 Metric-guided beats exploratory (2–5×)

CodeScene's benchmark ("Making Legacy Code AI-Ready") is blunt: an unguided agent
drifts to shallow renames; an agent held to a **code-health / structural-metric
target** does **2–5× more real improvement**, because the target converts
"exploratory edits" into "measurable uplift." The loop is **baseline → refactor →
re-measure**, every step, against an explicit floor (~9.5 code-health = "AI-safe").
So the pack is **always** run against a metric target and re-measures after every
atomic step.

---

## 3. The design

Your roster already had ~70% of the loop — `onboarding` (read-only baseline +
12-dim AI-readiness scorecard), `tester` (behavior signal, root-cause-before-fix),
`git-orchestrator` (atomic commits), `sentinel`. The sidecar model (a `repo/`
symlink, zero agentic footprint, seasoned-human authorship, human git identity)
is already the perfect drop-in vehicle. What was missing was a **refactoring
caste**. Four new bees:

| Agent | Caste | Job |
|-------|-------|-----|
| **`refactor-lead`** | queen (conductor) | Sets the metric target, sequences the worklist into one atomic refactoring per branch, fires the pack, decides continue-or-stop. Never edits source. |
| **`smell-scout`** | worker (proposer) | Read-only. Produces a **ranked structural worklist**, deliberately surfacing high-level candidates, each cited to file:line with a predicted metric Δ. Finds, never fixes. |
| **`refactor-surgeon`** | worker (proposer) | Applies **one** behavior-preserving structural refactoring to `repo/` per run. Refactoring-only, seasoned-human voice, zero agentic footprint. |
| **`behavior-guard`** | worker (verifier posture) | The gate: behavior preserved + structure improved + **no tangling**. Adversarial — approves only when it cannot refuse. |

Reused: **tester** (safety belt), **git-orchestrator** (branch + commit),
**onboarding** (optional baseline), **sentinel** (optional public-surface guard).

### 3.1 The campaign loop

```
baseline    smell-scout   → ranked worklist + before-metrics
  select    refactor-lead → highest impact-per-risk candidate
characterize tester       → behavior test net exists? else write one FIRST
  branch    git-orchestr. → one refactoring-only branch
 refactor   surgeon       → apply ONE behavior-preserving structural transform
 certify    behavior-guard→ preserved + improved + no tangling?  else REVERT
  commit    git-orchestr. → atomic human-voiced refactoring-only commit; re-measure
  repeat    refactor-lead → until target met | worklist exhausted | budget spent
  report    refactor-lead → before/after delta report
```

### 3.2 The sidecar layout (why the target stays pristine)

The pack runs with **`repoRoot` = the sidecar workspace**, not the target repo:

```
sidecars/<name>/
├── repo/            → symlink to the actual clone   (CODE lives here; surgeon writes here)
├── plans/refactor/  → worklists, campaign plans, reports   (agent artifacts)
├── notes/refactor/  → change-notes, verdicts               (agent artifacts)
└── REFACTOR.md      → the drop-in runbook (from packs/refactor/README.md)
```

Only `refactor-surgeon` writes into `repo/`, and only **code**. All agentic
artifacts land in `plans/` and `notes/`, which are siblings of `repo/`, never
inside it. The existing sidecar `.git/hooks/pre-commit` guard is defense-in-depth:
it refuses agentic paths even if one slips through. Comb leaves go to the durable
**hive** KM (via `ctx.comb`), independent of `repoRoot` — see Section 4.

### 3.3 Targeting the structural moat

The scout hunts structure, and each smell maps to the high-payoff refactoring:

| Smell (metric signal) | Refactoring |
|-----------------------|-------------|
| God / Large Class (high WMC, many responsibilities) | Extract Class / **Extract Subclass** / **Split Class** |
| Long Method / high cyclomatic / deep nesting | Extract Method, decompose conditional |
| Feature Envy / inappropriate intimacy | Move Method / Move Field |
| Primitive Obsession / long parameter list | **Introduce Parameter Object** |
| Duplicated blocks across files | Extract Method / Pull Up |
| Cyclic dependency / tight coupling (fan-in+out) | break the cycle, introduce a seam |

If the scout's worklist is all renames, it has failed.

---

## 4. The compounding flywheel (the moat, stated plainly)

This is the operator's thesis and the reason the pack is worth building:

```
   drop the pack into codebase N
            │
            ▼
   ┌─────────────────────────────────────────────┐
   │  refactor it (find → apply → certify)        │
   │  every certified refactoring is a labeled    │
   │  example: {smell, refactoring type, before/  │
   │  after metrics, behavior-preserving diff,     │
   │  verifier verdict}                            │
   └───────────────┬─────────────────────────────┘
                   ▼
           Comb (KMZ / KM)  ── cross-codebase commonalities accumulate
                   │            on the `software` branch, provenance-native
                   ▼
        distillation corpus  ── the labeled record IS the training set
                   │            others don't have (Comb = the moat, not the weights)
                   ▼
        local Gemma sidecar  ── workers migrate frontier → gemma3:12b (Ollama)
                   │            as the distilled corpus proves out
                   ▼
   the hive is cheaper + stronger + more reliable on codebase N+1
```

Three properties make this a living organism and not a static tool:

- **KM (the Comb):** every campaign writes attested leaves — which smells, which
  refactoring types certified clean, on which kinds of codebase, with what metric
  delta. This is the corpus. It compounds. Its **visible age is the switching-cost
  moat** — a competitor can copy the agents, not the accumulated record.
- **AOS (the governed swarm):** the actor≠verifier shape means the corpus is
  *self-certifying* — only behavior-guard-APPROVED refactorings become high-trust
  training signal. The governance is what makes the distillation corpus clean.
- **Gemma (the local model):** the corpus distills into the local sidecar so the
  worker tier migrates off frontier over time. Intelligence lives in the hive, not
  the weights — cheap/local/own models + KM match frontier *over time*.

The endgame: you conduct one durable hive that has refactored dozens of codebases,
whose local model has been trained on its own certified work, and which gets more
reliable every time you point it at something new. You are the beekeeper; the pack
is one caste of the colony.

> Related hive doctrine (memory): own-model + cheap-models-plus-KMS; cheap-model
> edge is distillation not routing (Comb = the distillation corpus); visible-age =
> switching-cost moat; product vision = box + OSS + private nuc; the nightly
> research loop is where the LoRA training runs.

---

## 5. Status: wired vs. open

**Done + green — reasoning, orchestration, AND tools wired (`9e029a9`):**

- **smell-scout** ✅ — forages via the `metric` tool (its `smells[]{kind,refactoring,…}`
  report *is* the worklist spine), confirms + pins file:line via `walk`/`read`/`grep`,
  and runs the 10-item DRIFT rubric via `grep` across sibling modules (the cross-file
  "applied here, skipped next door" checks the per-file metric tool can't see).
  Read-only (no `write`). *(2 tests pass.)*
- **refactor-surgeon** ✅ — fleshed: a two-move governed apply — learn the repo's
  exact style (`read`/`grep`/`glob`), then mutate `repo/<source>` via the `write`
  tool (one behavior-preserving refactoring, no tangling, seasoned-human voice, zero
  agentic footprint). Physical write happens inside the run on a live engine. *(3 tests pass.)*
- **behavior-guard** ✅ — fires the tester for the behavior signal; refuses
  `no-safety-net` *before* the cert pass; certifies `structure_improved` via the
  `metric` tool's before/after and judges `behavior_preserved`/`no_tangling` by
  reading the changed files. Three-gate structured verdict. *(5 tests pass.)*
- **refactor-lead** ✅ — the real `ctx.fire` campaign loop (scout → branch → surgeon
  → certify → commit/revert), bounded by `--max` + worklist exhaustion, allowlist
  enforced, plan grounded on the `metric` report, before/after report, Comb push. *(4 tests pass.)*

**Open (not blocked on the tool seam — genuine decisions/work):**

- **Commit authority** *(fork — needs a call)* — `git-orchestrator` carries the exec
  tool but its allowlist DENIES push/merge/deploy (inspect-only by policy), so the
  branch/commit ceremony is a `TODO(commit-authority)` brief. Options: (a) autonomous
  commit via a narrowly-scoped git exec grant under the human's identity — matches
  the sidecar zero-footprint + seasoned-human-authorship rules; (b) the pack edits
  `repo/` and leaves the commit to the operator; (c) open a PR. Decide before
  enabling autonomous commit.
- **Metric-in-the-loop** *(`TODO(flesh-out)`)* — the metric tool is live; wire its
  before/after report into `refactor-lead`'s re-measure so each step certifies its
  own delta (today the lead grounds the *plan* on it, but the loop doesn't yet
  re-read it per step).
- **Real end-to-end run** — everything above is green on the `$0` mock (which
  executes no tools). A live-provider run against a throwaway target repo is the next
  real validation — it exercises the actual `metric`/`walk`/`write` tool calls.

The seam itself is done: see `docs/reborn/tool-seam-spec.md` (marked IMPLEMENTED).

---

## 6. Run it (drop-in)

See [`README.md`](./README.md) for the full runbook. In short:

```bash
# 1. make a sidecar for the target (repo/ symlink + zero-footprint guards)
# 2. run a bee against the sidecar workspace as repoRoot:
bun fleet/runtime/cli.ts run smell-scout      --dir agents --repoRoot sidecars/<name>
bun fleet/runtime/cli.ts run refactor-lead    --dir agents --repoRoot sidecars/<name> --provider anthropic
# $0/offline dry run: drop --provider (defaults to the mock engine)
```

---

## 7. Provenance (sources ingested)

- IBM / Martin Keen — [What Is AI Code Refactoring? Agentic AI & Safe Code Changes](https://www.youtube.com/watch?v=f84XbvASkk4) (seed video) and the companion [IBM Think topic](https://www.ibm.com/think/topics/ai-code-refactoring).
- Horikawa, Li, Kashiwa, Adams, Iida, Hassan — *Agentic Refactoring: An Empirical Study of AI Coding Agents*, arXiv:2511.04824 (Nov 2025). The empirical spine.
- CodeScene — [Making Legacy Code AI-Ready: Benchmarks on Agentic Refactoring](https://codescene.com/blog/making-legacy-code-ai-ready-benchmarks-on-agentic-refactoring). Metric-guided 2–5× result.
- Kiro — [Refactoring Made Right](https://kiro.dev/blog/refactoring-made-right/). Program-analysis-backed safety framing.
