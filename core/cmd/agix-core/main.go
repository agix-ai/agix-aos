// Command agix-core is the Agix orchestration core as a single static binary.
//
//	agix-core version
//	agix-core route <capability>
//	agix-core run "<task>" [--provider mock|anthropic|openai|gemini|local] [--capability <cap>] [--report-home <url>]
//	agix-core flow "<task>" [--gate=approve|reject] [--provider mock]
//	agix-core hive "<task>" [--workers N] [--queen ID] [--worker-models ID,…] [--verifier ID]
//
// With --report-home <gateway-url>, a completed run also maps its Result into a
// cross-hive report Envelope and POSTs it (bearer AGIX_HIVE_KEY) to a hive's
// report-home gateway — the sender half of the federated-apiary loop. HIVE (or
// AGIX_HIVE) names the reporting hive; the actor crosses as a drone.
//
// The `run` command executes ONE forage→work→return/feed agent path. The `flow`
// command runs the forage→ratify→feed governance graph through the orchestrator
// port + mem engine, pausing at the ratification gate (actor≠verifier) and
// resuming with the --gate verdict. `--provider mock` (the default) is
// deterministic and zero-cost — no network, no API key. The runtime audit ledger
// is written under ./.agix-core/ (gitignored).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/orchestrator/demo"
	"github.com/agix-ai/agix/core/provider/anthropic"
	"github.com/agix-ai/agix/core/provider/gemini"
	"github.com/agix-ai/agix/core/provider/local"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/provider/openai"
	"github.com/agix-ai/agix/core/router"
)

const version = "0.1.0"

const ledgerPath = ".agix-core/ledger.jsonl"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	switch args[0] {
	case "version", "-v", "--version":
		fmt.Printf("agix-core %s\n", version)
	case "route":
		os.Exit(cmdRoute(args[1:]))
	case "run":
		os.Exit(cmdRun(args[1:]))
	case "flow":
		os.Exit(cmdFlow(args[1:]))
	case "swarm":
		os.Exit(RunSwarmCLI(args[1:]))
	case "hive":
		os.Exit(RunHiveCLI(args[1:]))
	case "agent":
		os.Exit(cmdAgent(args[1:]))
	case "km":
		os.Exit(cmdKM(args[1:]))
	case "distill-export":
		os.Exit(cmdDistillExport(args[1:]))
	case "autonomy":
		os.Exit(cmdAutonomy(args[1:]))
	case "secret":
		os.Exit(cmdSecret(args[1:]))
	case "verify-guard":
		os.Exit(cmdVerifyGuard(args[1:]))
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `agix-core — the Agix orchestration core (single binary)

usage:
  agix-core version
  agix-core route <capability>
  agix-core run "<task>" [--provider mock|anthropic|openai|gemini|local] [--capability <cap>] [--report-home <gateway-url>]
  agix-core flow "<task>" [--gate=approve|reject] [--provider mock]
  agix-core hive "<task>" [--workers N] [--queen ID] [--worker-models ID,…] [--verifier ID]
  agix-core agent list [--dir agents] [--public-only]
  agix-core agent run <name> "<task>" [--dir agents] [--provider mock] [--public-only]
  agix-core km put|link|retrieve|traverse|cosign|stats [--db PATH] …
  agix-core distill-export [--db PATH] [--branch software] [--out DIR] [--min-trust 0.9]
  agix-core autonomy status | gate <domain> <rung> | observe <domain> accept|reject
  agix-core secret check <ref> | scan <file>
  agix-core verify-guard [--review <path>] [--repo owner/repo] [--pr N] [--allowlist <path>] [--risk <path>]

capabilities: default-quality, cheap-classification, long-context, tool-use-heavy, vision
`)
}

func cmdRoute(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "route: need a capability")
		return 2
	}
	r := router.NewRouter()
	route, err := r.Resolve(router.Capability(args[0]))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("%s -> %s/%s\n", route.Capability, route.Provider, route.Model)
	return 0
}

