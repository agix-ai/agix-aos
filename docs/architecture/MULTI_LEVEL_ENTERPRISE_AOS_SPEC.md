# Multi-Level Enterprise AOS — Architecture & Loop-Engineering Spec

> **Date:** 2026-07-02
> **Scope:** Enterprise → Users → Roles → Mandates → Runs, with one shared loop-engineering
> scaffold instantiated (not copy-pasted) at three levels via the multi-tenant seams already on
> `main`.
> **Grounding:** extends `AGENT_COORDINATION_FABRIC.md` + `AGENT_POLICY.yaml`; reuses
> `lib/agix-runtime.mjs`, `lib/agix-state-backend.mjs`, `lib/agix-policy.mjs`,
> `lib/agix-identity.mjs`, `agents/sensei/lib/policy.mjs`, `lib/agix-mentor-gate.mjs` /
> `lib/agix-mentor.mjs`, `lib/agix-soul.mjs`. Repatriates the earned-autonomy trust ledger
> (D-104) + loop doctrine (D-100).
> **Design posture:** the Mandate is the atom, the Run is the audit atom (R2 §12);
> leader-as-face, governance-as-brain (R2 §6); singleplayer open / multiplayer commercial
> (`docs/strategy/2026-07-02-open-source-aos-strategy.md` §3).

---

## 0. The one idea

The repo already parameterizes *scope* by dependency injection: `LocalRuntime` takes
`{tenantId, dojoId, agentName}` at construction and resolves **every** state read/write,
authority check, and audit event from that scope tuple — **never from agent input**
(`agix-runtime.mjs:444` `_stateScope`, `agix-state-backend.mjs:40` `stateDocSegments`). That is
exactly the "duplicate the scaffolding per level" mechanism, unbuilt-out: **the same loop
scaffold, constructed with a deeper scope tuple, is a different level.**

The multi-level AOS is not three systems. It is **one `LoopScaffold`, instantiated three times
against three scope depths**, each isolated structurally by the same canonical-key contract:

| Level | Scope tuple | Loop question | Existing seam it rides |
|---|---|---|---|
| **L0 — agent** | `(ent, user, role, mandate, agent, run)` | "did *this Run* verify?" | `runAgent` + `_beginRunEvent` + `checkBudget` + mentor-gate |
| **L1 — role/user instance** | `(ent, user, role)` | "should *this seat* earn more autonomy?" | `dojoId` sub-namespace + trust ledger + `soul` reflection |
| **L2 — enterprise umbrella** | `(ent)` | "what priors hold *across all seats*?" | `tenantId` + per-tenant audit ledger + cross-seat priors |

The scaffold's five parts are identical at every level; only the **scope depth**, the **signal
it ingests** (own Runs vs child-scope rollups), and the **priors it emits** (down to children)
differ.

---

## 1. The hierarchy + data model

