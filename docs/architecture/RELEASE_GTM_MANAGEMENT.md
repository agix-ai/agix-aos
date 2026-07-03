# Release & GTM Management Layer — the firm above the dev loop

> **Date:** 2026-07-03
> The governance / semantics / market layer above the loop-engineered SDLC: three agents —
> **release-manager**, **version-manager**, **gtm-advisor** — that plan and ship releases the way
> disciplined firms do (Apple release trains, ITIL, SAFe ARTs, Google launch-readiness, SemVer/
> CalVer, GTM launch tiers), and that **grow with the enterprise** via the L2 umbrella loop.
> Grounded in a 2026-07-03 research sweep. Builds on `LOOP_ENGINEERED_SDLC.md` +
> `MULTI_LEVEL_ENTERPRISE_AOS_SPEC.md`. Part of the architecture framework.

## 0. Where it sits
The dev-fleet `release-engineer` owns the *mechanical* pipeline (build → branch → test → package →
deploy, canary, rollback, DORA). These three new agents sit **above** it and own *governance,
semantics, and market* — not the plumbing.
```
   L2 umbrella loop ─▶  GTM-ADVISOR      RELEASE-MANAGER      VERSION-MANAGER      (this layer)
   tunes their priors      (market)        (calendar/gate)      (semantics)
                                │ owns gates        │ stamps artifacts
                       ─────────▼───────────────────▼───────────────────────────
   dev fleet (L0/L1)   release-engineer: build→branch→test→package→deploy · DORA · audit ledger
```
Each new agent is an **actor** producing a plan/artifact AND a **verifier** of the layer below
(release-manager verifies the build is launch-ready; version-manager verifies the release isn't a
MAJOR mislabeled MINOR; gtm-advisor verifies the launch tier matches the actual change). Standard
Agix agent shape (`agent.mjs` seam, local- and cloud-capable), writing to the audit ledger.

