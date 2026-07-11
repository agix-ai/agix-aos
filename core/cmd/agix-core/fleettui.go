// The `agix fleet` verb launches the interactive fleet TUI. The TUI lives in its OWN nested
// module (core/cmd/agix-tui, Bubble Tea + Lipgloss) so a UI dependency never touches the
// born-clean core; `agix fleet` reaches it as a pure exec boundary, inheriting the terminal
// (a TTY app cannot have its stdio captured).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// cmdFleet execs the agix-tui binary with the terminal inherited. It resolves the binary via
// AGIX_TUI_BIN, then beside this executable (the install layout: libexec/bin/agix-tui next to
// agix-core), then a dev .agix-bin/, then PATH.
func cmdFleet(args []string) int {
	bin := resolveTUIBin()
	if bin == "" {
		fmt.Fprintln(os.Stderr, "agix fleet: the TUI binary (agix-tui) isn't available.")
		fmt.Fprintln(os.Stderr, "  from a clone:  (cd core/cmd/agix-tui && go build -o \"$OLDPWD/.agix-bin/agix-tui\" .)")
		fmt.Fprintln(os.Stderr, "  or set AGIX_TUI_BIN to its path.")
		return 1
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "agix fleet: %v\n", err)
		return 1
	}
	return 0
}

// resolveTUIBin locates the agix-tui binary, or "" if not found.
func resolveTUIBin() string {
	isFile := func(p string) bool {
		fi, err := os.Stat(p)
		return err == nil && !fi.IsDir()
	}
	if p := os.Getenv("AGIX_TUI_BIN"); p != "" && isFile(p) {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe) // installed: libexec/bin (agix-tui sits beside agix-core)
		for _, cand := range []string{
			filepath.Join(dir, "agix-tui"),
			filepath.Join(dir, "..", "..", ".agix-bin", "agix-tui"),
		} {
			if isFile(cand) {
				return cand
			}
		}
	}
	if isFile(".agix-bin/agix-tui") { // dev convenience, run from repo root
		return ".agix-bin/agix-tui"
	}
	if p, err := exec.LookPath("agix-tui"); err == nil {
		return p
	}
	return ""
}
