# Architecture

A five-minute map of the hive, for a human or an agent arriving for the first
time. It says what the major pieces are, where they live, and how they fit —
not every file. For build/test/PR mechanics see [`AGENTS.md`](AGENTS.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md); for the agent-legibility index see
[`llms.txt`](llms.txt).

## The one idea

Agix is a **hive**: a governed swarm of small agents ("bees") that forage,
return, and feed durable knowledge back to a shared store — coordinated through
a shared medium rather than by chatter, and held to one rule everywhere:
**`actor ≠ verifier`** (the bee that does the work is never the bee that
certifies it). Everything below is a mechanical realization of that rule.

The system exists in two implementations that grow side by side:

- a **Node reference implementation** — the `agix` CLI, the agent fleet, and the
  runtime library (`bin/`, `agents/`, `lib/`), where new behavior is prototyped;
- a **born-clean Go core** (`core/`) — a single static, zero-dependency binary
  that is the shipping substrate for the orchestration hot path. It is clean by
  construction, not extracted-and-scrubbed after the fact.

## The layers

### 1. Runtime — the Go core (`core/`)

A single statically-linked Go binary, stdlib-only (`go build ./cmd/agix-core`).
Its packages are the hive's load-bearing seams:

| Package | Role |
|---|---|
| `core/router` | **Model-agnostic capability router** — maps `capability → provider+model`, owns the rate card, and preserves each provider's *native* efficiency (e.g. Anthropic `cache_control` prompt caching) instead of flattening to a lowest-common-denominator call. When a routed provider lacks a requested native feature it appends an honest `Degraded[]` marker. |
| `core/provider/*` | Wire-level adapters (`anthropic`, `openai`, `gemini`, plus a deterministic zero-cost `mock`) and a `keyenv` key loader. Live calls are guarded behind an API-key check, so tests and CI never touch the network. |
| `core/agent` | **One** forage → work → return/feed agent loop; graceful-degrades on a provider/budget error (ship what landed, release the lease) rather than retry-looping. |
| `core/orchestrator` | The **graph/runner port**: `State`, `Node`/`AgentNode`/`GateNode`, `Graph`, `Checkpointer`, `Runner`. A `GateNode` does not decide — it raises an `Interrupt` and pauses the run so a *different* bee (or human) can ratify. `orchestrator/mem` is the working default engine (interrupt/resume + checkpointing, zero network); `orchestrator/adk` is the Google ADK-Go substrate behind the same port (nested module; session/state binding functional, graph-walk driving scoped `TODO`). |
| `core/swarm` | First-light **governed swarm**: a Queen decomposes a task, N cheap workers forage subtasks in parallel, a **distinct verifier** certifies the synthesized answer, and the run emits a frozen `Result`. Deterministic and $0 under the mock provider — a real offline system-under-test. |
| `core/caste` | The role→caste taxonomy: maps a bee's ROLE (forager, verifier, conductor…) to its CASTE — **queen** (decompose/synthesize) · **worker** (forage/verify) · **drone** (the only caste that may cross a hive boundary). This split is the mechanical basis for `actor ≠ verifier`. |
| `core/kmstore` | The **Comb** — the provenance-gated KM graph store, the hive's durable "honey". A property graph with embeddings on CGo-free `modernc.org/sqlite`, cosine-ranked in Go. Enforces the **attestation gate** (a leaf is attested only if a distinct verifier vouches at trust ≥ floor) and an **anti-poisoning shield** (an attested leaf can only be superseded by another attested write; un-attested contradictions are quarantined to an append-only trail, never destructively overwritten). |
| `core/coord` | The **lease ledger** (stigmergy / "shares"): a bee claims a path scope before working so parallel bees never collide. `MemLedger` is the working in-process implementation; an `MCPLeaseLedger` seam will speak to the real `services/coord-mcp` so a whole hive shares one ledger across processes. |
| `core/ledger` | An **append-only JSONL audit ledger** — the trace of record; every gate decision and verdict is written here. |
| `core/secrets` | The **guard-bee** boundary: a `Broker` mediates every secret access against a **deny-by-default** policy allowlist (role → allowed refs), auditing each decision by ref + verdict + source, **never** by value. A bee never resolves a secret directly. |
| `core/apiary` | The canonical **cross-hive envelope** and its pure-Go sender — the *only* thing that crosses a hive boundary. Its validation **is** the perimeter: right destination hive, well-formed actor, and **drone sender only** (workers and queens never leave their hive). |