### 1.1 The five entities
```
Enterprise            tenant identity; deny-by-default boundary; owns L2 umbrella loop
  └─ User             a real person (agix-identity users[])
       └─ Role        the unit of policy (owner|operator|reviewer|viewer|domain); owns an L1 loop
            └─ Mandate   a unit of delegated, bounded, accountable authority (the ATOM)
                 └─ Run  one immutable execution event (the AUDIT ATOM)
```
Today: Enterprise/User/Role exist in `agix-identity.mjs` (`enterpriseId`, `loadUsers`,
`rolesForUser`, `currentActor:163`) + `AGENT_POLICY.yaml`; **Mandate is missing** (gap-analysis
#2); Run exists only as a **local per-agent** run-event (`_beginRunEvent:731`), not a per-tenant
audit atom.

### 1.2 The Mandate (net-new — the atom)
```
Mandate {
  mandate_id            // uuidv7 (reuse agix-runtime.mjs:868)
  parent_mandate_id     // null at the root of a delegation chain
  scope                 // { enterpriseId, userId, roleId }   ← the L1 owner-seat
  goal
  granted_authority {   // the envelope — MONOTONICALLY narrowing (§1.4)
    action_allowlist    // ∩ down the chain
    fire_allowlist      // ∩ down the chain (reuse assertFireAllowed)
    edit_paths          // ∩ down the chain (glob-narrowing)
    data_class          // max privacy tier its I/O may touch
  }
  budget                // { max_cost_usd, max_tokens, expires_at }  (reuse checkBudget)
  hard_boundaries       // forbidden_actions (deny wins, non-overridable downward)
  accountable_owner     // actorId of the Responsible (RACI)
  verification_gate     // { verifier_class, min_confidence, requires_approval[] }
  status                // open | delegated | verifying | closed | revoked
}
```
- **Standing Mandate** (a "seat"/Role): long-lived, `expires_at=null`, owner+budget — the L1 unit.
- **One-shot Mandate**: a single delegated task; `parent_mandate_id` links it into the Delegation Graph.
- workflow = Mandate template; department = Mandate cluster; organization = the Mandate graph.

### 1.3 The Run (extend the existing run-event → audit atom)
`_beginRunEvent:731` already emits an immutable uuidv7 record with `run_id`, `models_used`,
`totals`, `outputs_summary`, `decisions`, `budget`, `error` — the Run seed. **Net-new fields to
bind it to governance:**
```
Run (add) {
  mandate_id            // which Mandate authorized this Run
  actor                 // executing agent + resolved human (currentActor)
  authority_used        // exact grants exercised
  inputs_hash           // provenance
  verification { verifier, verdict: pass|fail|unverified, confidence }
  gate_decision         // mentor-gate: ask|propose|proceed + gates held
  overridden_by_human   // did the human reverse the outcome?
}
```
Today written local/per-agent to `~/.cache/agix-<agent>/runs/<run_id>.json`
(`safeWriteRunEvent:1172`). The audit atom requires **also** writing to the per-tenant
append-only ledger under the canonical key (§3) — the "system of record for governed AI work."

### 1.4 Authority narrows monotonically on delegation
The primitive already exists: `assertFireAllowed(policy, manifestAllowlist, agentName)`
(`sensei/lib/policy.mjs:70`) is a **set intersection**. Generalize from "sub-agent allowlist" to
the whole envelope:
```
sub_mandate.granted_authority = parent.granted_authority ∩ requested_authority   (per-field)
  action_allowlist: parent ∩ requested   (can only LOSE actions)
  fire_allowlist:   parent ∩ requested   (reuse assertFireAllowed verbatim)
  edit_paths:       glob-narrowing (reuse matchesGlob, sensei/lib/policy.mjs:147)
  data_class:       min(parent, requested)
  hard_boundaries:  UNION (forbidden set only grows downward; deny always wins)
```
Enforced structurally, the way `agix-policy.mjs:114` makes deny win over allow. The four Sensei
checkpoints become the per-Mandate authority checks, promoted from Sensei-local to fabric-wide:

| Sensei checkpoint | Generalized role |
|---|---|
| `assertOperatorAllowed` | is the resolved actor bound to a role that owns/holds this Mandate? |
| `assertEditPathAllowed` | is the write inside the Mandate's `edit_paths` envelope? |
| `assertFireAllowed` | is the sub-agent inside `fire_allowlist` (the ∩ delegation edge)? |
| `assertGitOperationAllowed` | is this irreversible/externally-visible action inside authority + approval gates? |

### 1.5 Map onto the coordination fabric (extend, don't reinvent)
This is fabric-step-2. The fabric already gives the Actor abstraction (§1), the
Enterprise→User→Role→Agent→Mandate hierarchy (§2), the Delegation Graph (§9), the Record (§10),
and `runtime.authorize()` as the Hanko PDP seam (`agix-runtime.mjs:548`). This spec fills the two
holes the gap analysis flagged: (a) no first-class Mandate object, (b) the Record audits
model-spend not actions. The three loop levels (§2) are the new layer on top.

---

## 2. The three loop levels

Each level runs the **same five-part scaffold** (§3); only the loop's inputs/outputs differ.

### 2.1 Level-0 — the agent loop (verify-don't-trust)
**Question:** did *this Run* produce a verified result within budget? **Cadence:** every `runAgent`.
Machinery (all present): model spine `getModel()` (capability-tiered + ledger); budget gate
`checkBudget()`→`BudgetExceededError`; verification gate (verifier ≠ actor, STV anti-collusion);
the autonomy gate `agix-mentor-gate.decide()` → `ask|propose|proceed` (precedent ≥3 backlinked
≥0.7 sim, recentApproval ≤14d, reversible; high-risk+irreversible always asks).
- **Signal UP → L1:** `{action_class, verdict, cost, gate_decision, overridden_by_human, reversible, risk_tier}`.
- **Priors DOWN ← L1:** the mentor-gate `memory` + the seat's trust budget (shifts `GATE_DEFAULTS` per-seat).

### 2.2 Level-1 — the role/user instance loop (earned autonomy)
**Question:** has *this seat* earned more autonomy for an action-class? **Cadence:** on Run
completion + a scheduled reflection tick (`runtime.scheduler`).
- **Earned-autonomy trust ledger (REPATRIATE — D-104):** pure/deterministic/falsifiable, keyed
  `(enterpriseId, userId, roleId, action_class)` → `{attempts, verified, failed, human_overrides,
  catastrophic_flag, trust_budget 0..1, last_updated}`. Update: `verified & !overridden` →
  budget += earn; `failed | overridden` → budget -= penalty (asymmetric, penalty > earn);
  `catastrophic` → 0 + freeze. **This is the gradient signal the "recursive learning" claim has
  lacked.**
- **Standing Mandates with owner+budget:** the seat *is* a standing Mandate.
- **Reflection accretion (REUSE `agix-soul.mjs`):** generalize `soul.md` from one-file-per-instance
  to one reflection doc *per seat*, under the L1 scope key; `recordLearning()` already accretes.
- **Signal UP → L2:** trust-ledger deltas + per-action-class outcome distributions (aggregate/content-free).
- **Priors DOWN ← L2:** cold-start trust priors, gate config, canaried behavior versions, tightened policy.
- **Priors DOWN → L0:** feeds L0's mentor-gate memory + per-seat trust budget.

### 2.3 Level-2 — the enterprise umbrella loop (org system of record)
**Question:** what priors hold across all seats, and what behavior ships org-wide? **Cadence:**
scheduled (nightly/weekly). Machinery (mostly net-new — the commercial core):
- **Org audit ledger as system of record:** per-tenant append-only Run ledger (§1.3, §3),
  tamper-evident, provable tenant isolation (R2 §7). *This is the product* (R2 §5).
- **Cross-seat prior learning:** aggregate L1 signals into org priors (risk_tier defaults, gate
  thresholds, over-budget patterns) — priors, not per-seat state.
- **Versioned + canaried behavior rollout:** ship a new gate config/policy/prior set as a version,
  canary to one seat, measure catastrophic-error + override rate, roll forward.
- **Signal DOWN → L1:** priors + canaried versions. **Consumes:** L1 rollups only — never a seat's raw private state.

### 2.4 Boundary summary
| Boundary | UP (signal) | DOWN (priors) |
|---|---|---|
| L0 → L1 | Run verdicts, cost, gate decisions, overrides | mentor-gate memory + per-seat trust budget |
| L1 → L2 | trust-ledger deltas, per-action-class outcome distributions (aggregate) | cold-start priors, gate config, canaried versions, tightened policy |

**Invariant:** signal flows up as *aggregates*; priors flow down as *config*. No level reads a
deeper level's raw private state except through the audit ledger it is authorized to see — what
keeps the umbrella loop from becoming a cross-tenant leak (R2 §7: company-ending).

---

## 3. How the shared scaffold instantiates per level

### 3.1 The canonical key — the instantiation mechanism
`stateDocSegments` (`agix-state-backend.mjs:40`) is the single source of truth for both the local
file layout and the cloud store, already nesting `tenants/{tenant}/dojos/{dojo}/agents/{agent}/
state/{name}`. **Extend it to carry the level scope**, keeping today's shape as the degenerate case:
```
enterprises/{enterpriseId}/state/{name}                                    ← L2 umbrella scope
enterprises/{enterpriseId}/users/{userId}/roles/{roleId}/state/{name}      ← L1 seat scope
   .../roles/{roleId}/mandates/{mandateId}/state/{name}                    ← a Mandate
   .../mandates/{mandateId}/runs/{runId}                                   ← a Run (audit atom)
```
Map onto today with zero migration: **`tenantId` → `enterpriseId`** (already the name in
`agix-identity.mjs:66`), **the `dojoId` slot → the `(userId,roleId)` seat**. Single-operator
collapses to today's `tenants/agix/...` byte-for-byte (`dojoId===null` branch,
`agix-state-backend.mjs:45`). Isolation stays structural — scope comes from the runtime's own
identity, never from agent input (`agix-state-backend.mjs:16`).

