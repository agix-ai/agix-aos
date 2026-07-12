package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
)

// sandboxHome points HOME at a fresh temp dir so agixHome()/defaultDBPath() resolve
// under it — the whole point of the test is that provisioning touches nothing real.
func sandboxHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

// TestProvisionCreatesEverything — a clean pass creates the km fabric (seeded),
// wiki/, soul.md, and settings.json under ~/.agix.
func TestProvisionCreatesEverything(t *testing.T) {
	home := sandboxHome(t)
	rep, err := provision(onboardOpts{interactive: false, out: &bytes.Buffer{}})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	agix := filepath.Join(home, ".agix")
	for _, p := range []string{
		filepath.Join(agix, "km.db"),
		filepath.Join(agix, "wiki"),
		filepath.Join(agix, "soul.md"),
		filepath.Join(agix, "settings.json"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected %s to exist: %v", p, err)
		}
	}
	if !rep.CreatedDB || !rep.CreatedWiki || !rep.CreatedSoul || !rep.CreatedSet {
		t.Errorf("expected all-created on a clean pass, got %+v", rep)
	}
	if rep.SeededLeaves != len(starterLeaves) {
		t.Errorf("seeded = %d, want %d", rep.SeededLeaves, len(starterLeaves))
	}

	// The fabric is genuinely non-empty and the seed is retrievable.
	st, err := kmstore.Open(rep.DBPath)
	if err != nil {
		t.Fatalf("open seeded db: %v", err)
	}
	defer st.Close()
	s, _ := st.Stats()
	if s.Leaves != len(starterLeaves) {
		t.Errorf("db leaves = %d, want %d", s.Leaves, len(starterLeaves))
	}
}

// TestProvisionIdempotent — a re-run keeps existing state: it creates nothing new,
// re-seeds nothing, and does NOT overwrite an edited soul.md.
func TestProvisionIdempotent(t *testing.T) {
	sandboxHome(t)
	if _, err := provision(onboardOpts{out: &bytes.Buffer{}}); err != nil {
		t.Fatalf("first provision: %v", err)
	}

	// Operator edits the soul between runs.
	soul := filepath.Join(agixHome(), "soul.md")
	const edited = "# my edited soul\n"
	if err := os.WriteFile(soul, []byte(edited), 0o644); err != nil {
		t.Fatalf("edit soul: %v", err)
	}

	rep, err := provision(onboardOpts{out: &bytes.Buffer{}})
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}
	if rep.CreatedDB || rep.CreatedWiki || rep.CreatedSoul || rep.CreatedSet {
		t.Errorf("re-run should create nothing, got %+v", rep)
	}
	if rep.SeededLeaves != 0 {
		t.Errorf("re-run should re-seed nothing, got %d", rep.SeededLeaves)
	}
	if b, _ := os.ReadFile(soul); string(b) != edited {
		t.Errorf("soul.md was clobbered: got %q", string(b))
	}

	// The fabric still holds exactly the original seed — no duplicates.
	st, _ := kmstore.Open(rep.DBPath)
	defer st.Close()
	s, _ := st.Stats()
	if s.Leaves != len(starterLeaves) {
		t.Errorf("after re-run leaves = %d, want %d (no duplicates)", s.Leaves, len(starterLeaves))
	}
}

// TestDefaultsIsNonInteractive — with --defaults (interactive:false) provisioning
// reads NOTHING from stdin, so a reader that would error if touched proves it.
func TestDefaultsIsNonInteractive(t *testing.T) {
	sandboxHome(t)
	// A reader whose Read panics if called — any prompt attempt fails the test.
	guard := readerThatFailsIfRead{t: t}
	code := runOnboarding(onboardOpts{interactive: false, in: guard, out: &bytes.Buffer{}})
	if code != 0 {
		t.Fatalf("runOnboarding exit = %d, want 0", code)
	}
}

type readerThatFailsIfRead struct{ t *testing.T }

func (r readerThatFailsIfRead) Read([]byte) (int, error) {
	r.t.Fatalf("--defaults must not read stdin")
	return 0, nil
}

