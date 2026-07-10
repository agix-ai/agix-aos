# agix-coord-mcp — design notes

The Agix agent-coordination lease ledger, exposed as an MCP server. It is the
**coordination control plane** the loop-engineered SDLC's Integrate gate and
parallel-agent safety assume: agents claim path globs over the tree before
editing, and the server refuses overlapping exclusive claims **race-free**, so
two agents can never both hold the same file.

Companion: `architecture/03-ai-ml/agent-architecture/GO_MCP_SERVER.md` (the
repatriation spec + open-core seam).

## Tool surface

Two groups today:

**Coordination (Go-native lease plane):**
`claim_lease` · `release_lease` · `heartbeat` · `list_leases` ·
`check_overlap` · `get_events`.

**Ledger (read-only, the Node↔Go shared substrate):**
`ledger_read` · `ledger_stats` over the Agix governance audit ledger.

## Coordination semantics

| Property | Mechanism |
|---|---|
| No premature orphan-clear | Liveness is first-class: `heartbeat` + TTL. Expiry is a **lazy sweep on read** that marks leases `expired` (events preserved) — it never *releases* them. |
| No branch-name false-block | Leases are **identity-keyed** (`agent`, `branches[]`): an agent's own leases never block it, across branches and stacked PRs. |
| No edit races | Claims are atomic server calls under **one mutex** — the overlap check and the write happen in one critical section (race-tested with `-race` + a 32-goroutine exactly-one-winner test). |
| No prose false-claims | Claims only enter via the typed `claim_lease` call; there is no free-text channel to mis-parse. |
| Owner-authenticated release | `release_lease` succeeds only for the **owning agent identity or the coordinator key**; a foreign release is refused and the attempt is attributable (`releasedBy` + the event actor). |

**Never-auto-release / anti-self-unclaim.** Expiry marks a lease `expired`;
only an explicit, attributed call releases it. Expired ≠ released ≠ deleted.

**Append-only audit.** The event log (`claimed / released / heartbeat /
expired / narrowed`) is the source of truth; the current-leases view is a
replay of it. Events carry lease snapshots, so the log alone reconstructs
history. `get_events` is the exportable tail.

**Conservative defaults.** A persist failure rolls the mutation back
(fail-closed: an unpersisted claim is never handed out). Overlap rejections
tell the agent to narrow scope or route to the owner — never to override.

## Storage: in-memory + write-through snapshot

Materialized state lives in RAM; the append-only event log is persisted as ONE
JSON object, written **synchronously on every mutation** (write-through, not
periodic flush). Backends:

- **`MemorySnapshotter`** — ephemeral / tests.
- **`FileSnapshotter`** — **the local default** (atomic tmp+rename). No keys, no
  cloud: `COORD_MCP_STORE=/path/to/ledger.json`. This is the open-source,
  self-hostable path.
- **`GCSSnapshotter`** — the optional **commercial/hosted** path, selected by a
  `gs://bucket/object` store target. One JSON object written with GCS
  `ifGenerationMatch` preconditions (compare-and-swap). It uses the raw GCS
  JSON API + the metadata-server token — **zero extra dependencies**, so the
  module's only external dependency stays the official MCP Go SDK.

Consequences, priced:

- **Durability:** write-through means a crash loses nothing acknowledged. A
  failed save rolls back and the tool call errors.
- **Write-result ambiguity:** a save whose response is lost (network / 5xx) may
  have committed. `GCSSnapshotter.Save` resolves it by reading the object back:
  bytes match → the write landed, adopt the observed generation and report
  success; mismatch or read-back failure → roll back and mark the store
  **DEGRADED** (surfaced in `list_leases`/`get_events` output and `/healthz`)
  rather than silently diverging. A definite **412** reloads the snapshot,
  replays, and returns a retryable `ErrLedgerConflict` — no restart-to-recover
  wedge.
- **Reads never persist:** expiry on the read paths is computed view-side; only
  mutating calls persist the lazy sweep. Reads keep answering from memory when
  storage is down; writes fail closed.
- **Concurrency:** correctness needs a single writer. The store mutex serializes
  concurrent requests; on the hosted path, `max-instances=1` plus the GCS
  generation precondition turns any second writer into a loud, recoverable
  conflict rather than silent corruption.
