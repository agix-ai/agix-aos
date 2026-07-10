# Agix AOS

An operating system for a team of AI agents you own. Scale your AI organically.

> ⚠️ **Agix AOS v0.1.0 is in beta.** It's early and actively evolving — expect rough edges
> and breaking changes between releases. [Issues and feedback](../../issues) are very welcome.

[![Website](https://img.shields.io/badge/website-agix--ai.io-1f2937)](https://agix-ai.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-3b82f6)](LICENSE)
[![Homebrew tap](https://img.shields.io/badge/homebrew-agix--ai%2Fagix-8b5e34)](https://github.com/agix-ai/homebrew-agix)

![Platform: macOS](https://img.shields.io/badge/platform-macOS-6b7280)
![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-4b5563)
![Core: Go + Rust](https://img.shields.io/badge/core-Go%20%2B%20Rust-8b5e34)
![No API key required](https://img.shields.io/badge/API%20key-not%20required-2f6f4e)

Agix AOS is a local agentic operating system: a CLI (`agix`) plus a fleet of agents that
coordinate over an intra-agent message bus, backed by a local knowledge fabric and a
growing instance "soul." It runs on the coding-agent CLI you already have — **Claude Code
or OpenAI Codex** — so there's **no API key to manage**. You bring the model; Agix brings
the operating layer around it: cheaper multi-agent coordination and orchestration
discipline, using the same models your CLI already calls.

> **Honest framing, up front.** Agix AOS is *agentic software with real capabilities* — it
> runs agents that act on your machine (read/write a local brain + wiki, run a task over a
> local bus, scaffold files). Its value is **cheaper multi-agent coordination and
> orchestration discipline**, not smarter answers: it uses the same models your CLI already
> calls.

|  |  |  |  |
|---|---|---|---|
| [**Install**](#install) | [**The agent fleet**](#the-agent-fleet) | [**Your data & privacy**](#security--official-sources) | [**Docs**](AGENTS.md) |

## Install

Agix AOS installs from a Homebrew tap:

```sh
brew tap agix-ai/agix
brew install agix-aos
```

What the install does and needs:

- The `agix` CLI is a **single Go binary** (`agix-core`); the agents are **TypeScript, run
  on [Bun](https://bun.sh)** (never Node), loaded dynamically from the install tree.
  Homebrew installs Bun (runtime) plus the Go and Rust toolchains (build-time only).
- Builds a **small Rust component on install** — the `lewis-aos-bus` intra-agent message
  bus ships as source and compiles at install time (so `agix swarm` and `agix agent serve`
  work from a clean install, cross-architecture; ~18s, build-time only).
- State lives under your home dir (`~/.config/agix`, `~/.cache/agix`,
  `~/.local/state/agix`) — nothing is installed system-wide beyond the formula tree.
- **No telemetry.** Agix makes no background network calls of its own. The only outbound
  calls are the model calls you trigger, through your CLI agent or a key you set. See
  [Security & official sources](#security--official-sources).

## First run

Just run `agix`. On a fresh machine it **auto-onboards** — zero config:

```sh
agix
```

First run provisions everything for you:

- a local **knowledge fabric** (seeded, so it's non-empty out of the box),
- a `wiki/` for your durable notes,
- a starting **`soul.md`** (your instance identity, which grows as Agix learns about you),
- a `settings.json`,
- and it **picks your installed CLI agent as the provider** (Claude Code or Codex) — no
  API key required.

A short, optional get-to-know-you (name, role, what you're building) personalizes the
soul. You can run setup explicitly any time:

```sh
agix init               # full interactive onboarding
agix init --defaults    # non-interactive: provision everything with placeholders
```

If neither Claude Code nor Codex is installed, onboarding still completes — it just asks
you to install a CLI agent (or set an API key) before agents make a model call.

## The agent fleet

Agix ships a fleet of generic, basic-tier agents — a **team**, not a single assistant.
Each carries an explicit role, trust level, and boundary, so the fleet stays legible and
governed: you can see who is allowed to do what, and why. That legibility is the point —
it's the difference between one opaque chatbot and an operating layer you can reason about.

| Agent | What it does |
|---|---|
| `mentor` | Strategic mentor (the conductor) — synthesizes your goals, re-grounds you when execution drifts from your North Star. Five modes (brief / chat / plan / session / goals). |
| `architect` | Cross-references new findings against your in-flight specs; annotates them and flags duplicates. |
| `research` | Scans your curated sources and synthesizes a structured, graded brief. |
| `investigator` | Root-cause debugger — runs a structured investigate → analyze → hypothesize pass and writes a diagnosis. Holds the Iron Law: no fix without identifying the root cause first. |
| `tester` | Runs your project's test suite and reports pass/fail + regressions. Surfaces failures; never patches source to make a test pass. |
| `git-orchestrator` | Owns the mechanical git/merge ceremony and learns from CI/merge failures across runs. Never force-pushes; never auto-merges past the gate. |
| `onboarding` | Reads a codebase (read-only) and produces a baseline source map + readiness assessment. |
| `context-warden` | Watches a long session's context occupancy and warns you when it enters the degradation zone (time to switch sessions / compact). |

…plus governance and release roles (`security-officer`, `sentinel`, `curator`, `director`,
`release-manager`, and more). Run `agix agent list` to see the full set, and grow it
yourself with `agix agent new <name>` — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

A structural rule runs through the fleet: **the agent that produces work is never the one
that certifies it** (actor ≠ verifier). See [`AGENTS.md`](AGENTS.md).

### Core commands

```sh
agix                              # interactive mentor + slash commands (the default entry point)
agix agent list                   # list your agents
agix agent run <name> [flags]     # run an agent locally
agix agent new <name>             # scaffold a new working agent from the template
agix swarm --worker <name> --n 3  # fan tasks out to a serving worker over the bus
agix soul show                    # print your instance soul (it grows with you)
agix soul note "<learning>"       # append a dated learning to the soul
```

`agix swarm` needs a worker answering on the bus — start one in another shell with
`agix agent serve <name>` first (otherwise the fanout returns `0/N ok`: the bus routes
fine, but there's no one home).

## What's inside

```
agix-aos/
├── core/        # the Go engine + the `agix-core` CLI — the governed capability boundary
├── fleet/       # the TypeScript runtime (runs on Bun): engine seam, bus client, Comb, soul
├── agents/      # the agent fleet — one directory per agent (manifest + behavior + policy)
├── packs/       # bundled agent packs
├── services/    # the coordination plane (MCP lease ledger) + shared components
├── cli/         # the Rust intra-agent bus (`crates/lewis-aos-bus`) + CLI glue
└── packaging/   # the Homebrew formula and release packaging
```

Agents don't touch the OS directly — they act through the Go engine's **governed tool
catalog** (filesystem, metrics, process exec), which scopes and audits every call. The
capability *is* the boundary.

## Security & official sources

> [!NOTE]
> **Install only from the official tap.** The only supported install path is
> `brew tap agix-ai/agix` → `brew install agix-aos`. Don't install Agix from a fork or
> mirror you don't trust.
>
> **Agents act on your machine.** Agix is agentic software with real capabilities — its
> agents read and write a local brain + wiki, scaffold files, run your test suite, and
> coordinate over a local bus. Executor-trust agents can write source, commit, and push.
> The trust model is **advisory today** (declared in each agent's policy, not yet
> hard-enforced at runtime). **Review any agent before you run it** — especially
> executor-trust agents or anything you didn't author.
>
> **Your data stays local.** No telemetry, no covert network calls, nothing phones home.
> State lives under `~/.config/agix`, `~/.cache/agix`, and `~/.local/state/agix`. The only
> outbound calls are the model calls you trigger.

Full detail, the trust-model roadmap, and how to report a vulnerability are in
[`SECURITY.md`](SECURITY.md).

## Platform support

| Platform | Status |
|---|---|
| **macOS** (Apple Silicon + Intel) | **Supported** — built and install-verified on arm64; the install path is architecture-independent. |
| **Linux** | **Beta** — the intra-agent bus uses portable Unix-domain sockets and the install path is cross-architecture by design, but it is not yet exercised end-to-end on a Linux runner. |
| **Windows** | **Unsupported** — the bus is built on Unix-domain sockets, which Windows does not provide. Use WSL2 if you're on Windows. |

## Uninstall

```sh
brew uninstall agix-aos        # remove the agix CLI + formula tree
agix uninstall --purge-state   # OR, before uninstalling the binary: purge per-user state
```

`agix uninstall` (no flag) previews exactly which state dirs it would remove; add
`--purge-state` (or `--yes`) to delete them. If you've already run `brew uninstall`, remove
them by hand:

```sh
rm -rf ~/.config/agix ~/.cache/agix* ~/.local/state/agix
```

## Contributing

Dev setup, the agent structure, the DCO, and the public-clean release gate are in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Agent-authored contributions are welcome — see
[`AI_POLICY.md`](AI_POLICY.md). Be kind: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). Copyright © 2026 Agix AI LLC.