func cmdRun(args []string) int {
	task, provider, capability, reportHome, err := parseRunArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if task == "" {
		fmt.Fprintln(os.Stderr, `run: need a task, e.g. agix-core run "hello hive"`)
		return 2
	}

	r := router.NewRouter()
	switch provider {
	case "mock":
		r.Register(mock.New())
		r.ForceProvider("mock") // mock is synthetic; the table never routes to it
	case "anthropic":
		r.Register(anthropic.New())
	case "openai":
		r.Register(openai.New())
	case "gemini":
		r.Register(gemini.New())
	case "local":
		// Local Ollama lane ($0). Like mock, the default table never routes to
		// "local", so pin every call to it.
		r.Register(local.New())
		r.ForceProvider("local")
	default:
		fmt.Fprintf(os.Stderr, "run: unknown provider %q (mock|anthropic|openai|gemini|local)\n", provider)
		return 2
	}

	led, err := ledger.Open(ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "run: open ledger: %v\n", err)
		return 1
	}
	leases := coord.NewMemLedger()
	ag := &agent.Agent{Name: "forager-1", Router: r, Ledger: led, Leases: leases}

	runStart := time.Now().UTC()
	res, runErr := ag.Run(context.Background(), agent.Task{
		Name:       "cli-task",
		Prompt:     task,
		Capability: router.Capability(capability),
		Scope:      []string{"hive/cli/" + provider},
	})

	// Result.
	if res.Text != "" {
		fmt.Printf("result: %s\n", res.Text)
	}
	if runErr != nil {
		fmt.Printf("status: degraded (%s)\n", res.Err)
	}
	if res.Provider != "" {
		fmt.Printf("route:  %s/%s\n", res.Provider, res.Model)
	}
	fmt.Printf("usage:  in=%d out=%d cached=%d cost=$%.6f\n",
		res.Usage.InputTokens, res.Usage.OutputTokens, res.Usage.CachedTokens, res.Usage.CostUSD)
	if len(res.Degraded) > 0 {
		fmt.Printf("degraded: %s\n", strings.Join(res.Degraded, ", "))
	}

	// Compact ledger summary for this run.
	claimed, released := 0, 0
	entries, _ := led.Read("", runStart)
	for _, e := range entries {
		switch e.Kind {
		case ledger.KindLeaseClaim:
			claimed++
		case ledger.KindLeaseRelease:
			released++
		}
	}
	fmt.Printf("ledger: leases claimed=%d released=%d  (%s)\n", claimed, released, ledgerPath)

	// ── report home (additive) ────────────────────────────────────────────
	// When --report-home is set, close the federated-apiary loop: map the
	// Result → a report-kind cross-hive Envelope → an authenticated POST to the
	// destination hive's gateway. The sender is a boundary bee, so the actor
	// caste MUST be drone or the gateway 403s. Absent the flag, nothing changes.
	// The flag wins; AGIX_HOME_ENDPOINT is the env fallback so a container can
	// drive report-home purely by environment (see core/Dockerfile).
	if reportHome == "" {
		reportHome = strings.TrimSpace(os.Getenv("AGIX_HOME_ENDPOINT"))
	}
	reportFailed := false
	if reportHome != "" {
		if code := doReportHome(reportHome, res); code != 0 {
			reportFailed = true
		}
	}

	if runErr != nil || reportFailed {
		return 1
	}
	return 0
}