- **Scale ceiling:** one JSON object rewritten per event is fine to ~10⁴–10⁵
  events. Past that, compaction (snapshot + event tail) is the answer.

## Auth trust model (documented level: fleet-internal)

- **Key gates access:** `COORD_MCP_KEY` (fleet) / `COORD_MCP_COORDINATOR_KEY`
  (coordinator), compared constant-time (SHA-256 both sides, then
  `subtle.ConstantTimeCompare`). No valid key → 401 before any tool runs. Behind
  a platform IAM layer (e.g. Cloud Run `--no-allow-unauthenticated`), the IAM
  identity token owns `Authorization`, so the shared key also rides
  `X-Coord-Key` (defense in depth).
- **Identity attributes actions:** `X-Coord-Agent` names the caller. It is
  *claimed, not proven* — any fleet-key holder could assert any name. The
  guarantee is that ownership is now *checked*: a release/narrow/heartbeat by a
  non-owner without the coordinator key is refused and attributable.
  `check_overlap` always runs as the authenticated identity; a caller-supplied
  `agent` argument is honored only for the coordinator key (otherwise any agent
  could pass `agent=<owner>` and get a false "no overlap" on the owner's files).

## Open-core seam

- **Open (ships / self-hostable):** this Go MCP server — coordination +
  single-tenant read-only ledger tools, File/local snapshot, no auth-service
  dependency. Anyone runs it locally.
- **Commercial (hosted control plane):** authenticated-not-asserted identity
  (short-TTL minted per-agent tokens), cross-tenant lease/ledger, RBAC/SSO,
  GCS-snapshot at scale. Identity moving from *claimed* to *authenticated* is
  the cutover-blocker to a multi-tenant authoritative plane, and lives on the
  hosted path by design.

## The ledger tools (Node↔Go shared substrate)

`ledger_read` / `ledger_stats` expose the Agix governance **audit ledger** —
the per-tenant, append-only JSONL system of record (gate decisions, verifier
verdicts, merges, leases, releases, version bumps, launches) that the Node
fleet writes. The Go server **reads and serves** it so an external agent can
inspect the fleet's verified verdicts, gate history, and governance rollups.

- On-disk shape matches the Node audit ledger record (`entry_id`, `ts`,
  `scope{enterpriseId,userId,roleId,mandateId,runId}`, `actor`, `phase`,
  `kind`, `verifier`, `verdict`, `authority_used`, `inputs_hash`, `cost`,
  `overridden_by_human`, `meta?`), one JSON object per line.
- Path resolution mirrors the Node runtime's `getLedger()` FileLedger location:
  `AGIX_LEDGER_PATH` wins; else
  `<AGIX_DATA_DIR | $XDG_STATE_HOME/agix | ~/.local/state/agix>/governance/tenants/<AGIX_TENANT | agix>/ledger.jsonl`.
- **READ-ONLY by design.** The append side stays on the Node runtime — the
  authority that validates kinds/verdicts/scope and shapes each entry. The Go
  reader tolerates a torn tail line and reads a not-yet-existent ledger as
  empty (the tools are always safe to register).

## Deferred (follow-on)

- **`ledger_append` (governed writes).** A write path from the Go side would
  need to re-implement the Node ledger's kind/verdict/scope validation and its
  isolation guarantees. Deferred until that contract is shared safely; the Node
  runtime remains the single writer for now.
- **Agent-invocation tools (`list_agents` / `run_agent`).** A thin shell-to-CLI
  frontend over the Node fleet (`agix agent run <name>`) — the Go server as a
  thin frontend, no agent rewrite. Deferred to a follow-on per the spec
  (GO_MCP_SERVER.md §2/§7); noted here so the boundary stays explicit.

## Layout

```
services/coord-mcp/
  cmd/coord-mcp/main.go     entrypoint: stdio (-stdio) or Streamable HTTP (:PORT)
                            (logging/health/shutdown wiring from go-common)
  internal/ledger/          lease event log + materialized view, glob port, snapshotters
  internal/auditledger/     read-only governance audit-ledger JSONL reader
  internal/tools/           MCP tool registration + handlers (coord + ledger groups)
  Dockerfile                multi-stage → distroless/static, CGO_ENABLED=0
  cloudbuild.yaml           the same build for a hosted image
```

The generic substrate (logging / auth / health / shutdown) is imported from
`services/go-common` via a relative `replace` — no duplicate copies here.
