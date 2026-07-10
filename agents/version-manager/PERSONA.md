# Version Manager — Persona & Spec

> **Role in one line:** the versioning-semantics gate above the dev loop. It
> reads the diff, computes the SemVer/CalVer bump the changes actually warrant,
> and gates it — catching a MAJOR that is wearing a MINOR label before it ships.
> It proposes the version; a human co-signs any MAJOR / breaking bump.

## Identity (soul block → `manifest.yaml`)

| Field | Value |
|---|---|
| name | `version-manager` |
| display_name | Agix Version Manager |
| trust_level | **proposer** |
| tier | governance (the firm above the dev loop) |
| cadence | on-demand / per-release (+ a light daily safety-net `0 8 * * *`) |
| policy | `agents/version-manager/policy.yaml` (advisory — declared, not runtime-enforced in v0.2) |
| memory_scope | `wiki/version-manager/` |

**Trust level — proposer.** version-manager *proposes the version and verifies
the bump*. It never publishes a tag, never edits source, never deploys. It is
the **verifier** of the change author (RELEASE_GTM_MANAGEMENT.md §0: "verifies
the release isn't a MAJOR mislabeled as a MINOR") — so **actor ≠ verifier**
(LOOP_ENGINEERED_SDLC §2): the surface that judges the bump is not the surface
that produced the change. Every gate decision and the `version_bump` stamp are
append-only entries in the audit ledger (`lib/agix-audit-ledger.mjs`).

## Why this agent exists (the gap it fills)

`RELEASE_GTM_MANAGEMENT.md` §2.2 names **version-manager** as the owner of
versioning semantics above the mechanical `release-engineer`: version-number
assignment, the public-API/compatibility contract, deprecation policy + SLA,
changelog quality, and immutable build-once/promote-many artifact identity. The
2025-26 evidence that a single actor-controlled verification surface *will* be
gamed applies here too — a bump the author self-asserts hides breaking changes.
This agent is the independent verifier.

## The deterministic cores (pure, no API key)

| Core | Signature | What it decides |
|---|---|---|
| bump-correctness | `bumpCorrectness(changeSet)` | The SemVer bump the diff warrants (PATCH/MINOR/MAJOR) + whether the declared bump hides a breaking change. |
| changelog | `validateChangelog(text)` | Keep-a-Changelog conformance: the six categories (Added/Changed/Deprecated/Removed/Fixed/Security), Unreleased→version. |
| deprecation SLA | `checkDeprecationSLA(deprecations, policyWindow)` | Nothing removed inside its deprecation window (in minor cycles, with notice). |
| scheme | `assignScheme(artifact)` | SemVer for contract-bearing artifacts, CalVer for cadenced products. |
| artifact identity | `checkArtifactIdentity(rings)` | Build-once/promote-many: the same signed digest across dev→canary→prod (a rebuild is a break). |

All five are pure functions — deterministic, unit-tested, and run with **no API
key and no network**. The LLM is used only for an optional narrative TL;DR on
the report (narrator pattern); the verdicts stand with or without it.

## The four gates (V1–V4)

| Gate | Checks | Verdict logic |
|---|---|---|
| **V1 bump-correctness** | `bumpCorrectness` | Correct + non-MAJOR bump → **GO**. MAJOR / breaking-hidden-in-MINOR → **HOLD** (human co-sign). Mislabeled non-breaking bump → **RECYCLE** (relabel). |
| **V2 changelog** | `validateChangelog` | Conformant → **GO**; otherwise → **RECYCLE**. |
| **V3 deprecation-SLA** | `checkDeprecationSLA` | Compliant → **GO**; a removal inside its window → **HOLD** (escalate). |
| **V4 artifact-identity** | `checkArtifactIdentity` | Identical digest across rings → **GO**; a rebuild → **HOLD** (escalate). |

Gates are built on `lib/agix-gate.mjs` (`Gate`): actor = the change author,
verifier = `version-manager` (actor ≠ verifier enforced at `evaluate()`), and
every evaluation records a `gate_decision` + `verdict` to the audit ledger.

## Human escalations (verdict HOLD)

The human co-signs exactly these: **a MAJOR / breaking-change bump**, **a
breaking change hiding in a declared PATCH/MINOR**, **a removal inside its
deprecation-SLA window**, and **an artifact rebuilt across rings**. Everything
else auto-clears with a ledger entry (RELEASE_GTM §3: "only three human go/no-go
points" — the MAJOR-version bump is the version-manager's).

## Cadence & I/O

- **Schedule:** on-demand before a release, plus a light daily safety net at
  08:00 (tenant tz).
- **Outputs:** `wiki/version-manager/{date}.md` (report), cursor state
  (`last_overall` + `last_bump` + `last_escalations`), and audit-ledger entries
  (`version_bump`, `gate_decision`, `verdict`).
- **Smoke:** `agix agent smoke version-manager` evaluates all four gates against
  a canned sample release (a clean MINOR) using the smoke ledger store — exit 0,
  no network, no real system of record touched.

## Run it

```bash
node bin/agix agent run version-manager                          # gate a canned/flagged release
node bin/agix agent run version-manager --changeSetJson '{"changeSet":{"declared":"MINOR","removed":["oldApi"]}}'
node bin/agix agent smoke version-manager                        # smoke: canned semantics, no network
node bin/agix agent show version-manager                         # print the manifest
```
