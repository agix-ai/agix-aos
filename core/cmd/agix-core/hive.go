package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/agix-ai/agix/core/hivekit"
	"github.com/agix-ai/agix/core/ledger"
)

// RunHiveCLI is the `hive` subcommand — the ADK front door. Where `swarm` calls
// swarm.Run with an explicit Options struct, `hive` drives the same governed run
// through the fluent hivekit builder, so the CLI dogfoods the developer kit the
// public will use. It prints the guaranteed-distinct verifier actor (the
// actor≠verifier proof), the verdict, the answer, and the cost rollup.
//
//	agix-core hive "<task>" [--provider mock] [--workers N] [--hive NAME]
//	  [--queen ID] [--worker-models ID1,ID2,...] [--verifier ID]
//
// Zero-cost and offline on the default mock provider (no key, no network).
func RunHiveCLI(args []string) int {
	a, err := parseHiveArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if a.task == "" {
		fmt.Fprintln(os.Stderr, `hive: need a task, e.g. agix-core hive "add a login page" --workers 3`)
		return 2
	}

	led, err := ledger.Open(ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "hive: open ledger: %v\n", err)
		return 1
	}

	// Assemble the hive through the ADK builder (per-role tiering, distinct
	// verifier, $0/offline default) rather than hand-filling swarm.Options.
	hive := hivekit.New().
		Named(a.hive).
		Provider(a.provider).
		Workers(a.workers, a.workerModels...).
		Queen(a.queenModel).
		Verifier(a.verifyModel).
		Ledger(led)

	res, runErr := hive.Run(context.Background(), a.task)
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "hive: %v\n", runErr)
		return 1
	}

	fmt.Printf("task:     %s\n", res.Task)
	fmt.Printf("subtasks: %d (workers=%d, provider=%s, hive=%s)\n", len(res.Subtasks), a.workers, a.provider, a.hive)
	// The distinct verifier is a first-class, inspectable property of the hive.
	fmt.Printf("verifier: %s (actor≠verifier; queen=%s)\n", hive.VerifierActor(), hive.QueenActor())
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

// hiveArgs is the parsed `hive` invocation — a lean subset of the swarm flags,
// enough to demonstrate per-role tiering through the builder.
type hiveArgs struct {
	task         string
	provider     string
	workers      int
	hive         string
	queenModel   string
	workerModels []string
	verifyModel  string
}

// parseHiveArgs pulls the positional (or --task) task plus flags in any order,
// mirroring the hand-rolled scheme used by parseSwarmArgs.
func parseHiveArgs(args []string) (hiveArgs, error) {
	a := hiveArgs{provider: "mock", workers: 2, hive: "agix"}
	i := 0
	for i < len(args) {
		arg := args[i]
		switch {
		case arg == "--provider":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --provider needs a value")
			}
			a.provider, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--provider="):
			a.provider, i = strings.TrimPrefix(arg, "--provider="), i+1

		case arg == "--workers":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --workers needs a value")
			}
			w, err := strconv.Atoi(args[i+1])
			if err != nil {
				return hiveArgs{}, fmt.Errorf("hive: --workers must be an integer: %w", err)
			}
			a.workers, i = w, i+2
		case strings.HasPrefix(arg, "--workers="):
			w, err := strconv.Atoi(strings.TrimPrefix(arg, "--workers="))
			if err != nil {
				return hiveArgs{}, fmt.Errorf("hive: --workers must be an integer: %w", err)
			}
			a.workers, i = w, i+1

		case arg == "--hive":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --hive needs a value")
			}
			a.hive, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--hive="):
			a.hive, i = strings.TrimPrefix(arg, "--hive="), i+1

		case arg == "--task":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --task needs a value")
			}
			a.task, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--task="):
			a.task, i = strings.TrimPrefix(arg, "--task="), i+1

		case arg == "--queen":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --queen needs a value")
			}
			a.queenModel, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--queen="):
			a.queenModel, i = strings.TrimPrefix(arg, "--queen="), i+1

		case arg == "--worker-models":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --worker-models needs a value")
			}
			a.workerModels, i = splitModels(args[i+1]), i+2
		case strings.HasPrefix(arg, "--worker-models="):
			a.workerModels, i = splitModels(strings.TrimPrefix(arg, "--worker-models=")), i+1

		case arg == "--verifier":
			if i+1 >= len(args) {
				return hiveArgs{}, fmt.Errorf("hive: --verifier needs a value")
			}
			a.verifyModel, i = args[i+1], i+2
		case strings.HasPrefix(arg, "--verifier="):
			a.verifyModel, i = strings.TrimPrefix(arg, "--verifier="), i+1

		case strings.HasPrefix(arg, "--"):
			return hiveArgs{}, fmt.Errorf("hive: unknown flag %q", arg)

		default:
			if a.task == "" {
				a.task = arg
			}
			i++
		}
	}
	return a, nil
}
