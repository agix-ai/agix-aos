// Per-verb help — so the `agix <command> --help` path the banner advertises actually works,
// consistently, on every verb (stdout, exit 0). Intercepted centrally in main() before the
// verb's own arg parser can reject the flag.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

// helpFlag reports whether s is a help request.
func helpFlag(s string) bool { return s == "-h" || s == "--help" || s == "-help" || s == "help" }

// taskModes map a problem-type verb to the specialist agent that owns it, so a user names the
// problem, not the machinery: `agix debug "<issue>"` runs the investigator through the same
// governed (actor≠verifier) path as `agix agent run investigator "<issue>"`.
var taskModes = map[string]string{
	"debug":    "investigator",
	"refactor": "refactor-lead",
	"research": "research",
	"review":   "pr-reviewer",
	"test":     "tester",
	"onboard":  "onboarding",
}

// verbHelp returns the help text for a verb and whether one exists. Lines stay ≤80 cols so
// they don't hard-wrap on a standard terminal.
func verbHelp(verb string) (string, bool) {
	h, ok := verbHelpText[verb]
	return h, ok
}

var verbHelpText = map[string]string{
	"init": `agix init — first-run onboarding; provision this instance's durable state

Idempotent: it never clobbers existing state (an existing file is kept, not
overwritten). Provisions under ~/.agix — the knowledge fabric (km.db, seeded so
it's non-empty), a wiki/, a soul.md (instance identity), and a settings.json —
and detects your coding-agent CLI (Claude Code, then Codex) as the default
provider. Runs fully offline; no API key required.

usage:
  agix init             interactive on a TTY — a short get-to-know-you personalizes soul.md
  agix init --defaults  non-interactive — provision everything with placeholders, no prompts

On a fresh machine, bare 'agix' auto-onboards once (equivalent to 'agix init
--defaults') and then prints the welcome banner.
`,
	"run": `agix run — one forage→work→return agent path; writes the audit ledger

usage:
  agix run "<task>" [flags]

flags:
  --provider <p>       mock|anthropic|openai|gemini|local  (default mock, $0)
  --capability <cap>   route by capability instead of the default
  --report-home <url>  POST the result to a hive's report-home gateway
`,
	"flow": `agix flow — the forage→ratify→feed governance graph

Pauses at the ratification gate (actor≠verifier) and resumes with your verdict.

usage:
  agix flow "<task>" [--gate=approve|reject] [--provider mock]
`,
	"hive": `agix hive — decompose→work→converge across a governed worker swarm

usage:
  agix hive "<task>" [flags]

flags:
  --workers N            number of workers
  --queen <id>           queen model id
  --worker-models <ids>  comma-separated per-worker model ids
  --verifier <id>        verifier model id
`,
	"route": `agix route — show + edit the per-capability routing overlay

The router resolves a capability to a provider/model by PRECEDENCE:
  overlay > --provider force > default table.
The overlay (~/.agix/routing.json) is a surgical, per-capability override that
OUTRANKS a whole-run --provider force — so a graduated capability keeps its
provider even when the run is pinned elsewhere (e.g. cheap-classification→local
under --provider anthropic).

usage:
  agix route                         list the full effective table
  agix route list                    (same)
  agix route <capability>            show the provider/model one capability resolves to
  agix route set <capability> <p>    persist an override (p: mock|anthropic|openai|gemini|local)
  agix route unset <capability>      remove an override

capabilities:
  default-quality · cheap-classification · long-context · tool-use-heavy · vision
`,
	"km": `agix km — the provenance-gated knowledge store (the Comb)

A leaf is ATTESTED iff a verifier distinct from the author AND on the roster
vouches (actor≠verifier). --attested-only refuses un-attested knowledge.

usage:
  agix km put      --content "…" [--author A --verifier V --trust 0.9 --branch B --id X]
  agix km link     --src X --type <t> --dst Y [--author A --verifier V --trust 0.9]
  agix km retrieve --query "…" [--k 5 --attested-only]
  agix km traverse --seed X --type <t> [--hops 2 --attested-only]
  agix km cosign   --id X --verifier V [--trust 1.0]
  agix km reembed  [--dry-run --force]
  agix km stats

  all subcommands accept --db PATH (default ~/.agix/km.db)
  roster: AGIX_KM_VERIFIERS="v1,v2" (comma-separated actor refs)
`,
	"distill-export": `agix distill-export — write the verifier-certified Comb record as an mlx-lm corpus

usage:
  agix distill-export [flags]

flags:
  --db PATH         Comb store file (default ~/.agix/km.db)
  --branch <b>      TOGAF branch to export ("" = all attested; default software)
  --out DIR         output dir for {train,valid,test}.jsonl
  --min-trust <f>   drop certified leaves below this verifier trust (default 0.9)
`,
	"agent": `agix agent — author + run agents (manifest + governed hive)

An agent is a manifest (agent.json: role · trust · tools · boundary · instructions) plus an
optional agent.ts behavior. Author your own — no Go required.

usage:
  agix agent new <name>          scaffold + interactive wizard (--defaults to skip prompts)
  agix agent list                list your agents (--public-only)
  agix agent edit <name>         open the manifest in $EDITOR, then re-validate
  agix agent validate <name>     schema-check against the runner's contract
  agix agent run <name> "<task>" [--dir agents] [--provider mock|anthropic|openai|gemini|local]
`,
	"autonomy": `agix autonomy — the per-domain autonomy rung (from the ledger)

usage:
  agix autonomy status                              rung per domain
  agix autonomy gate <domain> <rung>                is an action at <rung> allowed?
  agix autonomy observe <domain> accept|reject      apply one outcome, print new rung
`,
	"secret": `agix secret — the guard bee (least-privilege secret access)

usage:
  agix secret check <ref>    presence probe → PRESENT (backend=…) | ABSENT
  agix secret scan  <file>   run the egress scanner over a file, redacted
`,
	"verify-guard": `agix verify-guard — the independent-verifier gate (actor≠verifier), enforced

Passes a non-risk PR immediately; a risk-area PR needs an approving review from a
login that is ≠ the author AND on the allow-list. Exits 0 pass / 1 fail, fails closed.

usage:
  agix verify-guard [--review <path>] [--repo owner/repo] [--pr N]
                    [--allowlist <path>] [--risk <path>]

  --review <path>   a JSON review context {files, author, headSha, reviews[]}
                    (offline mode); omit to read the PR live via gh (--repo/--pr)
  --allowlist <p>   curated verifier allow-list JSON (default .github/agix-verifier-allowlist.json);
                    required only for a risk-area PR — a non-risk PR passes without it
  --risk <path>     risk taxonomy override (default: built-in globs)
`,
	"artifacts": `agix artifacts — render the append-only ledger as a governance receipt

The reviewable actor→verifier→verdict trail for a run: who did the work, the
DISTINCT verifier that certified it (actor≠verifier, computed + shown), the
verdict, cost/token totals, and a compact timeline. Backed by the machine-
enforced ledger, not a narrative.

usage:
  agix artifacts                 receipt for the most recent run
  agix artifacts <run-id>        a specific run (swarm run id, lease id, or scope)
  agix artifacts --list          recent runs, newest first
  agix artifacts --json          machine-readable receipt (the Stage-2 HTML seam)
  agix artifacts <run> --html    self-contained HTML receipt (attach to a PR / open offline)

flags:
  --list, -l        list recent runs (id, task, time, bees, cost, verdict)
  --json            emit the receipt struct as JSON (array with --list)
  --html            render a single run as a self-contained, shareable HTML receipt
  --out <path>      write the HTML there (implies --html); '-' writes to stdout;
                    default .agix/receipts/<run-id>.html (dir created)
  --ledger <path>   read this ledger instead of the default .agix/ledger.jsonl
`,
	"swarm": `agix swarm — decompose→worker→converge, KM-augmented (in-process)

usage:
  agix swarm --task "<task>" [--workers N] [per-role model flags]
`,

	"fleet": `agix fleet — the interactive fleet TUI (browse agents, inspect their manifests)

usage:
  agix fleet [agents-dir]      # defaults to ./agents

keys: ↑/↓ or j/k move · g/G top/bottom · q quit. Runs the agix-tui binary (kept in its own
module so the UI toolkit never touches the born-clean core).
`,

	// ── task modes: name a problem, get the right agent (governed) ──────────────────
	"debug": `agix debug "<issue>" — root-cause a failure via the investigator agent
(investigate → analyze → hypothesize → root cause). Finds the cause; never edits source.
Same as: agix agent run investigator "<issue>". Accepts the agent-run flags (--provider, --dir…).
`,
	"refactor": `agix refactor "<target>" — restructure code via the refactor-lead agent, governed
(behavior-preserving; the actor≠verifier gate applies). Same as: agix agent run refactor-lead "…".
`,
	"research": `agix research "<question>" — scan curated sources and synthesize a graded brief
via the research agent. Same as: agix agent run research "<question>".
`,
	"review": `agix review "<target>" — review a diff/PR via the pr-reviewer agent.
Same as: agix agent run pr-reviewer "<target>".
`,
	"test": `agix test "<scope>" — run the suite and report pass/fail + regressions via the tester
agent (never patches source to make a test pass). Same as: agix agent run tester "<scope>".
`,
	"onboard": `agix onboard "<repo>" — read a codebase (read-only) and produce a source map +
readiness assessment via the onboarding agent. Same as: agix agent run onboarding "<repo>".
`,
}
