# hive-gateway

Apiary **report-home** ingest for a federated hive. A remote/cloud swarm forages,
then POSTs a canonical cross-hive envelope to its destination hive's gateway. The
gateway authenticates the caller, validates the envelope at the perimeter (right
hive, well-formed actor, **drone sender only** — workers never cross a boundary),
and appends an accepted event to the hive's append-only audit ledger.

**Endpoint:** `POST /apiary/report` (bearer-authed) — body is the cross-hive
envelope; returns `200 {"accepted":true,"entry_id":...,"envelope_id":...}`.
`GET /up` and `GET /readyz` are unauthenticated health probes.

**Env:** `HIVE_GATEWAY_KEY` (per-hive bearer, required), `HIVE_NAME` (hive served,
required), `HIVE_LEDGER_PATH` (default `./tenants/<HIVE_NAME>/ledger.jsonl`),
`PORT` (default 8080), `AGIX_LOG_QUIET` (`1` silences request logs).

**Build:** `docker build -f services/hive-gateway/Dockerfile services/`
