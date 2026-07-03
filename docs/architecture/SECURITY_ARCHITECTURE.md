# Agix Security Architecture — adversarial by construction

> **Date:** 2026-07-03
> Security ingrained from day one for a code-executing, open-source, multi-agent system. Synthesis
> of two 2026-07-03 research sweeps (OpenClaw + competitor postures; the security-architecture body
> of practice — OWASP LLM/Agentic Top-10, NIST SSDF 800-218/A, DeepMind CaMeL, Claude Code sandboxing,
> SLSA). Part of the architecture framework. Ties to `LOOP_ENGINEERED_SDLC.md`,
> `RELEASE_GTM_MANAGEMENT.md`, `GO_MCP_SERVER.md`, `MULTI_LEVEL_ENTERPRISE_AOS_SPEC.md`.

## 0. The doctrine (the one framing)
**You cannot make an LLM injection-proof — the code/data boundary that tamed SQL injection does not
exist inside a model** (joint position of Anthropic/OpenAI/DeepMind). So the entire posture is:
**assume the agent's brain is compromised, and enforce deterministic controls OUTSIDE the model** —
sandbox, capability gates, egress control, provenance. **Autonomy is granted WITHIN hard boundaries,
not by removing them.** The leaders made security *ingrained* by making the isolated, least-
privilege, default-deny state the **substrate the agent runs on** — there is no "off." OpenClaw's
expensive lesson: it retrofitted this under public pressure after shipping capability-first defaults
(bound `0.0.0.0` by default → tens of thousands of exposed instances). **We ship the substrate on
day one instead.** This maps directly onto our existing actor≠verifier + Curator-ratification model
— the move is to make those gates *enforced, not advisory*, and add an *adversary lens* as a
first-class SDLC phase.

## 1. The on-brand move — security-officer as a held-out adversarial verifier (SDLC phase)
Our actor≠verifier + held-out-verifier pattern is already the skeleton (proven 2026-07-03: the
held-out verifier caught a real HIGH-severity bug on the Go MCP build). The upgrade: **the
`security-officer` agent becomes a held-out ADVERSARIAL verifier wired as a distinct SDLC phase** —
it reviews the artifact blind to the actor's rationale, actively produces injection + capability-
escape attempts, and emits an **OWASP-ASI-mapped verdict that can BLOCK the loop** (Go/Kill/Hold/
Recycle). This operationalizes *adversary ≠ builder*, records to the audit ledger, and is a
dogfooding + marketing artifact at once. Anchor the coverage on the **OWASP Agentic Top-10 (2026):**
ASI01 goal-hijack · ASI02 tool-misuse · ASI03 identity/privilege-abuse (confused deputy) · ASI04
agentic supply-chain · ASI05 unexpected code-exec · ASI06 memory/context-poisoning · ASI07 insecure
inter-agent comms · ASI08 cascading failures · ASI09 human-agent-trust exploitation · ASI10 rogue
agents. **ASI07 + ASI08 are uniquely OURS** (we're an ensemble; most competitors are single-agent).

## 2. Enforced trust model — advisory → admission control
The universal 2025-26 finding: **gates in the prompt are advisory and defeated by injection; gates
must be enforced at the runtime layer, below the model.** Define **executor trust tiers** and make
them **runtime admission control** (the policy engine is consulted BEFORE each tool call):
- **T0** read-only / no-network · **T1** write-in-workspace · **T2** network-egress-to-allowlist ·
  **T3** irreversible / externally-visible (install, mass-email, credential-change, deploy, data-delete).
- **T3 always requires human step-up.** **Separate read-from-untrusted from write-authority** — an
  agent that reads untrusted content must not hold write authority without a per-action human
  confirmation (breaks the confused-deputy chain). **Blended identity:** downscope the agent to the
  delegating user's permissions at runtime (access = agent identity ∧ human identity).
- This is where actor≠verifier stops being a review suggestion and becomes an admission-control
  decision. Maps onto "sessions are branches, Bonsai is main, Curator ratifies" — **make ratification
  the enforced approval gate; an agent can't self-ratify** (never let the model self-attest its own
  action is safe — the Cline bypass lesson).

