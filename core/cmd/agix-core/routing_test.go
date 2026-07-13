package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

// tempHome points ~/.agix at a throwaway dir so route set/unset/list persist there
// (via router.DefaultOverlayPath → os.UserHomeDir → $HOME), never the real home.
func tempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func readOverlayFile(t *testing.T, home string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".agix", "routing.json"))
	if err != nil {
		t.Fatalf("read routing.json: %v", err)
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse routing.json: %v", err)
	}
	return m
}

// TestRouteSetWritesValidJSON proves `route set` persists a valid override and
// that it round-trips through router.LoadOverlay at the ~/.agix path.
func TestRouteSetWritesValidJSON(t *testing.T) {
	home := tempHome(t)
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "cheap-classification", "local"})
	}); code != 0 {
		t.Fatalf("route set exit = %d, want 0", code)
	}
	m := readOverlayFile(t, home)
	if m["cheap-classification"] != "local" {
		t.Fatalf("routing.json = %v, want cheap-classification=local", m)
	}
	// Round-trips through the loader the runtime uses.
	overlay, err := router.LoadOverlay(router.DefaultOverlayPath())
	if err != nil {
		t.Fatal(err)
	}
	if overlay[router.CapCheapClassification] != "local" {
		t.Fatalf("LoadOverlay = %v, want cheap-classification=local", overlay)
	}
}

// TestRouteUnsetRemovesOverride proves `route unset` drops the key (and removes
// the file when it becomes empty, keeping the default path pristine).
func TestRouteUnsetRemovesOverride(t *testing.T) {
	home := tempHome(t)
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "vision", "openai"})
	}); code != 0 {
		t.Fatal("route set failed")
	}
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"unset", "vision"})
	}); code != 0 {
		t.Fatalf("route unset exit != 0")
	}
	if _, err := os.Stat(filepath.Join(home, ".agix", "routing.json")); !os.IsNotExist(err) {
		t.Fatalf("routing.json should be gone after unsetting the last override; stat err = %v", err)
	}
}

// TestRouteListShowsOverlaidVsDefault proves `route list` renders the full
// effective table, tagging the overlaid capability and leaving the rest default.
func TestRouteListShowsOverlaidVsDefault(t *testing.T) {
	tempHome(t)
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "cheap-classification", "local"})
	}); code != 0 {
		t.Fatal("route set failed")
	}
	out, code := captureStdout(t, func() int { return cmdRoute([]string{"list"}) })
	if code != 0 {
		t.Fatalf("route list exit = %d, want 0", code)
	}
	// The overlaid line: cheap-classification → local (overlaid).
	assertLineHas(t, out, "cheap-classification", "local", "(overlaid)")
	// A default line: default-quality → anthropic (default).
	assertLineHas(t, out, "default-quality", "anthropic", "(default)")
}

// TestRouteShowMarksOverlaid proves `route <cap>` marks an overlaid capability.
func TestRouteShowMarksOverlaid(t *testing.T) {
	tempHome(t)
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "cheap-classification", "local"})
	}); code != 0 {
		t.Fatal("route set failed")
	}
	out, code := captureStdout(t, func() int {
		return cmdRoute([]string{"cheap-classification"})
	})
	if code != 0 {
		t.Fatalf("route show exit = %d, want 0", code)
	}
	if !strings.Contains(out, "local") || !strings.Contains(out, "(overlaid)") {
		t.Fatalf("route show output = %q, want it to mention local + (overlaid)", out)
	}

	// A non-overlaid capability is NOT tagged.
	out2, _ := captureStdout(t, func() int { return cmdRoute([]string{"default-quality"}) })
	if strings.Contains(out2, "(overlaid)") {
		t.Fatalf("default-quality wrongly tagged overlaid: %q", out2)
	}
}

// TestRouteSetRejectsInvalid proves invalid cap/provider exit non-zero and write
// nothing (the file stays absent).
func TestRouteSetRejectsInvalid(t *testing.T) {
	home := tempHome(t)
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "not-a-cap", "local"})
	}); code == 0 {
		t.Fatal("route set with unknown capability should exit non-zero")
	}
	if _, code := captureStdout(t, func() int {
		return cmdRoute([]string{"set", "vision", "borg"})
	}); code == 0 {
		t.Fatal("route set with unknown provider should exit non-zero")
	}
	if _, err := os.Stat(filepath.Join(home, ".agix", "routing.json")); !os.IsNotExist(err) {
		t.Fatalf("a rejected route set must not create routing.json; stat err = %v", err)
	}
}

// TestRouteListDefaultAllUnoverlaid proves the no-overlay default: every row is
// (default), none (overlaid).
func TestRouteListDefaultAllUnoverlaid(t *testing.T) {
	tempHome(t)
	out, code := captureStdout(t, func() int { return cmdRoute([]string{"list"}) })
	if code != 0 {
		t.Fatalf("route list exit = %d, want 0", code)
	}
	if strings.Contains(out, "(overlaid)") {
		t.Fatalf("fresh home should have no overlaid rows: %q", out)
	}
}

// assertLineHas fails unless some line of out contains all of the given substrings.
func assertLineHas(t *testing.T, out string, subs ...string) {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		ok := true
		for _, s := range subs {
			if !strings.Contains(line, s) {
				ok = false
				break
			}
		}
		if ok {
			return
		}
	}
	t.Fatalf("no line in output contains all of %v\n---\n%s", subs, out)
}
