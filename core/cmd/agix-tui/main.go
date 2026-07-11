// Command agix-tui is the `agix fleet` terminal UI: a read-only browser over the
// reborn agent fleet. It discovers the declarative specs under an agents/ tree and
// presents a two-pane inspector — a roster on the left, the selected agent's full
// contract (identity, role/trust/caste, tools, guard-bee boundary, and the behavioral
// instructions) on the right.
//
//	agix-tui [dir]        # browse the fleet under dir (default: ./agents)
//	agix-tui --smoke [dir] # build the model from dir, print the agent count, exit
//
// This binary lives in its OWN nested Go module (see go.mod) so the Charm UI
// dependency tree never touches the born-clean, stdlib-only core module. It is meant
// to be exec'd by the `agix` wrapper as `agix fleet` (see the follow-up wiring note in
// the module's build report); on disk it is `agix-tui`, mirroring the agix-core split.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	dir := "agents"
	smoke := false
	for _, a := range os.Args[1:] {
		switch a {
		case "--smoke":
			smoke = true
		case "-h", "--help":
			fmt.Fprint(os.Stdout, usage)
			return
		default:
			if len(a) > 0 && a[0] == '-' {
				fmt.Fprintf(os.Stderr, "agix-tui: unknown flag %q\n%s", a, usage)
				os.Exit(2)
			}
			dir = a
		}
	}

	m, err := newModel(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agix-tui: %v\n", err)
		os.Exit(1)
	}

	// --smoke is the headless proof: a TUI can't be driven in CI, so this path builds
	// the SAME initial model from the real agents/ dir, reports how many agents it
	// discovered, and exits 0 without ever starting the Bubble Tea program. It is the
	// verifiable "the program constructs and loads the fleet" check.
	if smoke {
		fmt.Printf("agix fleet: discovered %d agents under %s\n", len(m.specs), dir)
		return
	}

	// AltScreen gives the TUI its own buffer so quitting restores the operator's
	// scrollback intact. Bubble Tea sends a WindowSizeMsg on start, which seeds the
	// first real frame.
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "agix-tui: %v\n", err)
		os.Exit(1)
	}
}

const usage = `agix fleet — browse the reborn agent fleet

  agix-tui [dir]          browse the fleet under dir (default: ./agents)
  agix-tui --smoke [dir]  print the discovered agent count and exit (headless check)

keys: ↑/↓ or j/k move · g/G top/bottom · q quit
`