## 3. Sandboxing — local-first, two-dimensional, default-on
Adopt the **Claude Code model** (best fit for a local tool): OS-primitive sandbox — **bubblewrap
(Linux) / Seatbelt (macOS)** — enforcing **both** boundaries, default-on, covering spawned
subprocesses:
- **Filesystem** scoped to the `~/agix` session workspace (read/write only there; blocks modifying
  system files — stops a prompt-injected agent escaping).
- **Network egress default-DENY through an allowlisting proxy** running *outside* the sandbox
  (stops SSH-key/token exfiltration even when injection succeeds — the OpenHands lethal-trifecta
  lesson: a sandbox contains host compromise but NOT exfiltration without egress control).
- Payoff: isolation **buys autonomy** — Anthropic reports it cut permission prompts **84%**. "No
  sandbox" is a loud per-session explicit opt-out, never the default. Security agents stay local by
  design. (Heavier gVisor/Kata/microVM is the hosted/enterprise escalation, not the local default.)

## 4. Supply chain (deps + registry + MCP)
- **Dependency cooldowns — highest-leverage, near-free.** `minimumReleaseAge ≥ 3 days` (Renovate;
  npm cooldown now default) — would have blocked **8 of 10** recent supply-chain attacks (sub-week
  exploit windows). Committed lockfiles + `--frozen-lockfile` in CI + Dependabot alerts. (Auto-merge
  without cooldown is itself a malware vector — pin + cooldown first.)
- **Signing + SBOM + SLSA provenance** on every released artifact (we already cosign the Rust bus —
  extend to all): cosign keyless, SBOM signed, provenance = GitHub Actions invocation identity,
  verified with `slsa-verifier`; "no provenance, no deploy." SBOM = what's inside; provenance = where
  it came from.
- **Pack-registry hardening (`agix-packs`):** proven-ownership (DNS/org-verified) namespacing +
  **reserved names** (block core/first-party impersonation), **path-traversal/zip-slip rejection** on
  extract, publish-time **malware + secret scan**, **signed packs + provenance verified at install**,
  and a **version cooldown**. This is our OpenClaw-ClawHub moment — get ahead of the community-skill
  poisoning class.
- **MCP hardening (our Go server + client):** treat every tool **description as untrusted content**
  (tool-poisoning: malicious instructions in metadata the model reads but the user never sees);
  **pin + hash tool definitions and alert on drift** (rug-pull detection); authenticate the transport;
  scope the client to an **allowlist of vetted servers**; keep MCP dev tooling (Inspector-class, cf.
  CVE-2025-49596) off any network. The Go MCP server's WS/auth is **fail-closed** (OpenClaw model).

