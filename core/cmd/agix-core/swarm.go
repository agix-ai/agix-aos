package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/swarm"
)

// defaultKMDBPath is where --km opens the Comb when --km-db is not given. It sits
// beside the ledger under .agix so a repo-local run finds its own honey.
const defaultKMDBPath = ".agix/km.db"

// swarmKMk is how many attested hits the Comb retriever merges per subtask.
const swarmKMk = 5

// RunSwarmCLI is the `swarm` subcommand: it runs a governed swarm (Queen
// decomposes → N workers forage in parallel → Queen synthesizes → a distinct
// verifier certifies) and prints either the frozen agix.swarm.v1 JSON contract
// (--json) or a human summary. It parses its own flags and returns an exit code,
// so main.go wires it with a single line and this file carries no other coupling.
//
//	agix swarm "<task>" [--provider mock] [--workers N] [--concurrency N] [--hive agix]
//	  [--queen-model ID] [--worker-models ID1,ID2,...] [--verify-model ID]
//	  [--max-tokens N] [--synth-max-tokens N] [--km [--km-db PATH]] [--json]
//
// --max-tokens caps the per-slice calls (decompose/worker/verify, default 1024);
// --synth-max-tokens caps the Queen's merge — the graded artifact (default 4096,
// and never below --max-tokens). Raise --synth-max-tokens for breadth/coverage
// tasks where the merge of N workers would otherwise truncate.
func RunSwarmCLI(args []string) int {
	a, err := parseSwarmArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if a.task == "" {
		fmt.Fprintln(os.Stderr, `swarm: need a task, e.g. agix swarm "add a login page"`)
		return 2
	}

	led, err := ledger.Open(ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "swarm: open ledger: %v\n", err)
		return 1
	}

	// Run bracket: the OUTERMOST process owns exactly one bracket. A directly-invoked
	// `agix swarm` is outermost and records the ORIGINAL task exactly; a nested engine
	// sub-invocation (AGIX_RUN_ID already set) inherits the id and skips emitting so
	// the run is never double-bracketed. The id is threaded into the swarm either way
	// so the lease scope ("<hive>/swarm/<runID>") and the bracket agree.
	runID, owner := runBracketOwner()
	if owner {
		emitRunStart(led, runID, a.task, "", "swarm", a.hive)
	}

	opts := swarm.Options{
		Task:           a.task,
		Provider:       a.provider,
		Workers:        a.workers,
		Concurrency:    a.concurrency,
		Hive:           a.hive,
		Ledger:         led,
		RunID:          runID,
		QueenModel:     a.queenModel,
		WorkerModels:   a.workerModels,
		VerifyModel:    a.verifyModel,
		MaxTokens:      a.maxTokens,
		SynthMaxTokens: a.synthMaxTokens,
	}

	// KM-ON arm: open the Comb and give workers governed (attested-only) access
	// to the hive's durable honey. KM-OFF (the default) leaves Retriever nil.
	if a.km {
		store, err := kmstore.Open(a.kmDB)
		if err != nil {
			fmt.Fprintf(os.Stderr, "swarm: open km store %s: %v\n", a.kmDB, err)
			return 1
		}
		defer store.Close()
		opts.Retriever = swarm.NewCombRetriever(store, swarmKMk, embedDim)
	}

	res, runErr := swarm.Run(context.Background(), opts)
	if owner {
		emitRunDone(led, runID, runErr == nil, res.Cost.USD)
	}
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "swarm: %v\n", runErr)
		return 1
	}

	if a.asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(swarmToJSON(res, a)); err != nil {
			fmt.Fprintf(os.Stderr, "swarm: encode json: %v\n", err)
			return 1
		}
		return 0
	}

	// Human summary.
	fmt.Printf("task:     %s\n", res.Task)
	fmt.Printf("subtasks: %d (workers=%d, provider=%s, km=%t)\n", len(res.Subtasks), a.workers, a.provider, a.km)
	fmt.Printf("verdict:  %s by %s — %s\n", verifiedWord(res.Verified), res.Verdict.By, res.Verdict.Notes)
	if res.Answer != "" {
		fmt.Printf("answer:   %s\n", res.Answer)
	}
	fmt.Printf("cost:     $%.6f  in=%d out=%d cached=%d  bees=%d\n",
		res.Cost.USD, res.Cost.InputTokens, res.Cost.OutputTokens, res.Cost.CachedTokens, len(res.Cost.Bees))
	if len(res.Degraded) > 0 {
		fmt.Printf("degraded: %s\n", strings.Join(res.Degraded, ", "))
	}
	fmt.Printf("ledger:   %s\n", ledgerPath)
	return 0
}

func verifiedWord(v bool) string {
	if v {
		return "verified"
	}
	return "rejected"
}

