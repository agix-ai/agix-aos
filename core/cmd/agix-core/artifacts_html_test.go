// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/ledger"
)

// externalRefs matches anything that would break the receipt's self-contained /
// strict-CSP contract: an http(s) URL, a protocol-relative src, or an external
// <script>/<link> reference. The receipt must contain NONE of these.
var externalRefs = regexp.MustCompile(`(?i)https?://|src\s*=\s*["']//|<script\b|<link\b[^>]*\bhref`)

// ── the HTML renderer over a distinct (APPROVED) run ──────────────────────────

func TestRenderReceiptHTMLDistinct(t *testing.T) {
	c := newClk()
	entries := bracketed(c, "run-html-ok", "review the auth module for bugs", "", "swarm",
		func(c *clk) []ledger.Entry { return swarmRun(c, "run-html-ok", true) })
	html := renderReceiptHTML(*oneReceipt(t, entries))

	mustContainAll(t, html, []string{
		"<!doctype html>",
		"Governance Receipt",
		"review the auth module for bugs", // task
		"run-html-ok",                     // run id
		"agix/worker/forager-1",           // an actor
		"agix/worker/verifier-1",          // the distinct verifier
		"DISTINCT",                        // the hero badge
		"actor &ne; verifier",             // centerpiece
		"APPROVED",                        // verdict
		"Cost &amp; tokens",               // cost section
		"Timeline",                        // timeline section
	})
	if strings.Contains(html, "VIOLATION") {
		t.Errorf("distinct run must not render a VIOLATION badge")
	}
	assertSelfContained(t, html)
}

// ── the HTML renderer over a VIOLATION run (the loud red path) ─────────────────

func TestRenderReceiptHTMLViolation(t *testing.T) {
	c := newClk()
	// forager-1 both produces work and ratifies it → actor == verifier.
	entries := []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock"}),
		c.ent("agent_start", "agix/worker/forager-1", map[string]any{"task": "st-1", "capability": "cheap"}),
		c.ent("lease_claim", "agix/worker/forager-1", map[string]any{"lease": "lease-0001", "scope": []any{"agix/swarm/run-viol/subtask/st-1"}}),
		c.ent("model_call", "agix/worker/forager-1", map[string]any{"model": "mock", "input_tokens": 10.0, "output_tokens": 5.0}),
		c.ent("agent_done", "agix/worker/forager-1", map[string]any{"ok": true}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
		c.ent("ratify", "agix/worker/forager-1", map[string]any{"approved": true, "by": "agix/worker/forager-1", "gate": "ratify"}),
	}
	html := renderReceiptHTML(*oneReceipt(t, entries))

	mustContainAll(t, html, []string{
		"VIOLATION",                      // the red badge
		"actor also verified",            // the badge text
		"rc-violation",                   // the red hero css class
		"agix/worker/forager-1",          // the offending agent
		"ratified work it also produced", // the loud violation row
	})
	assertSelfContained(t, html)
}

// ── HTML-escaping: a hostile ledger value must be inert ────────────────────────

func TestRenderReceiptHTMLEscapesLedgerText(t *testing.T) {
	c := newClk()
	const evil = `<script>alert('xss')</script> & "quoted" <b>bold</b>`
	entries := bracketed(c, "run-xss", evil, "", "swarm",
		func(c *clk) []ledger.Entry { return swarmRun(c, "run-xss", true) })
	html := renderReceiptHTML(*oneReceipt(t, entries))

	// The raw task must NOT appear verbatim anywhere.
	if strings.Contains(html, "<script>alert") {
		t.Fatalf("raw <script> from a ledger task leaked into the HTML unescaped")
	}
	// It must appear ESCAPED.
	for _, want := range []string{"&lt;script&gt;", "&amp;", "&quot;", "&lt;b&gt;bold"} {
		if !strings.Contains(html, want) {
			t.Errorf("expected escaped fragment %q in output", want)
		}
	}
	// And still self-contained (the escaped <script> must not trip the scanner).
	assertSelfContained(t, html)
}

// ── escaping applies to agent names / notes too ───────────────────────────────

func TestRenderReceiptHTMLEscapesAgentAndNotes(t *testing.T) {
	c := newClk()
	entries := []ledger.Entry{
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "decompose", "model": "mock"}),
		c.ent("agent_start", "<img src=x>", map[string]any{"task": "st-1"}),
		c.ent("lease_claim", "<img src=x>", map[string]any{"lease": "l1", "scope": []any{"agix/swarm/run-esc/subtask/st-1"}}),
		c.ent("model_call", "<img src=x>", map[string]any{"model": "mock"}),
		c.ent("agent_done", "<img src=x>", map[string]any{"ok": true}),
		c.ent("model_call", "agix/queen/root", map[string]any{"role": "queen", "phase": "synthesize", "model": "mock"}),
		c.ent("gate_pause", "ratify", map[string]any{"node": "ratify"}),
		c.ent("model_call", "verifier-x", map[string]any{"role": "verifier", "phase": "verify", "model": "mock"}),
		c.ent("ratify", "verifier-x", map[string]any{"approved": false, "by": "verifier-x", "notes": `rejected: <b>bad</b> & unsafe`}),
	}
	html := renderReceiptHTML(*oneReceipt(t, entries))
	if strings.Contains(html, "<img src=x>") {
		t.Errorf("raw agent name leaked unescaped")
	}
	if !strings.Contains(html, "&lt;img src=x&gt;") {
		t.Errorf("agent name not escaped in chips/timeline")
	}
	if strings.Contains(html, "<b>bad</b>") || !strings.Contains(html, "&lt;b&gt;bad&lt;/b&gt;") {
		t.Errorf("verdict notes not escaped")
	}
	assertSelfContained(t, html)
}

