# Changelog

All notable changes to Agix AOS are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Version reset.** `0.1.0` is the **reborn** baseline — a ground-up rewrite of the
> stack (Go + TypeScript + Rust, zero Node). The `0.2.x` entries below describe the
> **retired Node runtime** and are kept for history; they are not a newer version of the
> current codebase. Public releases start fresh at `0.1.0` in the `agix-ai/agix-aos` repo.

## [0.1.3] — 2026-07-13 — per-capability routing + CLI polish

### Added
- **Per-capability routing.** `agix route set <capability> <provider>` (plus `unset` and `list`)
  persists a `~/.agix/routing.json` overlay so a single capability — say `cheap-classification` —
  can route to a **local** provider while the rest of a run stays on its default (or forced)
  provider. Precedence is overlay > forced > default table, so a graduated capability keeps its
  route even under `--provider X`. This is the basis for moving repetitive work onto a local model.

### Fixed
- **Unknown commands now exit `2`** (the usage-error convention), so a script can tell a bad
  invocation from a runtime error.

## [0.1.2] — 2026-07-12 — first-run onboarding + governance receipts

The new-user release: install, run `agix`, and it sets you up — plus a way to see the
governance trail of any run.

### Added
- **First-run onboarding.** `agix init` (and `agix init --defaults` for non-interactive)
  provisions your instance under `~/.agix` — a seeded knowledge fabric, a `wiki/`, a
  `soul.md`, and a `settings.json` — and detects your installed Claude Code / Codex CLI as
  the provider (no API key needed). Bare `agix` on a fresh machine auto-onboards once.
- **`agix artifacts`.** Render any run's **governance receipt** — the actor≠verifier trail,
  the verdict, cost, and a timeline — to the terminal, `--json`, or a self-contained,
  shareable `--html` page.

### Changed
- New honeycomb logo and a usage-driven demo (browse the fleet → run an agent → fan a task
  across a governed swarm → the actor≠verifier gate).

### Fixed
- `agix agent run` now **forwards agent-specific flags** (e.g. `--diff`, `--client`, `--task`)
  to the agent instead of rejecting them, so input-specific agents are runnable from the CLI.
- README accuracy: the core-commands, first-run, and uninstall sections now match what ships
  (removed documented-but-nonexistent commands; added `agix artifacts`).
- Unknown commands now exit non-zero.

## [0.1.1] — 2026-07-10 — branded CLI + provider-neutral release

An out-of-band patch: v0.1.0 shipped with pre-rebrand `agix-core` naming and internal
posture in the public tree. This makes the CLI present cleanly and keeps the OSS release
provider-neutral.

### Changed
- **CLI presents as `agix`** everywhere (was `agix-core` in version/help/usage): honey ⬡ AGIX
  logo + TTY-aware color; bare `agix`/`help`/`-h` show branded sectioned help on stdout;
  `agix <verb> --help` works on every verb; `--version` stays a parseable `agix 0.1.1`.
- **verify-guard**: a non-risk PR passes without an allow-list; humans get a plain error (the
  `::error::` annotation is emitted only under GitHub Actions).
- **State dir** `.agix-core/` → `.agix/` (no pre-rebrand name in run output).
- **Homebrew formula** passes `brew style` + `brew audit` in a tap; caveats fixed.

### Added
- **public-warden** — a deploy-time genericizer + hard bleed gate (`scripts/release/`) that keeps
  internal cloud / secret-manager / deploy references out of the OSS tree so the release stays
  provider-neutral. A cloud-specific secret backend is not shipped in the public build.
- **AOS testbench** (`research/aos-testbench/`) + nightlies guarding `main` between releases.

## [0.1.0] — 2026-07-09 — the reborn baseline

The first public release of the reborn Agix AOS. The old single-runtime Node stack was
retired and rebuilt around a governed core: a **Go engine** owns every capability, a
**TypeScript agent fleet** runs on **Bun**, and a **Rust bus** carries intra-agent
traffic. Local-first and $0-by-default — bring your own coding-agent CLI or run a local
model; no API key required, no telemetry.

### Added

