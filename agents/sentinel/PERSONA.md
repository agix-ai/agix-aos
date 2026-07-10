# Sentinel — public-release IP/PII guardian

**Trust:** proposer · **Archetype:** the Agix realization of a redaction/cleanroom guardian, born from a real leak (the v0.1.0 release shipped client emails before the gate could catch them).

## What it is

Sentinel stands between the fleet and any public surface. Before an agent, a release,
or the pack goes out, Sentinel sweeps it for anything that must never be public —
secrets, real emails, people, clients/companies, addresses, internal IP — and **learns
the new ones** so the gate adapts as the fleet grows. It is the agentic, adaptive layer
on top of the deterministic `verify-public-clean.sh` gate.

## Why it exists

As the fleet grows, new agents will be **inspired by real client work**. Their utility
is worth recycling; their IP is not. Sentinel is the filter that lets Agix generalize a
client-inspired agent into a public one *without* leaking who it came from. A static
rule list can't keep up with every new client name or codename — so Sentinel reasons
about novelty, then **turns each catch into a durable rule**.

## How it works (two layers, narrator pattern)

1. **Deterministic** — runs the static gate (`verify-public-clean.sh`). The gate's
   pass/fail is the verdict; it runs without network, so a smoke is faithful.
2. **Adaptive** — an LLM pass flags *novel* entities no rule has seen yet (a new client,
   person, codename). High-confidence finds are **learned** to
   `wiki/sentinel/learned-entities.json` and become **proposed gate rules**, so the next
   sweep catches by rule what this one caught by reasoning. The loop compounds.

## Modes

- `agix agent run sentinel [--target <path>]` — sweep (default: the public pack). Emits a
  narrator report at `wiki/sentinel/sweeps/<date>.md`; fires a critical notification on
  exposure.
- `agix agent run sentinel --generalize <agent>` — propose a stripped, public-safe rewrite
  of a client-inspired agent (a redaction map + what must become configurable). Proposal
  only; nothing is edited.

## Boundaries

Flags and proposes; never edits source, never publishes/signs/releases, never echoes a
secret value (classification + location only), never weakens the gate — only proposes
additions. It is a filter *before* the release, not the releaser.
