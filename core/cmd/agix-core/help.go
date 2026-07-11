// Per-verb help — so the `agix <command> --help` path the banner advertises actually works,
// consistently, on every verb (stdout, exit 0). Intercepted centrally in main() before the
// verb's own arg parser can reject the flag.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

// helpFlag reports whether s is a help request.
func helpFlag(s string) bool { return s == "-h" || s == "--help" || s == "-help" || s == "help" }

// verbHelp returns the help text for a verb and whether one exists. Lines stay ≤80 cols so
// they don't hard-wrap on a standard terminal.
func verbHelp(verb string) (string, bool) {
	h, ok := verbHelpText[verb]
	return h, ok
}

var verbHelpText = map[string]string{
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
	"route": `agix route — show which provider/model a capability resolves to

usage:
  agix route <capability>

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
	"swarm": `agix swarm — decompose→worker→converge, KM-augmented (in-process)

usage:
  agix swarm --task "<task>" [--workers N] [per-role model flags]
`,
}