### 3.2 The `LoopScaffold` object (one module, three constructions)
```
LoopScaffold(scope) exposes, all keyed by `scope` via stateDocSegments:
  1. identity()       → the scope tuple (from the runtime, immutable)
  2. trustLedger()    → read/update earned-autonomy ledger at this scope
  3. reflection()     → agix-soul recordLearning/readSoul at this scope
  4. authority()      → the Mandate envelope + the 4 checkpoints (via runtime.authorize)
  5. audit()          → append Run events to this scope's slice of the ledger

L2 = new LoopScaffold({ enterpriseId })
L1 = new LoopScaffold({ enterpriseId, userId, roleId })                          // a "dojo"
L0 = new LoopScaffold({ enterpriseId, userId, roleId, mandateId, agentName })    // a run context
```

### 3.3 Which existing seams get parameterized
| Seam (file) | Today | Parameterize to |
|---|---|---|
| `LocalRuntime` ctor (`agix-runtime.mjs:85`) | `{tenantId,dojoId,agentName,budget,stateBackend}` | `{enterpriseId,userId,roleId,mandateId,agentName}`; `tenantId`→`enterpriseId`, `dojoId`→`user:{u}/role:{r}` |
| `_stateScope` (`:444`) | `{tenantId,dojoId,agent,name}` | emit deeper scope so ledger/reflection/audit land at the right level |
| `stateDocSegments` (`:40`) | tenant/dojo/agent/state | add users/roles/mandates/runs; keep current branches as degenerate |
| `runtime.authorize` (`:548`) | `checkAuthority(actor,agent,action)` | Mandate-aware: check the Mandate's narrowed envelope; `assertFireAllowed`-∩ moves in |
| `checkAuthority` (`agix-policy.mjs:134`) | enterprise + role grants | already enterprise-scoped; L2 binding gets more roles/users |
| role/policy loaders | one file + local override | per-enterprise binding block already supported (`AGENT_POLICY.yaml enterprises:`) |
| `agix-soul.mjs soulPath()` (`:38`) | one `~/.config/agix/soul.md` | resolve reflection doc from scope key → one per seat (L1) + per enterprise (L2) |
| `runAgent` (`:1077`) | fires with tenant + `authorize('run')` | wrap every Run in a Mandate; propagate scope; write Run to per-tenant ledger |
| `runtime.scheduler` (`:321`) | per-agent tick | drives the L1 reflection tick + L2 umbrella tick |
| `stateBackend` (Firestore, `:85`) | tenant/dojo keyed | same backend all levels — key depth *is* the level |

