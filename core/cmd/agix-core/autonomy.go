// The autonomy verb: inspect and drive the earned-autonomy ladder (core/autonomy)
// that gates the OSS-steward fleet's host-drone. Autonomy is earned per DOMAIN
// (issue-label, pr-comment, changelog, dep-merge, release…) and every domain
// starts at Shadow — nothing acts until it has been earned.
//
//	agix-core autonomy status                     # rung per domain (from the ledger file)
//	agix-core autonomy gate <domain> <rung>       # would an action at <rung> be allowed? (exit 0/3)
//	agix-core autonomy observe <domain> accept|reject   # apply one outcome, persist, print new rung
//
// This command owns the DURABILITY seam core/autonomy deliberately leaves out (so
// that package stays a pure stdlib leaf): it replays the JSONL ledger to seed the
// in-memory ledger on start, and appends one record per observe. The default file
// is governance/tenants/agix/autonomy.jsonl, alongside the audit ledger.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/agix-ai/agix/core/autonomy"
)

const defaultAutonomyLedger = "governance/tenants/agix/autonomy.jsonl"

// splitLedgerFlag pulls the optional --ledger flag out of args in ANY position
// (stdlib flag requires flags-before-positionals; the fleet's CLIs hand-roll this
// so `autonomy gate issue-label act --ledger x` works too) and returns it plus the
// remaining positional args.
func splitLedgerFlag(args []string) (path string, rest []string, err error) {
	path = defaultAutonomyLedger
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--ledger":
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("autonomy: --ledger needs a value")
			}
			path = args[i+1]
			i++
		case strings.HasPrefix(a, "--ledger="):
			path = strings.TrimPrefix(a, "--ledger=")
		case strings.HasPrefix(a, "--"):
			return "", nil, fmt.Errorf("autonomy: unknown flag %q", a)
		default:
			rest = append(rest, a)
		}
	}
	return path, rest, nil
}

func cmdAutonomy(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "autonomy: need a subcommand (status|gate|observe)")
		return 2
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "status":
		return cmdAutonomyStatus(rest)
	case "gate":
		return cmdAutonomyGate(rest)
	case "observe":
		return cmdAutonomyObserve(rest)
	default:
		fmt.Fprintf(os.Stderr, "autonomy: unknown subcommand %q (status|gate|observe)\n", sub)
		return 2
	}
}

// loadLedger replays the JSONL file (last record per domain wins) and seeds a
// MemLedger. A missing file is not an error — it means every domain is at Shadow.
// The returned close func appends new observations to the same file.
func loadLedger(path string) (*autonomy.MemLedger, func(autonomy.State), error) {
	byDomain := map[autonomy.Domain]autonomy.State{}
	f, err := os.Open(path)
	if err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var s autonomy.State
			if json.Unmarshal(line, &s) == nil && s.Domain != "" {
				byDomain[s.Domain] = s // last line wins
			}
		}
		f.Close()
		if scErr := sc.Err(); scErr != nil {
			return nil, nil, fmt.Errorf("autonomy: read ledger %s: %w", path, scErr)
		}
	} else if !os.IsNotExist(err) {
		return nil, nil, fmt.Errorf("autonomy: open ledger %s: %w", path, err)
	}

	seed := make([]autonomy.State, 0, len(byDomain))
	for _, s := range byDomain {
		seed = append(seed, s)
	}

	appendRec := func(s autonomy.State) {
		if mkErr := os.MkdirAll(filepath.Dir(path), 0o755); mkErr != nil {
			fmt.Fprintf(os.Stderr, "autonomy: persist: %v\n", mkErr)
			return
		}
		out, mErr := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if mErr != nil {
			fmt.Fprintf(os.Stderr, "autonomy: persist: %v\n", mErr)
			return
		}
		defer out.Close()
		b, _ := json.Marshal(s)
		fmt.Fprintln(out, string(b))
	}

	led := autonomy.NewMemLedger(autonomy.Ladder{}, func(s autonomy.State, _ bool) { appendRec(s) })
	led.Seed(seed...)
	return led, appendRec, nil
}

func cmdAutonomyStatus(args []string) int {
	path, rest, err := splitLedgerFlag(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(rest) != 0 {
		fmt.Fprintf(os.Stderr, "autonomy status: unexpected arguments %v\n", rest)
		return 2
	}
	led, _, err := loadLedger(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	snap, _ := led.Snapshot(context.Background())
	if len(snap) == 0 {
		fmt.Printf("autonomy: no domains recorded yet (every domain defaults to shadow)  [%s]\n", path)
		return 0
	}
	fmt.Printf("autonomy ledger (%s):\n", path)
	fmt.Printf("  %-18s %-8s %-7s %s\n", "DOMAIN", "RUNG", "STREAK", "DEMOTIONS")
	for _, s := range snap {
		fmt.Printf("  %-18s %-8s %-7d %d\n", s.Domain, s.Rung, s.Streak, s.Demotions)
	}
	return 0
}

// cmdAutonomyGate answers the drone's question before a write: is an action that
// requires <rung> allowed for <domain>? Exit 0 = allowed, 3 = denied (a distinct
// non-2/1 code so a caller can branch on "denied" vs "usage/error").
func cmdAutonomyGate(args []string) int {
	path, rem, err := splitLedgerFlag(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(rem) != 2 {
		fmt.Fprintln(os.Stderr, "autonomy gate: need <domain> <rung>")
		return 2
	}
	domain := autonomy.Domain(rem[0])
	want, err := autonomy.ParseRung(rem[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	led, _, err := loadLedger(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	st, _ := led.Rung(context.Background(), domain)
	if st.Allows(want) {
		fmt.Printf("allowed: %s may act at %s (earned rung: %s)\n", domain, want, st.Rung)
		return 0
	}
	fmt.Printf("denied: %s has not earned %s (earned rung: %s)\n", domain, want, st.Rung)
	return 3
}

func cmdAutonomyObserve(args []string) int {
	path, rem, err := splitLedgerFlag(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(rem) != 2 {
		fmt.Fprintln(os.Stderr, "autonomy observe: need <domain> accept|reject")
		return 2
	}
	domain := autonomy.Domain(rem[0])
	var accepted bool
	switch rem[1] {
	case "accept", "accepted", "true":
		accepted = true
	case "reject", "rejected", "false":
		accepted = false
	default:
		fmt.Fprintf(os.Stderr, "autonomy observe: outcome must be accept|reject (got %q)\n", rem[1])
		return 2
	}
	led, _, err := loadLedger(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	st, err := led.Observe(context.Background(), domain, accepted)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	outcome := "accepted"
	if !accepted {
		outcome = "rejected"
	}
	fmt.Printf("observed %s on %s -> rung=%s streak=%d demotions=%d  [%s]\n",
		outcome, domain, st.Rung, st.Streak, st.Demotions, path)
	return 0
}
