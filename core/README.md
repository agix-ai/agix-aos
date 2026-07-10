# agix-core

The Agix orchestration core — a **model-agnostic capability router** and one
end-to-end **beehive agent loop** (forage → work → return/feed), shipped as a
single static Go binary with **zero external dependencies** (stdlib only).

This is the born-clean Go foundation seed for the AOS. It grows alongside the
Node reference implementation; nothing here is extracted or cleaned after the
fact — it is clean by construction.

- **Module:** `github.com/agix-ai/agix/core`
- **Go:** 1.26
- **Deps:** none (net/http, encoding/json, context, os, …)
- **License / copyright:** Apache-2.0, Copyright 2026 Agix AI LLC.

## The single-binary story

One statically-linked binary, no runtime, no SDKs to vendor, systems-daemon
identity. Build it, drop it on a box, run it:

```sh
cd core
go build -o agix-core ./cmd/agix-core

./agix-core version
./agix-core route default-quality              # prove the router
./agix-core run "hello hive" --provider mock   # run the agent loop, zero cost
./agix-core flow "ship a login page" --gate=approve   # run the governance graph
./agix-core flow "ship a login page" --gate=reject    # …and the reject branch
```

`run --provider mock` (the default) is **deterministic and zero-cost** — no
network, no API key. Real providers plug in with `--provider anthropic|openai|gemini`.
`flow` runs the forage→ratify→feed **governance graph** through the orchestrator
port (below): it pauses at the ratification gate and resumes with the `--gate`
verdict.

## Model-agnostic, without sacrificing provider-native efficiency

Being agnostic must **not** collapse to a lowest-common-denominator HTTP call.
The router routes a *capability* to the best provider **and preserves that
provider's native efficiency features on the way through** — it never flattens,
say, Anthropic prompt caching to a generic call.

- The [`router`](router) package owns the routing table
  (`capability → provider+model`), the `Provider` interface, the request/response
  types, the rate card (`Cost`), and the **degraded-marker discipline**: when a
  caller asks for a native feature (prompt caching, structured output) that the
  routed provider lacks, the router appends an honest `Degraded[]` marker rather
  than silently dropping it.
- Each provider adapter under [`provider/`](provider) advertises its native
  surface via `Capabilities()` and implements it at the wire level. Anthropic
  ships real `cache_control` prompt caching today (the big cost lever). Deeper
  native-efficiency work — Batch API, streaming, extended thinking, OpenAI
  `response_format` / Gemini `responseSchema` structured output — is scaffolded
  and marked with `// native-efficiency seam` TODOs so it can deepen **without
  changing the router contract or agent code**.
- Live provider calls are guarded behind an API-key check, so `go test` and CI
  never touch the network. Keys load from `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GEMINI_API_KEY` or `~/.config/agix/<provider>.env`, and a
  missing key only fails when a call actually routes to that provider.

## The orchestrator port — governance on interrupt/resume

Beyond one linear agent loop, a hive needs **graphs** with **governance gates**:
a different bee (or a human) must ratify work before it enters the comb —
`actor ≠ verifier`. The [`orchestrator`](orchestrator) package is the thin,
**zero-dependency Agix-owned port** that makes this real and keeps the execution
substrate swappable:

- `State` — the shared medium threaded through a run (the in-run stigmergy
  substrate; distinct from the cross-run lease ledger).
- `Node` / `AgentNode` / `GateNode` — a node forages/works (routing through the
  model-agnostic router) or **gates**. A `GateNode` does **not** decide: it
  returns an `Interrupt` describing what must be ratified and **pauses the run**.
- `Graph` — `AddNode` / `AddEdge` / `AddConditionalEdge` / `SetEntry` / `Validate`.
- `Checkpointer` (+ `MemCheckpointer`) — snapshots `State` at a pause so a run can
  survive the gap between interrupt and resume.
- `Runner` — `Run` starts a walk (completes, or pauses at a gate); `Resume`
  restarts from the checkpoint applying a `GateDecision` (approve → the work is
  fed; reject → it diverts to remediation and is **never** fed).