### 2. Services (`services/`)

Long-running infra, Go-first (per the operator-stack directive; `go-common` is
the shared zero-dependency substrate):

- `services/coord-mcp` — the coordination lease ledger exposed as an **MCP
  server**, so any MCP-speaking agent (Claude Code, Cursor, the Agix fleet) can
  claim work, avoid collisions, and read the audit log. The out-of-process
  counterpart to `core/coord`.
- `services/hive-gateway` — apiary **report-home** ingest for a **federated
  hive**: a remote/cloud swarm forages, then POSTs its cross-hive envelope to a
  destination hive's gateway, which authenticates, validates at the perimeter
  (drone-only), and appends an accepted event to that hive's audit ledger. The
  receiving half of `core/apiary`.
- `services/api-python` — a FastAPI baseline for Python-specific workloads
  (ML/CV, heavy compute), kept out of the Go/Rust hot path on purpose.

### 3. The proving ground (`research/`)

An **isolated Python EvalOps harness** (Inspect AI) whose product is the AOS it
tests. It drives the shipped system as an **external system-under-test** — it
never imports the product, it shells out to `node bin/agix …` — and scores it
against the frontier on a cadence. Two tiers: **Tier 1** deterministic/offline
($0, mock model, runs every commit) and **Tier 2** live-model (gated behind
`AGIX_LAB_TIER2=1` + an API key, bounded, opt-in). Delete `research/` and the
product still ships. This is where the central hypothesis — *a trained cheap
hive beats a single frontier model on cost × accuracy × speed over time* — is
measured, including honest negatives.

### 4. The Node reference layer (`lib/`, `agents/`, `bin/`)

- `bin/agix` — the CLI and default entry point; `bin/hive` — per-hive
  credential contexts for boundary work.
- `agents/<name>/` — the agent fleet, one directory per agent in a consistent
  four-file shape (`manifest.yaml` with a `soul:` block, `agent.mjs`,
  `policy.yaml`, `PERSONA.md`); auto-discovered by the CLI.
- `lib/` — the runtime library the CLI and agents share: the intra-agent bus
  (`agix-bus*`), the model adapter (`agix-model.mjs`), the audit ledger
  (`agix-audit-ledger.mjs`), the independent-verifier guard
  (`agix-verifier-guard.mjs`), the KM/gbrain seam (`agix-gbrain.mjs`), and the
  agent runtime (`agix-runtime.mjs`) — the seam that lets the same `agent.mjs`
  run locally or in the cloud.
- `cli/crates/lewis-aos-bus` — the Rust intra-agent message bus (Unix-domain
  sockets) that backs `agix swarm` / `agix agent serve`.

## Governance, end to end

The through-line, not a separate module:

1. A **Queen** (or the orchestrator graph) decomposes work and hands subtasks to
   **workers**, each claiming its own **lease** (`core/coord`) so they never
   collide.
2. Workers forage. Synthesis reaches a **gate** (`GateNode`), which **pauses** —
   it never self-approves.
3. A **distinct verifier** (a different worker, or a human) ratifies. Approve →
   the work is fed to the **Comb** (`core/kmstore`), but only if it clears the
   **attestation gate**. Reject → it diverts to remediation and is **never**
   fed.
4. Every step — gate, verdict, feed — is appended to the **audit ledger**
   (`core/ledger`). Any boundary crossing goes through a **drone** and the
   **apiary** perimeter; any secret access goes through the **guard-bee**
   broker.

**Honesty note:** trust levels (`observer` / `proposer` / `executor`) and agent
`policy.yaml` files are **advisory metadata** in today's Node runtime — read as
context, not yet hard-enforced by a runtime sandbox (see
[`SECURITY.md`](SECURITY.md)). The Go core's gates, lease ledger, attestation
gate, and drone-only perimeter *are* enforced in code. Runtime capability
mediation for the Node agents is on the roadmap.

## Where to go next

- [`AGENTS.md`](AGENTS.md) — the operating contract (build, test, PR, do-not-touch).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, the agent four-file shape, the eval CI gate, the public-clean gate.
- [`core/README.md`](core/README.md) — the Go core in depth (router, orchestrator port, beehive seams).
- [`research/README.md`](research/README.md) — the two-tier proving ground.
- `docs/architecture/` — ADRs and design specs (federated apiary, KM graph store, guard-bee secrets, the Go-substrate reconciliation).
