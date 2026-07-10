// Copyright 2026 Agix AI LLC. Apache-2.0.
package distill

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/kmstore"
)

func attestedLeaf(id, content, branch string, trust float64) kmstore.Leaf {
	return kmstore.Leaf{
		ID:         id,
		Content:    content,
		Branch:     branch,
		Author:     "agix/worker/surgeon-1",
		Verifier:   "agix/worker/verifier-1",
		TrustScore: trust,
		Attested:   true,
	}
}

func TestLeafToExample_CoarseApprove(t *testing.T) {
	l := attestedLeaf("bg-1",
		"Verdict APPROVE (2026-07-07) for extract-class-services/billing/foo.go:42 "+
			"[behavior=true structure=true tangling=false]: Extracted BillingCalculator from Invoice; moved 4 methods.",
		"software", 0.9)
	ex, ok := LeafToExample(l, DefaultSystem, 0.9)
	if !ok {
		t.Fatal("expected a coarse example from an APPROVE leaf")
	}
	if !strings.Contains(ex.Assistant, "Extracted BillingCalculator") {
		t.Fatalf("assistant = %q", ex.Assistant)
	}
	if ex.System != DefaultSystem {
		t.Fatal("system prompt not stamped")
	}
}

func TestLeafToExample_RefuseSkipped(t *testing.T) {
	l := attestedLeaf("bg-2",
		"Verdict REFUSE (2026-07-07) for foo [behavior=false structure=true tangling=false reason=behavior-changed]: reverted.",
		"software", 0.9)
	if _, ok := LeafToExample(l, DefaultSystem, 0.9); ok {
		t.Fatal("a REFUSE verdict must be skipped")
	}
}

func TestLeafToExample_LowTrustSkipped(t *testing.T) {
	l := attestedLeaf("bg-3", "Verdict APPROVE (d) for x [g]: some delta", "software", 0.5)
	if _, ok := LeafToExample(l, DefaultSystem, 0.9); ok {
		t.Fatal("a below-floor trust leaf must be skipped")
	}
}

func TestLeafToExample_UnattestedSkipped(t *testing.T) {
	l := kmstore.Leaf{ID: "x", Content: "Verdict APPROVE (d) for x [g]: delta", Verifier: "", TrustScore: 0.9}
	if _, ok := LeafToExample(l, DefaultSystem, 0.9); ok {
		t.Fatal("a leaf with no verifier must be skipped")
	}
}

func TestLeafToExample_Structured(t *testing.T) {
	cr := CertifiedRefactoring{
		Codebase:    "widgetco",
		Smell:       "God Class",
		Refactoring: "extract_class",
		Before:      "class Big { /* 40 methods */ }",
		After:       "class Big { /* 12 methods */ }\nclass Small { /* 28 methods */ }",
		Verdict:     "APPROVE",
	}
	b, _ := json.Marshal(cr)
	l := attestedLeaf("bg-4", string(b), "software", 0.9)
	ex, ok := LeafToExample(l, DefaultSystem, 0.9)
	if !ok {
		t.Fatal("a structured APPROVE record should map")
	}
	if ex.Codebase != "widgetco" {
		t.Fatalf("codebase = %q, want widgetco", ex.Codebase)
	}
	if !strings.Contains(ex.User, "God Class") || !strings.Contains(ex.Assistant, "class Small") {
		t.Fatalf("example did not carry the structured record: %+v", ex)
	}
}

func TestLeafToExample_EmbeddedJSON(t *testing.T) {
	// The behavior-guard convention: a prose summary, then the structured record on
	// its own line beneath it. The structured path must win (richer than the prose).
	cr := CertifiedRefactoring{
		Codebase:    "widgetco",
		Refactoring: "extract_class",
		After:       "Split SyncManager into SyncPlanner + SyncRunner.",
		Verdict:     "APPROVE",
		Rationale:   "WMC -11, behavior preserved, 14 tests green.",
	}
	b, _ := json.Marshal(cr)
	content := "Verdict APPROVE (2026-07-08) for split-class-widgetco/core [behavior=true structure=true tangling=false]: split it.\n\n" + string(b)
	l := attestedLeaf("bg-embed", content, "software", 0.9)

	ex, ok := LeafToExample(l, DefaultSystem, 0.9)
	if !ok {
		t.Fatal("an embedded JSON record should map via the structured path")
	}
	if ex.Codebase != "widgetco" {
		t.Fatalf("codebase = %q, want widgetco (from the embedded record, not the prose)", ex.Codebase)
	}
	if !strings.Contains(ex.Assistant, "SyncPlanner") || !strings.Contains(ex.Assistant, "WMC -11") {
		t.Fatalf("assistant missing change + rationale: %q", ex.Assistant)
	}
}

func TestSplitByCodebase_NoLeakAndDeterministic(t *testing.T) {
	var ex []Example
	for _, cb := range []string{"a", "b", "c", "d", "e"} {
		for i := 0; i < 3; i++ {
			ex = append(ex, Example{System: "s", User: "u", Assistant: "a", Codebase: cb})
		}
	}
	tr1, va1, te1 := SplitByCodebase(ex, 0.2, 0.2, 7)
	tr2, va2, te2 := SplitByCodebase(ex, 0.2, 0.2, 7)
	if len(tr1) != len(tr2) || len(va1) != len(va2) || len(te1) != len(te2) {
		t.Fatal("split is not deterministic for a fixed seed")
	}
	if len(tr1)+len(va1)+len(te1) != 15 {
		t.Fatalf("split lost examples: %d != 15", len(tr1)+len(va1)+len(te1))
	}
	// No codebase may appear in more than one bucket (leakage).
	bucketOf := map[string]string{}
	assign := func(rows []Example, name string) {
		for _, e := range rows {
			if prev, ok := bucketOf[e.Codebase]; ok && prev != name {
				t.Fatalf("codebase %q leaked across %q and %q", e.Codebase, prev, name)
			}
			bucketOf[e.Codebase] = name
		}
	}
	assign(tr1, "train")
	assign(va1, "valid")
	assign(te1, "test")
}

func TestExport_WritesValidChatJSONL(t *testing.T) {
	dir := t.TempDir()
	leaves := []kmstore.Leaf{
		attestedLeaf("1", "Verdict APPROVE (d) for extract-class-widgetco/svc/a.go:1 [g]: extracted A", "software", 0.9),
		attestedLeaf("2", "Verdict APPROVE (d) for extract-class-widgetco/svc/b.go:1 [g]: extracted B", "software", 0.9),
		attestedLeaf("3", "Verdict REFUSE (d) for c [g]: reverted", "software", 0.9), // skipped
	}
	st, err := Export(leaves, Options{OutDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if st.Examples != 2 || st.Skipped != 1 {
		t.Fatalf("stats = %+v, want Examples=2 Skipped=1", st)
	}
	if st.Train+st.Valid+st.Test != 2 {
		t.Fatalf("split totals = %d, want 2", st.Train+st.Valid+st.Test)
	}
	// Every written line must be a valid mlx-lm chat record.
	for _, name := range []string{"train", "valid", "test"} {
		data, err := os.ReadFile(filepath.Join(dir, name+".jsonl"))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line == "" {
				continue
			}
			var rec struct {
				Messages []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"messages"`
			}
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				t.Fatalf("%s: invalid json line: %v", name, err)
			}
			if len(rec.Messages) != 3 || rec.Messages[0].Role != "system" || rec.Messages[2].Role != "assistant" {
				t.Fatalf("%s: unexpected chat shape: %s", name, line)
			}
		}
	}
}
