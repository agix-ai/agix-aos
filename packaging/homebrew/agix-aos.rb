# Homebrew formula for Agix AOS — `brew install agix-aos`.
#
# Agix AOS is the reborn stack: a Go core + the `agix-core` CLI, a TypeScript agent
# fleet run on Bun (never Node), and a Rust intra-agent bus. This formula installs the
# source tree (core/ + fleet/ + agents/ + the bus crate) into libexec, compiles the Go
# CLI (`agix-core`) and the Rust bus at install time, and exposes a thin `agix` wrapper
# on PATH. ZERO Node: no `node` dependency, no `.mjs`, no vendored `node_modules`.
#
# PUBLISH (operator-gated): the reborn public repo is born from an orphan-root of the
# Go/TS/Rust tree (see docs/reborn/REBORN-EXECUTION-SPEC.md). Point `url`/`homepage` at
# the real public release host, set `sha256` from the published reborn tarball, add a
# matching root LICENSE, then push this formula to the public tap
# (e.g. `brew tap agix-ai/agix && brew install agix-aos`).
class AgixAos < Formula
  desc "Agix AOS — the agix CLI (Go) + TypeScript agent fleet (agentic operating system)"
  homepage "https://github.com/agix-ai/agix-aos"

  # Reborn Go/TS/Rust artifact (v0.1.0 — the fresh reborn baseline; matches the
  # `agix-core` binary constant in core/cmd/agix-core/main.go). Built from the staged
  # public tree by scripts/release/stage-reborn-public.sh.
  # OPERATOR: `url` assumes the release asset is attached to the `v0.1.0` tag of the
  # public repo agix-ai/agix-aos. If you host the tarball elsewhere (e.g. the
  # homebrew-agix tap release), update `url` to match. The `sha256` below is the hash of
  # dist/agix-aos-0.1.0.tar.gz — upload THAT exact file. If you rebuild the tarball,
  # recompute: `shasum -a 256 dist/agix-aos-0.1.0.tar.gz`. (The copy of this formula
  # that rides inside the tarball necessarily can't carry its own post-build hash — the
  # tap copy of this formula is what `brew` verifies against, and it is authoritative.)
  url "https://github.com/agix-ai/agix-aos/releases/download/v0.1.0/agix-aos-0.1.0.tar.gz"
  version "0.1.0"
  sha256 "0e23d148d3d20360dc7885e6ff3339c7dc26711b69d2863aabe046619acdabe1"
  license "Apache-2.0"

  # Build-time toolchains: Go compiles the `agix-core` CLI + the Go core; Rust compiles
  # the `lewis-aos-bus` intra-agent bus from SOURCE (cross-arch, no prebuilt binary).
  # Neither is needed to RUN the pack afterwards.
  depends_on "go" => :build
  depends_on "rust" => :build
  # Runtime: the TypeScript agent fleet (fleet/ + agents/*.ts) runs on Bun — NOT Node.
  depends_on "bun"

  def install
    libexec.install Dir["*"]

    # Build the Go CLI (agix-core) from the shipped source. core/ holds go.mod (the module
    # root); the binary lands at libexec/bin/agix-core — the canonical location the `agix`
    # wrapper execs.
    cd libexec/"core" do
      system "go", "build", "-o", libexec/"bin/agix-core", "./cmd/agix-core"
    end

    # Build the Rust intra-agent bus from the shipped source so `agix swarm` / `agix agent
    # serve` work from the installed pack (too big + arch-specific to ship prebuilt; compiled
    # at install time — Homebrew-idiomatic, cross-arch). Canonical path: libexec/bin/lewis-aos-bus.
    cd libexec/"cli/crates/lewis-aos-bus" do
      system "cargo", "build", "--release"
    end
    (libexec/"bin").install libexec/"cli/crates/lewis-aos-bus/target/release/lewis-aos-bus"

    # Thin wrapper: `agix` execs the Go binary directly. NO Node.
    #
    # The wrapper MUST export AGIX_CORE_BIN and AGIX_FLEET_CLI. `agix-core agent run`
    # delegates to the Bun fleet runner, and the TS runtime resolves the Go engine back
    # as `AGIX_CORE_BIN ?? "agix-core" on PATH` (fleet/runtime/engine.ts, comb.ts). Only
    # the `agix` wrapper lands on PATH — `agix-core` itself lives in libexec — so without
    # these exports every governed engine spawn and every Comb read fails to resolve.
    # AGIX_FLEET_CLI is likewise required because the fleet runner is probed relative to
    # CWD, which for an installed user is their own project, not libexec.
    (bin/"agix").write <<~SH
      #!/bin/bash
      export AGIX_CORE_BIN="${AGIX_CORE_BIN:-#{libexec}/bin/agix-core}"
      export AGIX_FLEET_CLI="${AGIX_FLEET_CLI:-#{libexec}/fleet/runtime/cli.ts}"
      exec "#{libexec}/bin/agix-core" "$@"
    SH
  end

  def caveats
    <<~EOS
      ★  Agix AOS v1 is in BETA — early and actively evolving. Expect rough edges and
         breaking changes between releases; feedback and issues are very welcome.

      Agix AOS runs autonomous AI agents that act on your machine — they can read
      and write files and run commands. Review agents before running them; agents
      marked "executor" have the most capability.

      • No API key? Agix uses your installed Claude Code / Codex CLI — so running
        agents makes real model calls that count against THAT account's usage.
      • Local-only: state lives in ~/.config/agix and ~/.local/state/agix. No telemetry.
      • Platform: macOS supported; Linux is beta (unverified end-to-end).

      Get started:  agix
      Uninstall:    brew uninstall agix-aos  &&  agix uninstall --purge-state
    EOS
  end

  test do
    # The wrapper execs the Go CLI, which prints `agix-core <v>` from its constant in
    # core/cmd/agix-core/main.go. This formula (0.1.0) and the Go binary (0.1.0) now
    # agree (CHANGELOG.md now leads with the reborn [0.1.0] entry). If you bump the
    # reborn version, bump the Go constant too so this assertion stays honest.
    assert_match "agix-core #{version}", shell_output("#{bin}/agix --version")
  end
end
