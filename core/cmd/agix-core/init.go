// `agix init` — real first-run onboarding: provision the durable instance state the
// runtime actually uses, then hand the user a working next command. This is the
// command the README's "First run" section promises; it is idempotent (never
// clobbers existing state) and works fully offline on Go stdlib + the core kmstore.
//
// WHERE THE RUNTIME ACTUALLY LOOKS (traced, not guessed):
//   - the knowledge fabric (the Comb) is ~/.agix/km.db — defaultDBPath() (km.go),
//     which kmstore.Open() creates. This is the ONE durable dir the code truly owns.
//   - provider KEY files are ~/.config/agix/<provider>.env — keyenv.devFallback().
//   - the per-run audit ledger is CWD-relative ./.agix/ledger.jsonl (main.go), and
//     agents write their notes to a CWD-relative ./wiki/<name>/ (the fs Workspace
//     Root defaults to CWD). So `wiki/` is a working-directory artifact per run.
//
// soul.md and settings.json are NOT read by any runtime code today (grep-confirmed):
// they are provisioned here as honest, durable, human-editable files under ~/.agix
// (the instance home), documented as such — not faked as live config. init keeps the
// README truthful rather than the reverse.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/kmstore"
)

// agixHome is the root of the durable instance state (~/.agix) — the parent of the
// km.db the runtime already owns, so soul.md/settings.json/wiki live alongside the
// one path the code genuinely reads. Derived from defaultDBPath() so the two can
// never drift.
func agixHome() string { return filepath.Dir(defaultDBPath()) }

// lookPath is exec.LookPath, indirected so tests can drive provider detection
// deterministically without mutating the process PATH.
var lookPath = exec.LookPath

// detectProvider probes for an installed coding-agent CLI in the README's stated
// precedence: Claude Code first, then Codex. It returns a stable label
// ("claude-code" | "codex"), the resolved binary path, and whether one was found.
func detectProvider() (label, path string, found bool) {
	return detectProviderWith(lookPath)
}

func detectProviderWith(look func(string) (string, error)) (label, path string, found bool) {
	if p, err := look("claude"); err == nil && p != "" {
		return "claude-code", p, true
	}
	if p, err := look("codex"); err == nil && p != "" {
		return "codex", p, true
	}
	return "", "", false
}

// stdinIsTTY (defined in agent_author.go) reports whether stdin is an interactive
// terminal — reused here to decide whether `agix init` can run the get-to-know-you.

// onboardOpts drives one provisioning pass.
type onboardOpts struct {
	interactive bool      // run the get-to-know-you prompts (TTY only)
	in          io.Reader // prompt input (os.Stdin in production)
	out         io.Writer // summary output (os.Stdout in production)
	// welcome, when set, appends the bare-`agix` welcome + command overview after the
	// summary (the auto-onboard path); a plain `agix init` prints just the summary.
	welcome bool
}

// onboardReport records what one pass created vs. found — the honest summary and the
// hook the auto-onboard sentinel and tests read.
type onboardReport struct {
	Home          string
	DBPath        string
	CreatedDB     bool
	SeededLeaves  int
	WikiPath      string
	CreatedWiki   bool
	SoulPath      string
	CreatedSoul   bool
	SettingsPath  string
	CreatedSet    bool
	ProviderLabel string // "claude-code" | "codex" | "" (none)
	ProviderPath  string
}

// runOnboarding provisions the full instance state and prints a branded, honest
// summary. Every step is idempotent: an existing artifact is kept, never clobbered.
// Returns a process exit code (0 on success; 1 on a hard provisioning error).
func runOnboarding(o onboardOpts) int {
	rep, err := provision(o)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init: %v\n", err)
		return 1
	}
	printSummary(o.out, rep)
	if o.welcome {
		fmt.Fprintln(o.out)
		fmt.Fprint(o.out, banner())
		fmt.Fprintln(o.out)
		usageTo(os.Stdout)
	}
	return 0
}

