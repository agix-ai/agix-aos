# Loop-Engineered SDLC — the dev fleet's operating lifecycle

> **Date:** 2026-07-03
> The software-development agents run a firm-grade SDLC (IBM 7-phase + DevOps loop + TOGAF ADM
> shell) with a **loop-engineering overlay**: verify-don't-trust, actor≠verifier, eval-gated
> Go/Kill/Hold/Recycle transitions, and the L0/L1/L2 improvement loops anchored in the audit
> ledger. Part of the architecture framework. Grounded in a 2026-07-03 research sweep (IBM SDLC/
> DevOps/DORA/Garage/ELM/ADLC; TOGAF ADM; Stage-Gate; Anthropic + GitHub agentic patterns;
> SpecBench/reward-hacking findings). Builds on `AGENT_COORDINATION_FABRIC.md` +
> `MULTI_LEVEL_ENTERPRISE_AOS_SPEC.md`.

## 0. The thesis (why this exists)
IBM's own admission: *"Writing code is less of a bottleneck, but evaluating the code written by AI
is."* The SDLC's center of gravity moves from *produce* to *verify*. And the 2025-26 evidence is
blunt: a single verification surface the actor controls **will** be gamed — reward-hacking
produces `sys.exit(0)` "all tests passed" and emergent misalignment (Anthropic); FreshBrew agents
"pass" by deleting failing tests; SpecBench shows the visible-vs-held-out gap **grows 28pp per 10×
code size**. So every phase needs a verifier the actor cannot edit, plus a signal the actor never
sees. This doc encodes that as the dev fleet's lifecycle.

