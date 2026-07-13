<p align="center">
  <img src="https://github.com/user-attachments/assets/a83b50c5-51ca-405b-aa15-07c3b258a279" alt="Agix AOS — an operating system for a team of AI agents you own" width="100%">
</p>

# Agix AOS

An operating system for a team of AI agents you own. Scale your AI organically.

> ⚠️ **Agix AOS v0.1.2 is in beta.** It's early and actively evolving — expect rough edges
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

**See it move** — browse the agent fleet, call an agent on a task, fan one task across a governed
swarm, and watch it pause at the actor≠verifier gate — all `$0` (mock, deterministic):

![Agix AOS terminal demo](.github/assets/agix-demo.gif)

Install in one line (macOS), then run a governed multi-agent flow:

```sh
brew tap agix-ai/agix && brew trust agix-ai/agix && brew install agix-aos
agix flow "add a login page" --gate=approve
```

**Why a team instead of one agent?** Same models, but coordinated and *governed*: the agent
that does the work never verifies it, every action traces back to a person, and what the hive
learns lands in a knowledge graph you own. Not a smarter model, a better operating layer around it.

|  |  |  |  |
|---|---|---|---|
| [**Install**](#install) | [**The agent fleet**](#the-agent-fleet) | [**Your data & privacy**](#security--official-sources) | [**Docs**](AGENTS.md) |

## Install

Agix AOS installs from a Homebrew tap. A third-party tap requires a one-time `brew trust`
(Homebrew's acknowledgement that a formula comes from outside its official repos):

```sh
brew tap agix-ai/agix
brew trust agix-ai/agix       # one-time — required for any third-party tap
brew install agix-aos
```

What the install does and needs:

- The `agix` CLI is a **single Go binary** (`agix-core`); the agents are **TypeScript, run
  on [Bun](https://bun.sh)** (never Node), loaded dynamically from the install tree.
  Homebrew installs Bun (runtime) plus the Go and Rust toolchains (build-time only).
- Builds a **small Rust component on install** — the `lewis-aos-bus` intra-agent message
  bus (the messaging substrate) ships as source and compiles at install time from a clean
  checkout, cross-architecture (~18s, build-time only).
- State lives under your home dir: the durable instance — the knowledge fabric
  (`~/.agix/km.db`), `soul.md`, `settings.json`, and `wiki/` — under `~/.agix`, and any
  provider key files under `~/.config/agix/<provider>.env`. Each run also writes its
  audit ledger to a `./.agix/` in the working directory (gitignored). Nothing is
  installed system-wide beyond the formula tree.
- **No telemetry.** Agix makes no background network calls of its own. The only outbound
  calls are the model calls you trigger, through your CLI agent or a key you set. See
  [Security & official sources](#security--official-sources).

## First run

Just run `agix`. On a fresh machine it **auto-onboards** — zero config:

```sh
agix
```

First run provisions everything for you, under `~/.agix`:

- a local **knowledge fabric** — the Comb, at `~/.agix/km.db` (seeded with a few honest
  starter leaves, so it's non-empty out of the box),
- a `wiki/` for durable notes,
- a starting **`soul.md`** — your instance identity (a durable, human-editable
  notes-to-self today; the runtime does not load it automatically yet),
- a `settings.json` recording the detected default provider,
- and it **detects your installed CLI agent** (Claude Code, then Codex) and records it as
  the default provider — no API key required.

A short, optional get-to-know-you (name, role, what you're building) personalizes the
soul. You can run setup explicitly any time:

```sh
agix init               # full interactive onboarding (personalizes soul.md on a TTY)
agix init --defaults    # non-interactive: provision everything with placeholders
```

`init` is idempotent — a re-run keeps your existing state and never overwrites an edited
`soul.md`. If neither Claude Code nor Codex is installed, onboarding still completes and
defaults the provider to `mock` (a `$0` dry run) — it just asks you to install a CLI
agent (or set an API key) before agents make a real model call.

## Connect your model

Agix is the operating layer around a model, not a model itself. You point it at whatever you
already use, and you can mix these freely:

**1. The coding CLI you already have (default, no API key).** The agent fleet
(`agix agent run …`) runs through your installed **Claude Code** or **OpenAI Codex** CLI.
Agix auto-detects it on first run — nothing to configure. Calls count against that account's
usage, not a separate key.

**2. Your own API key (Anthropic, OpenAI, or Gemini).** For the direct provider path, set a
key one of two ways, then pass `--provider`:

```sh
# option A — an environment variable
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY / GEMINI_API_KEY

# option B — a per-provider file under your config dir (keeps it out of shell history)
mkdir -p ~/.config/agix
printf '%s\n' "your-key" > ~/.config/agix/anthropic.env   # or openai.env / gemini.env

agix run "summarize this repo" --provider anthropic        # or openai / gemini
```

**3. A local model (Ollama), $0.** Point Agix at a model you run yourself — nothing leaves
your machine:

```sh
ollama pull qwen3.6:35b-a3b                                 # any model you like
AGIX_LOCAL_MODEL=qwen3.6:35b-a3b agix run "..." --provider local
```

`--provider mock` is a deterministic, zero-network dry run for trying commands out.

| Provider | Enable it with | Key? | Cost |
|---|---|---|---|
| Claude Code / Codex *(default)* | installed CLI, auto-detected | no | your CLI account |
| Anthropic · OpenAI · Gemini | `--provider <p>` + key (env or `~/.config/agix/<p>.env`) | yes | provider billing |
| Local (Ollama) | `--provider local` + `AGIX_LOCAL_MODEL` | no | **$0** |
| mock | `--provider mock` | no | $0 (dry run) |

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
agix                              # print the banner + a command overview
agix agent list                   # list your agents
agix agent run <name> [flags]     # run an agent locally (agent-specific flags pass through)
agix agent new <name>             # scaffold a new agent (interactive wizard on a TTY)
agix agent edit <name>            # open its manifest in $EDITOR, then re-validate
agix agent validate <name>        # schema-check an agent against the runner's contract
agix fleet                        # interactive TUI — browse the fleet
agix debug "<issue>"              # name a problem, get the right agent (governed)
                                  #   also: refactor · research · review · test · onboard
agix hive "<task>"                # decompose → work → converge across a governed swarm
agix swarm --task "<task>" --workers 3   # in-process decompose → workers → converge
agix flow "<task>" --gate=approve # the governance graph; pauses at the actor≠verifier gate
agix artifacts <run> [--html]     # render a run's governance receipt (terminal or shareable HTML)
```

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
> `brew tap agix-ai/agix` → `brew trust agix-ai/agix` → `brew install agix-aos`. Don't
> install Agix from a fork or mirror you don't trust.
>
> **Agents act on your machine.** Agix is agentic software with real capabilities — its
> agents read and write a local brain + wiki, scaffold files, run your test suite, and
> coordinate over a local bus. Executor-trust agents can write source, commit, and push.
> The trust model is **advisory today** (declared in each agent's policy, not yet
> hard-enforced at runtime). **Review any agent before you run it** — especially
> executor-trust agents or anything you didn't author.
>
> **Your data stays local.** No telemetry, no covert network calls, nothing phones home.
> State lives under `~/.agix` (the knowledge fabric, `soul.md`, `settings.json`, `wiki/`)
> and `~/.config/agix` (provider key files); each run's audit ledger is a `./.agix/` in
> its working directory. The only outbound calls are the model calls you trigger.

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
```

That removes the binary and formula tree. Agix keeps your instance state (the knowledge
fabric, `wiki/`, `soul.md`, and `settings.json`) under your home dir; to purge that too,
remove it by hand:

```sh
rm -rf ~/.agix ~/.config/agix
```

## Contributing

Dev setup, the agent structure, the DCO, and the public-clean release gate are in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Agent-authored contributions are welcome — see
[`AI_POLICY.md`](AI_POLICY.md). Be kind: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). Copyright © 2026 Agix AI LLC.
