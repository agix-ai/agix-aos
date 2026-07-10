# AGENTS.md

Operating contract for agents working in **Agix AOS** — the open, self-hostable
operating system for a governed AI agent fleet. This file is what an agent (or a
human) reads first to understand how work is done here. It ships at the repo root
of the public distribution.

## What this repo is

Agix AOS runs a **governed swarm**: many small agents that plan, act, and verify
each other's work, under a single conductor, with every consequential step gated
by a contract you can read. The pieces:

- **`core/`** — the Go engine and the `agix-core` CLI. The governance primitives
  live here: the tool-use loop, the capability boundary, the Comb (the knowledge
  store), and the actor≠verifier gate. `CGO_ENABLED=0` — a single static binary.
- **`fleet/` + `agents/`** — the agent fleet, TypeScript on **Bun** (never Node).
  Each agent is a **manifest** (`agents/<name>/agent.json` — declarative
  governance metadata the Go engine reads) plus an optional **behavior**
  (`agent.ts`). This is the "build your own bee" surface.
- **`packs/`** — composable capability packs (e.g. the refactoring pack) that
  drop a governed sub-swarm onto a target repo from a sidecar, with zero footprint
  in the target.
- **`services/`** — the Hono/TypeScript web + API + connector layer.
- **`cli/crates/`** — the Rust intra-agent bus.

## The governance contract (the part that matters)

Three invariants define the system. An agent that breaks one is a bug.

1. **Actor ≠ verifier.** The agent that produces work never certifies it. A
   distinct verifier actor grades every governed result, and the verdict — not the
   producer's say-so — decides whether work is accepted. The engine enforces this;
   agents cannot self-approve.
2. **Boundary as capability.** An agent may only touch what its manifest's
   `boundary` grants — the files it may read/write, the tools it may call, the
   secrets it may receive. A tool call outside the boundary is refused, not
   logged-and-allowed. Credentialed tools receive a scoped grant, never a raw key.
3. **External grounding beats judgment.** A verdict grounded in an external oracle
   (a passing test suite, a clean build, an exit-0) is stronger than a model's
   opinion. Certified, externally-grounded results are the only ones that persist
   as durable knowledge in the Comb.

## Build · test · run

```sh
# Go core + CLI
cd core && go build ./... && go test ./...

# The TypeScript fleet (needs Bun; never Node)
bun test fleet/tests/

# Run an agent (governed): declarative engine, scoped to a target dir
agix-core agent run <name> "<task>" --engine --repoRoot <dir>
```

`agix-core agent list` shows the fleet with each agent's caste, trust, and
declared tools.

## Adding or changing an agent

1. Create `agents/<name>/agent.json` — the manifest: `name`, `role`
   (queen/worker), `trust`, `tools`, and a `boundary` (the read/write/secret
   grants). Set `"public": true` only for agents meant to ship.
2. Optionally add `agents/<name>/agent.ts` — the behavior, run on Bun. It drives
   the Go engine through the provided context (`ctx.hive.run`, `ctx.read/writeRepoFile`,
   the governed tools); it never reaches outside its boundary.
3. Add a test under `fleet/tests/<name>.test.ts`. The suite must stay green.
4. Keep the change scoped and reviewable.

## Conventions

- **No secrets, ever.** No API keys, credentials, personal, or private data in any
  committed file. Keys are resolved at runtime from your own configured backend by
  alias — never a literal value in a commit, config, or comment.
- **Tests are the contract.** `go test ./...` and `bun test fleet/tests/` are
  green before you commit. A red suite is not shippable.
- **Boundaries are load-bearing.** When you widen an agent's boundary, say why in
  the manifest — a reviewer reads the boundary to know what the agent can do.
- **Governance is not optional.** Don't add a path that lets an agent approve its
  own work or write outside its grant. That is the one thing this project exists
  to prevent.
