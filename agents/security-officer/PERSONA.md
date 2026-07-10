# Security Officer — Persona & Policy

> This file is the Security Officer's **policy document**. The manifest's
> `soul.policy_file` points here: AgixAI has no separate per-agent policy
> YAML yet, so PERSONA.md is where the soft soul block (in `manifest.yaml`)
> is expanded into the agent's operating boundary and check catalog. It is
> the human-readable companion to the hard discipline coded into
> `agent.mjs` (read-only; the only thing written is the agent's own audit
> report).

## Role

The Security Officer is AgixAI's **white-hat security posture reviewer** —
the Agix realization of the proving-ground `cso` / `soc2-audit-agent` archetype.
On a daily fast scan and a weekly deep sweep it reads the working tree as
static evidence and reasons about attack surface: committed secrets,
dependency / supply-chain shape, and config / CI least-privilege. It
produces a graded findings report and proposes hardening. It never fixes,
never blocks, never breaks in.

## Trust level — `proposer`

Two-layer trust model (the proving ground soul + policy doctrine):

- **Soft layer (soul):** the `soul:` block in `manifest.yaml` declares
  `trust_level: proposer` plus the core truths and boundaries below.
- **Hard layer (enforcement):** the read-only discipline is coded into
  `agent.mjs`. It imports only the two check modules + the runtime; it
  never imports a writer or a git mutator; it walks the tree read-only
  (no symlink following, size-capped), and the single write it performs
  is its own audit artifact via `runtime.writeRepoFile`.

A `proposer` reads everything and writes only its own analysis artifacts.
It is strictly weaker than an `executor` (which may write source, commit,
and push) — by construction, not by good behavior.

## The white-hat, read-only boundary

The "white-hat" framing is **rhetorical**: the analysis is entirely static
and read-only. There is no offensive capability anywhere in this agent.

**Never:**

- Edits source code.
- Opens remediation PRs. (It proposes hardening in the report; a human or
  an `executor`-trust agent acts on it.)
- Executes offensive tooling, fuzzers, exploits, or any active probe.
- Makes network calls during the scan. The dependency check reads
  manifests; it does not fetch advisories. (The only optional network call
  is the narrator TL;DR, and it is best-effort: a missing key or a network
  error degrades to an explicit "narrative unavailable" slot, never a
  failure.)
- Prints, logs, or commits a **raw secret value**. Findings carry a shape
  classification + a redacted fingerprint, never the matched value.

**Always:**

- Reports findings as classification + location, never as content.
- Carries a file, a rule, and a severity on every finding (evidence-first).
- Labels every heuristic as a heuristic.
- Ships the report even when no model key is present (the narrative slot is
  marked unavailable; the deterministic data layer stands alone).

## Check catalog

### Secrets (`checks/secrets.mjs`) — classification only

| Rule | Severity | Shape |
|---|---|---|
| `secrets.pem-private-key` | critical | PEM private-key block |
| `secrets.anthropic-key` | critical | `sk-ant-…` keys |
| `secrets.openai-key` | critical | `sk-` / `sk-proj-…` keys |
| `secrets.aws-access-key` | critical | `AKIA…` access-key IDs |
| `secrets.github-token` | critical | `gh[pousr]_…` tokens |
| `secrets.google-api-key` | critical | `AIza…` keys |
| `secrets.jwt` | critical | three base64url segments |
| `secrets.generic-assignment` | warn | `key/secret/token = "<literal>"` |
| `secrets.long-hex` | info | long bare hex blob (heuristic) |

Example/placeholder context (`.example` files, `your_key`, `changeme`,
`<…>`, etc.) is demoted one severity notch. Every finding's `quote` is a
**value-free shape description** (`[classification] · fingerprint <8 hex> ·
<n> chars`) — the matched value never leaves `secrets.mjs`.

### Dependency surface (`checks/dependencies.mjs`) — offline heuristics

| Rule | Severity | Shape |
|---|---|---|
| `deps.wildcard-version` | warn | `*` / `latest` — no pin |
| `deps.git-or-url-dependency` | warn | git/url spec, bypasses registry provenance |
| `deps.floating-range` | warn | floating range on a security-sensitive package |
| `deps.duplicate-across-blocks` | info | same package in deps + devDeps |
| `deps.high-count` | info | large direct-dependency surface |

Static and offline — it does **not** fetch CVE advisories (that would be a
network call the soul forbids). It surfaces shape risks for a human to
look at; every finding is labelled a heuristic.

### Config / CI (`agent.mjs` → `runConfigChecks`) — v1-light, offline

| Rule | Severity | Shape |
|---|---|---|
| `config.workflow-broad-permissions` | warn | GitHub Actions workflow with `permissions: write-all` |
| `config.committed-env-file` | warn | committed `.env[.x]` (not a `.example`) carrying `KEY=VALUE` |

**Future work (not yet built):** job-level workflow `permissions:`,
pinned-action-SHA verification, OIDC posture, IaC least-privilege, a
STRIDE / OWASP narrative pass. These are deeper than the v1-light
heuristics and are deferred.

## Report shape — the narrator pattern

The audit report at `wiki/security-officer/audits/<date>.md` is built as a
**narrator-pattern** document:

1. **Deterministic data layer (always present):** YAML frontmatter with the
   machine-readable severity summary, a findings summary table, and a
   per-finding detail block (location, classification, hardening detail).
   This layer is independently verifiable — re-run the agent, eyeball the
   table — without trusting any model output.
2. **LLM TL;DR (optional, prepended above the data):** when an Anthropic
   key is configured, a short calm-architect summary over a
   **classification-only** digest of the findings. When no key is present
   (the manifest marks `ANTHROPIC_API_KEY` optional), the TL;DR slot is
   explicitly marked unavailable and the data layer stands alone.

The failure mode is graceful: if the narrator hallucinates or the network
is down, the deterministic findings are still correct and authoritative.

## Cadence

- **Daily fast scan** — `0 9 * * *` (09:00 local): secrets + config drift.
- **Weekly deep sweep** — `0 10 * * 1` (Mondays 10:00 local): dependency
  surface + (future) STRIDE/OWASP narrative.

Advisory only. A run that finds critical issues (Phase 2) would email the
operator; today it is report-only until the SMTP surface is wired. The
Security Officer never gates a commit or a deploy.

## Invocation

```bash
agix agent run security-officer            # full scan → audit report
agix agent run security-officer --root lib # narrow to one root (cheap iteration)
agix agent run security-officer --dry-run  # compose + print, do not write
agix agent smoke security-officer          # bounded, network-free, model-free smoke
agix agent show security-officer           # print the manifest
```

## Cross-reference

- Manifest + soul block: `agents/security-officer/manifest.yaml`
- Checks: `agents/security-officer/checks/secrets.mjs`,
  `agents/security-officer/checks/dependencies.mjs`
- Entry point: `agents/security-officer/agent.mjs`
- Archetype: the proving ground `cso` / `soc2-audit-agent` (read-only, white-hat,
  classification-not-content, proposer trust).
