// The Bubble Tea model behind `agix fleet` — a read-only fleet browser. It discovers
// the reborn agent specs under the agents/ tree (via the born-clean core's
// agentspec.Discover) and renders a two-pane view: a scrollable roster on the left
// and the selected agent's full contract on the right. It is pure inspection — v1
// never runs an agent, so it needs none of the swarm engine, only the declarative
// Spec. The Elm-architecture split is the usual Bubble Tea shape: Init seeds no work,
// Update folds one message into new state, View renders the state to a string.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"fmt"
	"strings"

	"github.com/agix-ai/agix/core/agentspec"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// model is the whole application state. specs is the discovered fleet (already
// sorted by name — agentspec.Discover guarantees it); cursor is the selected row;
// width/height track the terminal so View can size the two panes.
type model struct {
	specs  []*agentspec.Spec
	cursor int
	width  int
	height int
}

// newModel discovers the fleet under dir and returns the initial model. A discovery
// error is surfaced to the caller (main) rather than swallowed, so a broken spec
// fails loudly at startup instead of showing a half-empty roster.
func newModel(dir string) (model, error) {
	specs, err := agentspec.Discover(dir)
	if err != nil {
		return model{}, err
	}
	return model{specs: specs}, nil
}

// Init seeds no initial command — everything the TUI shows is already in the model,
// so there is no I/O to kick off. The first real frame arrives on the WindowSizeMsg
// Bubble Tea sends at startup.
func (m model) Init() tea.Cmd { return nil }

// Update folds one message into the next model. It handles window resizes (to size
// the panes) and the v1 key map: up/k and down/j move the selection, q / esc /
// ctrl+c quit. Unknown keys are ignored.
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.specs)-1 {
				m.cursor++
			}
		case "home", "g":
			m.cursor = 0
		case "end", "G":
			m.cursor = len(m.specs) - 1
		}
	}
	return m, nil
}

// View renders the current state. Layout is a honey title bar, then the roster and
// detail panes joined horizontally, then a key-hint footer. Widths are derived from
// the live terminal size so the TUI reflows on resize; before the first
// WindowSizeMsg (width == 0) it renders a short placeholder.
func (m model) View() string {
	if m.width == 0 {
		return "loading fleet…"
	}
	if len(m.specs) == 0 {
		return "no reborn agents found (an agent is ported when it carries an agent.json)\n"
	}

	title := titleStyle.Render(fmt.Sprintf("⬡ agix fleet · %d agents", len(m.specs)))
	footer := footerStyle.Render("↑/↓ · j/k move   g/G top/bottom   q quit")

	// Reserve rows for the title (1), footer (1), and the pane borders/blank lines,
	// then split the width: a fixed-ish roster gutter on the left, the rest to detail.
	bodyHeight := m.height - 4
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	listWidth := 34
	if listWidth > m.width/2 {
		listWidth = m.width / 2
	}
	detailWidth := m.width - listWidth - 6 // borders + padding + gap
	if detailWidth < 20 {
		detailWidth = 20
	}

	list := paneBorder.Width(listWidth).Height(bodyHeight).Render(m.renderList(bodyHeight))
	detail := paneBorder.Width(detailWidth).Height(bodyHeight).Render(m.renderDetail(detailWidth, bodyHeight))
	body := lipgloss.JoinHorizontal(lipgloss.Top, list, detail)

	return lipgloss.JoinVertical(lipgloss.Left, title, body, footer)
}

