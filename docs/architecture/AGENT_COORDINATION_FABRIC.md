# Agent Coordination & Identity Fabric

> **Status:** draft spec (2026-06-22). Defines how agents become *aware of each
> other and coordinate like a real enterprise* — and the identity/role/privilege
> model that secures it and makes it **reproducible across enterprises**.
>
> **Builds on (does not replace):** the Rust intra-agent bus
> (`cli/crates/lewis-aos-bus/`, `RUST_INTRA_AGENT_BUS.md`), the fleet-coordinator
> `madoguchi` (active-agent registry + spawn gate), the model-call ledger
> (`lib/model-adapters/ledger.mjs`), the per-agent manifest `soul`
> (`trust_level` / `boundaries` / `policy_file`), the Kagi+Hanko identity design
> (`wiki/concepts/centralized-auth-and-permissions.md`), the mentor leader
> (`MENTOR_LEADER_AGENT.md`), and the self-trained verification harness (STV /
> `scripts/stv-eval.mjs`).

---

## 0. The one idea

A real enterprise does **not** coordinate by everyone talking to everyone. It
coordinates through **a shared, queryable model of the organization and its
work**, a **small set of structured communication moves**, **roles that bound
who talks to whom**, and **a written record**. Agents that "freely chat" produce
combinatorial chatter, runaway cost, deadlocks, hallucinated agreement, and zero
auditability.

So: **don't build a chatroom — build an org.** Awareness is a *query against
shared state*, not gossip. Communication is a *typed, governed, recorded verb
set*, not free conversation. And every actor — **human or agent — is a peer in
the same fabric**, under the same identity, authority, and audit rules.

Two design pillars, closely intertwined:

1. **The Coordination Fabric** — Directory, World Model, typed verbs, Channels,
   RACI, the Delegation Graph (Mandates), and the Record.
2. **The Identity & Authority Model** — Enterprise → Users → Roles → Agents →
   Mandates, secured by Kagi (credentials) + Hanko (policy), with each agent's
   contract (trust, boundaries, sub-agent access, eval suite) **baked in and
   reproducible per enterprise**.

---

## PART I — THE ACTOR & IDENTITY MODEL

### 1. The Actor abstraction (human or agent)

The fabric has exactly one kind of participant: an **Actor**. A human and an
agent are the same shape — both have an identity, a role, authority, a place in
the directory, channel subscriptions, and an audit trail.

```
Actor {
  actorId        // stable, signed identity (e.g. ent:acme/user:sara | ent:acme/agent:director#7)
  kind           // "human" | "agent"
  enterpriseId   // the tenant this actor belongs to
  role           // the user-role or the agent-role (see §3)
  capabilities   // what it can do (for discovery)
  authority      // current granted scope (from Hanko policy)
  status         // available | busy | offline
}
```

This is the unification that makes the product valuable: *people and their agents
work in one governed fabric*, not two bolted-together systems. A human can pick
up a phase-plan an agent started; an agent can escalate to a human — over the
same verbs, in the same channels, recorded the same way.

### 2. The identity hierarchy (the keystone the operator asked for)

```
Enterprise (tenant, has an ID)
  └─ Users (real people, each with a Role)
       └─ Agents the user may invoke (a per-user, per-agent grant)
            └─ Sub-agents that agent may fire (the delegation allowlist)
                 └─ Mandates (units of delegated, accountable work)
```

- **Enterprise ID.** When an enterprise installs the agent pack, it is bound to
  a tenant identity (`enterpriseId`). All actors, policy, memory, and audit are
  namespaced under it. Cross-tenant access is deny-by-default (today's
  single-operator `agix-identity.mjs` is the seed; this generalizes it).
