// Presentation layer for the `agix fleet` TUI — the colors and boxes the operator
// sees. The palette is the CLI brand's honey/gold (#e5a53f, the bee mark) tuned for
// a dark terminal, so the TUI reads as the same product as `agix` on the command
// line. Lipgloss degrades on its own when the terminal has no color, so there is no
// hand-rolled NO_COLOR branch here (unlike the CLI's ANSI paint() helper) — the
// Charm renderer handles capability detection.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import "github.com/charmbracelet/lipgloss"

// Brand palette. honey is the bee mark (#e5a53f); comb is the muted honeycomb used
// for secondary labels; dim/subtle carry the low-emphasis metadata.
var (
	honey  = lipgloss.Color("#e5a53f")
	comb   = lipgloss.Color("#c8944a")
	fg     = lipgloss.Color("#e6e6e6")
	dim    = lipgloss.Color("#8a8a8a")
	subtle = lipgloss.Color("#6b6b6b")
	danger = lipgloss.Color("#d16c5a")
	ok     = lipgloss.Color("#7fae5f")
)

// Layout + text styles. These are values, not a struct, because the layout is fixed
// for v1 (a left roster + a right detail pane) and the widths are supplied per-frame
// in View from the current window size.
var (
	// titleStyle is the honey header bar above the whole app.
	titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#1c1a12")).
			Background(honey).
			Bold(true).
			Padding(0, 1)

	// listBox / detailBox are the two panes; the selected pane border is honey.
	paneBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(subtle).
			Padding(0, 1)

	// selectedRow is the highlighted agent in the roster.
	selectedRow = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#1c1a12")).
			Background(honey).
			Bold(true)

	// row is an unselected agent name in the roster.
	rowName = lipgloss.NewStyle().Foreground(fg)

	// casteTag / trustTag are the compact per-row metadata.
	metaDim = lipgloss.NewStyle().Foreground(dim)

	// detail-pane text roles.
	detailName  = lipgloss.NewStyle().Foreground(honey).Bold(true)
	detailDesc  = lipgloss.NewStyle().Foreground(fg)
	fieldLabel  = lipgloss.NewStyle().Foreground(comb).Bold(true)
	fieldValue  = lipgloss.NewStyle().Foreground(fg)
	sectionRule = lipgloss.NewStyle().Foreground(subtle)
	instrText   = lipgloss.NewStyle().Foreground(lipgloss.Color("#c4c4c4"))

	footerStyle = lipgloss.NewStyle().Foreground(subtle).Padding(0, 1)
)

// casteColor tints the resolved caste so a queen/worker/drone reads at a glance.
func casteColor(c string) lipgloss.Color {
	switch c {
	case "queen":
		return honey
	case "drone":
		return danger
	default: // worker
		return ok
	}
}
