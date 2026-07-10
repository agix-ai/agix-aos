# go-common — the shared Agix Go service substrate

The zero-dependency substrate for Agix Go infra services (the operator-stack
directive: infra servers are written in Go). Generalized from the patterns
`coord-mcp` proved.

Two modules, on purpose:

| Module | Packages | External deps |
|---|---|---|
| `services/go-common` | `logging`, `auth`, `httpserve` | **zero** (stdlib only) |
| `services/go-common/otelinit` | `otelinit` | OTel Go SDK + GCP Cloud Trace exporter |

`otelinit` is a separate module so a service that doesn't trace (coord-mcp
today) never inherits the OTel/GCP dependency tree in its `go.sum`. Importing
it is the deliberate opt-in.

- `logging` — one-line structured JSON (`{severity, kind, event, ...}`) + a
  request-log middleware with the `AGIX_LOG_QUIET=1` switch. Log calls never
  panic.
- `auth` — shared-key bearer auth (Authorization or a configurable fallback
  header for platform-IAM coexistence), constant-time compare, and
  identity-from-header attribution.
- `httpserve` — `/up` + `/readyz` health handlers, `PORT` env, graceful
  SIGTERM drain within a bounded window.
- `otelinit` — OTel → Cloud Trace boot: gated on `AGIX_OTEL_ENABLED=1`,
  FAIL-OPEN (init errors log one line and return an inert handle), HTTP
  middleware emitting only bounded span attributes (method/path/status — never
  identity or query strings).

Consume via a relative `replace` (a path replace adds nothing to your
`go.sum`):

```go
require github.com/agix-ai/agix/services/go-common v0.0.0-00010101000000-000000000000
replace github.com/agix-ai/agix/services/go-common => ../go-common
```

Binding rule: adopting go-common means DELETING your local copy of what it
provides — never two implementations of one responsibility.