// doReportHome builds the cross-hive Envelope from an agent Result and POSTs it
// to the report-home gateway. The from/to hive comes from HIVE (or AGIX_HIVE),
// and the bearer key from AGIX_HIVE_KEY. Returns 0 on an accepted report, 1 on
// any failure (missing key, local validation, transport, or a non-2xx).
func doReportHome(endpoint string, res agent.Result) int {
	hive := firstNonEmpty(os.Getenv("HIVE"), os.Getenv("AGIX_HIVE"), "agix")
	key := os.Getenv("AGIX_HIVE_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "report: AGIX_HIVE_KEY is unset — cannot authenticate the report-home POST")
		return 1
	}

	actor := apiary.ActorRef(hive, "drone", "forager")
	env := apiary.EnvelopeFromResult(
		apiary.ResultLike{
			Text:         res.Text,
			Provider:     res.Provider,
			Model:        res.Model,
			Degraded:     res.Degraded,
			InputTokens:  res.Usage.InputTokens,
			OutputTokens: res.Usage.OutputTokens,
			CachedTokens: res.Usage.CachedTokens,
			CostUSD:      res.Usage.CostUSD,
		},
		apiary.ReportMeta{
			FromHive:      hive,
			ToHive:        hive, // "report home" — the drone reports to its own hive
			Actor:         actor,
			Lineage:       []string{actor, apiary.ActorRef(hive, "queen", "root")},
			AuthorityUsed: "cross-hive-report",
		},
	)

	client := apiary.NewClient(endpoint, key)
	receipt, err := client.ReportHome(context.Background(), env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "report: %v\n", err)
		return 1
	}
	fmt.Printf("report: accepted entry_id=%s envelope_id=%s (%s)\n",
		receipt.EntryID, receipt.EnvelopeID, endpoint)
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// cmdFlow runs the forage→ratify→feed governance graph through the orchestrator
// port + mem engine. It auto-interrupts at the ratification gate and resumes
// with the --gate verdict (approve|reject), then prints the transcript, the
// verdict, and a ledger summary. Zero-cost on the mock provider (default).
func cmdFlow(args []string) int {
	task, gate, provider, err := parseFlowArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if task == "" {
		fmt.Fprintln(os.Stderr, `flow: need a task, e.g. agix-core flow "ship a login page" --gate=approve`)
		return 2
	}
	approve := true
	switch gate {
	case "", "approve":
		approve = true
	case "reject":
		approve = false
	default:
		fmt.Fprintf(os.Stderr, "flow: unknown --gate %q (approve|reject)\n", gate)
		return 2
	}

	led, err := ledger.Open(ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "flow: open ledger: %v\n", err)
		return 1
	}

	runStart := time.Now().UTC()
	res, runErr := demo.Run(context.Background(), demo.Options{
		Task:     task,
		Approve:  approve,
		Provider: provider,
		Ledger:   led,
	})
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "flow: %v\n", runErr)
		if res.CheckpointID != "" {
			fmt.Printf("paused: checkpoint=%s interrupt=%s\n", res.CheckpointID, res.Interrupted)
		}
		return 1
	}

	// Narrative summary.
	fmt.Printf("task:    %s\n", res.Task)
	fmt.Printf("lease:   %s\n", res.LeaseID)
	fmt.Printf("gate:    paused for %s → resumed by curator-1 → %s\n", res.Interrupted, verdictWord(res.Approved))
	fmt.Printf("outcome: %s\n", res.Outcome)
	if res.OutputText != "" {
		fmt.Printf("output:  %s\n", res.OutputText)
	}

	// Transcript.
	if res.State != nil && len(res.State.Transcript) > 0 {
		fmt.Println("transcript:")
		for _, m := range res.State.Transcript {
			fmt.Printf("  %-9s %s\n", m.Role+":", m.Content)
		}
	}

	// Ledger summary for this run: per-kind counts + the ratification verdict.
	entries, _ := led.Read("", runStart)
	counts := map[string]int{}
	var verdict string
	for _, e := range entries {
		counts[e.Kind]++
		if e.Kind == ledger.KindRatify {
			if v, ok := e.Data["approved"].(bool); ok {
				verdict = verdictWord(v)
			}
		}
	}
	fmt.Printf("ledger:  node_start=%d node_done=%d model_call=%d gate_pause=%d ratify=%s  (%s)\n",
		counts[ledger.KindNodeStart], counts[ledger.KindNodeDone], counts[ledger.KindModelCall],
		counts[ledger.KindGatePause], ratifySummary(counts[ledger.KindRatify], verdict), ledgerPath)
	return 0
}

func verdictWord(approved bool) string {
	if approved {
		return "approve"
	}
	return "reject"
}

func ratifySummary(n int, verdict string) string {
	if n == 0 {
		return "0"
	}
	return fmt.Sprintf("%d(%s)", n, verdict)
}

// parseFlowArgs pulls the positional task plus --gate/--provider flags in any
// order (same hand-rolled scheme as parseRunArgs).
func parseFlowArgs(args []string) (task, gate, provider string, err error) {
	provider = "mock"
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--gate":
			if i+1 >= len(args) {
				return "", "", "", fmt.Errorf("flow: --gate needs a value (approve|reject)")
			}
			gate = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--gate="):
			gate = strings.TrimPrefix(a, "--gate=")
			i++
		case a == "--provider":
			if i+1 >= len(args) {
				return "", "", "", fmt.Errorf("flow: --provider needs a value")
			}
			provider = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--provider="):
			provider = strings.TrimPrefix(a, "--provider=")
			i++
		case strings.HasPrefix(a, "--"):
			return "", "", "", fmt.Errorf("flow: unknown flag %q", a)
		default:
			if task == "" {
				task = a
			}
			i++
		}
	}
	return task, gate, provider, nil
}

// parseRunArgs pulls the positional task plus --provider/--capability/
// --report-home flags in any order (stdlib flag requires
// flags-before-positionals; we parse by hand).
func parseRunArgs(args []string) (task, provider, capability, reportHome string, err error) {
	provider = "mock"
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--provider":
			if i+1 >= len(args) {
				return "", "", "", "", fmt.Errorf("run: --provider needs a value")
			}
			provider = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--provider="):
			provider = strings.TrimPrefix(a, "--provider=")
			i++
		case a == "--capability":
			if i+1 >= len(args) {
				return "", "", "", "", fmt.Errorf("run: --capability needs a value")
			}
			capability = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--capability="):
			capability = strings.TrimPrefix(a, "--capability=")
			i++
		case a == "--report-home":
			if i+1 >= len(args) {
				return "", "", "", "", fmt.Errorf("run: --report-home needs a gateway URL")
			}
			reportHome = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--report-home="):
			reportHome = strings.TrimPrefix(a, "--report-home=")
			i++
		case strings.HasPrefix(a, "--"):
			return "", "", "", "", fmt.Errorf("run: unknown flag %q", a)
		default:
			if task == "" {
				task = a
			}
			i++
		}
	}
	return task, provider, capability, reportHome, nil
}
