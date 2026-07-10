# Contributing to Agix AOS

Thanks for helping build Agix AOS. This guide covers dev setup, how agents are
structured, how to add one with an eval, and the public-clean gate every public-bound
change must pass.

## Dev setup

The `agix` CLI + agent runtime is Node.js and runs straight from a checkout — no build
step needed for the CLI itself.

**Prerequisites**

- **Node.js 20+** — the CLI and agents are Node.js.
- **Rust + Cargo** — to build the `lewis-aos-bus` daemon for `agix swarm` /
  `agix agent serve`.
- **pnpm 9+** — only for the website/platform workspace under `apps/` + `packages/`.
- **Python 3.11+** — only for `services/api-python`.

**Run the CLI from a dev checkout**

```sh
node bin/agix agent list           # list agents under ./agents/
node bin/agix agent smoke tester   # model-free smoke of one agent
node bin/agix agent eval --all     # run every agent's eval suite (the CI gate)
```

The full monorepo dev-setup (pnpm/Turborepo, website + services) lives in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Agent structure

Each agent is a directory under `agents/<name>/` with a consistent four-file shape:

| File | Purpose |
|---|---|
| `manifest.yaml` | Identity + runtime + config: `name`, `display_name`, `description`, runtime limits, outputs, and the **`soul:`** block (trust level, core truths, boundaries, vibe, `policy_file` pointer). |
| `agent.mjs` | The agent's executable logic — exports a `run({ opts })` entry the runtime calls. |
| `policy.yaml` | The capability/boundary companion to the soul: `filesystem` read/write/deny, allowed `tools`, and `bash.deny_patterns`. These declare what the agent SHOULD do — advisory today, not runtime-enforced; runtime enforcement is on the roadmap. See [`SECURITY.md`](SECURITY.md). |
| `PERSONA.md` | The agent's persona / voice (optional but recommended). |

Trust levels are `observer` (read-only), `proposer` (writes plans/notes, never source),
and `executor` (writes source, commits, pushes). Pick the lowest level the agent needs.

`context-warden` is a good reference implementation of all four files.

### Scaffold a new agent

```sh
agix agent new <name> [--trust observer|proposer|executor] [--description "..."]
```

This emits a complete, internally consistent, **immediately-smoke-green** agent (the same
four-file shape) you can then flesh out. On a dev checkout it writes into the repo's
`agents/`; on an installed copy it writes to a user dir (`~/.config/agix/agents/`) that
survives upgrades. Discovery scans both, so the new agent is immediately
listable / runnable / smokeable.

After scaffolding:

```sh
agix agent smoke <name>            # verify it runs model-free
agix agent run <name> --text "hi"  # run it for real
```

## Evals

Agents carry eval suites under `agents/<name>/eval/*.suite.mjs`. The convention:

```sh
agix agent eval <name>      # run one agent's suites
agix agent eval --all       # run every suite — this is the CI gate
agix agent eval --coverage  # which agents are missing an eval
```

`--all` must stay green. See `agents/context-warden/eval/` for the suite shape. When you
add an agent, add at least one eval suite for it.

## The public-clean gate (required for public-bound changes)

Agix AOS ships publicly via Homebrew, so **every public-bound change must pass the
public-clean gate**. It refuses to package anything carrying secret shapes, real email
addresses, product/client identifiers, operator-personal facts, or private-repo
references — the structural fix for the kind of leak that forced an earlier release to be
pulled.

Run it locally before opening a PR that touches anything that could ship:

```sh
scripts/release/verify-public-clean.sh <path> [<path> ...]
```

The release builder (`scripts/release/build-agix-tarball.sh`) runs this gate on the exact
staged tree and aborts on any finding. If you hit a genuine false positive, allowlist it
inline with a `# public-clean: ok <reason>` comment on the same line — never by loosening
the gate.

## Pull requests

- Branch with a descriptive slug (`docs/...`, `feat/...`, `fix/...`).
- Keep PRs scoped; stage only the files your change intends to touch.
- Make sure `agix agent eval --all` is green and the public-clean gate passes on anything
  public-bound.
- For release mechanics, see [`docs/operations/publish-release.md`](docs/operations/publish-release.md).