// provision does the idempotent work and returns the report. It never clobbers: each
// helper detects an existing artifact and leaves it untouched.
func provision(o onboardOpts) (onboardReport, error) {
	home := agixHome()
	if err := os.MkdirAll(home, 0o755); err != nil {
		return onboardReport{}, fmt.Errorf("create %s: %w", home, err)
	}

	label, ppath, _ := detectProvider()
	rep := onboardReport{
		Home:          home,
		DBPath:        defaultDBPath(),
		WikiPath:      filepath.Join(home, "wiki"),
		SoulPath:      filepath.Join(home, "soul.md"),
		SettingsPath:  filepath.Join(home, "settings.json"),
		ProviderLabel: label,
		ProviderPath:  ppath,
	}

	// 1. the km fabric (the Comb) — open it (creates the file) and seed starter
	//    leaves so it's non-empty out of the box, but only when it's genuinely fresh.
	createdDB, seeded, err := provisionKM(rep.DBPath)
	if err != nil {
		return rep, err
	}
	rep.CreatedDB, rep.SeededLeaves = createdDB, seeded

	// 2. wiki/ — a durable home for the fleet's notes.
	createdWiki, err := provisionDir(rep.WikiPath)
	if err != nil {
		return rep, err
	}
	rep.CreatedWiki = createdWiki

	// 3. soul.md — instance identity, personalized on a TTY or a placeholder.
	name, role, building := "", "", ""
	if o.interactive {
		name, role, building = getToKnowYou(o.in, o.out)
	}
	createdSoul, err := provisionSoul(rep.SoulPath, name, role, building, rep.providerForSoul())
	if err != nil {
		return rep, err
	}
	rep.CreatedSoul = createdSoul

	// 4. settings.json — records the detected default provider (nothing reads it yet;
	//    it's an honest, durable record, not live config).
	createdSet, err := provisionSettings(rep)
	if err != nil {
		return rep, err
	}
	rep.CreatedSet = createdSet

	return rep, nil
}

// providerForSoul is the human label the soul records for the default provider.
func (r onboardReport) providerForSoul() string {
	if r.ProviderLabel != "" {
		return r.ProviderLabel
	}
	return "none detected (set a CLI agent or API key)"
}

// provisionDir creates dir if missing. Returns whether it was created.
func provisionDir(dir string) (bool, error) {
	if _, err := os.Stat(dir); err == nil {
		return false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("create %s: %w", dir, err)
	}
	return true, nil
}

// provisionKM opens the Comb at path (kmstore.Open creates the file + parent dir) and
// seeds a few honest starter leaves — but ONLY when the store is genuinely empty, so a
// re-run never duplicates or clobbers real knowledge. Returns whether the file was
// freshly created and how many leaves were seeded.
func provisionKM(path string) (created bool, seeded int, err error) {
	_, statErr := os.Stat(path)
	created = statErr != nil

	st, err := kmstore.Open(path)
	if err != nil {
		return false, 0, fmt.Errorf("open the knowledge fabric %s: %w", path, err)
	}
	defer st.Close()

	s, err := st.Stats()
	if err != nil {
		return created, 0, fmt.Errorf("read fabric stats: %w", err)
	}
	if s.Leaves > 0 {
		return created, 0, nil // already has knowledge — leave it be
	}

	for _, c := range starterLeaves {
		res, perr := st.Put(kmstore.Leaf{
			Content:   c,
			Author:    "agix/onboarding",
			Branch:    "software",
			Embedding: embedText(c),
		})
		if perr != nil {
			return created, seeded, fmt.Errorf("seed the knowledge fabric: %w", perr)
		}
		if res.Added {
			seeded++
		}
	}
	return created, seeded, nil
}