- **Reborn architecture — zero Node.** The stack is now a **Go core** (`agix-core` CLI +
  the governed engine), a **TypeScript agent fleet on Bun** (`fleet/` + `agents/*.ts`),
  and a **Rust intra-agent bus** (`lewis-aos-bus`, compiled at install time). The Node
  runtime — `bin/agix`, `lib/*.mjs`, the vendored `node_modules` — is gone.
- **Governed engine as the single capability boundary.** Agents don't touch the OS
  directly; they act through the Go engine's governed tool catalog (filesystem, metrics,
  process exec), which scopes and audits every call. Capability *is* the boundary.
- **actor ≠ verifier.** The agent that produces work is never the one that certifies it —
  a structural separation the fleet enforces, not a convention. See `AGENTS.md`.
- **The compounding knowledge loop (Comb).** Certified work is attested and flows into an
  accumulating corpus; `agix-core distill-export` emits those certified records as
  distillation-ready JSONL — the rails for a governed, self-improving knowledge store.
- **Local, $0 inference path.** A local **Ollama** provider runs the fleet's own model
  nucleus at no cost, with a local **nomic** embedder behind knowledge retrieval.
  Chain-of-thought is off by default on the local sidecar for latency.
- **A fleet of 23 generic agents** — `mentor` (the conductor), `architect`, `research`,
  `investigator`, `tester`, `curator`, `director`, `coordinator`, the `refactor-*` and
  `release-*` roles, governance agents (`security-officer`, `sentinel`, `behavior-guard`,
  `ci-warden`), and more — all shipped brand-neutral, extensible by you.

### Changed

- **Terminology:** `sensei` → **`mentor`** (the conductor agent); `Bonsai` → **Comb** (the
  knowledge fabric). Old `sensei` inputs still alias to the Queen caste for back-compat.

### Security / hygiene

- **Allowlist-based public staging.** `stage-reborn-public.sh` copies only an explicit
  allowlist of git-tracked paths, prunes private-moat agents, and swaps in a curated
  public `AGENTS.md`, then runs the full `verify-public-clean` gate on the staged tree —
  so gitignored local state (keys, `.env.local`, caches) can never leak.
- **Hardened leak gate.** `verify-public-clean.sh` adds a `[moat:private-agent]` gate
  (fails on any `public:false` agent in the surface) and a GCP-project-id detector (which
  caught and closed a real leak).

### Notes

- **Beta.** v0.1.0 is early and evolving; expect rough edges and breaking changes.
- **Platform:** macOS supported; Linux is beta (not yet exercised end-to-end); Windows
  unsupported (use WSL2). Install compiles Go + a small Rust component (`go`, `rust`,
  `bun` are build-time deps).
- **Trust model** layers provable *risk reductions*, not absolute guarantees — see
  [`SECURITY.md`](SECURITY.md).

---

_The entries below describe the **retired Node runtime** (pre-reborn). Kept for history._

## [0.2.2] — 2026-06-22

### Added

- **You choose where your Agix workspace lives.** First-run onboarding now asks where
  to keep your workspace — your `wiki/` and knowledge fabric (gbrain) — defaulting to
  `~/agix` instead of a hidden state dir. Your config (identity, soul, settings, the
  mentor instance) stays in `~/.config/agix`; the stuff you grow lives somewhere you
  can see and own. Set `AGIX_DATA_DIR` to override, or just press Enter for `~/agix`.
  Dev checkouts still write in-tree, unchanged.

## [0.2.1] — 2026-06-22

Turnkey onboarding now actually reaches a working first session. In 0.2.0 a brand-new
user could install and onboard, but the handoff to `agix agent run mentor` dead-ended.

### Fixed

- **`agix` → `agix agent run mentor` works end to end for a new user.** Onboarding now
  seeds a default mentor instance (`~/.config/agix/mentor/instances/agix/`) whose Goal
  Tree synthesis reads your captured north star from `soul.md`, so the first guided
  session reflects what you told onboarding instead of throwing "instance not found".
- **Solo users are no longer blocked at the operator-identity gate.** The basic-tier
  policy admits any operator identity (`operators_allowed: ['*']`), including a user
  with no `git config user.email`. Enterprise deployments still pin specific emails;
  the `cpo`/`ceo` roles stay fail-closed.
- **Release build is clean again.** The packaging step strips a dev-only local spike
  from the staged tree so the public-clean gate passes.

## [0.2.0] — 2026-06-19

