# `brew install agix-aos`

> **PUBLISH GATED — pending the reborn tarball.** Agix AOS is being reborn onto
> **Go + TypeScript-on-Bun + Rust** with ZERO Node (see
> `docs/reborn/REBORN-EXECUTION-SPEC.md`). The Homebrew formula
> (`packaging/homebrew/agix-aos.rb`) has been rewritten for the reborn build, but its
> `url`/`version`/`sha256` still point at the RETIRED Node v0.2.2 tarball and are flagged
> `TODO(operator, reborn)`. **Do not publish until the reborn tarball exists and those
> three fields are regenerated.** The reborn launch path orphan-roots the public repo
> from the reborn tree — not from the old extract/tarball pipeline.
>
> ```sh
> brew tap agix-ai/agix
> brew trust agix-ai/agix   # one-time — Homebrew requires trust for third-party taps
> brew install agix-aos
> agix                            # first run: onboards you + sets up your environment
> ```

Homebrew distribution for **Agix AOS** — the `agix` CLI (a single Go binary,
`agix-core`) + the TypeScript agent fleet. "Agix AOS" is not a lone binary: the CLI loads
agents dynamically from `agents/<name>/` relative to its install root, with state in
`~/.config/agix` + `~/.cache/agix`. So the brew artifact is the **source tree** (`core/`
Go + `fleet/` TypeScript + `agents/` + the Rust bus crate) installed to `libexec`, with
the Go CLI and the Rust bus compiled at install time and `agix` exposed on PATH.

## How it's built (reborn)

`packaging/homebrew/agix-aos.rb`:
1. `depends_on "go" => :build` + `depends_on "rust" => :build` (build-time toolchains)
   and `depends_on "bun"` (runtime — the TypeScript fleet runs on Bun, never Node).
2. Installs the source tree to `libexec`.
3. **Compiles the Go CLI** — `go build -o libexec/bin/agix-core ./cmd/agix-core` from
   `libexec/core` (the Go module root).
4. **Compiles the Rust bus** — `cargo build --release` of `cli/crates/lewis-aos-bus`,
   moved to `libexec/bin/lewis-aos-bus` (too big + arch-specific to ship prebuilt).
5. Writes a thin `bin/agix` wrapper that execs `libexec/bin/agix-core` — **no Node**.

The TypeScript fleet is **dependency-free** — there is no `package.json`, so nothing to
vendor: the runtime uses only Bun built-ins and shells into `agix-core` for all governed
execution. There is no `node_modules` step and no `npm`/`pnpm` install — a clean break
from the retired Node pack, which vendored prod dependencies into a flat `node_modules`.

## Proven end-to-end (retired Node pack, v0.2.0 — historical)

The install *shape* — source tree to `libexec`, compile-at-install, thin PATH wrapper —
was proven end-to-end on the retired Node pack: a local tap installed and ran it
(`agix --version`, 8/8 agent smokes, `agix init --defaults`, a 3-worker swarm over the
Rust bus). The reborn formula keeps that same shape (compile at install, run from
`libexec`), swapping the Node runtime for the Go CLI + the Bun fleet. It re-earns its
green once the reborn tarball is built and installed for real.

## Operator-gated publish steps (reborn)

1. **Reborn tarball** — produce the reborn source tarball from the Go/TS/Rust tree. The
   old `scripts/release/build-agix-tarball.sh` is **retired** (it packaged the deleted
   Node runtime — see its header); the reborn launch orphan-roots the public repo from
   the reborn tree rather than shipping an extract.
2. **LICENSE** — add a root `LICENSE` (Apache-2.0 matches the `lewis-aos-bus` crate).
3. **Public tap repo** — the tap is `agix-ai/agix` (the public
   `agix-ai/homebrew-agix` repo, org-led canonical distribution). This is what users
   `brew tap`.
4. **Fill the formula** — set `url`/`version`/`sha256` from the published reborn tarball
   (replacing the `TODO(operator, reborn)` block) and set `homepage` to the real host.
5. **Push the formula** to the tap's `Formula/agix-aos.rb`.
6. Anyone can then:  `brew tap agix-ai/agix && brew install agix-aos`.

## Known follow-ons (not blockers for a first Mac install)

- **Platform-specificity:** the Go CLI + Rust bus are compiled per-platform at install.
  For prebuilt bottles, publish per-platform artifacts later — the compile-at-install path
  is cross-architecture by design.
- **Bun as a runtime dependency:** the TypeScript fleet needs Bun at runtime
  (`depends_on "bun"`); Homebrew pulls it in. The core CLI (Go) and the bus (Rust) are
  self-contained native binaries once built.
