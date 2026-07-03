# Homebrew formula for Agix AOS — `brew install agix-aos`.
#
# Installs the Agix AOS runtime tree (the `agix` CLI + the agent fleet + lib +
# vendored prod deps) into libexec and exposes `agix` on PATH. Produced by
# scripts/release/build-agix-tarball.sh; the public-clean gate runs at build time.
#
# PUBLISH (operator-gated): set `url`/`homepage` to the real public release host,
# keep `sha256` in sync with the published tarball (the build script prints both),
# add a matching root LICENSE, then push this formula to the public tap
# (e.g. `brew tap blewis-maker/agix && brew install agix-aos`). See scripts/release/README.md.
class AgixAos < Formula
  desc "Agix AOS — the agix CLI and agent fleet (agentic operating system)"
  homepage "https://github.com/blewis-maker/agix-aos-cli" # public-clean: ok public-distribution-front-door (the public tap repo, not a private repo)
  url "https://github.com/blewis-maker/homebrew-agix/releases/download/v0.2.2/agix-aos-0.2.2.tar.gz"
  version "0.2.2"
  sha256 "8c7d243e3644da2ec9979938dafee087560e60be31a45a3e282cc363234b670d"
  license "Apache-2.0"

  depends_on "node"
  # The bus daemon (lewis-aos-bus) ships as Rust SOURCE, not a prebuilt binary (cross-arch +
  # avoids shipping a huge arch-specific target/). We compile it at install time. Build-time
  # only — Rust is not needed to RUN the pack.
  depends_on "rust" => :build

  def install
    libexec.install Dir["*"]

    # Build the bus daemon from the shipped source so `agix swarm` / `agix agent serve` work
    # from the installed pack. The source was just moved into libexec by the install above, so
    # build there. We move the freshly-built binary to libexec/bin/lewis-aos-bus — the stable
    # canonical location that lib/agix-fanout.mjs ensureDaemon resolves via its sibling-install
    # candidate (<repoRoot>/bin/lewis-aos-bus, repoRoot == libexec here).
    cd libexec/"cli/crates/lewis-aos-bus" do
      system "cargo", "build", "--release"
    end
    (libexec/"bin").install libexec/"cli/crates/lewis-aos-bus/target/release/lewis-aos-bus"

    # Wrapper invokes the brew-managed node explicitly so the install is PATH-independent.
    (bin/"agix").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/agix" "$@"
    SH
  end

  def caveats
    <<~EOS
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
    assert_match "agix #{version}", shell_output("#{bin}/agix --version")
  end
end
