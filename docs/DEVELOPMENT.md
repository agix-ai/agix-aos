# Development — Agix Platform Monorepo

> This is the **contributor / dev-setup** guide. For the user-facing install and
> first-run story, see the root [`README.md`](../README.md). For how to add agents,
> run evals, and ship public-clean changes, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
>
> _Relocated 2026-06-19 from the root README, which now serves the public
> (`brew install`) audience. The monorepo dev-setup content below is unchanged._

**Agix builds the best agent systems on the market.** Agents you own, that learn with you, that compound for your team over time.

Two tracks, one specialty:

- **Agix** — the downloadable Agix Agents Pack. Run locally with your own coding-agent
  CLI account (no API key) or with an API key. A first-run onboarding flow produces the
  instance soul + identity + a local knowledge fabric the rest of the pack inherits.
- **Agix Enterprise** — commissioned agent systems built for and deployed inside an
  enterprise. Discovery, Foundation, Build, Hand-off or Operate.

Tagline: *Scale your AI organically.* The bonsai brand metaphor (`wiki/concepts/bonsai-brand-metaphor.md`) is the picture; slow patient growth is the promise.

This repository is the operating foundation for:

1. Agix business, architecture, and delivery system documentation
2. Agix public website and reusable client platform scaffolding
3. The Agix Agents Pack — agent specs, runtime, persona templates, voice foundation

## Repository Layout

- `bin/` - the `agix` CLI + per-agent shims
- `lib/` - the agent runtime, onboarding, soul, bus, and model adapters
- `agents/` - agent specs (manifest + agent.mjs + policy + persona), one dir per agent
- `cli/crates/` - Rust workspace, incl. the `lewis-aos-bus` intra-agent message bus
- `scripts/release/` - the public-clean gate + tarball builder
- `packaging/homebrew/` - the Homebrew formula + install story
- `apps/` - product-facing applications (starting with `website/`)
- `packages/` - shared UI, types, config, and prompts
- `services/` - backend and service runtimes (starting with `api-python/`)
- `architecture/` - source-of-truth architecture and operating design
- `docs/` - execution docs, handoffs, workflows, and decision records
- `templates/` - reusable templates for delivery artifacts
- `.github/` - CI/CD, issue templates, and repository automation

## Local Setup Baseline

Agix uses a Next.js-first monorepo with pnpm workspaces and Turborepo task orchestration
for the website/platform apps. The `agix` CLI + agent runtime is Node.js (>=20) and does
not require pnpm/Turborepo to develop or run.

### Prerequisites

- Node.js 20+
- pnpm 9+ (for the `apps/` / `packages/` website workspace)
- Rust + Cargo (to build the `lewis-aos-bus` daemon for `agix swarm` / `agix agent serve`)
- Python 3.11+ (for `services/api-python`)

### Quick Start (website workspace)

```bash
pnpm install
pnpm --filter @agix/website dev
```

### Quick Start (the `agix` CLI from a dev checkout)

```bash
node bin/agix agent list           # list the agents under ./agents/
node bin/agix agent smoke tester   # model-free smoke an agent
node bin/agix agent eval --all     # run every agent's eval suite (the CI gate)
```

### Full Bootstrap Commands

If starting from an empty directory, use:

- `docs/workflows/LOCAL_REPO_BOOTSTRAP.md`

## Working Principles

- Keep docs concise and current; update docs with architecture-impacting changes.
- Build reusable foundations before project-specific customizations.
- Treat this monorepo as enterprise-grade operating infrastructure.
- Prefer practical defaults over speculative abstractions.
- Build for the average person, not just the operator. The mandate is *both* the most technically advanced agentic systems on the market *and* the easiest to use — neither is a hedge against the other.
- Legibility is a first-class agentic-system property. The user can always see what the agents are doing, why, and at what stage. See `wiki/concepts/intuitive-agentic-ui.md` for the North Star refinement (2026-05-19) this principle anchors.

## Architecture Direction

- Website platform shell: Next.js (`apps/website`)
- Shared packages: `packages/*` for reusable UI, types, config, and prompts
- Specialized Python services: `services/api-python` for domain-specific compute
- GCP-friendly operations: Cloud Run, Secret Manager, Cloud Logging/Monitoring
