# Security Policy

Agix AOS is a local agentic operating system. This page states its honest security
posture and how to report a vulnerability. If anything here drifts from the code, the
code wins — open a report and we'll fix the doc.

## Posture

- **No telemetry. No covert network calls.** Agix AOS does not phone home, collect
  analytics, or make background network requests of its own. The only outbound calls are
  the ones you trigger: an agent making a model call goes through the CLI agent you
  configured (Claude Code / Codex) or, if you set one, your own API key. State is local
  (`~/.config/agix`, `~/.cache/agix`, `~/.local/state/agix`).
- **Public releases pass a public-clean gate.** Every public-bound artifact is built
  behind `scripts/release/verify-public-clean.sh`, which scans the exact staged tree for
  secret shapes, real email addresses, product/client identifiers, operator-personal
  facts, and private-repo references. The build aborts if anything leaks. (This gate
  exists because an earlier release leaked a third-party email before it was deleted; the
  gate is the structural fix.)

## Trust model — currently advisory

Each agent declares a **soul** (identity, trust level, boundaries) and a companion
**policy** (`agents/<name>/policy.yaml`) describing what it may read, write, and run. The
trust levels are `observer` (read-only), `proposer` (writes plans/notes, never source),
and `executor` (writes source, commits, pushes).

> **Be honest with yourself about this:** in the current public pack, the soul/policy
> trust model is **advisory metadata**. It documents intent and is read by agents as
> context, but it is **not hard-enforced at runtime** yet — runtime enforcement is on the
> roadmap. Do not treat a `proposer` or `observer` declaration as a sandbox.

**What "advisory" means concretely.** Agents are `agent.mjs` `run({ runtime, opts })`
functions executed in-process by the runtime — they have the full capability of the
Node process (filesystem, `child_process`, network). There is no harness interception
of an agent's tool calls today, so a `policy.yaml` `deny_patterns` list is documentation
of what an agent *should not* do, not a wall that stops it. The one real safety control
shipping in v0.2 is **informed consent**: running an `executor`-trust agent prints a
visible warning (it can write files and run commands on your machine), and
`agix agent new --trust executor` cautions you when it scaffolds one.

**Roadmap — runtime enforcement.** A real capability-mediated sandbox (running each
agent in a constrained subprocess whose filesystem / process / network capabilities are
mediated against its declared `policy.yaml`, so a `deny_pattern` actually blocks the
command) is the planned hard-enforcement layer. Until it ships, treat trust as advisory
and review agents before you run them.

## "Agents act on your machine" caveat

Agix AOS is agentic software with real capabilities. Agents can read and write a local
brain + wiki, scaffold files, run a project's test suite, and coordinate work over a
local bus. **Executor-trust agents have real capabilities** — they can write source,
commit, and push.

Treat it accordingly:

- **Review what you run.** Read an agent's manifest, persona, and policy
  (`agix agent show <name>`) before running it, especially anything executor-trust or
  anything you didn't author.
- **Run untrusted agents in a throwaway checkout** until you've reviewed them. There is
  no runtime sandbox yet (see above).
- **The model is yours.** Because Agix passes calls through your CLI agent / key, agent
  output and any actions it proposes inherit your account's capabilities.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- **Use GitHub Private Vulnerability Reporting** on this repository:
  **Security → Advisories → Report a vulnerability → Open a draft advisory**. This routes
  the report to the maintainers privately and is the preferred channel.

Please include a description, reproduction steps, and impact. Do not include real secrets,
customer data, or production credentials in a report.

## Coordinated disclosure

We follow coordinated disclosure. When you report a vulnerability:

- We aim to **acknowledge receipt within 72 hours** and give an initial assessment
  shortly after.
- We'll work with you on a fix and agree on a disclosure timeline. Our default is a
  **90-day coordinated-disclosure window** from the report date — we aim to ship a fix
  and publish an advisory within that window, and we may disclose sooner once a fix is
  available.
- We'll credit reporters who want credit in the published advisory. Please give us a
  reasonable chance to remediate before any public disclosure.
