# Agix AOS

**A turnkey, LLM-agnostic multi-agent operating layer for your machine.**

Agix AOS is a local agentic operating system: a CLI (`agix`) plus a small fleet of
agents that coordinate over an intra-agent message bus, backed by a local knowledge
fabric (gbrain) and a growing instance "soul." It runs on the coding-agent CLI you
already have — **Claude Code or OpenAI Codex** — so there's **no API key to manage**.

> **Honest framing, up front.** Agix AOS is *agentic software with real capabilities* —
> it runs agents that act on your machine (read/write a local brain + wiki, run a task
> over a local bus, scaffold files). Its value is **cheaper multi-agent coordination and
> orchestration discipline**, not smarter answers: it uses the same models your CLI
> already calls. You bring the model; Agix brings the operating layer around it.

---

## Install

Agix AOS installs from a Homebrew tap. A third-party tap requires a one-time `brew trust`.

```sh
brew tap blewis-maker/agix
brew trust blewis-maker/agix      # one-time — Homebrew requires trust for third-party taps
brew install agix-aos
```

**What the install does / needs:**

- Requires [`node`](https://nodejs.org) (Homebrew installs it as a dependency). The CLI
  is Node.js; agents are loaded dynamically from the install tree and run by `node`.
- Builds a **small Rust component on install** — the `lewis-aos-bus` intra-agent message
  bus is shipped as source and compiled at install time (so `agix swarm` and
  `agix agent serve` work from a clean install, cross-architecture).
- State lives under your home dir (`~/.config/agix`, `~/.cache/agix`,
  `~/.local/state/agix`) — nothing is installed system-wide beyond the formula tree.
- **No telemetry.** Agix AOS makes no background network calls of its own — it doesn't
  phone home or collect analytics. The only outbound calls are the model calls you
  trigger, through the CLI agent (Claude Code / Codex) or API key you configure. See
  [`SECURITY.md`](SECURITY.md).

> **Why `brew trust`?** Homebrew requires a one-time `brew trust` for any third-party tap
> (a tap that isn't `homebrew/core`). It's Homebrew telling you "this formula comes from
> outside the official repos" — running it once acknowledges that and lets `brew install`
> proceed.

> **Not published yet?** v0.2.0 is built and install-verified but going live is a
> deliberate operator step. If `brew tap` can't find it, the tap isn't public yet — see
> [`docs/operations/publish-release.md`](docs/operations/publish-release.md).

## First run

Just run `agix`. On a fresh machine it **auto-onboards** — zero config:

```sh
agix
```

First run provisions everything for you:

- a local **gbrain** knowledge fabric (seeded, so it's non-empty out of the box),
- a `wiki/` for your durable notes,
- a starting **`soul.md`** (your instance identity, which grows as Agix learns about you),
- a `settings.json`,
- and it **picks your installed CLI agent as the provider** (Claude Code or Codex) — no
  API key required.

A short, optional get-to-know-you (name, role, what you're building) personalizes the
soul. You can run the setup explicitly any time:

```sh
agix init               # full interactive onboarding
agix init --defaults    # non-interactive: provision everything with placeholders
```

If neither Claude Code nor Codex is installed, onboarding still completes — it just asks
you to install a CLI agent (or set an API key) before agents make a model call.

## Core commands

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

## What ships in the pack

Eight generic, basic-tier agents — described by what they do for you:

| Agent | What it does |
|---|---|
| `sensei` | Strategic mentor — synthesizes your goals, re-grounds you when execution drifts from your North Star. Five modes (brief / chat / plan / session / goals). |
| `architect` | Cross-references new findings against your in-flight specs; annotates them and flags duplicates. |
| `research` | Scans your curated sources and synthesizes a structured, graded brief. |
| `git-orchestrator` | Owns the mechanical git/merge ceremony and learns from CI/merge failures across runs, proposing a structural fix when one recurs. Never force-pushes; never auto-merges past the gate. |
| `tester` | Runs your project's test suite and reports pass/fail + regressions. Surfaces failures; never patches source to make a test pass. |
| `investigator` | Root-cause debugger — runs a structured investigate → analyze → hypothesize pass and writes a diagnosis. Holds the Iron Law: no fix without identifying the root cause first. |
| `onboarding` | Reads a codebase (read-only) and produces a baseline source map + readiness assessment. |
| `context-warden` | Watches a long session's context occupancy and warns you when it enters the degradation zone (time to switch sessions / compact). |

You can grow the fleet yourself with `agix agent new <name>` — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Platform support

| Platform | Status |
|---|---|
| **macOS** (Apple Silicon + Intel) | **Supported** — built and install-verified on arm64; the install path is architecture-independent. |
| **Linux** | **Supported** — the intra-agent bus uses portable Unix-domain sockets and the install path (Rust compile + Homebrew wrapper) is cross-architecture by design. (Beta: not yet exercised end-to-end on a Linux runner.) |
| **Windows** | **Unsupported** — the `lewis-aos-bus` intra-agent bus is built on Unix-domain sockets, which Windows does not provide. Use WSL2 (a Linux environment) if you're on Windows. |

> **The install compiles a small Rust component.** The `lewis-aos-bus` message bus
> ships as source and is built with `cargo build --release` during `brew install` (so
> `agix swarm` / `agix agent serve` work cross-architecture from a clean install). This
> adds a build-time **Rust toolchain** dependency (`brew` pulls it in) and ~18s of
> compile to the install — it is **not** needed to *run* the pack afterwards.

### Email signatures need a system Chromium (optional)

One optional feature — rendering an email-signature image — uses a headless Chromium via
the optional `puppeteer-core` dependency and a system Chrome/Chromium binary
(`/Applications/Google Chrome.app`, `/usr/bin/chromium`, …). If neither is present the
email still sends — it just **degrades gracefully to no rendered signature** with a clear
message, rather than crashing. The signature template references a web font from `rsms.me`
at render time; if that host is unreachable the renderer falls back to system fonts. None
of this affects any other agent or the core CLI.

## Security & contributing

- **[`SECURITY.md`](SECURITY.md)** — security posture (no telemetry / no covert network
  calls), the trust model (currently advisory — runtime enforcement is on the roadmap),
  the "agents act on your machine" caveat, and how to report a vulnerability.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — dev setup, the agent structure, how to add an
  agent and an eval, and the public-clean release gate every public-bound change must pass.
- **[`CHANGELOG.md`](CHANGELOG.md)** — what shipped, per version.
- **[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)** — the full monorepo dev-setup guide
  (pnpm / Turborepo, website + services workspaces).

## Uninstall

Removing Agix AOS is two steps — the binary and the per-user state:

```sh
brew uninstall agix-aos        # remove the agix CLI + formula tree
agix uninstall --purge-state   # OR, before uninstalling the binary: purge per-user state
```

`agix uninstall` (no flag) previews exactly which state dirs it would remove
(`~/.config/agix`, `~/.cache/agix*`, `~/.local/state/agix`); add `--purge-state`
(or `--yes`) to actually delete them. If you've already run `brew uninstall`, just
remove those directories by hand:

```sh
rm -rf ~/.config/agix ~/.cache/agix* ~/.local/state/agix
```

## License

[Apache-2.0](LICENSE).