- **Users + Roles.** Each user has a **Role** (e.g. `owner`, `operator`,
  `reviewer`, `viewer`, or domain roles like `permitting-lead`). The Role — not
  the individual — is the unit of policy, so a 25-person team needs *one*
  Director whose actions are gated per-role, not 25 copies (Hanko's thesis).
- **Per-user/per-agent grants.** "Can Sara have the Director rerun this deploy?"
  is answered by Hanko policy keyed on `{ enterprise, role/user, agent, action,
  scope }`.
- **Sub-agent access graph.** Which sub-agents an agent may fire is part of its
  contract (today: manifest `defaults.fire_allowlist` ∩ the role policy's
  `fire_allowlist`). This is the *delegation allowlist* — the spine of the
  Delegation Graph (§9).

### 3. The agent's baked-in contract (reproducible across enterprises)

Every agent **ships with its own identity & governance contract** in its
manifest + policy file, so the security, privileges, and evaluation rules travel
*with the agent* and instantiate identically in any enterprise. Extend today's
`soul` block into a full **Agent Charter**:

```yaml
# agents/<name>/manifest.yaml  (soul) + agents/<name>/policy.yaml
charter:
  agent_role:       director            # the agent's role in the org
  trust_level:      executor            # observer | proposer | executor | narrator
  capabilities:     [deploy.rerun, gh.run.rerun]   # for Directory discovery
  authority:                            # what it MAY do (Hanko enforces)
    allowed_actions:   [gh.run.rerun, apphosting.rollout.create]
    forbidden_actions: [prod.database.drop]
    requires_approval: [apphosting.rollout.create]   # Rule-of-Two gate
  sub_agents:        [research, tester]  # the fire/delegation allowlist
  memory_scope:      wiki/director/      # what it may read/write
  credentials:       [github.token, apphosting.read]  # brokered by Kagi, never held
  eval_suite:        agents/director/eval/*.suite.mjs  # the STV/eval gate bound to THIS agent
  data_class:        internal           # what privacy tier its I/O may touch
```

The enterprise install overlays a **policy binding** (which users/roles may
invoke this agent, with what scope) — the *agent charter is reproducible; the
binding is per-enterprise*. Same Director everywhere; ACME grants it to
`operator@example.com` for `gh.run.rerun` only.

### 4. The identity substrate — Kagi + Hanko (build on the planned design)

- **Hanko** (permission) is the **policy decision point**: every privileged
  action and every cross-actor message is checked `{ enterprise, requesting
  user/role, agent, action, scope }` → allow/deny + a short-TTL signed
  permission token. It owns `AGENT_POLICY.yaml` (versioned, PR-reviewed) and
  enforces `requires_approval` (Rule of Two) and tenant deny-by-default.
- **Kagi** (auth) is the **credential broker**: no agent holds long-lived
  secrets; it requests a scoped, short-TTL token *and* presents Hanko's
  permission token. Two-key: **no token without permission, no permission
  without policy.**
- **Every privileged action and inter-agent verb is therefore: Hanko-checked →
  (Kagi-brokered if it needs a credential) → executed → written to the Record.**

This is what makes the fabric enterprise-safe and reproducible: the security and
privilege rules are *structural* (policy + brokered tokens + audit), not
per-agent code.

---

## PART II — THE COORDINATION FABRIC

### 5. The Directory — "who exists and who owns what"

A live, queryable registry of every Actor: identity, role, capabilities,
authority, status. Agents **discover by query**, never by hardcoded knowledge of
each other:

```
directory.find({ capability: "gis.validate" })     // → [agent:gis#3]
directory.find({ role: "permitting-lead" })         // → [user:sara]
directory.whoOwns({ mandate: "Permit-QC#4821" })    // → agent:qc#2 (Responsible)
```

*Seed:* `madoguchi` already owns the active-agent registry + spawn gate, and the
bus has a register/locate broker. Promote this to a first-class Directory
service that also indexes humans, roles, and capabilities.

### 6. The World Model — "what's going on right now"

A versioned, queryable picture of active Mandates/objectives, owners, status,
and blockers — the org's "standup board." Actors gain **situational awareness by
subscribing to the slices relevant to their role and reading shared state**, not
by being told everything. Implementation: an append-only event log (the Record)
+ materialized views. This is the antidote to chatter — awareness is a
*subscription/read*, not an N² message storm.

### 7. The communication protocol — a bounded, typed verb set

Encode the enterprise's actual move-types. **No free-form "chat"; no
"negotiate."** (Conflict resolves via governance/objective function, §11 — not
agent debate.)

| Verb | Meaning | Authority |
|---|---|---|
| `delegate` | hand a Mandate down with scoped authority | actor must hold ≥ that authority |
| `report` | return a result + verification verdict | to the delegator |
| `handoff` | transfer ownership of a Mandate/phase-plan to another actor | both must be permitted |
| `escalate` | raise up the chain (irreversible / over-budget / external / low-confidence) | always allowed |
| `consult` | ask a peer for input, no authority transferred (RACI "Consulted") | per RACI |
| `announce` | post status/completion to a Channel | to subscribers |
| `inform` | notify the "Informed" parties | per RACI |

**Message envelope** (signed, Hanko-checked, logged):

```
{ from: actorId, to: actorId|role|capability, verb,
  mandate: mandateId, channel: channelId,
  authority: <granted scope>, payload: {...},
  requires_ack: bool, ts, signature }
```

Every message is typed, addressed (by identity/role/capability), **authority-
checked by Hanko**, and **appended to the Record**. Coordination is *only* via
acknowledged messages — an actor may **never infer** another's agreement
(kills hallucinated coordination).

### 8. Channels — the structured "rooms"

Topic channels keyed by **Mandate**, **domain/department**, and **event type**.
Actors involved in a Mandate subscribe to its channel; status, handoffs, and
escalations flow there; everything is logged. The bus already does pub/sub —
Channels add the org structure and the subscription scoping that bound cost and
attention.

### 9. RACI + the Delegation Graph — the structure that *bounds* who talks to whom

- **RACI per Mandate:** Responsible (owner), Accountable (authority), Consulted,
  Informed. Communication is **licensed by RACI + authority** — the structural
  antidote to N² chatter. An agent may `consult` the GIS specialist *because the
  Mandate's RACI permits it*, and that is checked.
- **The Delegation Graph** is the **live org chart**: the Mandate tree. Authority
  flows down (monotonically narrowing — a sub-Mandate can only *lose* authority),
  results/escalations flow up, consults flow sideways within authority. A
  *workflow* is a Mandate template; a *Role/seat* is a standing Mandate set; a
  *department* is a stable Mandate cluster; the *organization* is the graph.
  *Seed:* the sensei role policy's `fire_allowlist` intersection
  (`assertFireAllowed`) is the per-edge check; generalize it fabric-wide.

### 10. The Record — onboarding by reading, not briefing

Every message, decision, delegation, and action lands in an **append-only,
per-enterprise audit ledger** with `{ mandate, from, to, verb, authority used,
model, cost, inputs hash, verification verdict, ts }`. A new actor joining a
Mandate gains awareness by **reading the Record** (like a person reads the
history), not by a peer re-broadcasting context. *Seed:* today's
`lib/model-adapters/ledger.mjs` records **model calls only** — extend it to the
full **action/authority audit** (this is the "system of record for governed AI
work," and the enterprise-sales weapon).

### 11. Governance over coordination

- **Authority on every directed verb** (Hanko): can A `delegate`/`handoff`/
  `consult` B for this, at this scope?
- **Escalation triggers** (automatic): irreversible · over-budget · externally-
  visible · low verification confidence → routed (not decided) by the actor's
  leader.
- **Verifier ≠ actor:** no agent both performs and self-attests a high-stakes
  action (generalize the STV anti-collusion result into the default).
- **Budgets per channel/Mandate:** hard token/$/time caps prevent chatter
  runaway.
- **Identity on the wire:** *target* = every directed message signed and
  authority-checked. **Today** the bus only *connection-attests* `from` at HELLO
  (not client-forgeable) and accepts a `trust` field it never enforces — signing
  + the per-message authority check are net-new and required here.

---

## PART III — ACROSS ENTERPRISES & ACTORS

### 12. Reproducibility across enterprises

The same agent pack must instantiate identically for any business, with that
business's people, roles, and rules:

1. **Install binds an `enterpriseId`** (the tenant identity) — generalizes
   `~/.config/agix/identity.json` from one operator to `{ enterprise, users[],
   roles[] }`.
2. **Agents ship their Charter** (trust, capabilities, authority envelope,
   sub-agent allowlist, eval suite, data-class) — *baked into the manifest/policy,
   identical everywhere*.
3. **The enterprise overlays a Policy Binding** (`AGENT_POLICY.yaml`): which
   users/roles may invoke which agents, at what scope, with what approval gates.
4. **The eval/security gate travels with the agent.** Each agent's `eval_suite`
   (STV-style) and its `policy.yaml` are part of the pack, so "is this agent
   behaving + permitted correctly" is reproducible and verifiable on every
   install — the enterprise can run the agent's own gate before trusting it.

Result: *the agent is universal; the binding is per-tenant; the audit is
per-tenant.* This is what lets different businesses, teams, and users run the
same governed fleet reproducibly.

### 13. Concurrency & conflict — the merge problem

When two actors (e.g. my agent and your agent) act on the same Mandate, you get
the **merge-conflict problem for agentic work**. Design rules:

- **Single Responsible per Mandate** at a time (the "lock"); others are
  Consulted/Informed. Ownership changes only via `handoff`.
- **The Record is the source of truth;** state is event-sourced, so concurrent
  effects are ordered and reconcilable (git/CRDT-shaped thinking, not LLM
  thinking).
- **Conflicting writes** to shared artifacts go through a review/merge Mandate,
  not a silent overwrite.
- **Deadlock/timeout:** every awaited `delegate`/`consult` has a timeout →
  auto-escalate.

Nailing cross-actor concurrency under governance is genuinely hard and is itself
a moat — most "multi-agent" systems avoid concurrent multi-*human* authority.

---

## PART IV — MAPPING & NON-GOALS

### 14. What exists vs. what's net-new (bridge to the evaluation)

| Fabric element | Today | Net-new |
|---|---|---|
| Transport (pub/sub + req/reply) | `lewis-aos-bus` (TCP) ✅ — but a *spike*, not yet wired into the runtime; `from` is connection-attested, not signed | typed verb set + signed envelope + Hanko check on each directed verb |
| Directory | `madoguchi` registry + bus broker (partial) | humans + roles + capability index; query API |
| World Model | — | versioned shared state + materialized views |
| Channels | bus pub/sub (raw) | Mandate/domain/event-typed channels + scoped subscription |
| RACI / Delegation | `assertFireAllowed` exists **only inside Sensei**; runtime `runAgent` spawns sub-agents ungated | RACI per Mandate; **move the fire gate into the runtime** → fabric-wide delegation graph |
| Mandate abstraction | implicit runs; **budget enforcement already exists** (`agix-runtime` checkBudget) | first-class Mandate object binding goal/authority/budget/verify |
| Identity (multi-user) | single operator (`agix-identity`, a greeting-name file) | Enterprise→User→Role model |
| AuthZ / credentials | sensei role policies + env keys (advisory elsewhere) | **Kagi + Hanko** (concept-only today, not built) |
| Record / audit | model-*call* ledger only (`tenant` is a label, not isolation) | full action/authority audit ledger, per-tenant |
| Eval bound to agent | generic harness `lib/agix-eval/` + ~11 agent `eval/*.suite.mjs` ✅ (`stv-eval` is director-specific) | declare `eval_suite` in manifests + run on install/before-trust |

### 14a. Verified current-state caveats (2026-06-22)

A code-grounded gap analysis (see `AGENT_COORDINATION_FABRIC_GAP_ANALYSIS.md`)
corrected several optimistic assumptions in earlier drafts of this spec:

- **Identity-on-wire is *attested, not signed*.** `from` is set by the daemon at
  HELLO; the `trust` field is accepted but never enforced. Per-message signing +
  authority check are net-new.
- **The fire/delegation check is Sensei-only.** `assertFireAllowed` lives in
  `agents/sensei/lib/policy.mjs`; the general `lib/agix-runtime.mjs` `runAgent`
  path does **not** call it — so sub-agent spawning is ungated fabric-wide today.
- **`soul`/Charter coverage is partial.** Only ~8 of 18 agents declare a `soul`;
  **director and sensei have none**, no manifest carries
  `capabilities/authority/credentials/eval_suite/data_class`, and **no schema
  validates** any of it (best-effort YAML parse). The contract is also
  *advisory*, not runtime-enforced, in v0.2.
- **Trust levels:** code's valid set is `observer | proposer | executor` —
  `narrator` (used in this spec) is **proposed, not yet valid**.
- **`stv-eval` is the director deploy-health proof,** not the generic per-agent
  harness (that's `lib/agix-eval/` + `scripts/agix-eval.mjs`).
- **Budget enforcement already exists** — it's the one Mandate ingredient that's
  further along than a from-scratch build.

### 15. Non-goals / failure modes to design against

- **Not a chatroom.** Awareness = query/subscribe; comms = typed verbs. No
  free-form agent conversation.
- **No simulated office politics.** Model the *coordination mechanisms*
  (delegate/escalate/handoff), never the social theater (agents "negotiating,"
  simulated meetings).
- **No inferred coordination.** Acknowledged messages only; never assume another
  actor agreed.
- **No unbounded chatter.** RACI + channel budgets + prefer-read-over-message.
- **No long-lived secrets in agents.** Kagi brokers; agents hold nothing.

### 16. Open questions

1. Directory + World Model: centralized service (simplest, a SPOF) vs.
   replicated? Start centralized (`madoguchi`-hosted), revisit at scale.
2. Mandate persistence + event log store: extend the ledger, or a dedicated
   event store? (Tenant isolation must be provable either way.)
3. Cross-enterprise *shared* agents (a marketplace agent acting in tenant ACME):
   how does its Charter compose with ACME's binding without leaking?
4. Human-actor UX: each human's leader as their fabric client — one inbox over
   all channels/escalations they're RACI-bound to.
5. Concurrency model depth: lock-per-Mandate (simple) vs. CRDT-merge (powerful)
   — pick per artifact type.

---

## References

- `RUST_INTRA_AGENT_BUS.md` — the transport this rides on.
- `wiki/concepts/centralized-auth-and-permissions.md` — Kagi + Hanko (the
  identity substrate; Track N).
- `MENTOR_LEADER_AGENT.md` — the leader as each human's fabric client (face over
  an inspectable brain).
- `lib/model-adapters/ledger.mjs` — the Record's seed (extend to action audit).
- `lib/agix-eval/` + `scripts/agix-eval.mjs` — the generic per-agent eval
  harness (`eval_suite` substrate). `scripts/stv-eval.mjs` is the director
  deploy-health proof specifically.
- `AGENT_COORDINATION_FABRIC_GAP_ANALYSIS.md` — code-grounded current-state
  evaluation + the dependency-ordered build sequence.
- `agents/<name>/manifest.yaml` `soul` + `policy.yaml` — the Agent Charter seed.
