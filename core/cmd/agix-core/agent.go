package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/secrets"
)

// cmdAgent is the `agent` verb — the reborn fleet front door. It loads a
// declarative agent spec (agents/<name>/agent.json) and runs it as a governed
// hive through fleet.Runner, so the CLI dogfoods the exact contract + runner the
// fleet port is built on.
//
//	agix agent list [--dir agents] [--public-only]
//	agix agent run <name> "<task>" [--dir agents] [--provider mock] [--public-only]
//
// Zero-cost and offline on the default mock provider (no key, no network).
func cmdAgent(args []string) int {
	if len(args) == 0 {
		agentUsage()
		return 2
	}
	switch args[0] {
	case "list":
		return cmdAgentList(args[1:])
	case "run":
		return cmdAgentRun(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "agent: unknown subcommand %q\n", args[0])
		agentUsage()
		return 2
	}
}

func agentUsage() {
	fmt.Fprint(os.Stderr, `agix agent — run a reborn agent (manifest + governed hive)

usage:
  agix agent list [--dir agents] [--public-only]
  agix agent run <name> "<task>" [--dir agents] [--provider mock|anthropic|openai|gemini|local]
      [--repoRoot <dir>] [--public-only] [--json] [--engine] [--attest] [--comb <db>]

An agent is a manifest (agent.json — governance metadata this binary reads) plus,
optionally, a TypeScript behavior file (agent.ts, run on Bun). When agent.ts is
present, "agent run" DELEGATES to the Bun runner (the behavior/orchestration
layer); each governed unit of work the behavior triggers calls back into THIS
binary with --engine, which runs the declarative governed hive (actor≠verifier)
and never re-enters Bun. Flags:
  --engine   force the declarative governed path; never delegate to Bun (the
             governance primitive the TS behavior layer calls back into).
  --json     emit the governed RunResult as JSON (the TS↔Go seam contract).
  --repoRoot the target tree the built-in filesystem/metric tools are scoped to
             (the sidecar seam); defaults to the current directory. Every
             read/glob/grep/walk/write/metric call resolves under it and cannot
             escape, further constrained by the agent's boundary.
  --attest   turn on the flywheel WRITE side: record the run's certified artifact
             into the Comb (~/.agix/km.db) under the attestation policy — an
             externally grounded verdict auto-attests; a judgment-only verdict is
             held pending a human co-sign (agix km cosign). Auto-attestation
             requires the run's verifier actor to be on AGIX_KM_VERIFIERS.
  --comb DB  attest into the store at DB (implies --attest).
`)
}