Punchline: **no per-level code.** Inject a deeper scope tuple; the identical scaffold reads/writes
a deeper key. That is "duplicate the scaffolding via multi-tenant seams, not copy-paste."

---

## 4. The open-core seam (the precise cut)
Line: **singleplayer = open, multiplayer = commercial.**

**OPEN (single-operator, Apache-2.0, the `agix` AOS repo):** L0 in full (runtime, model spine +
tiering, budget gate, verification gate, mentor-gate); **basic L1** (trust ledger + reflection for
a single seat = the operator; degenerate one-dojo path); the coordination substrate (bus,
Directory, typed verbs, local `AGENT_POLICY.yaml` + in-process Hanko PDP — already pure/no-network);
the Mandate object + Run event single-tenant; local state backend + local gbrain.

**COMMERCIAL (multiplayer control plane, private `agix-cloud`):** L2 umbrella loop in full
(cross-seat priors, versioned/canaried rollout); the Mandate graph across users (delegation between
different humans' agents, concurrency/merge); the org audit ledger as system of record (append-only,
tamper-evident, provable isolation to a CISO — the moat, R2 §8); cross-user priors; RBAC/SSO (Kagi
credential broker + Hanko-as-a-service, hosted multi-tenant state, managed model-routing keys).

**The precise cut is the second seat.** One seat → whole loop open (L0 + degenerate L1). ≥2
users/roles under one tenant → the across-seat machinery (L2, Mandate graph, cross-seat priors, org
ledger, RBAC/SSO) is paid. The shared scaffold is identical across the line; the commercial repo
only supplies deeper-scope constructions + the hosted backend + the cross-seat learner. No
relicensing risk (commercial logic in a separate repo; DCO-not-CLA).

---

## 5. Reuse map + gaps + build order