The release that turns the proof-of-distribution into something a newcomer can pick up
and run end to end: turnkey onboarding, an embedded local brain, agents that work without
an API key, and a real intra-agent bus that builds at install time.

### Added

- **Turnkey first-run onboarding.** Just run `agix` on a fresh machine and it auto-onboards
  — provisions a seeded local gbrain, a `wiki/`, a starting `soul.md`, and a
  `settings.json` with zero config. `agix init` runs it interactively; `agix init --defaults`
  runs it non-interactively.
- **Embedded local gbrain.** The knowledge fabric is provisioned locally on first run
  (under `~/.local/state/agix/gbrain`) — knowledge capture works out of the box, no
  external service to stand up.
- **No-API-key CLI passthrough.** Onboarding detects an installed coding-agent CLI
  (Claude Code / Codex) and sets it as the default provider, so the fleet runs on your
  existing CLI account with **no API key required**. An API key remains a supported
  fallback, never a requirement.
- **`agix agent new <name>`.** Scaffold a complete, immediately-smoke-green agent from a
  template — the fleet is extensible by you, not just the bundled set.
- **Growing instance soul.** `soul.md` accretes dated learnings over time instead of being
  a static file; `agix soul show` / `agix soul note` are the human-facing surfaces.
- **Real `swarm`.** `agix swarm --worker <name> --n <k>` fans tasks out to a serving
  worker over the bus and collects results.
- **Bus daemon ships + builds on install.** The `lewis-aos-bus` (Rust) intra-agent
  communication daemon ships as **source** and is compiled at install time, so
  `agix swarm` / `agix agent serve` work from a clean Homebrew install, cross-architecture.

### Fixed

- **Client-leak fix + hardened public-clean gate.** A prior release leaked a third-party
  email; the build now runs behind a hardened `verify-public-clean.sh` gate (secret shapes,
  any real mailbox, product/client identifiers, operator-personal facts, private-repo refs)
  on the exact staged tree that gets packaged — the build aborts if anything leaks.
- **Install-write fix.** Six runtime dependencies were misclassified as `devDependencies`
  and weren't vendored, so a clean install crashed; moved to `dependencies`.
- **`agent new` user-dir fix.** On an installed (read-only / upgrade-wiped) tree,
  `agix agent new` now writes to a user-writable dir (`~/.config/agix/agents/`) that
  persists across upgrades, instead of the pack tree.
- **`agix agent run <unknown>` now exits non-zero.** Previously an unknown agent name
  could exit 0 when stdout was a pipe, so scripts/CI couldn't catch the failure.
- **Public-pack hygiene.** The shipped pack no longer carries `*-demo.mjs` scripts or
  orphaned R&D lib files (unfinished self-training stubs, the git-custodian branch-reaper);
  ships a trimmed `package.json` (`name: agix-aos`, runtime deps only — not the monorepo
  manifest); and `agix --help` examples + the bus crate description are public-facing
  (no internal dev paths, no "Spike" language). The public-clean gate now also scans
  `.env*` / `*.example` templates.

### Added

- **`agix uninstall`.** Previews (then, with `--purge-state`, removes) the per-user state
  Agix created (`~/.config/agix`, `~/.cache/agix*`, `~/.local/state/agix`). The binary
  itself is removed by your package manager (`brew uninstall agix-aos`).

### Notes

- **Platform support:** macOS (Apple Silicon + Intel) and Linux are supported (the
  intra-agent bus uses portable Unix-domain sockets); **Windows is unsupported** (no Unix
  sockets — use WSL2). Linux is not yet exercised end-to-end on a runner. The install
  compiles a small Rust component (`lewis-aos-bus`) via `cargo` (~18s, build-time only).
- **No telemetry.** Agix AOS makes no background network calls of its own; the only
  outbound traffic is the model calls you trigger. See [`SECURITY.md`](SECURITY.md).
- **Trust model is advisory** in this release — runtime enforcement of agent soul/policy
  is on the roadmap. See [`SECURITY.md`](SECURITY.md).
- **What ships:** eight generic basic-tier agents (`onboarding`, `mentor`, `architect`,
  `research`, `git-orchestrator`, `tester`, `investigator`, `context-warden`).

[0.2.0]: docs/releases/v0.2.0.md