## 1. The proven-practice priors (what each agent ships knowing)
- **Apple release train** (the transferable process): anchor majors to a **calendar**; **feature-
  freeze then quality-only** betas at a fixed interval with monotonically-narrowing scope; **the
  last beta is the RC = the literal ship build**; **separate the launch moment (coordinated, dated)
  from the rollout mechanism (staged, pausable, reversible** — Apple's 7-day phased release);
  **point releases carry what missed the train** so the train never slips.
- **ITIL 4 release management:** the gatekeeper lifecycle (Plan&Schedule → Build&Package →
  Test&Validate → Deploy → **Early Life Support** → Review&Improve), the Release Policy/Plan/
  Calendar/Record artifacts, target **≥90% release success rate**, major/minor/emergency types.
- **SAFe:** **develop on cadence, release on demand** — decouple the technical cycle from when the
  business exposes value; Agile Release Trains at enterprise scale.
- **Google release engineering + launch-readiness:** self-service, push-on-green, **hermetic/
  reproducible builds**, gated ops; **build-once, promote-many** (promote the *same signed
  artifact* dev→canary→prod, never rebuild); the **PRR + LCE launch checklist** (architecture,
  capacity/load w/ 6-mo projection, failure modes N+2, monitoring, security, dependencies, 10×
  scaling, rollout/canary plan) with **fast-path templates for common launch shapes**.
- **Versioning:** **SemVer** for API/SDK contracts, **CalVer** for cadenced products (hybrids ok;
  version-manager picks per-artifact); deprecation SLA (deprecate ≥1 minor cycle w/ notice before
  removal); support/LTS matrix; **Keep a Changelog** (Added/Changed/Deprecated/Removed/Fixed/
  Security, human-readable, Unreleased→version).
- **GTM launch tiering (T-shirt sizing):** Tier 0 company-defining → Tier 1 major → Tier 2 market-
  expansion → Tier 3 CX update → Tier 4 technical update; the tier is decided **early** and drives
  effort. **Maps 1:1 to release type** (Tier 4 ≈ patch, Tier 1 ≈ major). Three readiness
  checklists (Product / GTM / Sales-Support); PMM positioning + persona messaging; beta→GA→launch
  chained to a shared calendar + embargoes.

## 2. The three agent specs

### 2.1 `release-manager`
- **Owns:** release calendar & cadence; feature-freeze & code-freeze dates; RC cycle; launch-
  readiness/PRR review; rollout & rollback plan; Early Life Support; the release record.
- **Gates (verifier of the dev fleet):** **G1 feature-freeze** (no new scope past freeze) · **G2
  code-freeze/RC** (RC = ship build; only blocker cherry-picks) · **G3 launch-readiness go/no-go**
  (PRR-style checklist; *human co-sign*) · **G4 rollout** (canary %, bake time, abort criteria met
  per ring).
- **Artifacts:** release plan; calendar; RC manifest; launch-readiness checklist (Google-LCE
  shape); rollout plan; release record + ELS log.
- **Metrics:** release success rate (≥90%), change-fail rate & MTTR (DORA, reused), % on planned
  date, canary catch-rate, ELS incident count.
- **Human gate:** G3 go/no-go; emergency-release path.

### 2.2 `version-manager`
- **Owns:** versioning scheme per artifact (SemVer/CalVer/hybrid); version-number assignment;
  public-API/compatibility contract; deprecation policy & SLA; support/LTS matrix; changelog
  quality; immutable build-once-promote-many artifact identity.
- **Gates:** **V1 bump-correctness** (diff ⇒ is this really PATCH/MINOR/MAJOR? block a breaking
  change hiding in a MINOR) · **V2 changelog** (Keep-a-Changelog categories, human-readable) · **V3
  deprecation-SLA** (nothing removed that wasn't deprecated ≥ window w/ notice) · **V4 artifact-
  identity** (same signed artifact promoted across rings; no rebuild).
- **Artifacts:** version registry; API/compat contract; CHANGELOG; support/LTS matrix; deprecation
  schedule; signed artifact manifest.
- **Metrics:** % correct bumps, unplanned backward-compat breaks (target 0), changelog
  completeness, deprecation-SLA adherence, artifact-reproducibility.
- **Human gate:** any MAJOR / breaking-change bump.

### 2.3 `gtm-advisor`
- **Owns:** launch tiering per release; positioning & messaging drafts; the three readiness
  checklists; beta→GA→launch sequencing; launch calendar, embargoes; coordinated-marketing timing.
- **Gates:** **M1 tier-assignment** (Tier 0–4; *must match the version bump* — a MAJOR can't ship
  as a Tier-4 silent update) · **M2 GTM-readiness** (positioning/pricing/messaging/enablement) ·
  **M3 sales & support readiness** · **M4 launch-sync** (marketing fires on the release/GA
  calendar; embargo lift = the coordinated moment).
- **Artifacts:** tier decision + rationale; positioning/messaging (per persona); 3-part readiness
  checklist; launch calendar; embargo schedule; post-launch adoption roadmap (Tier 1).
- **Metrics:** launch-tier hit-rate, time-to-adoption, message resonance, enablement completeness,
  launch-date accuracy vs release.
- **Human gate:** Tier 0/1 launch approval; public positioning sign-off.

## 3. How it plugs into the loop-engineered SDLC
- **plan→…→integrate:** dev fleet + release-engineer as today (L0/L1). Version-manager attaches
  early (V1 tentative bump from the plan's scope; V2 accumulates Unreleased changelog entries as
  work lands).
- **release:** release-manager takes over — G1 freeze → G2 RC → G3 go/no-go (human) → G4 staged
  rollout w/ canary+rollback. Version-manager stamps the immutable artifact (V1/V3/V4). Runs in
  parallel branches (launch-agents-first, channel via Sensei).
- **operate:** Early Life Support (release-manager) + adoption tracking (gtm-advisor) → audit
  ledger. **gtm-advisor** runs a parallel track from `plan` onward (M1 tier decided early) and
  converges at `release` (M4 launch-sync).
- **Only three human go/no-go points:** launch go/no-go (G3), MAJOR-version bump (V), Tier-0/1
  launch (M). Everything else auto-clears with a ledger entry.

## 4. Grow-with-the-enterprise — the maturity ladder (discipline is EARNED, not configured)
The agents ship the §1 priors as day-one defaults, then the **L2 umbrella loop reads audit-ledger
history and promotes each tenant up the ladder** only when the evidence (clean canaries, honored
deprecations, accurate launch tiers) shows it can absorb more ceremony — Google's "fast-path for
common shapes, high-touch only when warranted."

| Rung | Enterprise | Release | Version | GTM | Agent posture |
|---|---|---|---|---|---|
| **0 Solo** | 1 person | push-on-green + auto-canary + auto-rollback; no formal freeze | CalVer or 0.y.z; auto-changelog; no LTS | "ship note" vs "announce" | advisory & auto-clear; only surfaces on a tripped canary |
| **1 Small (~5)** | early startup | weekly release; lightweight freeze day; canary rings | SemVer w/ real API; deprecation SLA begins; changelog gate | Tier 2–4; basic readiness | enforce V1/V2 + G4; humans gate MAJOR + Tier-1 |
| **2 Scaling (~15–25)** | growth | named calendar; freeze→RC train; PRR review; ELS | full SemVer/CalVer per artifact; LTS matrix; strict deprecation | full tiering; 3-part readiness; embargoes; PMM messaging | all gates live; L2 tunes freeze intervals + rollout speed |
| **3 Enterprise (50+)** | mature | Agile Release Trains, PI cadence, RTE coordination; release-on-demand; multi-region staged rollout | governed version registry; LTS commitments; API-compat board | Tier 0/1 major-launch machine; coordinated marketing+release+embargoes on one calendar | full release-train discipline; humans hold strategic go/no-go only |

## 5. Why it's a sustainable, un-fakeable ecosystem (the Bonsai / visible-age moat)
The release history *is* a trunk-ring record. Each shipped version is a leaf on the **Software** and
**Business** TOGAF/Bonsai branches; the *learned cadence* (freeze intervals, canary bake times,
launch-tier thresholds) is bark that thickens with real history. A mature tenant's release log —
dated versions, clean changelog lineage, honored deprecation timelines, launch-tier hit-rate — is a
**visible-age moat**: it can't be faked, it compounds, and switching platforms means abandoning the
learned cadence and the audit record that justifies faster, safer releases. The gtm-advisor's
accumulated launch outcomes become priors that make the *next* launch better — the recursive-
learning loop applied to the release/market layer. Proven practice is the floor; the enterprise's
own compounding history is the edge.