// ── agix.swarm.v1 wire contract ────────────────────────────────────────────
// A CLI-local view of swarm.Result, frozen to the exact field names + order the
// study arm and Comb pieces consume. Kept separate from swarm.BeeCost so the
// library types stay free to evolve behind this stable surface.

type swarmJSON struct {
	Schema   string          `json:"schema"`
	Task     string          `json:"task"`
	Answer   string          `json:"answer"`
	Verified bool            `json:"verified"`
	Verdict  swarmVerdictOut `json:"verdict"`
	Cost     swarmCostOut    `json:"cost"`
	Bees     []swarmBeeOut   `json:"bees"`
	Config   swarmConfigOut  `json:"config"`
	Degraded []string        `json:"degraded"`
}

type swarmVerdictOut struct {
	Approved bool   `json:"approved"`
	By       string `json:"by"`
	Notes    string `json:"notes"`
}

type swarmCostOut struct {
	USD          float64 `json:"usd"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CachedTokens int     `json:"cached_tokens"`
	LatencyS     float64 `json:"latency_s"`
}

type swarmBeeOut struct {
	Actor    string  `json:"actor"`
	Role     string  `json:"role"`
	Phase    string  `json:"phase"`
	Model    string  `json:"model"`
	USD      float64 `json:"usd"`
	InTok    int     `json:"in_tok"`
	OutTok   int     `json:"out_tok"`
	LatencyS float64 `json:"latency_s"`
}

type swarmConfigOut struct {
	Provider       string   `json:"provider"`
	Workers        int      `json:"workers"`
	KM             bool     `json:"km"`
	Subtasks       int      `json:"subtasks"`
	QueenModel     string   `json:"queen_model"`
	WorkerModels   []string `json:"worker_models"`
	VerifyModel    string   `json:"verify_model"`
	MaxTokens      int      `json:"max_tokens"`       // per-slice output budget (decompose/worker/verify)
	SynthMaxTokens int      `json:"synth_max_tokens"` // the Queen's merge budget (the graded artifact)
}

func swarmToJSON(res swarm.Result, a swarmArgs) swarmJSON {
	bees := make([]swarmBeeOut, len(res.Cost.Bees))
	for i, b := range res.Cost.Bees {
		bees[i] = swarmBeeOut{
			Actor:    b.Actor,
			Role:     b.Role,
			Phase:    b.Phase,
			Model:    b.Model,
			USD:      b.Usage.CostUSD,
			InTok:    b.Usage.InputTokens,
			OutTok:   b.Usage.OutputTokens,
			LatencyS: b.LatencyS,
		}
	}
	degraded := res.Degraded
	if degraded == nil {
		degraded = []string{}
	}
	workerModels := a.workerModels
	if workerModels == nil {
		workerModels = []string{}
	}
	return swarmJSON{
		Schema:   "agix.swarm.v1",
		Task:     res.Task,
		Answer:   res.Answer,
		Verified: res.Verified,
		Verdict: swarmVerdictOut{
			Approved: res.Verdict.Approved,
			By:       res.Verdict.By,
			Notes:    res.Verdict.Notes,
		},
		Cost: swarmCostOut{
			USD:          res.Cost.USD,
			InputTokens:  res.Cost.InputTokens,
			OutputTokens: res.Cost.OutputTokens,
			CachedTokens: res.Cost.CachedTokens,
			LatencyS:     res.Cost.LatencyS,
		},
		Bees: bees,
		Config: swarmConfigOut{
			Provider:       a.provider,
			Workers:        a.workers,
			KM:             a.km, // true when --km wired a CombRetriever
			Subtasks:       len(res.Subtasks),
			QueenModel:     a.queenModel,
			WorkerModels:   workerModels,
			VerifyModel:    a.verifyModel,
			MaxTokens:      a.maxTokens,
			SynthMaxTokens: a.synthMaxTokens,
		},
		Degraded: degraded,
	}
}

// swarmArgs is the parsed swarm CLI invocation. Grouping the fields keeps the
// flag parser's many error paths from each having to spell out an 8-value tuple.
type swarmArgs struct {
	task        string
	provider    string
	workers     int
	concurrency int
	hive        string
	asJSON      bool
	km          bool   // --km: open the Comb and give workers governed KM
	kmDB        string // --km-db PATH: where the Comb lives (default defaultKMDBPath)

	// Explicit per-role model overrides (empty = capability default).
	queenModel   string   // --queen-model
	workerModels []string // --worker-models (comma-separated, round-robin)
	verifyModel  string   // --verify-model

	// Output-token budgets. maxTokens caps the per-slice calls (decompose,
	// worker forage, verify); synthMaxTokens caps the Queen's merge — the graded
	// artifact — and defaults higher so the merge is never starved.
	maxTokens      int // --max-tokens
	synthMaxTokens int // --synth-max-tokens
}

// splitModels parses a comma-separated model list, trimming whitespace and
// dropping empty entries (so "a, ,b," → ["a","b"]). Returns nil for an empty
// list so the swarm falls back to the capability default.
func splitModels(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseSwarmArgs pulls the positional (or --task) task plus flags in any order,
// mirroring the hand-rolled scheme used by parseRunArgs/parseFlowArgs.
func parseSwarmArgs(args []string) (swarmArgs, error) {
	a := swarmArgs{
		provider:       "mock",
		workers:        2,
		concurrency:    4,
		hive:           "agix",
		kmDB:           defaultKMDBPath,
		maxTokens:      1024, // mirrors swarm.withDefaults; kept explicit so config reflects it
		synthMaxTokens: 4096, // mirrors swarm.defaultSynthMaxTokens (the merge budget)
	}

	i := 0
	for i < len(args) {
		arg := args[i]
		switch {
		case arg == "--provider":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --provider needs a value")
			}
			a.provider, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--provider="):
			a.provider, i = strings.TrimPrefix(arg, "--provider="), i+1

		case arg == "--workers":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --workers needs a value")
			}
			w, err := strconv.Atoi(args[i+1])
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --workers must be an integer: %w", err)
			}
			a.workers, i = w, i+2
		case strings.HasPrefix(arg, "--workers="):
			w, err := strconv.Atoi(strings.TrimPrefix(arg, "--workers="))
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --workers must be an integer: %w", err)
			}
			a.workers, i = w, i+1

		case arg == "--concurrency":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --concurrency needs a value")
			}
			c, err := strconv.Atoi(args[i+1])
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --concurrency must be an integer: %w", err)
			}
			a.concurrency, i = c, i+2
		case strings.HasPrefix(arg, "--concurrency="):
			c, err := strconv.Atoi(strings.TrimPrefix(arg, "--concurrency="))
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --concurrency must be an integer: %w", err)
			}
			a.concurrency, i = c, i+1

		case arg == "--hive":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --hive needs a value")
			}
			a.hive, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--hive="):
			a.hive, i = strings.TrimPrefix(arg, "--hive="), i+1

		case arg == "--task":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --task needs a value")
			}
			a.task, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--task="):
			a.task, i = strings.TrimPrefix(arg, "--task="), i+1

		case arg == "--queen-model":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --queen-model needs a value")
			}
			a.queenModel, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--queen-model="):
			a.queenModel, i = strings.TrimPrefix(arg, "--queen-model="), i+1

		case arg == "--worker-models":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --worker-models needs a value")
			}
			a.workerModels, i = splitModels(args[i+1]), i+2
		case strings.HasPrefix(arg, "--worker-models="):
			a.workerModels, i = splitModels(strings.TrimPrefix(arg, "--worker-models=")), i+1

		case arg == "--verify-model":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --verify-model needs a value")
			}
			a.verifyModel, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--verify-model="):
			a.verifyModel, i = strings.TrimPrefix(arg, "--verify-model="), i+1

		case arg == "--max-tokens":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --max-tokens needs a value")
			}
			m, err := strconv.Atoi(args[i+1])
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --max-tokens must be an integer: %w", err)
			}
			a.maxTokens, i = m, i+2
		case strings.HasPrefix(arg, "--max-tokens="):
			m, err := strconv.Atoi(strings.TrimPrefix(arg, "--max-tokens="))
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --max-tokens must be an integer: %w", err)
			}
			a.maxTokens, i = m, i+1

		case arg == "--synth-max-tokens":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --synth-max-tokens needs a value")
			}
			m, err := strconv.Atoi(args[i+1])
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --synth-max-tokens must be an integer: %w", err)
			}
			a.synthMaxTokens, i = m, i+2
		case strings.HasPrefix(arg, "--synth-max-tokens="):
			m, err := strconv.Atoi(strings.TrimPrefix(arg, "--synth-max-tokens="))
			if err != nil {
				return swarmArgs{}, fmt.Errorf("swarm: --synth-max-tokens must be an integer: %w", err)
			}
			a.synthMaxTokens, i = m, i+1

		case arg == "--km":
			a.km, i = true, i+1

		case arg == "--km-db":
			if i+1 >= len(args) {
				return swarmArgs{}, fmt.Errorf("swarm: --km-db needs a value")
			}
			a.kmDB, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--km-db="):
			a.kmDB, i = strings.TrimPrefix(arg, "--km-db="), i+1

		case arg == "--json":
			a.asJSON, i = true, i+1

		case strings.HasPrefix(arg, "--"):
			return swarmArgs{}, fmt.Errorf("swarm: unknown flag %q", arg)

		default:
			if a.task == "" {
				a.task = arg
			}
			i++
		}
	}
	// Keep the emitted config honest: the library never lets the merge budget
	// fall below the per-slice budget, so mirror that floor here too.
	if a.synthMaxTokens < a.maxTokens {
		a.synthMaxTokens = a.maxTokens
	}
	return a, nil
}
