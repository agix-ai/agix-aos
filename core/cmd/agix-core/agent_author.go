// Agent authoring verbs — the "make your own agents" surface: scaffold, edit, and
// validate an agent from the CLI, so a non-Go author ships a governed bee by writing a
// spec (agent.json). Everything is validated through core/agentspec (the one contract),
// so a scaffolded or edited agent is checked against the same rules the runner enforces.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/agix-ai/agix/core/agentspec"
)

// cmdAgentNew scaffolds a new agent under <dir>/<name>/ (agent.json + PERSONA.md). It runs
// an interactive wizard when stdin is a terminal, or uses defaults with --defaults / flags.
// The result is validated before it lands, so `agent new` never writes a broken spec.
func cmdAgentNew(args []string) int {
	dir, defaults := "agents", false
	var name, role, trust, toolsCSV string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--dir":
			i++
			if i < len(args) {
				dir = args[i]
			}
		case strings.HasPrefix(a, "--dir="):
			dir = strings.TrimPrefix(a, "--dir=")
		case a == "--defaults":
			defaults = true
		case a == "--role":
			i++
			if i < len(args) {
				role = args[i]
			}
		case a == "--trust":
			i++
			if i < len(args) {
				trust = args[i]
			}
		case a == "--tools":
			i++
			if i < len(args) {
				toolsCSV = args[i]
			}
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "agent new: unknown flag %q\n", a)
			return 2
		default:
			if name == "" {
				name = a
			}
		}
	}
	if name == "" {
		fmt.Fprintln(os.Stderr, `agent new: need a name, e.g. agix agent new my-helper`)
		return 2
	}
	if strings.ContainsAny(name, " \t/\\") {
		fmt.Fprintf(os.Stderr, "agent new: %q must be a slug (no spaces or slashes)\n", name)
		return 2
	}
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); err == nil {
		fmt.Fprintf(os.Stderr, "agent new: %s already exists — edit it with `agix agent edit %s`\n", target, name)
		return 2
	}

	// defaults, then the wizard fills them in on a TTY.
	display, desc := "Agix "+titleCase(name), "A custom agent."
	if role == "" {
		role = "worker"
	}
	if trust == "" {
		trust = "proposer"
	}
	tools := []string{"read", "grep", "glob"}
	if toolsCSV != "" {
		tools = splitCSV(toolsCSV)
	}
	if !defaults && stdinIsTTY() {
		r := bufio.NewReader(os.Stdin)
		fmt.Print(paint(cHoney+cBold, "new agent: "+name) + "  (press enter to keep the default in brackets)\n")
		display = ask(r, "display name", display)
		desc = ask(r, "one-line description", desc)
		role = ask(r, "role (what it does: investigator/researcher/worker/…)", role)
		trust = ask(r, "trust (conductor|proposer|boundary)", trust)
		tools = splitCSV(ask(r, "tools (comma sep: read,grep,glob,write,exec,metric)", strings.Join(tools, ",")))
	}

	spec := &agentspec.Spec{
		Name: name, DisplayName: display, Description: desc,
		Tier: "basic", Public: true,
		Role: role, Trust: trust,
		Instructions: starterInstructions(name, role, desc),
		Tools:        tools,
		Models:       agentspec.ModelTiers{Worker: []string{"claude-sonnet-4-6"}, Verifier: "claude-haiku-4-5", Workers: 1},
		Boundary: agentspec.Boundary{
			Read:  []string{"agents/" + name + "/", "wiki/"},
			Write: []string{"wiki/" + name + "/"},
			Deny:  []string{"git push", "git commit", "gh pr merge"},
		},
		Config:  []agentspec.ConfigVar{{Name: "ANTHROPIC_API_KEY", Required: false}},
		Outputs: []agentspec.Output{{Kind: "file", Path: "wiki/" + name + "/{{date}}.md"}},
	}
	if err := spec.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "agent new: scaffold failed validation: %v\n", err)
		return 1
	}

	if err := os.MkdirAll(target, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "agent new: %v\n", err)
		return 1
	}
	data, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent new: %v\n", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(target, "agent.json"), append(data, '\n'), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "agent new: %v\n", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(target, "PERSONA.md"), []byte(personaTemplate(spec)), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "agent new: %v\n", err)
		return 1
	}

	fmt.Printf("%s %s\n", paint(cHoney, "created"), target)
	fmt.Println("  agent.json  the manifest — role · trust · tools · boundary")
	fmt.Println("  PERSONA.md  the persona doc")
	fmt.Println("next:")
	fmt.Printf("  agix agent edit %s        flesh out the instructions/persona\n", name)
	fmt.Printf("  agix agent validate %s    schema-check it\n", name)
	fmt.Printf("  agix agent run %s \"...\" --provider mock\n", name)
	return 0
}

