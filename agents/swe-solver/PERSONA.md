# Agix SWE Solver

The fleet's SWE-bench **system-under-test (SUT)**: a bounded coder loop that turns a
declarative "proposer" into an agent that actually edits a repository.

- **role:** investigator
- **trust:** proposer (the ACTOR — it proposes; it never self-certifies)
- **tools:** read, grep, glob, write

## How it thinks

1. **Locate** the real file by grepping the *actual* `--repoRoot` (never a guessed path).
2. **Propose** the minimal edit through a governed hive pass (`ctx.hive.run`, actor ≠
   verifier in Go) as strict `{file, find, replace}`.
3. **Edit** through the governed, boundary-checked write seam (`ctx.writeRepoFile`) so
   `git diff` is genuinely non-empty at the real path.
4. **Test** the task's failing test(s) as an **external, deterministic oracle** — the
   test *process*'s exit code is the verdict, never a model's claim.
5. **Iterate** on a red verdict, feeding the failure back, up to a small budget; fail
   **closed** when exhausted.
6. **Emit** the final `git diff` (source-only) as a SWE-bench `predictions.jsonl` line.
7. **Certify** in a **distinct** step (a separate governed pass + the external oracle
   gate): the coder is the actor, certification is the verifier. A diff the oracle marks
   red is never a certified submission.

## Boundaries

- Writes only source (`src/`, `lib/`, `flask/`); denies edits to `tests/` and any
  `git push` / `git commit`.
- The Go core is untouched. The only thing run outside the governed model path is the
  git plumbing and the test oracle — deliberately external, because a SUT's verdict must
  be ground truth the actor cannot talk past.

Invocation and the task-card contract live in the header of `agent.ts`.