The working default engine is [`orchestrator/mem`](orchestrator/mem) —
`MemRunner`, a deterministic in-memory walker with full interrupt/resume +
checkpointing, zero network, zero cost. The end-to-end demo
([`orchestrator/demo`](orchestrator/demo), also the `flow` CLI) wires **one
governance gate** — `forage → ratify → feed`, mock provider, a coord lease around
the whole run — and the audit ledger shows the complete `forage → gate → feed`
trail with the ratification verdict.

### Swappable substrate (the reversible seam)

The port is the point: which engine walks the graph is a one-line swap that never
touches node code.

- **`mem` (default, today):** stdlib-only, deterministic, tested.
- **Google ADK-Go (the shipping substrate, behind the port):**
  [`orchestrator/adk`](orchestrator/adk) is a **nested Go module** so ADK-Go's
  large Google-Cloud dependency tree never touches this zero-dep core. Its
  `Checkpointer` binds `State` onto ADK's real `session.Service` **today**
  (functional, tested, no network); driving the graph walk through ADK's
  runner/agent event stream + long-running-tool HITL is scoped `TODO(adk)`. See
  [`ADK-INTEGRATION-NOTES.md`](orchestrator/adk/ADK-INTEGRATION-NOTES.md).
- **CloudWeGo Eino (fallback):** the same `Runner` interface admits an Eino-backed
  engine as an alternative substrate.

## The beehive seams

- **shares** — [`coord`](coord): the lease ledger (stigmergy). Agents coordinate
  *through* a shared medium, not by chatter: claim a path scope before working so
  parallel bees never collide.
- **feed the hive** — [`ledger`](ledger): an append-only JSONL audit ledger; the
  honey and the trace of record.
- **heals** — the [`agent`](agent) loop graceful-degrades: on a provider/budget
  error it ships what landed and releases the lease, never a retry loop.
- **extends** — the routing table + capability set are the agent-factory seam.

## Layout

```
core/
├── router/           capability router, routing table, rate card, degraded discipline
├── provider/
│   ├── anthropic/    HTTP adapter — cache_control prompt caching implemented
│   ├── openai/       HTTP adapter — automatic caching + structured-output seams
│   ├── gemini/       HTTP adapter — context-caching + responseSchema seams
│   ├── mock/         deterministic, zero-cost provider (tests + offline SUT)
│   └── keyenv/       env / ~/.config/agix/<provider>.env key loader
├── ledger/           append-only JSONL audit ledger (+ orchestrator frame kinds)
├── coord/            LeaseLedger interface + in-memory MemLedger (+ MCP-client seam)
├── agent/            ONE forage→work→return/feed loop
├── orchestrator/     the graph/runner PORT (State, Node, Graph, Gate, Checkpointer, Runner)
│   ├── mem/          MemRunner — the working default engine (interrupt/resume + checkpoint)
│   ├── demo/         forage→ratify→feed governance graph (shared by `flow` + tests)
│   └── adk/          ADK-Go-backed substrate (NESTED module; session/state binding functional)
└── cmd/agix-core/    single-binary CLI
```

## The coord-mcp seam (status: honest)

`coord.LeaseLedger` mirrors the tools of `services/coord-mcp`
(`claim_lease` / `release_lease` / `heartbeat` / `check_overlap`). Today the
working implementation is the **in-process `MemLedger`** — real and testable,
used by the agent loop. The **next step** is `coord.MCPLeaseLedger`: a stdio
MCP-client adapter that speaks to the real `services/coord-mcp` server so a
whole hive can share ONE coordination ledger across processes and machines. That
adapter is a documented seam (`// seam:` in `coord/coord.go`) returning
`ErrMCPNotImplemented`, not yet built — coordination stays artifact-mediated, not
chat-mediated.

## Build · run · test

```sh
cd core
gofmt -l .            # formatting (no output = clean)
go vet ./...          # static checks
go build ./...        # compile all packages
go test ./...         # full suite — ZERO network calls (mock provider path)
go build -o agix-core ./cmd/agix-core
```

Everything runs and tests green with zero API cost via the mock provider.
