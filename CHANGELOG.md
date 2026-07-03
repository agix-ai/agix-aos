# Changelog

All notable changes to Agix AOS are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.2] — 2026-06-22

### Added

- **You choose where your Agix workspace lives.** First-run onboarding now asks where
  to keep your workspace — your `wiki/` and knowledge fabric (gbrain) — defaulting to
  `~/agix` instead of a hidden state dir. Your config (identity, soul, settings, the
  sensei instance) stays in `~/.config/agix`; the stuff you grow lives somewhere you
  can see and own. Set `AGIX_DATA_DIR` to override, or just press Enter for `~/agix`.
  Dev checkouts still write in-tree, unchanged.

## [0.2.1] — 2026-06-22

Turnkey onboarding now actually reaches a working first session. In 0.2.0 a brand-new
user could install and onboard, but the handoff to `agix agent run sensei` dead-ended.

### Fixed

- **`agix` → `agix agent run sensei` works end to end for a new user.** Onboarding now
  seeds a default sensei instance (`~/.config/agix/sensei/instances/agix/`) whose Goal
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
- **What ships:** eight generic basic-tier agents (`onboarding`, `sensei`, `architect`,
  `research`, `git-orchestrator`, `tester`, `investigator`, `context-warden`).

[0.2.0]: docs/releases/v0.2.0.md
