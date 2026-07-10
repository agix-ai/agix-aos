# Agix Refactoring Pack — drop-in runbook

A governed swarm you drop into **another** codebase to autonomously refactor and
clean it up, from a sidecar, with zero agentic footprint in the target. It targets
the high-level **structural** refactorings coding agents are proven weak at, runs
metric-guided, and certifies every change is behavior-preserving (actor≠verifier).

> Status: **scaffold**. The agents load and run governed smoke passes today; the
> reasoning passes are stubbed (`TODO(flesh-out)`). See [`SPEC.md`](./SPEC.md) for
> the design, the empirical grounding, and the compounding flywheel.

## The pack

| Agent | Caste | Job |
|-------|-------|-----|
| `refactor-lead` | queen | conducts the metric-guided campaign |
| `smell-scout` | worker | ranked structural worklist (find, don't fix) |
| `refactor-surgeon` | worker | apply ONE behavior-preserving structural refactoring |
| `behavior-guard` | worker | certify: preserved + improved + no tangling |

Reused from the fleet: `tester` (safety belt), `git-orchestrator` (atomic
commits), `onboarding` (optional baseline), `sentinel` (optional guard).

## Drop it into a codebase

The pack runs with `repoRoot` = a **sidecar workspace**, and the target code lives
at `repo/` inside it. This is what keeps the target pristine — agent artifacts land
in `plans/` and `notes/`, never inside `repo/`.

```bash
# 1. make a sidecar for the target
mkdir -p sidecars/<name>/{plans/refactor,notes/refactor}
ln -s /abs/path/to/target-clone sidecars/<name>/repo
cp packs/refactor/README.md sidecars/<name>/REFACTOR.md

# 2. (recommended) install the zero-footprint guards in the target clone
#    - .git/info/exclude: hide agentic paths
#    - .git/hooks/pre-commit: refuse agentic paths even if force-added
#    - .git/hooks/pre-push: bind commits to the human's git identity
#    (mirror sidecars/dataops-aws-lakehouse/CLAUDE.md — that sidecar is the reference)
```

## Run a bee

```bash
# $0 / offline dry run (mock engine — no key, no network, testable):
bun fleet/runtime/cli.ts run smell-scout   --dir agents --repoRoot sidecars/<name>

# real run against a provider:
bun fleet/runtime/cli.ts run refactor-lead  --dir agents --repoRoot sidecars/<name> \
    --provider anthropic --target "the payments service" \
    --goal "bring the top-5 God classes under a healthy WMC"

# individual stages:
bun fleet/runtime/cli.ts run refactor-surgeon --dir agents --repoRoot sidecars/<name> \
    --candidate "Extract Subclass from OrderManager (repo/src/order.ts:120)" --id cand-3
bun fleet/runtime/cli.ts run behavior-guard   --dir agents --repoRoot sidecars/<name> \
    --change "<surgeon change-note>" --id cand-3
```

## The prime directive (non-negotiable)

1. **Zero agentic footprint in `repo/`.** Only `refactor-surgeon` writes there, and
   only CODE. No `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agix/`, no agent notes.
2. **Seasoned-human authorship.** Every changed line reads as if a senior engineer
   who owns the code wrote it — match naming, comment density (usually sparse),
   import order, error handling. No AI-slop, no "comprehensive/robust", no emoji,
   no `Co-Authored-By: Claude`. Commit under the human's normal git identity.
3. **Refactoring-only, atomic, reversible.** One refactoring per commit. Never
   tangle a feature or a fix into a refactor. `behavior-guard` refuses tangling.
4. **Behavior-preserving.** A behavior test net exists before the change, or is
   written first. Same inputs → same outputs and side effects.

## The compounding payoff

Every certified refactoring is a labeled example that lands in the Comb (KM) on the
`software` branch — which smell, which refactoring type, which metric delta, which
behavior-preserving diff, which verdict. That cross-codebase record is the
distillation corpus for the local **Gemma** sidecar: the worker tier migrates
frontier → `gemma3:12b` (Ollama) as the corpus proves out, so the hive gets cheaper
and more reliable on every drop-in. See [`SPEC.md`](./SPEC.md) §4.
