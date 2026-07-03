# Deploy Postmortem — `<service>` `<short-failure-title>`

Date: `YYYY-MM-DD`
Author: `<agent or human>`
Triggering rollout / build ID: `<id or URL>`
Severity: `low` | `medium` | `high`
Time to detect: `<minutes>`
Time to resolve: `<minutes>`

## Summary (1–3 sentences)

What broke, what users (if any) saw, what fixed it.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| HH:MM | Push / trigger |
| HH:MM | Failure observed |
| HH:MM | Root cause identified |
| HH:MM | Fix shipped |
| HH:MM | Rollout green |

## Root cause

The single thing that, if it had been different, would have prevented
the failure. Avoid "human error" — describe the missing guardrail.

## Why it wasn't caught earlier

- Was there a CI check that should have caught this?
- Was there a pre-deploy validation gate that should have run?
- Was the failure mode previously seen and not documented?

## Action items

| ID | Action | Owner | Tracked in |
| --- | --- | --- | --- |
| 1 | … | next agent | framework milestone A?, or new milestone |

## What to update in the framework

- Does `BUILD_FRAMEWORK.md` §3 need a new milestone to prevent recurrence?
- Does `AGENTS.md` need a new operating rule?
- Does any contract or schema need a version bump?

## Links

- Build / rollout URL
- Logs query URL
- Related handoff(s)