// starterLeaves is the minimal, HONEST seed: true statements about what Agix is and
// how to drive it — not fabricated benchmark data. Authored by agix/onboarding with no
// verifier, so they store UN-attested (the honest provenance for an un-vouched fact).
var starterLeaves = []string{
	"Agix AOS is a local agentic operating system: the `agix` CLI plus a fleet of governed agents that coordinate over a message bus, backed by this knowledge fabric (the Comb).",
	"The Comb is provenance-gated: a leaf is ATTESTED only when a verifier distinct from its author vouches for it (actor≠verifier). These seed leaves are un-attested until a verifier co-signs.",
	"Run `agix flow \"<task>\" --gate=approve` to drive the forage→ratify→feed governance flow; it pauses at the actor≠verifier gate and resumes with your verdict.",
	"Providers: the fleet runs on your installed Claude Code or Codex CLI (no API key), or `--provider mock` for a deterministic $0 dry run; `--provider local` uses a local Ollama model.",
	"Durable state lives under ~/.agix (this fabric, soul.md, settings.json, wiki/); provider key files live under ~/.config/agix/<provider>.env; each run's audit ledger is written to ./.agix/ledger.jsonl in the working directory.",
}

// getToKnowYou runs the short, optional personalization prompts. Any field may be left
// blank (the soul records a placeholder). Never errors — an EOF/closed stdin just
// yields blanks.
func getToKnowYou(in io.Reader, out io.Writer) (name, role, building string) {
	sc := bufio.NewScanner(in)
	ask := func(q string) string {
		fmt.Fprint(out, "  "+q)
		if !sc.Scan() {
			return ""
		}
		return strings.TrimSpace(sc.Text())
	}
	fmt.Fprintln(out, hy("Let's personalize your instance")+paint(cDim, "  (press Enter to skip any)"))
	name = ask("Your name?           ")
	role = ask("Your role?           ")
	building = ask("What are you building? ")
	fmt.Fprintln(out)
	return name, role, building
}

// provisionSoul writes the instance-identity soul.md if absent. It is never
// overwritten — a re-run keeps the operator's edited soul intact.
func provisionSoul(path, name, role, building, provider string) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return false, nil
	}
	orPlaceholder := func(v, ph string) string {
		if strings.TrimSpace(v) == "" {
			return ph
		}
		return v
	}
	body := fmt.Sprintf(`# soul.md — Agix instance identity

<!-- This is your Agix instance's "soul": a durable, human-readable identity that
     grows as you and the fleet work. Edit it freely — it is yours. Note: the
     runtime does not yet load this file automatically; it is your durable notes-
     to-self today, wired into agent context in a later release. -->

## Operator
- Name:     %s
- Role:     %s
- Building: %s

## Instance
- Created:          %s
- Home:             %s
- Default provider: %s

## North Star
%s

## Notes
(Durable context accrues here over time.)
`,
		orPlaceholder(name, "(not set — run `agix init` to personalize)"),
		orPlaceholder(role, "(not set)"),
		orPlaceholder(building, "(not set)"),
		time.Now().UTC().Format("2006-01-02"),
		agixHome(),
		provider,
		orPlaceholder(building, "(describe what you're building — the fleet re-grounds you against this)"),
	)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return false, fmt.Errorf("write %s: %w", path, err)
	}
	return true, nil
}

// settingsFile is the on-disk shape of settings.json. It is an honest, durable record
// of the provisioned instance (paths + detected provider), NOT live runtime config —
// no code reads it back today, and the comment field says so out loud.
type settingsFile struct {
	Comment  string            `json:"_comment"`
	Version  string            `json:"version"`
	Created  string            `json:"created"`
	Provider settingsProv      `json:"provider"`
	Paths    map[string]string `json:"paths"`
}

type settingsProv struct {
	Default  string `json:"default"`             // "claude-code" | "codex" | "mock"
	CLIAgent string `json:"cli_agent,omitempty"` // resolved binary path when detected
	Detected bool   `json:"detected"`
}

// provisionSettings writes settings.json if absent, recording the detected default
// provider. When no CLI agent is found, the default is "mock" (the only $0, no-config
// path that always works) — the summary tells the user to install one or set a key.
func provisionSettings(rep onboardReport) (bool, error) {
	if _, err := os.Stat(rep.SettingsPath); err == nil {
		return false, nil
	}
	def := rep.ProviderLabel
	if def == "" {
		def = "mock"
	}
	sf := settingsFile{
		Comment: "Provisioned by `agix init`. An honest record of this instance; not yet read back by the runtime.",
		Version: version,
		Created: time.Now().UTC().Format(time.RFC3339),
		Provider: settingsProv{
			Default:  def,
			CLIAgent: rep.ProviderPath,
			Detected: rep.ProviderLabel != "",
		},
		Paths: map[string]string{
			"km_db":   rep.DBPath,
			"wiki":    rep.WikiPath,
			"soul":    rep.SoulPath,
			"home":    rep.Home,
			"key_dir": filepath.Join(filepath.Dir(rep.Home), ".config", "agix"),
		},
	}
	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return false, fmt.Errorf("encode settings: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(rep.SettingsPath, data, 0o644); err != nil {
		return false, fmt.Errorf("write %s: %w", rep.SettingsPath, err)
	}
	return true, nil
}

