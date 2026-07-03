# Go MCP Server — expose the Agix fleet, ledger & coordination as MCP tools

> **Date:** 2026-07-03
> Spec for closing integration gap #4 (from the CLI/MCP coherence review). **Written in Go**
> (operator stack directive: infra servers = Go, API runtimes = Bun, local CLI + fleet stay Node,
> bus stays Rust). This is a **repatriation, not a new build** — bring home an internal MCP server's `coord-mcp`
> (Go MCP lease service) + `go-common` (zero-dep Go service substrate) and extend them to serve the
> Agix fleet + audit ledger. Companion: `RELEASE_GTM_MANAGEMENT.md`, `LOOP_ENGINEERED_SDLC.md`,
> `AGENT_COORDINATION_FABRIC.md`.

## 0. Why (the adoption lever)
Agix is an MCP **client** today (`lib/agix-mcp-client.mjs`) — it *consumes* external tools. It does
not expose a **server**. Exposing one so **Claude Code / Cursor / any MCP-speaking agent can call
the Agix fleet, the coordination lease plane, and the audit ledger as tools** is a major adoption
lever and the natural front door for the git-repo-as-registry ecosystem. The `agix agent serve`
subcommand already exists as the hook.

## 1. Foundation — repatriate, don't rebuild
Bring home from an internal MCP server (Agix-domain per the governing agreement; strip product coupling):
- **`coord-mcp`** (Go) — the MCP lease service: 6 tools (`claim_lease`, `release_lease`, `heartbeat`,
  `list_leases`, `check_overlap`, `get_events`); **event-log + materialized-view** design; overlap-
  check + write under one mutex (race-tested, exactly-one-winner); identity-keyed leases; TTL lazy
  expiry (expired ≠ released ≠ deleted); snapshot persistence with pluggable backends (Memory /
  File / GCS with `ifGenerationMatch` compare-and-swap); DEGRADED-flag recovery; owner/coordinator-
  only release.
- **`go-common`** — zero-external-dep Go service substrate: `logging` / `auth` / `httpserve`
  (`/up` + `/readyz` + SIGTERM drain), with `otelinit` a *separate* module so non-tracing services
  don't inherit the OTel tree. Lift-as-is.
Official MCP Go SDK as the single external dep (matches the internal MCP server).

## 2. Tool surface (three groups)
1. **Coordination (Go-native, from coord-mcp):** the lease control plane — `claim_lease` /
   `release_lease` / `heartbeat` / `list_leases` / `check_overlap` / `get_events`. This is the
   substrate the loop-engineered SDLC's Integrate gate + parallel-agent safety already assume.
2. **Ledger (Go-native):** `ledger_read` / `ledger_stats` / `ledger_append` over the audit ledger
   (`lib/agix-audit-ledger.mjs` JSONL) — so an external agent can read the system-of-record, the
   DORA metrics, and the gate history, and append governed entries. Read side is the high-value
   part (an external reviewer inspects the fleet's verified verdicts).
3. **Agent invocation (shell-to-CLI):** `list_agents` / `run_agent(name, opts)` — invoke the Node
   fleet via the CLI seam (`agix agent run <name>`), the exact **coord.mjs shell-to-CLI pattern**.
   No agent rewrite; the Go server is a thin frontend over the Node runtime.

## 3. The boundary (Go server ⇄ Node fleet)
```
   MCP client (Claude Code / Cursor / any agent)
             │  MCP (Streamable HTTP or stdio, JSON-RPC 2.0)
   ┌─────────▼──────────────────────────────────────────┐
   │  agix Go MCP server  (coord-mcp + go-common base)   │
   │   • coordination tools   — Go-native (lease plane)  │
   │   • ledger tools         — Go reads/serves the JSONL│
   │   • agent-invocation      — shell → `agix agent run`│
   └─────────┬───────────────────────────┬───────────────┘
             │ spawn CLI                   │ read
   ┌─────────▼───────────┐     ┌───────────▼─────────────┐
   │  Node agent fleet    │     │  audit ledger (JSONL)   │
   │  (bin/agix, runtime) │     │  ~/.cache/agix/governance│
   └──────────────────────┘     └─────────────────────────┘
```
The Go server owns the concurrent/long-running surfaces (leases, serving); the Node fleet owns
agent execution; the ledger is the **shared substrate** both touch (Node writes gate/version/
release/launch entries; Go reads + serves + can append governed entries). Wire `agix agent serve`
to spawn/manage the Go binary (or the Go binary stands alone; the CLI just discovers it).

## 4. Local + deploy
- **Local (open-source, self-hostable):** a single Go binary, built at install (the `lewis-aos-bus`
  Rust pattern — compile from source in the Homebrew formula) or shipped as a signed release
  binary. `agix agent serve` starts it; `/up`+`/readyz` for health; File-snapshot backend by
  default (no cloud). This is the "someone can use it open-source to help them" path — no keys, no
  cloud, runs on their box.
- **Deploy (swappable):** a prior deploy path is Cloud Run + GCS-snapshot backend (WIF keyless);
  inherited but not required — the File backend is the local default and any object store works.
- **Bun** is the runtime for the API/server layer (an internal API runtime = Bun+Hono) when a hosted control
  plane is needed; the Go MCP server + Rust bus are the concurrent infra; Node is the local CLI +
  fleet. Polyglot by design, each language where it's strongest.

## 5. Open-core seam
- **Open (ships / self-hostable):** the Go MCP server itself — coordination + single-tenant ledger
  + agent-invocation tools, File/local snapshot, no auth-service dependency. Anyone runs it locally.
- **Commercial:** the hosted multi-tenant control plane — Kagi/Hanko-as-a-service auth (coord-mcp's
  cutover blocker: identity is asserted-not-authenticated locally), cross-tenant lease/ledger,
  RBAC/SSO, GCS-snapshot at scale. The "second seat" line again.

## 6. Isolation (public-bound)
On repatriation, strip internal product coupling (internal deploy-slot checks, `coord.mjs`-parity
messaging, product ledger paths); rename to `agix`. `verify-public-clean.sh` gates the Go tree same
as the Node tree. The scrub gate already covers the client names.

## 7. Build order (when we build it)
1. Repatriate `go-common` (lift-as-is) + the `coord-mcp` ledger/glob/snapshot/tools packages
   (strip coord.mjs-parity; File snapshot default).
2. Add the **ledger tools** (read/stats/append over the audit-ledger JSONL) — the Go/Node shared
   substrate.
3. Add the **agent-invocation tools** (shell → `agix agent run`).
4. Wire `agix agent serve` → the Go binary; Homebrew build-at-install (or signed release binary).
5. Auth: local = identity-asserted (dev); hosted = Kagi/Hanko broker (commercial).
