# `brew install agix-aos`

> **LIVE — v0.2.2 (2026-06-22).** The pack is published on the public tap and
> installs end to end. Install with:
>
> ```sh
> brew tap blewis-maker/agix
> brew trust blewis-maker/agix   # one-time — Homebrew requires trust for third-party taps
> brew install agix-aos
> agix                            # first run: onboards you + sets up your environment
> ```
>
> v0.2.2 lets you choose where your workspace (wiki + knowledge base) lives at
> onboarding (defaults to `~/agix`); v0.2.1 closed the onboarding→first-session
> gap so `agix agent run sensei` works turnkey and reflects your captured north
> star (see `CHANGELOG.md`). The public front door is
> **https://github.com/blewis-maker/agix-aos-cli**; the go-live runbook is <!-- # public-clean: ok public-distribution-front-door (the public tap repo, not a private repo) -->
> **`docs/operations/publish-release.md`**.

Homebrew distribution for **Agix AOS** — the `agix` CLI + the agent fleet. "Agix AOS"
is not a single binary: the CLI loads agents dynamically from `agents/<name>/` relative
to its install root, with state in `~/.config/agix` + `~/.cache/agix`. So the brew
artifact is the **runtime tree** (bin + lib + agents + vendored prod deps) installed to
`libexec`, run by `node`, with `agix` exposed on PATH.

## Proven (this session, real Homebrew, end to end — v0.2.0)

Built the v0.2.0 tarball, pointed a local tap at it, and reinstalled + ran it for real:

```
$ brew reinstall agix-test/local/agix-aos   → cargo build --release (Rust bus) ✓
$ agix --version                            → agix 0.2.0 (local runtime)
$ agix agent smoke <each of 8 public agents> → ✓ 8/8 smoke passed
$ HOME=$(mktemp -d) agix init --defaults    → gbrain + wiki + soul + config; provider=claude-code (no key)
$ agix swarm --worker tester --n 3 --op ping → ✓ 3/3 ok over the Rust bus
```

So **someone can `brew install` Agix AOS and it runs** — gated only on publishing the
tarball + tap publicly (operator steps in `docs/operations/publish-release.md`).

## How it's built

`scripts/release/build-agix-tarball.sh`:
1. **public-clean gate** (`verify-public-clean.sh`) — refuses to package if the tree
   carries product/secret/personal-email/private-repo leakage.
2. Stages bin + lib + agents + package.json.
3. **Vendors prod deps** (`bun install --production` → flat, portable `node_modules`).
4. Tars + emits sha256 (the formula consumes both).

`packaging/homebrew/agix-aos.rb` — `depends_on "node"`; installs the tree to `libexec`;
writes a `bin/agix` wrapper that invokes the brew-managed node against `libexec/bin/agix`.

## Findings fixed to make it installable (these were real blockers)

- **6 runtime deps were misclassified as `devDependencies`** (`js-yaml`, `@anthropic-ai/sdk`,
  `marked`, `nodemailer`, `googleapis`, `puppeteer-core`) — imported at runtime but not
  vendored, so a clean install crashed (`Cannot find package 'js-yaml'`). Moved to
  `dependencies`. Caught only because we tested a real `brew install`.
- **A product-named lineage doc** was referenced by 4 public-pack agents → product leak.
  Renamed to a product-neutral `agentic-discoveries-*.md` (20 refs updated); the
  public-clean gate now passes on the runtime tree.

## Operator-gated publish steps (turnkey — do these to go live)

1. **LICENSE** — add a root `LICENSE` (Apache-2.0 matches the `lewis-aos-bus` crate; confirm
   the choice). A public package needs one; the formula already declares `license "Apache-2.0"`.
2. **Public tap repo** — the live tap is `blewis-maker/agix` (the public
   `blewis-maker/homebrew-agix` repo). This is what users `brew tap`. It can be
   transferred to a dedicated Agix org later without breaking installs.
3. **Publish the tarball** — run `scripts/release/build-agix-tarball.sh`; (optionally sign
   via the bus release flow); upload `dist/agix-aos-<version>.tar.gz` to the public release
   host (GitHub Releases). Set the formula's `url` + `homepage` to the real host and the
   `sha256` to the build script's output.
4. **Push the formula** to the tap's `Formula/agix-aos.rb`.
5. Anyone can then:  `brew tap blewis-maker/agix && brew install agix-aos`.

## Known follow-ons (not blockers for a first Mac install)

- **Platform-specificity:** the vendored tree is built per-platform; for multi-platform,
  publish per-platform bottles or lazy-load native deps. (The current tree has no native
  deps in the core path — `sharp` is intentionally omitted, see next.)
- **`sharp` (native image lib):** not vendored. No public-pack agent needs it in its core
  path, so the 8 public agents + the core CLI are unaffected; an agent that wants native
  image work can `npm i -g sharp` per-platform.
- **The Rust bus:** `agix bus …` needs the signed `lewis-aos-bus` binary (its own release
  flow, `build-bus-release.sh`); bundling it into the brew install is a follow-on.