// printSummary prints the friendly, honest what-was-created report + the next command.
func printSummary(w io.Writer, rep onboardReport) {
	mark := func(created bool) string {
		if created {
			return paint(cHoney, "created")
		}
		return paint(cDim, "kept   ")
	}
	fmt.Fprintln(w, hy("Agix is ready.")+paint(cDim, "  Instance home: "+rep.Home))
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  knowledge fabric  %s", mark(rep.CreatedDB), rep.DBPath)
	if rep.SeededLeaves > 0 {
		fmt.Fprintf(w, paint(cDim, "  (seeded %d starter leaves)"), rep.SeededLeaves)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  wiki/             %s\n", mark(rep.CreatedWiki), rep.WikiPath)
	fmt.Fprintf(w, "  %s  soul.md           %s\n", mark(rep.CreatedSoul), rep.SoulPath)
	fmt.Fprintf(w, "  %s  settings.json     %s\n", mark(rep.CreatedSet), rep.SettingsPath)
	fmt.Fprintln(w)

	if rep.ProviderLabel != "" {
		fmt.Fprintf(w, "  %s detected %s (%s) — the fleet runs on it, no API key.\n",
			hy("provider:"), paint(cHoney, rep.ProviderLabel), rep.ProviderPath)
	} else {
		fmt.Fprintf(w, "  %s no Claude Code or Codex CLI found. Defaulting to %s (a $0 dry run).\n",
			hy("provider:"), paint(cHoney, "mock"))
		fmt.Fprintln(w, paint(cDim, "            Install one (or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)"))
		fmt.Fprintln(w, paint(cDim, "            before agents make a real model call. `--provider mock` works now."))
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Try it:  "+paint(cHoney, `agix flow "add a login page" --gate=approve`))
}

// cmdInit is the `agix init` entry point. `--defaults` (or a non-TTY stdin) skips the
// get-to-know-you prompts and provisions with placeholders; on a TTY it personalizes.
func cmdInit(args []string) int {
	defaults := false
	for _, a := range args {
		switch a {
		case "--defaults":
			defaults = true
		case "-h", "--help", "-help", "help":
			// Normally intercepted centrally in main(); handle it here too so a direct
			// call still does the right thing.
			if h, ok := verbHelp("init"); ok {
				fmt.Fprint(os.Stdout, h)
			}
			return 0
		default:
			fmt.Fprintf(os.Stderr, "init: unknown flag %q (the only flag is --defaults)\n", a)
			return 2
		}
	}
	return runOnboarding(onboardOpts{
		interactive: !defaults && stdinIsTTY(),
		in:          os.Stdin,
		out:         os.Stdout,
	})
}

// isOnboarded is the auto-onboard sentinel: the provisioned state existing. The km
// fabric file is the marker (it's the one path the runtime truly owns), so a fresh
// machine (no ~/.agix/km.db) auto-onboards exactly once and every run after just
// shows the banner.
func isOnboarded() bool {
	_, err := os.Stat(defaultDBPath())
	return err == nil
}

// autoOnboard is bare `agix` on a fresh machine: a quick, non-interactive,
// non-destructive provision (equivalent to `agix init --defaults`) followed by the
// welcome banner + command overview. Guarded by isOnboarded() at the call site so it
// runs at most once.
func autoOnboard() int {
	return runOnboarding(onboardOpts{
		interactive: false,
		in:          os.Stdin,
		out:         os.Stdout,
		welcome:     true,
	})
}
