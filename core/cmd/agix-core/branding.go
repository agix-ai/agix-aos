// Presentation layer for the agix CLI — the logo, colors, and name the user sees.
//
// The binary on disk is `agix-core` and lives in libexec; the user always invokes it
// through the thin `agix` wrapper on PATH. So everything user-facing presents as `agix`,
// never `agix-core`. Color is emitted ONLY when stdout is a real terminal and NO_COLOR is
// unset (so pipes, CI, and `brew test` get clean, parseable text).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import "os"

// appName is how the CLI refers to itself in all help/usage/error text.
const appName = "agix"

// tagline is the one-line descriptor under the logo.
const tagline = "the agentic operating system"

// ── color ────────────────────────────────────────────────────────────────────────────

const (
	cReset = "\033[0m"
	cBold  = "\033[1m"
	cDim   = "\033[2m"
	cHoney = "\033[38;5;214m" // brand honey/gold — the bee mark
	cComb  = "\033[38;5;179m" // muted honeycomb
)

// colorOn reports whether we should emit ANSI. True only for an interactive stdout with
// NO_COLOR unset and a real TERM — pipes/redirects/CI/`brew test` get plain text.
func colorOn() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if t := os.Getenv("TERM"); t == "" || t == "dumb" {
		return false
	}
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// paint wraps s in code…reset iff color is on.
func paint(code, s string) string {
	if !colorOn() {
		return s
	}
	return code + s + cReset
}

// ── logo ─────────────────────────────────────────────────────────────────────────────

// logo is the AGIX wordmark with a honeycomb mark. Half-block glyphs keep it compact and
// monospace-clean; honey-gold when color is on.
func logo() string {
	l1 := "  ⬡  ▄▀█ █▀▀ █ ▀▄▀"
	l2 := "     █▀█ █▄█ █ █ █"
	if colorOn() {
		l1 = cHoney + cBold + l1 + cReset
		l2 = cHoney + cBold + l2 + cReset
	}
	return l1 + "\n" + l2
}

// banner is the logo + tagline + version line, used for `version` and bare/`help` output.
func banner() string {
	return logo() + "  " + paint(cDim, tagline) + "\n" +
		"     " + paint(cComb, appName+" "+version+" · beta") + "\n"
}
