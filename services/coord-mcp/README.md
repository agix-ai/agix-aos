# agix-coord-mcp

The Agix agent-coordination lease ledger, exposed as an MCP server — the
coordination control plane any MCP-speaking agent (Claude Code, Cursor, the
Agix fleet) can call to claim work, avoid collisions, and read the audit log.

## Tools

| Tool | What it does |
|---|---|
| `claim_lease` | Atomically claim path globs (rejects overlaps with other agents' active exclusive claims). `leaseId` narrows/replaces a lease you own. |
| `release_lease` | Release a lease — **owner or coordinator only**; never automatic. |
| `heartbeat` | Extend liveness; leases silent past their TTL get marked `expired` (not deleted) by a lazy sweep. |
| `list_leases` | Compact current view (active by default). |
| `check_overlap` | Do these files fall under someone else's active claim? (Includes `shared-append` coexistence + excludes.) Always runs as your authenticated identity; only the coordinator key may check on another agent's behalf. |
| `get_events` | Tail the append-only audit log. |
| `ledger_read` | Read the Agix audit-ledger JSONL (governance system of record): filter by kind, scope, and `since`. Read-only. |
| `ledger_stats` | Summarize the audit ledger: totals by kind, verdict, and phase. Read-only. |

`ledger_read` / `ledger_stats` are registered only when an audit ledger is
found (see `AGIX_LEDGER_PATH` below).

When persistence cannot be confirmed, `list_leases`/`get_events` responses and
the `/healthz` body carry a `degraded` flag: reads keep serving from memory,
writes fail closed until storage recovers.

Glob syntax: `*` (within a segment), `**` (any depth), `?` (one char), bare
directory prefix = whole subtree, `excludes[]` subtract from your claims, mode
`shared-append` coexists with other shared-append holders.

Identity comes from the `X-Coord-Agent` header (HTTP) or `COORD_MCP_AGENT`
(stdio); the shared key gates access, identity attributes actions (trust level:
fleet-internal — see DESIGN.md).

## Quickstart

Requires Go 1.26+.

```bash
cd services/coord-mcp

# tests (race detector on — the claim path is concurrency-critical)
go test -race ./...

# local stdio run (single session; identity from env, file-backed ledger)
COORD_MCP_AGENT=me COORD_MCP_STORE=/tmp/coord-ledger.json \
  go run ./cmd/coord-mcp -stdio

# local HTTP run
COORD_MCP_KEY=dev-key COORD_MCP_STORE=/tmp/coord-ledger.json PORT=8080 \
  go run ./cmd/coord-mcp
curl -s localhost:8080/healthz   # plain-text liveness
curl -s localhost:8080/up        # {ok, service, version}
curl -s localhost:8080/readyz    # readiness + persistence check
```

Configuration (env):

| Var | Meaning |
|---|---|
| `COORD_MCP_KEY` | shared fleet bearer key (required for HTTP) |
| `COORD_MCP_COORDINATOR_KEY` | optional coordinator key — may release/narrow leases it doesn't own |
| `COORD_MCP_STORE` | `gs://bucket/object`, a local file path, or empty = ephemeral memory. **File is the local default**; `gs://` selects the optional GCS backend. |
| `COORD_MCP_AGENT` | agent identity for stdio runs |
| `AGIX_LEDGER_PATH` | full path to the audit-ledger `ledger.jsonl` (enables `ledger_read`/`ledger_stats`) |
| `AGIX_DATA_DIR` / `AGIX_TENANT` | fallback: derive the ledger path as `<AGIX_DATA_DIR>/governance/tenants/<AGIX_TENANT>/ledger.jsonl` |
| `AGIX_LOG_QUIET` | `1` silences the per-request `http_request` log lines |
| `PORT` | HTTP port (default 8080) |

Flags: `-stdio` (single stdio session), `-coordinator` (stdio only: act with
the coordinator role).

## Shared substrate

Logging (structured `{severity, kind, event, ...}` JSON), shared-key auth,
`/up` + `/readyz`, and graceful SIGTERM shutdown come from
[`services/go-common`](../go-common) — consumed via a relative `replace` in
`go.mod` (zero external dependencies, so this module's `go.sum` and its
single-dep supply-chain stance are unchanged). The only external dependency is
the official MCP Go SDK.

## Build / deploy

- Image: build context is `services/` (the relative replace must resolve):
  `cd services && docker build -f coord-mcp/Dockerfile .` → static binary in
  `distroless/static` (CGO off). `cloudbuild.yaml` drives the same invocation.
- Local (open-source, self-hostable): a single Go binary, File-snapshot backend
  by default — no keys, no cloud, runs on your box.
- Hosted (optional, commercial): Cloud Run + GCS-snapshot backend
  (`COORD_MCP_STORE=gs://…`), `--no-allow-unauthenticated`, min-instances=0,
  max-instances=1 (single-writer ledger).

## Design

Storage choice (in-memory + write-through snapshot), the auth trust model, the
preserved coordination properties (never-auto-release, append-only audit,
anti-self-unclaim), the open-core seam, and the deferred `run_agent` tool: see
[DESIGN.md](./DESIGN.md).
