package ledger_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/ledger"
)

func TestAppendReadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	l, err := ledger.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	entries := []ledger.Entry{
		{Kind: ledger.KindAgentStart, Agent: "bee-1", Data: map[string]any{"task": "t"}},
		{Kind: ledger.KindModelCall, Agent: "bee-1", Data: map[string]any{"cost_usd": 0.0}},
		{Kind: ledger.KindAgentDone, Agent: "bee-1"},
	}
	for _, e := range entries {
		if err := l.Append(e); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	got, err := l.Read("", time.Time{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("read %d entries, want 3", len(got))
	}
	if got[0].Kind != ledger.KindAgentStart || got[0].Agent != "bee-1" {
		t.Errorf("first entry = %+v", got[0])
	}
}

func TestReadKindFilter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	l, _ := ledger.Open(path)
	_ = l.Append(ledger.Entry{Kind: ledger.KindAgentStart, Agent: "a"})
	_ = l.Append(ledger.Entry{Kind: ledger.KindModelCall, Agent: "a"})
	_ = l.Append(ledger.Entry{Kind: ledger.KindModelCall, Agent: "a"})
	got, err := l.Read(ledger.KindModelCall, time.Time{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("kind filter returned %d, want 2", len(got))
	}
}

func TestReadSinceFilter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	l, _ := ledger.Open(path)
	old := time.Now().UTC().Add(-time.Hour)
	_ = l.Append(ledger.Entry{TS: old, Kind: ledger.KindAgentStart, Agent: "a"})
	cutoff := time.Now().UTC().Add(-time.Minute)
	_ = l.Append(ledger.Entry{Kind: ledger.KindAgentDone, Agent: "a"}) // now
	got, err := l.Read("", cutoff)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got) != 1 || got[0].Kind != ledger.KindAgentDone {
		t.Fatalf("since filter = %+v, want just agent_done", got)
	}
}

// TestAppendRedactsSecrets is the SECURITY regression for BUG 1: a provider
// error string that embeds an API key (the exact shape agent.go writes on a
// transport failure) must be redacted before it persists to the append-only,
// committed, ingested audit ledger — the EgressScanner is wired into Append.
func TestAppendRedactsSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	l, err := ledger.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	const key = "AIzaSyLEAK0123456789abcdefghijklmnopqrs" // fake google key shape
	leakURL := "gemini: http: Post \"https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=" + key + "\": dial tcp: i/o timeout"

	if err := l.Append(ledger.Entry{
		Kind:  ledger.KindAgentDone,
		Agent: "forager-1",
		Data:  map[string]any{"ok": false, "error": leakURL},
	}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// The raw bytes on disk must not contain the key.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if strings.Contains(string(raw), key) {
		t.Fatalf("SECURITY: ledger persisted the API key in plaintext:\n%s", raw)
	}
	if !strings.Contains(string(raw), "[REDACTED:google-api-key]") {
		t.Fatalf("expected a [REDACTED:google-api-key] marker, got:\n%s", raw)
	}

	// The redacted line must still parse as valid JSON (Read round-trips it).
	got, err := l.Read("", time.Time{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("read %d entries, want 1", len(got))
	}
	if s, _ := got[0].Data["error"].(string); strings.Contains(s, key) || !strings.Contains(s, "[REDACTED:google-api-key]") {
		t.Fatalf("round-tripped error field not redacted: %q", s)
	}
}

func TestReadMissingFileEmpty(t *testing.T) {
	l, _ := ledger.Open(filepath.Join(t.TempDir(), "nope.jsonl"))
	got, err := l.Read("", time.Time{})
	if err != nil {
		t.Fatalf("Read missing: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("missing file should read empty, got %d", len(got))
	}
}
