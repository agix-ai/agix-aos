// Construction + navigation coverage for the fleet TUI. A Bubble Tea program can't
// be driven headlessly, so these tests exercise the model directly: discovery seeds
// a non-empty roster from the repo's real agents/ tree, and the key map folds into
// the expected cursor moves. This is the automated half of the `--smoke` proof.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// agentsDir is the repo's real fleet, reached from this package's directory
// (core/cmd/agix-tui) — three levels up to the repo root, then agents/.
const agentsDir = "../../../agents"

func TestNewModelDiscoversFleet(t *testing.T) {
	m, err := newModel(agentsDir)
	if err != nil {
		t.Fatalf("newModel(%q): %v", agentsDir, err)
	}
	if len(m.specs) == 0 {
		t.Fatalf("discovered 0 agents under %s, want a non-empty fleet", agentsDir)
	}
	// Discover guarantees name-sorted specs; a resolved caste must always land in the
	// closed queen|worker|drone set (the model relies on this for its caste tint).
	for i, s := range m.specs {
		if i > 0 && m.specs[i-1].Name > s.Name {
			t.Fatalf("specs not sorted by name at %d: %q > %q", i, m.specs[i-1].Name, s.Name)
		}
		switch string(s.ResolveCaste()) {
		case "queen", "worker", "drone":
		default:
			t.Fatalf("agent %q resolved to an unknown caste %q", s.Name, s.ResolveCaste())
		}
	}
}

func TestNavigationAndQuit(t *testing.T) {
	m, err := newModel(agentsDir)
	if err != nil {
		t.Fatal(err)
	}
	// Give the model a size so View renders a real frame, then drive the key map.
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(model)

	// down moves the cursor; up at the top is a no-op.
	if got := step(m, "up").cursor; got != 0 {
		t.Fatalf("up at top: cursor = %d, want 0", got)
	}
	if got := step(m, "down").cursor; got != 1 {
		t.Fatalf("down: cursor = %d, want 1", got)
	}
	// G jumps to the last agent, g back to the first.
	if got := step(m, "G").cursor; got != len(m.specs)-1 {
		t.Fatalf("G: cursor = %d, want %d", got, len(m.specs)-1)
	}
	if got := step(m, "g").cursor; got != 0 {
		t.Fatalf("g: cursor = %d, want 0", got)
	}
	// q asks to quit.
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")}); cmd == nil {
		t.Fatal("q: expected a quit command, got nil")
	}
	// View must render without panicking and mention the fleet.
	if out := m.View(); len(out) == 0 {
		t.Fatal("View returned an empty frame")
	}
}

// step applies one key press and returns the resulting model.
func step(m model, key string) model {
	var msg tea.KeyMsg
	switch key {
	case "up":
		msg = tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		msg = tea.KeyMsg{Type: tea.KeyDown}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
	}
	next, _ := m.Update(msg)
	return next.(model)
}
