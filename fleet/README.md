# Agix fleet — the reborn TypeScript-on-Bun agent runtime

The fleet is every Agix agent, reborn as **TypeScript on Bun** (never Node). An
agent is two files:

```
agents/<name>/
  agent.json    # the MANIFEST — declarative governance metadata (Go + Bun both read it)
  agent.ts      # the BEHAVIOR — orchestration on Bun (imports fleet/runtime/sdk.ts)
```

Governance stays in **Go**. The TypeScript layer authors + orchestrates; every
unit of intelligence is delegated to the governed Go engine (`agix-core`), which
runs the actor≠verifier tool-use loop + swarm. The TS runtime **never**
re-implements the swarm or the tool loop.

## The boundary (TS ↔ Go)

```
 bun cli.ts run mentor  ──►  runner.ts loads agent.json + agent.ts, builds ctx
                                  │
   agent.ts orchestrates ─────────┤ ctx.hive.run(task)  ──► agix-core agent run <name> --engine --json
   (modes, sequencing,            │                         (Go: queen→workers→synth→DISTINCT verifier)
    input/output shaping)         │ ctx.comb.*          ──► agix-core km …  (provenance-gated KM store)
                                  │ ctx.fire(other,task)──► agix-core agent run <other> --engine --json
```

- **`ctx.hive.run(task)`** — one governed swarm in Go. Returns a `GovernedResult`
  the runtime asserts is `actor≠verifier` (distinct verifier certified the answer)
  before handing it back. This is the only way an agent invokes intelligence.
- **`ctx.comb`** — the durable, provenance-gated knowledge graph (put / link /
  retrieve / traverse / stats). Reads are attested-only by default; writes carry a
  distinct verifier + trust.
- **`ctx.fire(name, task)`** — delegate a governed unit to another agent (the
  `fire` capability; the agent enforces its own allowlist).
- **`ctx.readRepoFile` / `ctx.writeRepoFile`** — writes are advisory-bounded by the
  manifest's `boundary.write` globs (Go is authoritative).

The agent never sees a model key and never runs a tool-use loop — that governance
lives in Go, driven from `agent.json`.

## Run one

```bash
# via the Go front door (delegates to Bun when agent.ts is present):
agix-core agent run mentor goals --dir agents

# or the Bun front door directly:
bun fleet/runtime/cli.ts run investigator "the build is red at step 0"
bun fleet/runtime/cli.ts list
```

`--provider mock` (default) is $0/offline. Point `AGIX_CORE_BIN` at the built
`agix-core` binary if it is not on `PATH`.

## Test

The fleet is **dependency-free** — no `package.json`, nothing to install:

```bash
bun test fleet/tests                       # hermetic: MockEngine + MemComb, no binary
AGIX_CORE_BIN=/path/agix-core bun test fleet/   # + the real Go seam (integration.test.ts)
```

## Author a new agent (the port recipe)

Porting one legacy `agents/<name>/agent.mjs` to the reborn contract:

1. **Manifest** — write `agents/<name>/agent.json` (or reuse the one already there).
   Port `manifest.yaml` → the fields in `runtime/manifest.ts`: `name`, `role`,
   `trust` (conductor|proposer|boundary → queen|worker|drone), `public`, `tier`,
   `instructions` (the persona), `tools`, `models` (queen/worker[]/verifier/workers),
   `boundary` (secrets allowlist + read/write/deny globs), `config`, `schedule`,
   `outputs`. `agix-core agent list` validates it.
2. **Behavior** — write `agents/<name>/agent.ts`:
   ```ts
   import { defineAgent, type AgentContext } from "../../fleet/runtime/sdk.ts";
   export default defineAgent(async (ctx: AgentContext) => {
     if (ctx.smoke) { /* one ctx.hive.run + return */ }
     // dispatch on ctx.input.mode / ctx.input.text
     const r = await ctx.hive.run(shapeTheTask(ctx.input));
     // persist via ctx.writeRepoFile / ctx.comb.put (author=r.queenActor, verifier=r.verifierActor)
     return { ok: r.verified, /* provenance */ };
   });
   ```
   Map the legacy `runtime.getModel().chat()` calls → `ctx.hive.run(task)` (each
   becomes a governed pass; per-role model tiering comes from `agent.json`).
   Map `runtime.readState/writeState` and journal writes → `ctx.comb.*` and
   `ctx.writeRepoFile`.
3. **Retire** — delete `agent.mjs` + `manifest.yaml` once the port is verified.
4. **Test** — add a case to `fleet/tests/runner.test.ts` (MockEngine + MemComb):
   assert `result.ok`, the distinct verifier, and the agent's orchestration.

Agents that lean on a capability the contract does not yet express (an
interactive REPL turn-loop, a live editor seam, a raw non-governed model call, or
a tool the Go catalog has not registered) should port the governed core and flag
the gap in-code (see `agent.ts` NOT-PORTED notes in mentor), rather than fake it.

Copyright 2026 Agix AI LLC. Apache-2.0.