// cmdAgentEdit opens an agent's manifest in $EDITOR, then re-validates it.
func cmdAgentEdit(args []string) int {
	name, dir := agentNameAndDir(args)
	if name == "" {
		fmt.Fprintln(os.Stderr, "agent edit: need a name, e.g. agix agent edit investigator")
		return 2
	}
	path := filepath.Join(dir, name, agentspec.SpecFileName)
	if _, err := os.Stat(path); err != nil {
		fmt.Fprintf(os.Stderr, "agent edit: %s not found (create it with `agix agent new %s`)\n", path, name)
		return 2
	}
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}
	if editor == "" {
		editor = "nano"
	}
	cmd := exec.Command(editor, path)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "agent edit: %v\n", err)
		return 1
	}
	// A bad edit should fail loud here, not at run time.
	if _, err := agentspec.LoadName(dir, name); err != nil {
		fmt.Fprintf(os.Stderr, "⚠ saved, but the spec is now INVALID: %v\n", err)
		return 1
	}
	fmt.Printf("%s %s valid\n", paint(cHoney, "✓"), name)
	return 0
}

// cmdAgentValidate schema-checks an agent through the same contract the runner uses.
func cmdAgentValidate(args []string) int {
	name, dir := agentNameAndDir(args)
	if name == "" {
		fmt.Fprintln(os.Stderr, "agent validate: need a name, e.g. agix agent validate investigator")
		return 2
	}
	spec, err := agentspec.LoadName(dir, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ %v\n", err)
		return 1
	}
	fmt.Printf("%s %s valid — role=%s caste=%s trust=%s tools=[%s]\n",
		paint(cHoney, "✓"), spec.Name, spec.Role, spec.ResolveCaste(), orDash(spec.Trust), strings.Join(spec.Tools, ","))
	return 0
}

// ── small authoring helpers ────────────────────────────────────────────────────

// agentNameAndDir pulls the first positional (name) and an optional --dir (default agents).
func agentNameAndDir(args []string) (name, dir string) {
	dir = "agents"
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--dir":
			i++
			if i < len(args) {
				dir = args[i]
			}
		case strings.HasPrefix(a, "--dir="):
			dir = strings.TrimPrefix(a, "--dir=")
		case !strings.HasPrefix(a, "-") && name == "":
			name = a
		}
	}
	return name, dir
}

// stdinIsTTY reports whether stdin is an interactive terminal (drives the wizard).
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// ask prompts "label [default]: " and returns the trimmed answer, or def if empty.
func ask(r *bufio.Reader, label, def string) string {
	fmt.Printf("  %s [%s]: ", label, paint(cDim, def))
	line, _ := r.ReadString('\n')
	if s := strings.TrimSpace(line); s != "" {
		return s
	}
	return def
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func titleCase(slug string) string {
	parts := strings.FieldsFunc(slug, func(r rune) bool { return r == '-' || r == '_' })
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// starterInstructions builds a non-empty behavioral prompt the author then fleshes out.
// (Instructions are required — a spec with none is a manifest, not an agent.)
func starterInstructions(name, role, desc string) string {
	return fmt.Sprintf("You are the %s. %s\n\nDescribe your method in a few numbered steps, then "+
		"state your hard rules and what you will NOT do. You are a governed agent: the work you "+
		"produce is verified by a DIFFERENT actor (actor != verifier), so be precise and honest, "+
		"and tie every claim to evidence. No em dashes, builder-to-builder.\n\n"+
		"(Edit this: `agix agent edit %s`.)", role, desc, name)
}

func personaTemplate(s *agentspec.Spec) string {
	return fmt.Sprintf("# %s\n\n%s\n\n- **role:** %s\n- **trust:** %s\n- **tools:** %s\n\n"+
		"The behavioral prompt lives in `agent.json` under `instructions`. This doc is the\n"+
		"human-readable persona: what this agent is for, how it thinks, and its boundaries.\n",
		s.DisplayName, s.Description, s.Role, orDash(s.Trust), strings.Join(s.Tools, ", "))
}