### 5.1 Per-piece disposition
| Piece | Exists? | Where / disposition |
|---|---|---|
| Enterprise→User→Role identity | ✅ | `agix-identity.mjs` |
| Policy binding + in-process PDP | ✅ | `AGENT_POLICY.yaml` + `agix-policy.mjs` (deny-wins) |
| Authority enforcement seam | ✅ | `runtime.authorize` (`:548`, advisory/enforce) |
| Monotonic authority-narrowing primitive | ✅ (siloed) | `assertFireAllowed` ∩ (`sensei/lib/policy.mjs:70`) — **promote to runtime** |
| 4 authority checkpoints | ✅ (Sensei-only) | `sensei/lib/policy.mjs` — generalize to Mandate envelope |
| Budget as structural constraint | ✅ | `checkBudget`/`BudgetExceededError` — the one Mandate ingredient done |
| Run event (audit-atom seed) | ✅ (local, per-agent) | `_beginRunEvent` — **extend + re-target to per-tenant ledger** |
| Canonical multi-tenant key | ✅ | `stateDocSegments` — **extend depth** |
| Autonomy gate (ask/propose/proceed) | ✅ | `agix-mentor-gate.mjs` + `agix-mentor.mjs` |
| Reflection accretion | ✅ (one file) | `agix-soul.mjs recordLearning` — **scope per seat/enterprise** |
| Coordination transport | ✅ (spike) | `agix-bus.mjs` + `lewis-aos-bus` — not yet runtime-wired |
| Directory | ⚠️ partial | `madoguchi` (running processes only) |
| **Earned-autonomy trust ledger (D-104)** | ❌ repatriate | pure/deterministic; the L1 gradient |
| **Loop doctrine (D-100, L1/L2)** | ❌ repatriate as code | the connective tissue |
| **Coordination substrate (coord-mcp)** | ❌ repatriate | closes session-guardrail/duplicate-task gap |
| **First-class Mandate object** | ❌ net-new | the atom |
| **Per-tenant action/authority ledger** | ❌ net-new | the org system of record (commercial) |
| **L2 cross-seat learner + canary rollout** | ❌ net-new | the commercial umbrella loop |
| Typed verbs + signed envelope | ❌ net-new | fabric §7 |
| Kagi/Hanko as services + RBAC/SSO | ❌ net-new (commercial) | fabric §4 |

### 5.2 Ranked build order
1. **Mandate object + budget binding** — promote runs to first-class Mandates; reuse `checkBudget`; wrap `runAgent`. *(Unblocks everything.)*
2. **Move the fire/authority gate into the runtime** — generalize `assertFireAllowed`-∩ into `runtime.authorize` against the Mandate envelope (fixes gap #4).
3. **Extend the Run event → per-tenant append-only audit ledger** — add the governance fields; write under the canonical key (fixes gap #5). *(L0→L1 signal source.)*
4. **Repatriate the earned-autonomy trust ledger (D-104)**, scoped `(ent,user,role,action-class)`; wire trust budget into mentor-gate thresholds → **L1 closes.**
5. **Scope reflection per seat** — point `agix-soul` at the L1 scope key.
6. **Extend `stateDocSegments` depth + `LocalRuntime` scope** so the same scaffold stamps L0/L1/L2.
7. **L2 umbrella observer + cross-seat prior learner (commercial)** — aggregate L1 rollups → org priors + canaried rollout. **L2 closes.**
8. Typed verbs, Directory promotion, Kagi/Hanko-as-services — after the loops close.

---

## 6. First milestone — smallest end-to-end slice that proves the multi-level loop
**Config:** one Enterprise (`agix`), two Roles under one user (reuse `operator` + `reviewer` from
`AGENT_POLICY.yaml`), one standing Mandate per role, one L1 trust ledger per seat, one L2 umbrella
observer. All local — no cloud, no Kagi/Hanko-as-services.

**Build:** (1) Mandate object + `mandates/` registry under each seat's scope key, each role one
standing Mandate with envelope + budget from its grants; (2) wrap `runAgent` to require a
`mandate_id`, enforce the envelope via `runtime.authorize` (enforce mode), write the extended Run
event to a per-enterprise append-only ledger; (3) repatriate D-104, update
`trust_ledger[(agix,user,roleA|roleB,action_class)]` per Run, feed trust budget into
`mentor-gate.decide`; (4) an L2 umbrella tick that reads both seats' rollups, writes one
enterprise-scoped prior doc, re-seeds down to seats.

**Acceptance criteria:**
- **A1 (isolation):** Role A's Run cannot read/write Role B's trust ledger or reflection — verified by canonical keys differing + no API accepting a foreign scope.
- **A2 (monotonic authority):** a sub-Mandate from Role A provably cannot exercise an action outside `parent.action_allowlist ∩ requested`; attempting throws `PermissionDeniedError` in enforce mode.
- **A3 (L0→L1 gradient):** after N verified, non-overridden Runs of one action-class, the seat's `trust_budget` rises and the mentor-gate flips a would-be `ask` to `propose`/`proceed`; one human override drops it — shown from the ledger, not asserted by hand.
- **A4 (L1→L2→L1 priors):** the umbrella tick derives one org prior, writes it enterprise-scoped, and a subsequent Role B Run inherits a prior it never generated — cross-seat priors flow down.
- **A5 (audit atom):** every Run is reconstructable from the per-enterprise ledger — what was done, by which actor, under which Mandate's authority, verified or not — append-only.
- **A6 (degenerate = today):** single-operator run produces byte-identical local paths to today's `tenants/agix/...` — proving the open singleplayer path is the same scaffold at depth-1.

A3+A4 together prove the multi-level loop *closes and compounds* — the whole claim.
