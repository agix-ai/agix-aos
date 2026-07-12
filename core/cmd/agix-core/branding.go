// Presentation layer for the agix CLI — the logo, colors, and name the user sees.
//
// The binary on disk is `agix-core` and lives in libexec; the user always invokes it
// through the thin `agix` wrapper on PATH. So everything user-facing presents as `agix`,
// never `agix-core`. Color is emitted ONLY when stdout is a real terminal and NO_COLOR is
// unset (so pipes, CI, and `brew test` get clean, parseable text).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"os"
	"strings"
)

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

// combRows is the honeycomb-sheet mark (a little beehive comb). Plain ASCII so it tiles
// crisply in any monospace font; honey-gold when color is on. The AGIX wordmark rides the
// two middle rows (indices 2 and 3), drawn with half-block glyphs.
var (
	combRows = []string{
		" __    __    __",
		`/  \__/  \__/  \`,
		`\__/  \__/  \__/`,
		`/  \__/  \__/  \`,
		`\__/  \__/  \__/`,
	}
	wordmarkRows = []string{"▄▀█ █▀▀ █ ▀▄▀", "█▀█ █▄█ █ █ █"}
)

// hy paints s honey-gold + bold iff color is on.
func hy(s string) string {
	if colorOn() {
		return cHoney + cBold + s + cReset
	}
	return s
}

// renderMark composes the honeycomb + AGIX wordmark. With meta, the tagline and version line
// ride the wordmark's two rows.
func renderMark(meta bool) string {
	var b strings.Builder
	for i, row := range combRows {
		b.WriteString(hy(row))
		switch i {
		case 2:
			b.WriteString("   " + hy(wordmarkRows[0]))
			if meta {
				b.WriteString("   " + paint(cDim, tagline))
			}
		case 3:
			b.WriteString("   " + hy(wordmarkRows[1]))
			if meta {
				b.WriteString("   " + paint(cComb, appName+" "+version+" · beta"))
			}
		}
		if i < len(combRows)-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// logo is the honeycomb mark + AGIX wordmark, honey-gold.
func logo() string { return renderMark(false) }

// banner is the logo + tagline + version line, used for `version` and bare/`help` output.
func banner() string { return renderMark(true) + "\n" }
