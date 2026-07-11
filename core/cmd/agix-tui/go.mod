// Nested module: the `agix fleet` TUI lives in its OWN Go module so the born-clean
// core module (github.com/agix-ai/agix/core) stays zero-dependency (stdlib only).
// Bubble Tea + Lipgloss are a UI dependency tree, and adding them to core would
// pollute `core`'s ./... — nested modules are excluded from the parent's ./... , so
// `go build/vet/test ./...` at the core root never pull the Charm libraries in.
// The `replace` below points at the parent so this binary can import core packages
// (agentspec, caste) without vendoring or publishing them. Build/vet THIS binary
// explicitly from this directory, exactly like core/orchestrator/adk.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
module github.com/agix-ai/agix/core/cmd/agix-tui

go 1.26

require (
	github.com/agix-ai/agix/core v0.0.0
	github.com/charmbracelet/bubbletea v1.3.10
	github.com/charmbracelet/lipgloss v1.1.0
)

require (
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/charmbracelet/colorprofile v0.2.3-0.20250311203215-f60798e515dc // indirect
	github.com/charmbracelet/x/ansi v0.10.1 // indirect
	github.com/charmbracelet/x/cellbuf v0.0.13-0.20250311204145-2c3ea96c31dd // indirect
	github.com/charmbracelet/x/term v0.2.1 // indirect
	github.com/erikgeiser/coninput v0.0.0-20211004153227-1c3628e74d0f // indirect
	github.com/lucasb-eyer/go-colorful v1.2.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mattn/go-localereader v0.0.1 // indirect
	github.com/mattn/go-runewidth v0.0.16 // indirect
	github.com/muesli/ansi v0.0.0-20230316100256-276c6243b2f6 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/muesli/termenv v0.16.0 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	golang.org/x/sys v0.44.0 // indirect
	golang.org/x/text v0.3.8 // indirect
)

replace github.com/agix-ai/agix/core => ../..