// TestInteractivePersonalizesSoul — the get-to-know-you answers land in soul.md.
func TestInteractivePersonalizesSoul(t *testing.T) {
	sandboxHome(t)
	in := strings.NewReader("Ada Lovelace\nEngineer\na governed agent fleet\n")
	code := runOnboarding(onboardOpts{interactive: true, in: in, out: &bytes.Buffer{}})
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	b, err := os.ReadFile(filepath.Join(agixHome(), "soul.md"))
	if err != nil {
		t.Fatalf("read soul: %v", err)
	}
	soul := string(b)
	for _, want := range []string{"Ada Lovelace", "Engineer", "a governed agent fleet"} {
		if !strings.Contains(soul, want) {
			t.Errorf("soul.md missing %q\n---\n%s", want, soul)
		}
	}
}

// TestProviderDetectionPrecedence — claude beats codex beats none, and the choice is
// recorded in settings.json.
func TestProviderDetectionPrecedence(t *testing.T) {
	cases := []struct {
		name       string
		has        map[string]bool
		wantLabel  string
		wantDetect bool
		wantDef    string
	}{
		{"claude wins", map[string]bool{"claude": true, "codex": true}, "claude-code", true, "claude-code"},
		{"codex when no claude", map[string]bool{"codex": true}, "codex", true, "codex"},
		{"none -> mock default", map[string]bool{}, "", false, "mock"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			label, _, found := detectProviderWith(func(name string) (string, error) {
				if c.has[name] {
					return "/fake/bin/" + name, nil
				}
				return "", errors.New("not found")
			})
			if label != c.wantLabel || found != c.wantDetect {
				t.Errorf("detect = (%q,%v), want (%q,%v)", label, found, c.wantLabel, c.wantDetect)
			}

			// End-to-end: the recorded default in settings.json matches.
			sandboxHome(t)
			old := lookPath
			lookPath = func(name string) (string, error) {
				if c.has[name] {
					return "/fake/bin/" + name, nil
				}
				return "", errors.New("not found")
			}
			defer func() { lookPath = old }()

			rep, err := provision(onboardOpts{out: &bytes.Buffer{}})
			if err != nil {
				t.Fatalf("provision: %v", err)
			}
			b, _ := os.ReadFile(rep.SettingsPath)
			var sf settingsFile
			if err := json.Unmarshal(b, &sf); err != nil {
				t.Fatalf("parse settings.json: %v\n%s", err, b)
			}
			if sf.Provider.Default != c.wantDef {
				t.Errorf("settings default = %q, want %q", sf.Provider.Default, c.wantDef)
			}
			if sf.Provider.Detected != c.wantDetect {
				t.Errorf("settings detected = %v, want %v", sf.Provider.Detected, c.wantDetect)
			}
		})
	}
}

// TestIsOnboardedSentinel — the auto-onboard sentinel flips exactly when the km
// fabric exists (a fresh HOME is not onboarded; after a pass it is).
func TestIsOnboardedSentinel(t *testing.T) {
	sandboxHome(t)
	if isOnboarded() {
		t.Fatal("fresh HOME should not be onboarded")
	}
	if _, err := provision(onboardOpts{out: &bytes.Buffer{}}); err != nil {
		t.Fatalf("provision: %v", err)
	}
	if !isOnboarded() {
		t.Fatal("after provisioning the sentinel should report onboarded")
	}
}

// TestCmdInitRejectsUnknownFlag — `agix init --bogus` is a usage error (exit 2).
func TestCmdInitRejectsUnknownFlag(t *testing.T) {
	sandboxHome(t)
	if code := cmdInit([]string{"--bogus"}); code != 2 {
		t.Errorf("cmdInit --bogus exit = %d, want 2", code)
	}
}

// TestUnknownCommandExitsOne — the money regression for the small fix: an unknown
// top-level command must exit 1 (was 0/2), so a script can detect it. We exercise the
// real binary since the dispatch os.Exit()s.
func TestUnknownCommandExitsOne(t *testing.T) {
	bin := buildTestBinary(t)
	cmd := exec.Command(bin, "definitely-not-a-command")
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "NO_COLOR=1")
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("expected a non-zero exit, got err=%v", err)
	}
	if ee.ExitCode() != 1 {
		t.Errorf("unknown command exit = %d, want 1", ee.ExitCode())
	}
}

// buildTestBinary compiles the CLI into a temp path for black-box exit-code tests.
func buildTestBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "agix-core-test")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build test binary: %v\n%s", err, out)
	}
	return bin
}