// ── CLI surface: --out - to stdout ────────────────────────────────────────────

func TestCmdArtifactsHTMLToStdout(t *testing.T) {
	c := newClk()
	path := writeLedger(t, swarmRun(c, "run-stdout", true))
	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"run-stdout", "--html", "--out", "-", "--ledger", path})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0; out:\n%s", code, out)
	}
	if !strings.HasPrefix(strings.TrimSpace(out), "<!doctype html>") {
		t.Errorf("--out - should write the HTML document to stdout; got:\n%s", out[:min(120, len(out))])
	}
	if !strings.Contains(out, "DISTINCT") {
		t.Errorf("stdout HTML missing the DISTINCT badge")
	}
	assertSelfContained(t, out)
}

// ── CLI surface: default path created under .agix/receipts/ ───────────────────

func TestCmdArtifactsHTMLDefaultPath(t *testing.T) {
	c := newClk()
	dir := t.TempDir()
	ledgerFile := filepath.Join(dir, "ledger.jsonl")
	writeLedgerAt(t, ledgerFile, swarmRun(c, "run-defpath", true))

	out, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"run-defpath", "--html", "--ledger", ledgerFile})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0; out:\n%s", code, out)
	}
	want := filepath.Join(dir, "receipts", "run-defpath.html")
	if !strings.Contains(out, want) {
		t.Errorf("expected the written path %q printed; got:\n%s", want, out)
	}
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("default receipt not written under receipts/: %v", err)
	}
	if !strings.Contains(string(data), "<!doctype html>") {
		t.Errorf("written file is not an HTML document")
	}
	assertSelfContained(t, string(data))
}

// ── CLI surface: --out <file> writes there and --out implies --html ───────────

func TestCmdArtifactsHTMLOutImpliesHTML(t *testing.T) {
	c := newClk()
	dir := t.TempDir()
	ledgerFile := filepath.Join(dir, "ledger.jsonl")
	writeLedgerAt(t, ledgerFile, swarmRun(c, "run-outfile", true))
	dest := filepath.Join(dir, "nested", "receipt.html")

	// No --html flag — --out alone must imply it.
	_, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"run-outfile", "--out", dest, "--ledger", ledgerFile})
	})
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("--out target not written (nested dir not created?): %v", err)
	}
	if !strings.Contains(string(data), "run-outfile") {
		t.Errorf("written receipt missing run id")
	}
}

// --html + --list is rejected (HTML is a single-run renderer).
func TestCmdArtifactsHTMLRejectsList(t *testing.T) {
	c := newClk()
	path := writeLedger(t, swarmRun(c, "run-x", true))
	_, code := captureStdout(t, func() int {
		return cmdArtifacts([]string{"--list", "--html", "--ledger", path})
	})
	if code != 2 {
		t.Errorf("exit = %d, want 2 for --html --list", code)
	}
}

// safeFilename must never yield a path separator (default path can't escape dir).
func TestSafeFilename(t *testing.T) {
	cases := map[string]string{
		"run-777":                "run-777",
		"hive/cli/mock":          "hive-cli-mock",
		"agix/swarm/run/subtask": "agix-swarm-run-subtask",
		"":                       "receipt",
		"../../etc/passwd":       "etc-passwd",
		"a:b*c?d":                "a-b-c-d",
	}
	for in, want := range cases {
		if got := safeFilename(in); got != want {
			t.Errorf("safeFilename(%q) = %q, want %q", in, got, want)
		}
		if strings.ContainsAny(safeFilename(in), `/\`) {
			t.Errorf("safeFilename(%q) leaked a separator: %q", in, safeFilename(in))
		}
	}
}

// commafy sanity.
func TestCommafy(t *testing.T) {
	for in, want := range map[int]string{0: "0", 517: "517", 1234: "1,234", 1000000: "1,000,000"} {
		if got := commafy(in); got != want {
			t.Errorf("commafy(%d) = %q, want %q", in, got, want)
		}
	}
}

// embedImageDataURI embeds a small local raster image, and refuses non-images.
func TestEmbedImageDataURI(t *testing.T) {
	dir := t.TempDir()
	// A tiny valid-enough PNG payload (bytes, not a real decode — size/ext gate only).
	png := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(png, []byte("\x89PNG\r\n\x1a\nfake-but-small"), 0o644); err != nil {
		t.Fatal(err)
	}
	if uri, ok := embedImageDataURI(png); !ok || !strings.HasPrefix(uri, "data:image/png;base64,") {
		t.Errorf("small png not embedded as data uri: ok=%v uri=%.40q", ok, uri)
	}
	txt := filepath.Join(dir, "notes.txt")
	os.WriteFile(txt, []byte("hi"), 0o644)
	if _, ok := embedImageDataURI(txt); ok {
		t.Errorf("non-image should not be embedded")
	}
	if _, ok := embedImageDataURI(filepath.Join(dir, "missing.png")); ok {
		t.Errorf("missing file should not be embedded")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func assertSelfContained(t *testing.T, html string) {
	t.Helper()
	if m := externalRefs.FindString(html); m != "" {
		t.Errorf("receipt is NOT self-contained — found external ref %q", m)
	}
	if strings.Contains(html, "src=\"//") {
		t.Errorf("receipt contains a protocol-relative src")
	}
}

func mustContainAll(t *testing.T, s string, wants []string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(s, w) {
			t.Errorf("output missing %q", w)
		}
	}
}

// writeLedgerAt writes fixture entries to an explicit path (so a test can control
// the ledger's directory and assert the default receipts/ path beside it).
func writeLedgerAt(t *testing.T, path string, entries []ledger.Entry) {
	t.Helper()
	var b strings.Builder
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal fixture entry: %v", err)
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write fixture ledger: %v", err)
	}
}