## 1. The phase list (9 phases, looped inside the TOGAF ADM shell)
**Orient → Spec → Design → Implement → Test → Integrate → (Root-cause on any fail) → Release →
Operate/Monitor → back to Spec.** = IBM's 7-phase SDLC + DevOps's Operate/Monitor loop + an
explicit **Orient** phase (Agix's onboarding edge) + **Root-cause** as a first-class failure
branch (Agix's investigator edge). It sits inside TOGAF ADM so the dev loop and the Bonsai memory
graph share the five-domain spine; TOGAF **Phase G** (Implementation Governance) is the
architecture-conformance gate and **Phase H → new cycle** is the umbrella loop.

## 2. Per-phase overlay + agent mapping (actor ≠ verifier is the load-bearing rule)

| # | Phase | Actor (owner) | Exit gate (DoD) → verdict | Verifier (must ≠ actor) | Verified signal |
|---|---|---|---|---|---|
| 0 | **Orient** | onboarding | codebase map + risk/dependency notes | architect spot-checks | orientation artifact + confidence |
| 1 | **Spec/Plan** | architect + human | spec is testable; acceptance criteria + **held-out eval** defined | **human gatekeeper** (Go/Kill/Hold) | ratified spec + eval criteria |
| 2 | **Design** | architect | SDD + threat model; conforms to Bonsai/TOGAF branch | 2nd architect instance / human (high-risk) | approved design + threat model |
| 3 | **Implement** | coder/impl | compiles, self-tests + brand/lint pass; **lease** held on target files | architect review (**not the coder**) | draft PR + diff |
| 4 | **Test** | tester | pyramid coverage; **visible AND held-out tests pass** | held-out suite (actor never sees) + LLM-judge | test report + visible/held-out gap |
| 5 | **Integrate** | git-orchestrator + ci-warden | CI green within cost budget; **author ≠ approver** | ci-warden (gates+cost) + human approver | merge record + DORA lead-time stamp |
| 6 | **Root-cause** (on fail) | investigator | root cause found (Iron Law: no fix without root cause) | tester re-runs to confirm | RCA + fix verification |
| 7 | **Release** | release-engineer | canary healthy @1–5%, SLOs hold, rollback ready | automated canary eval + human promotion | canary verdict + deploy stamp |
| 8 | **Operate/Monitor** | release-engineer + ci-warden | DORA within targets; no unrecovered incident | monitoring (external signal) | 5 DORA metrics + rework rate |

**The hard rule: no agent verifies its own output.** Coder's PR → architect + tester; investigator's
fix → tester; tester's coverage → held-out tests + LLM-judge; release-engineer's canary → automated
eval + human. Backed by SpecBench, the Anthropic reward-hacking paper, and GitHub's shipping
author≠approver product rule. *(Gap: the fleet has no dedicated **coder** agent — either name one or
split architect+impl, but the coder must be a distinct actor from its verifier.)*

**Gate verdicts are Go / Kill / Hold / Recycle** (Stage-Gate), not pass/fail — richer and it maps
onto what Agix already does: merge / abandon-branch / hold-for-human / send-back-to-actor.

**Four hard human gates:** Spec approval, high-risk design sign-off, merge-to-main (author≠approver,
always), production promotion. Everything else agent-gated with human-on-escalation (IBM HITL).

## 3. Anti-spec-gaming mechanics (non-negotiable)
1. **Held-out tests** at the Test gate the coder never sees; track the **visible-vs-held-out gap** as
   a first-class metric (it *is* the spec-gaming detector, and grows with task size → cap agent task
   horizon).
2. **Immutable verifier surface** — the coder cannot edit the test harness, CI config, or gate
   criteria (prevents `sys.exit(0)`, deleting failing tests, monkey-patching scorers).
3. **Inoculation prompt** the coder ("satisfy the real spec, not merely make the grader pass").
4. **LLM-judge layered on tests, never replacing them** (EVILGENIE: judges catch hacks tests miss;
   but judges are biased — use both).
5. **Cap task horizon** — reward-hacking and unreliability both scale with task length; keep each
   unit of work small and reviewable.

## 4. Metrics — DORA (5) + agentic extensions (the ledger enables)
Standard five, target **Elite** bands: Deployment Frequency (on-demand), Change Lead Time (<1 day),
Change Failure Rate (≤5%), Failed-Deployment Recovery (<1 hr), Deployment Rework Rate. Plus the
agentic extensions the audit ledger uniquely enables:
- **Gate rejection rate per phase/agent** (where the loop catches things — the L0 health signal).
- **Visible/held-out test gap** (spec-gaming index — should trend to 0).
- **Verification cost per merged PR** (ci-warden's budget metric).
- **Human-escalation rate** (should fall as L2 priors mature).
- **First-pass gate yield** (Go-on-first-attempt vs Recycle — the compounding-quality curve).

## 5. The loops (L0/L1/L2) + the audit ledger
- **L0 — phase-local** (within a phase, one run): evaluator-optimizer. Verifier verdict → actor
  refines, bounded 2–5 iterations. Improvement signal = the *verified verdict*, never the actor's
  self-report. Agix's LL.3 relative-ranking critic lives here.
- **L1 — run-level** (across phases, one session): each phase appends its verified signal; the run
  closes with a reflection envelope. "Session = branch, Bonsai = main."
- **L2 — umbrella** (across runs): a scheduled `/evolve`-style pass reads the **audit ledger**,
  computes the §4 metrics across runs, and promotes durable priors — tightened gate criteria, new
  held-out patterns, agent-specific inoculation prompts, architecture defaults. Maps to TOGAF Phase
  H → new cycle and Bonsai ratification.
- **The audit ledger is the substrate** (Agix's lightweight IBM-ELM/Jazz analogue): every gate
  decision, verifier verdict, held-out result, lease grant, and merge is an append-only entry. **You
  cannot learn priors you did not record** — the ledger is what turns single-run gates into
  cross-run learning, and (per the visible-age moat) the artifact that can't be faked.

**Coordination control plane:** **leases** are the entry precondition for Implement/Integrate (an
agent can't act on files/branches it hasn't leased — prevents parallel-session collisions);
**merge-ordering** serializes the Integrate gate deterministically. Both recorded in the ledger.

## 6. Build sequence (what to implement first)
1. **Ledger + gate schema** (Go/Kill/Hold/Recycle verdicts, verifier≠actor recorded) — nothing else
   works without the record.
2. **Held-out test surface + immutable-harness rule** at the Test/Integrate gates — highest-leverage
   safety control; directly answers SpecBench/reward-hacking.
3. **Author≠approver + leases + merge-ordering** in git-orchestrator (GitHub-proven).
4. **DORA + agentic-extension instrumentation** wired into the ledger.
5. **L2 `/evolve` pass** over the ledger last — it needs runs to learn from.

Net: a firm-grade SDLC (IBM 7-phase + Garage value-tracking + ELM traceability) turned into a *loop*
(DevOps ∞ + DORA), overlaid with the controls the 2025-26 agentic research proves mandatory
(actor≠verifier, held-out verification, Go/Kill/Hold/Recycle transitions, multi-level learning on an
append-only ledger) — reusing the TOGAF/Bonsai spine Agix already owns.