## 5. Prompt-injection + memory-poisoning
**Injection (LLM01, #1 two editions running) — defense-in-depth, not a filter:**
- **Untrusted-content-as-data:** structurally separate + mark web/tool/MCP content ("spotlighting" /
  boundary markers `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`); never concatenate tool results into the
  instruction channel; inoculation/instruction-defense prompts.
- **Injection probe on the way IN:** scan every tool/web/file/MCP output before it enters context and
  tag untrusted spans (Anthropic auto-mode).
- **Architectural patterns** for high-stakes flows: **plan-then-execute** (plan fixed before touching
  untrusted data → tool results can't redirect it), escalating to **dual-LLM** (privileged planner +
  quarantined tool-less processor) and a **CaMeL-style capability/data-flow interpreter** for the
  riskiest tool sequences (defended ~67% of an injection benchmark with zero task-specific policy).
- **Egress constraint** (§3) + **tool-invocation monitoring** (MELON-style) catches exfiltration even
  when the injection itself evades detection.

**Memory poisoning (ASI06) — directly on the Bonsai/brain-graph:** persisted injected content is
*compounding* injection (MINJA: 76.8% success, query-only). OWASP ASI06's five layers map onto our
ingestion→consolidation→retrieval pipeline: **(1)** input moderation + trust-scoring at ingestion
(scan hidden text — white-on-white, zero-font, CSS-hidden — before anything enters memory); **(2)**
**provenance + trust-score field on every Bonsai leaf/neuron** (creation time, source session, source
doc, ingestion trust); **(3)** trust-aware retrieval (gate by provenance); **(4)** behavioral
monitoring; **(5)** forensic audit. **The Curator ratification pass is the trust-promotion gate:
operator-ratified = trusted; session-derived = quarantined until reviewed.** (This also strengthens
the FAMA memory model — provenance shield + trust score.)

## 6. Secrets (BYOK)
Request-scoped, never-logged, never-in-artifact. Resolve keys at a **broker/virtual-key layer** — app
code references a virtual key; the real credential is resolved at the broker, never in the agent's
ambient env / workspace `.env` / logs (redact-by-default). **Narrow per-agent scoped keys** so a
compromised reasoning engine still can't take catastrophic downstream action. **Never-in-artifact** =
the `verify-public-clean.sh` scrub gate (extend to CI secret-scanning + push-protection). Status/
health endpoints return **presence/validity booleans, never key material.**

## 7. The release security review (ship-blocking CI)
Dogfood security on the open-source release itself — "secure to the utmost" *demonstrated*, not claimed:
1. **SECURITY.md + GitHub Private Vulnerability Reporting enabled**, 90-day coordinated-disclosure
   window. (PVR ≠ SECURITY.md — ship both. The OpenHands 148-day-silence anti-pattern is the one to
   avoid; we WILL get reports.)
2. **Signing + SBOM + SLSA provenance** verified in CI on every artifact.
3. **Scrub gate** (`verify-public-clean.sh`) + **secret scanning with push protection**.
4. **Dependency scanning + `minimumReleaseAge` ≥3-day cooldown** + committed lockfiles.
5. **OWASP LLM/Agentic Top-10 coverage matrix** attached to each release (each ASI: mitigated / N-A /
   accepted-risk).
6. **The 6 GitHub maintainer settings** (branch protection, required review, Dependabot alerts, secret
   scanning, 2FA-required, signed commits).

## 8. Ranked implementation (ingrain now → architectural)
**Tier 0 — ingrain now (days, high-leverage/low-cost):**
1. `security-officer` → held-out adversarial verifier, wired as an SDLC phase that can block the loop
   (the single most on-brand move — operationalizes adversary≠builder).
2. Dependency cooldown ≥3d + lockfiles + Dependabot alerts + secret-scanning/push-protection.
3. SECURITY.md + enable PVR (90-day CVD) — required for a credible OSS release + OpenSSF score.
4. Extend the scrub gate → the §7 release security checklist as a ship-blocking CI job.

**Tier 1 — enforce, don't advise (weeks):**
5. Executor trust tiers as runtime admission control (T0→T3; T3 human step-up; read≠write authority).
6. Claude Code local-first sandbox (bubblewrap/Seatbelt + egress allowlist proxy, covers subprocesses).
7. MCP tool-description-as-untrusted + pin/diff (rug-pull) + transport auth + server allowlist.

**Tier 2 — registry + memory (weeks–months):**
8. Pack-registry proven-ownership + reserved names + path-traversal reject + scan gate + signed packs
   + cooldown.
9. Memory-poisoning defenses on the Bonsai pipeline (provenance+trust-score per leaf; ingestion
   scanning; trust-aware retrieval; Curator = trust-promotion gate).

**Tier 3 — architectural (strongest guarantees):**
10. Plan-then-execute → dual-LLM for the riskiest flows; evaluate a CaMeL capability interpreter;
    tool-invocation monitoring.

**Enterprise track (parallel, for the ICP):** SOC 2 Type II, self-host/VPC, SSO/SCIM, ZDR, audit
export — the table stakes to sell into enterprise (Devin/Factory), orthogonal to the runtime
hardening but required for the commercial tier.