// cmdAgentList discovers every reborn spec under the agents dir and prints its
// identity, resolved caste, trust, distribution, and declared tools.
func cmdAgentList(args []string) int {
	f, err := parseAgentFlags(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(f.rest) > 0 {
		fmt.Fprintf(os.Stderr, "agent list: unexpected argument %q\n", f.rest[0])
		return 2
	}
	publicOnly := f.publicOnly
	specs, err := agentspec.Discover(f.dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent list: %v\n", err)
		return 1
	}
	if len(specs) == 0 {
		fmt.Printf("no reborn agents found under %s (an agent is ported when it has an %s)\n", f.dir, agentspec.SpecFileName)
		return 0
	}
	for _, s := range specs {
		if publicOnly && !s.Public {
			continue
		}
		dist := "proprietary"
		if s.Public {
			dist = "public"
		}
		tools := "-"
		if len(s.Tools) > 0 {
			tools = strings.Join(s.Tools, ",")
		}
		fmt.Printf("%-14s caste=%-6s trust=%-9s %s/%s  tools=%s\n",
			s.Name, s.ResolveCaste(), orDash(s.Trust), s.Tier, dist, tools)
	}
	return 0
}

// cmdAgentRun is the fleet front door. It loads one named spec and, unless the
// caller forced --engine, DELEGATES to the Bun runner when the agent carries a
// TypeScript behavior file (agent.ts) — the behavior/orchestration layer runs on
// Bun and calls back into --engine for each governed unit of work. With --engine
// (or when there is no agent.ts, or Bun is unavailable) it runs the declarative
// governed hive here in Go: the queen decomposes, workers forage, the queen
// synthesizes, and a DISTINCT verifier certifies (actor≠verifier). It prints the
// verifier (the actor≠verifier proof), the verdict, the answer, the guard-bee
// boundary decisions, any unresolved tools, and the cost — or the same as JSON
// with --json (the TS↔Go seam contract).
func cmdAgentRun(args []string) int {
	f, err := parseAgentFlags(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	dir, provider, publicOnly, jsonOut, engineOnly := f.dir, f.provider, f.publicOnly, f.jsonOut, f.engineOnly
	if len(f.rest) < 1 {
		fmt.Fprintln(os.Stderr, `agent run: need an agent name, e.g. agix agent run investigator "the build is red"`)
		return 2
	}
	// Fail loud on a supplied-but-missing --repoRoot before anything runs (the
	// live-run safety seam): the built-in fs/exec/metric tools are scoped to it, and
	// an empty RepoRoot legitimately defaults to CWD downstream — so a bad path must
	// refuse here, never silently scope a governed write/refactor to the wrong tree.
	if err := validateRepoRoot(f.repoRoot); err != nil {
		fmt.Fprintf(os.Stderr, "agent run: %v\n", err)
		return 2
	}

	name := f.rest[0]
	task := strings.TrimSpace(strings.Join(f.rest[1:], " "))
	if task == "" {
		task = "Run your default pass and report."
	}

	spec, err := agentspec.LoadName(dir, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent run: %v\n", err)
		return 1
	}

	// Behavior-layer delegation. When the agent has a TypeScript behavior file
	// and the caller did not force the declarative engine, hand off to the Bun
	// runner. This is the ONE place Go crosses into Bun; the Bun runner drives
	// orchestration and calls back with --engine (which lands below, never here),
	// so the hop is non-recursive by construction.
	if !engineOnly {
		if tsPath := agentTSPath(dir, name); tsPath != "" {
			if code, delegated := delegateToBun(dir, name, provider, task, f.repoRoot, jsonOut, publicOnly); delegated {
				return code
			}
			// Bun unavailable → honest degrade to the declarative governed path.
			fmt.Fprintf(os.Stderr, "agent run: %q has a TypeScript behavior (%s) but Bun is unavailable; running the declarative governed hive (--engine)\n", name, tsPath)
		}
	}

	led, err := ledger.Open(ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent run: open ledger: %v\n", err)
		return 1
	}

	runner := fleet.New()
	runner.Provider = provider
	runner.Ledger = led
	runner.PublicOnly = publicOnly
	runner.RepoRoot = f.repoRoot // scope the built-in fs/metric tools to the sidecar
	// Wire the guard-bee vault so a credentialed exec tool (a `gh` command wanting
	// GH_TOKEN) can receive its secret via a scoped grant. Construction performs no
	// backend call; a ref only resolves if an exec command actually runs with an
	// authorized grant, and it degrades to unauthenticated when the store has no value.
	if vault, verr := secrets.NewVault(); verr == nil {
		runner.Vault = vault
	}

	// Flywheel WRITE side (opt-in): with --attest, wire the Comb so a completed run
	// records its certified artifact under the attestation policy — externally
	// grounded → attested, judgment-only → pending human co-sign. The trusted-
	// verifier roster is seeded from AGIX_KM_VERIFIERS (the runner honors it), so a
	// run only auto-attests when the operator has named its verifier actor.
	if f.attest {
		st, err := kmstore.Open(f.attestDB)
		if err != nil {
			fmt.Fprintf(os.Stderr, "agent run: open Comb %s: %v\n", f.attestDB, err)
			return 1
		}
		defer st.Close()
		runner.Comb = st
	}

	res, runErr := runner.Run(context.Background(), spec, task)
	if runErr != nil {
		if jsonOut {
			emitRunError(runErr)
		} else {
			fmt.Fprintf(os.Stderr, "agent run: %v\n", runErr)
		}
		return 1
	}

	if jsonOut {
		return emitRunJSON(spec, res)
	}

	fmt.Printf("agent:    %s (%s) caste=%s trust=%s\n", spec.Name, spec.DisplayName, res.Caste, orDash(spec.Trust))
	fmt.Printf("verifier: %s (actor≠verifier; queen=%s)\n", res.VerifierActor, res.QueenActor)
	fmt.Printf("verdict:  %s by %s — %s\n", verifiedWord(res.Result.Verified), res.Result.Verdict.By, res.Result.Verdict.Notes)
	if res.Result.Answer != "" {
		fmt.Printf("answer:   %s\n", res.Result.Answer)
	}
	if len(res.Tools) > 0 {
		fmt.Printf("tools:    %s\n", strings.Join(res.Tools, ", "))
	}
	if len(res.UnresolvedTools) > 0 {
		fmt.Printf("unported: %s (declared, no reborn tool yet)\n", strings.Join(res.UnresolvedTools, ", "))
	}
	for _, b := range res.Boundary {
		fmt.Printf("boundary: %s → %s (%s, %s)\n", b.Ref, allowWord(b.Allowed), b.Role, b.Source)
	}
	fmt.Printf("cost:     $%.6f  in=%d out=%d  bees=%d\n",
		res.Result.Cost.USD, res.Result.Cost.InputTokens, res.Result.Cost.OutputTokens, len(res.Result.Cost.Bees))
	if f.attest {
		fmt.Printf("attest:   grounding=%s attested=%t pending_cosign=%t — %s\n",
			orDash(res.Result.Verdict.Grounding), res.Attestation.Attested, res.Attestation.PendingCosign, res.Attestation.Reason)
	}
	fmt.Printf("ledger:   %s\n", ledgerPath)
	return 0
}

// runJSON is the machine-readable governed result — the exact contract the Bun
// runner parses over a --json invocation. It surfaces the two governance facts a
// reviewer (and the TS-side actor≠verifier tripwire) checks: the distinct verifier
// and the graded verdict, alongside the answer, cost, boundary, and unresolved
// tools.
type runJSON struct {
	Agent           string        `json:"agent"`
	Caste           string        `json:"caste"`
	Trust           string        `json:"trust"`
	Verified        bool          `json:"verified"`
	Verdict         verdictJSON   `json:"verdict"`
	Answer          string        `json:"answer"`
	QueenActor      string        `json:"queen_actor"`
	VerifierActor   string        `json:"verifier_actor"`
	Tools           []string      `json:"tools"`
	UnresolvedTools []string      `json:"unresolved_tools"`
	Boundary        []grantJSON   `json:"boundary"`
	Cost            costJSON      `json:"cost"`
	Subtasks        []subtaskJSON `json:"subtasks"`
	Degraded        []string      `json:"degraded"`
}

type verdictJSON struct {
	Approved bool   `json:"approved"`
	By       string `json:"by"`
	Notes    string `json:"notes"`
}

type grantJSON struct {
	Ref     string `json:"ref"`
	Allowed bool   `json:"allowed"`
	Source  string `json:"source"`
}

type costJSON struct {
	USD          float64 `json:"usd"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	Bees         int     `json:"bees"`
}

type subtaskJSON struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// emitRunJSON marshals a governed RunResult to the seam contract on stdout.
func emitRunJSON(spec *agentspec.Spec, res fleet.RunResult) int {
	out := runJSON{
		Agent:         spec.Name,
		Caste:         string(res.Caste),
		Trust:         spec.Trust,
		Verified:      res.Result.Verified,
		Verdict:       verdictJSON{Approved: res.Result.Verdict.Approved, By: res.Result.Verdict.By, Notes: res.Result.Verdict.Notes},
		Answer:        res.Result.Answer,
		QueenActor:    res.QueenActor,
		VerifierActor: res.VerifierActor,
		Tools:         res.Tools,
		Cost:          costJSON{USD: res.Result.Cost.USD, InputTokens: res.Result.Cost.InputTokens, OutputTokens: res.Result.Cost.OutputTokens, Bees: len(res.Result.Cost.Bees)},
		Degraded:      res.Result.Degraded,
	}
	out.UnresolvedTools = append(out.UnresolvedTools, res.UnresolvedTools...)
	for _, b := range res.Boundary {
		out.Boundary = append(out.Boundary, grantJSON{Ref: b.Ref, Allowed: b.Allowed, Source: b.Source})
	}
	for _, s := range res.Result.Subtasks {
		out.Subtasks = append(out.Subtasks, subtaskJSON{ID: s.ID, Title: s.Title})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "agent run: encode json: %v\n", err)
		return 1
	}
	return 0
}

// emitRunError writes a seam-shaped error object to stdout so the Bun runner can
// parse a governed failure the same way it parses success.
func emitRunError(err error) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]string{"error": err.Error()})
}

// agentTSPath returns <dir>/<name>/agent.ts if it exists, else "". Its presence is
// the sole signal that an agent carries a TypeScript behavior layer.
func agentTSPath(dir, name string) string {
	p := filepath.Join(dir, name, "agent.ts")
	if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
		return p
	}
	return ""
}

// delegateToBun runs the Bun behavior runner for a TS agent, streaming its
// output through, and reports (exitCode, delegated). delegated is false only when
// Bun or the fleet CLI cannot be located, so the caller can degrade to the
// declarative path. The Bun runner calls back with `agent run <name> --engine`,
// which lands on the declarative path in-process — the hop never recurses.
func delegateToBun(dir, name, provider, task, repoRoot string, jsonOut, publicOnly bool) (int, bool) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		return 0, false
	}
	cli := resolveFleetCLI(dir)
	if cli == "" {
		return 0, false
	}
	argv := []string{cli, "run", name, "--dir", dir, "--provider", provider}
	if repoRoot != "" {
		argv = append(argv, "--repoRoot", repoRoot)
	}
	if jsonOut {
		argv = append(argv, "--json")
	}
	if publicOnly {
		argv = append(argv, "--public-only")
	}
	if task != "" {
		argv = append(argv, task)
	}
	cmd := exec.Command(bun, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), true
		}
		fmt.Fprintf(os.Stderr, "agent run: bun runner failed: %v\n", err)
		return 1, true
	}
	return 0, true
}

// resolveFleetCLI locates the Bun fleet runner entrypoint. AGIX_FLEET_CLI wins;
// otherwise it probes the conventional fleet/runtime/cli.ts relative to the CWD
// and to the agents dir's parent (so it resolves whether the binary runs from the
// repo root or from a nested working dir). Empty means "not found" → degrade.
func resolveFleetCLI(dir string) string {
	if p := strings.TrimSpace(os.Getenv("AGIX_FLEET_CLI")); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	candidates := []string{
		filepath.Join("fleet", "runtime", "cli.ts"),
		filepath.Join(filepath.Dir(strings.TrimRight(dir, string(os.PathSeparator))), "fleet", "runtime", "cli.ts"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// agentFlags is the parsed shared flag set for the agent verbs.
type agentFlags struct {
	dir        string
	provider   string
	repoRoot   string
	publicOnly bool
	jsonOut    bool
	engineOnly bool
	attest     bool   // wire the Comb write side (attest the run's certified artifact)
	attestDB   string // Comb store path (default ~/.agix/km.db)
	rest       []string
}

// parseAgentFlags pulls the shared --dir/--provider/--repoRoot/--public-only/--json/
// --engine flags in any order and returns them plus the remaining positional args.
func parseAgentFlags(args []string) (agentFlags, error) {
	f := agentFlags{dir: "agents", provider: "mock", attestDB: defaultDBPath()}
	i := 0
	for i < len(args) {
		arg := args[i]
		needsValue := func() (string, bool) {
			if i+1 >= len(args) {
				return "", false
			}
			return args[i+1], true
		}
		switch {
		case arg == "--attest":
			f.attest, i = true, i+1
		case arg == "--comb":
			v, ok := needsValue()
			if !ok {
				return agentFlags{}, fmt.Errorf("agent: --comb needs a store path")
			}
			f.attest, f.attestDB, i = true, v, i+2
		case strings.HasPrefix(arg, "--comb="):
			f.attest, f.attestDB, i = true, strings.TrimPrefix(arg, "--comb="), i+1
		case arg == "--dir":
			v, ok := needsValue()
			if !ok {
				return agentFlags{}, fmt.Errorf("agent: --dir needs a value")
			}
			f.dir, i = v, i+2
		case strings.HasPrefix(arg, "--dir="):
			f.dir, i = strings.TrimPrefix(arg, "--dir="), i+1
		case arg == "--provider":
			v, ok := needsValue()
			if !ok {
				return agentFlags{}, fmt.Errorf("agent: --provider needs a value")
			}
			f.provider, i = v, i+2
		case strings.HasPrefix(arg, "--provider="):
			f.provider, i = strings.TrimPrefix(arg, "--provider="), i+1
		case arg == "--repoRoot":
			v, ok := needsValue()
			if !ok {
				return agentFlags{}, fmt.Errorf("agent: --repoRoot needs a value")
			}
			f.repoRoot, i = v, i+2
		case strings.HasPrefix(arg, "--repoRoot="):
			f.repoRoot, i = strings.TrimPrefix(arg, "--repoRoot="), i+1
		case arg == "--public-only":
			f.publicOnly, i = true, i+1
		case arg == "--json":
			f.jsonOut, i = true, i+1
		case arg == "--engine":
			f.engineOnly, i = true, i+1
		case strings.HasPrefix(arg, "--"):
			return agentFlags{}, fmt.Errorf("agent: unknown flag %q", arg)
		default:
			f.rest = append(f.rest, arg)
			i++
		}
	}
	return f, nil
}

func allowWord(ok bool) string {
	if ok {
		return "ALLOW"
	}
	return "DENY"
}

// validateRepoRoot enforces the --repoRoot live-run safety contract: an empty value
// (flag unset) is allowed and defaults to the current working directory downstream,
// but a SUPPLIED root that does not exist or is not a directory is a hard error —
// the built-in filesystem/exec/metric tools are scoped to it, and silently falling
// back to CWD would let a governed write or structural refactor target the wrong
// tree (the surgeon editing the current dir instead of the sidecar's repo/).
func validateRepoRoot(repoRoot string) error {
	p := strings.TrimSpace(repoRoot)
	if p == "" {
		return nil
	}
	fi, err := os.Stat(p)
	if err != nil {
		return fmt.Errorf("--repoRoot %q does not exist (refusing to fall back to CWD): %w", repoRoot, err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("--repoRoot %q is not a directory (refusing to fall back to CWD)", repoRoot)
	}
	return nil
}
