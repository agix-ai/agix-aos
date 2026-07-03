# AGENTS.md

Agent operating contract for the Agix monorepo.

## Mission

Deliver enterprise-grade software and operating documentation with high continuity, traceability, and implementation discipline.

## Core Non-Negotiables

- Keep architecture and delivery decisions documented in `architecture/` and `docs/`.
- Do not commit secrets, credentials, or sensitive client data.
- Avoid one-off hacks in shared packages and templates.
- Keep changes scoped, explicit, and reviewable.
- Follow prompt and handoff standards in `PROMPT_SYSTEM.md`.

## Mandatory Handoff Rule

Agents must always leave a handoff file in `docs/handoffs/` after meaningful work.

Meaningful work includes:

- architecture or sequencing decisions,
- code/template changes another agent may continue,
- review/QA findings requiring follow-up,
- blocked work needing escalation.

Use `templates/handoff-template.md` and naming:

`YYYY-MM-DD-<workstream>-<topic>.md`

## Expected Workflow

1. Read `docs/framework/BUILD_FRAMEWORK.md` and pick the next milestone
   per its §6 decision rule.
2. Confirm scope, constraints, and acceptance criteria from the
   chosen milestone.
3. Choose prompt category (`architecture`, `implementation`, `review`, `qa`, `orchestration`) per `PROMPT_SYSTEM.md`.
4. Execute scoped work with practical quality checks
   (`pnpm lint && pnpm typecheck && pnpm build`, plus `ruff` / `pytest`
   for python changes).
5. Update relevant docs/templates when process or structure changes.
6. Update the `BUILD_FRAMEWORK.md` §5 status table.
7. Produce a handoff with completed work, open tasks, risks, and next
   action.

## Directory Responsibilities

- `agents/` owns the autonomous agent fleet (one directory per agent, auto-discovered by `bin/agix`). See `architecture/03-ai-ml/agent-architecture/AGENT_STACK_COMPREHENSIVE_AUDIT_2026-06-18.md` for the fleet map + the dev-discipline tier (git-orchestrator, tester, ci-warden, security-officer).
- `apps/` owns user-facing applications.
- `packages/` owns reusable shared modules and prompt assets.
- `services/` owns backend/API runtimes.
- `architecture/` owns long-lived design and operating architecture.
- `docs/` owns process artifacts, prompts operations, and handoffs.
- `templates/` owns standard reusable delivery formats.

## Definition of Done

- Deliverables meet the acceptance criteria for the chosen milestone in
  `docs/framework/BUILD_FRAMEWORK.md`.
- Artifacts and docs reflect the current state.
- `BUILD_FRAMEWORK.md` §5 status table is updated.
- Handoff is written and actionable for the next agent.

## Deploy postmortems

Any failed production rollout (Firebase App Hosting or Cloud Run) gets
a 5-minute postmortem in `docs/handoffs/` using
`templates/deploy-postmortem-template.md`. Reference: framework
milestone A3.

## Dependency pin policy

`next`, `react`, `react-dom`, and their `@types/*` siblings are
**exact-pinned** in `apps/website/package.json` — no caret ranges.
The Firebase App Hosting Next.js adapter validates the Next version
against its CVE list at build time, and stochastic carets were the
proximate cause of two deploy failures in April. Version moves happen
through Dependabot PRs (`.github/dependabot.yml`, weekly Monday 06:00
MT, labeled `dependency-pin-policy`); reviewers verify the new pin
passes `pnpm run apphosting:check-nextjs` before merging. Reference:
framework milestone A2.