// renderList draws the roster: one row per agent showing its name, resolved caste,
// and trust. The selected row is honey-highlighted; the visible window scrolls to
// keep the cursor in view when the fleet is taller than the pane.
func (m model) renderList(height int) string {
	var b strings.Builder
	start := 0
	if m.cursor >= height {
		start = m.cursor - height + 1
	}
	end := start + height
	if end > len(m.specs) {
		end = len(m.specs)
	}
	for i := start; i < end; i++ {
		s := m.specs[i]
		caste := string(s.ResolveCaste())
		if i == m.cursor {
			line := fmt.Sprintf("%-16s %s", truncate(s.Name, 16), caste)
			b.WriteString(selectedRow.Render(" " + truncate(line, 30) + " "))
		} else {
			name := rowName.Render(truncate(s.Name, 16))
			tag := lipgloss.NewStyle().Foreground(casteColor(caste)).Render(caste)
			b.WriteString(" " + name + " " + tag)
		}
		if i < end-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// renderDetail draws the full contract for the selected agent: identity, the
// role/trust/caste triple, declared tools, the guard-bee boundary (read/write/deny),
// and the behavioral instructions. Text is wrapped to the pane width; the
// instructions are clipped to whatever vertical space is left so the pane never
// overflows its box.
func (m model) renderDetail(width, height int) string {
	s := m.specs[m.cursor]
	inner := width - 2 // account for the pane's horizontal padding
	if inner < 10 {
		inner = 10
	}
	var b strings.Builder

	name := s.DisplayName
	if name == "" {
		name = s.Name
	}
	b.WriteString(detailName.Render(name))
	b.WriteString("\n")
	if s.Description != "" {
		b.WriteString(detailDesc.Render(wrap(s.Description, inner)))
		b.WriteString("\n")
	}
	b.WriteString(rule(inner))
	b.WriteString("\n")

	caste := string(s.ResolveCaste())
	casteTag := lipgloss.NewStyle().Foreground(casteColor(caste)).Bold(true).Render(caste)
	b.WriteString(field("role", s.Role))
	b.WriteString(field("trust", orDash(s.Trust)))
	b.WriteString(fieldLabel.Render(pad("caste")) + casteTag + "\n")
	if s.Tier != "" {
		access := "proprietary"
		if s.Public {
			access = "public"
		}
		b.WriteString(field("tier", s.Tier+" · "+access))
	}

	if len(s.Tools) > 0 {
		b.WriteString(field("tools", wrapIndent(strings.Join(s.Tools, ", "), inner)))
	}

	// Boundary — the guard-bee trust boundary. Only render the sub-fields that exist.
	if len(s.Boundary.Read) > 0 || len(s.Boundary.Write) > 0 || len(s.Boundary.Deny) > 0 {
		b.WriteString(rule(inner))
		b.WriteString("\n")
		b.WriteString(fieldLabel.Render("boundary") + "\n")
		if len(s.Boundary.Read) > 0 {
			b.WriteString(subField("read", wrapIndent(strings.Join(s.Boundary.Read, ", "), inner)))
		}
		if len(s.Boundary.Write) > 0 {
			b.WriteString(subField("write", wrapIndent(strings.Join(s.Boundary.Write, ", "), inner)))
		}
		if len(s.Boundary.Deny) > 0 {
			b.WriteString(subField("deny", wrapIndent(strings.Join(s.Boundary.Deny, ", "), inner)))
		}
	}

	// Instructions fill whatever vertical space remains. Count the lines used so far
	// and clip the (wrapped) instructions to the rest, with an ellipsis when cut.
	b.WriteString(rule(inner))
	b.WriteString("\n")
	b.WriteString(fieldLabel.Render("instructions") + "\n")

	used := strings.Count(b.String(), "\n") + 1
	remain := height - used
	if remain < 1 {
		remain = 1
	}
	instr := wrap(s.Instructions, inner)
	lines := strings.Split(instr, "\n")
	if len(lines) > remain {
		lines = lines[:remain]
		if remain > 0 {
			lines[remain-1] = truncate(lines[remain-1], inner-1) + "…"
		}
	}
	b.WriteString(instrText.Render(strings.Join(lines, "\n")))

	return b.String()
}

// ── small text helpers ───────────────────────────────────────────────────────

// field renders a "label  value" line with the value wrapped/indented under the
// gutter when it spills. label is padded to a fixed gutter so values align.
func field(label, value string) string {
	return fieldLabel.Render(pad(label)) + fieldValue.Render(value) + "\n"
}

// subField is a field indented one level, used for the boundary's read/write/deny.
func subField(label, value string) string {
	return "  " + fieldLabel.Render(pad(label)) + fieldValue.Render(value) + "\n"
}

// pad right-pads a field label into an 11-col gutter so values line up.
func pad(label string) string {
	const gutter = 11
	if len(label) >= gutter {
		return label + " "
	}
	return label + strings.Repeat(" ", gutter-len(label))
}

// rule draws a faint horizontal divider n cols wide.
func rule(n int) string {
	if n < 1 {
		n = 1
	}
	return sectionRule.Render(strings.Repeat("─", n))
}

// orDash returns s, or "—" when s is empty (for optional fields like trust).
func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

// truncate clips s to at most n runes (no ellipsis — callers add one when wanted).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n < 0 {
		n = 0
	}
	return string(r[:n])
}

// wrap hard-wraps s to width cols on word boundaries, preserving existing newlines
// (an instructions block often carries \n between numbered points).
func wrap(s string, width int) string {
	if width < 1 {
		width = 1
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		out = append(out, wrapLine(para, width))
	}
	return strings.Join(out, "\n")
}

// wrapIndent wraps like wrap but hangs continuation lines under the value gutter so
// a long tools/boundary list stays readable beside its label.
func wrapIndent(s string, width int) string {
	const gutter = 11
	w := width - gutter
	if w < 8 {
		w = 8
	}
	wrapped := wrapLine(s, w)
	lines := strings.Split(wrapped, "\n")
	for i := 1; i < len(lines); i++ {
		lines[i] = strings.Repeat(" ", gutter) + lines[i]
	}
	return strings.Join(lines, "\n")
}

// wrapLine greedily word-wraps a single logical line to width cols.
func wrapLine(s string, width int) string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return ""
	}
	var b strings.Builder
	col := 0
	for i, w := range words {
		wl := len([]rune(w))
		if col == 0 {
			b.WriteString(w)
			col = wl
			continue
		}
		if col+1+wl > width {
			b.WriteString("\n")
			b.WriteString(w)
			col = wl
		} else {
			b.WriteString(" ")
			b.WriteString(w)
			col += 1 + wl
		}
		_ = i
	}
	return b.String()
}
