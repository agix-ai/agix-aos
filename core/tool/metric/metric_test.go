package metric_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/tool/fs"
	"github.com/agix-ai/agix/core/tool/metric"
)

// report mirrors the tool's JSON output for assertions.
type report struct {
	FilesAnalyzed int            `json:"files_analyzed"`
	Languages     map[string]int `json:"languages"`
	Totals        struct {
		Classes    int `json:"classes"`
		Functions  int `json:"functions"`
		MaxNesting int `json:"max_nesting"`
	} `json:"totals"`
	Smells []struct {
		Kind        string `json:"kind"`
		Refactoring string `json:"refactoring"`
		Path        string `json:"path"`
		Unit        string `json:"unit"`
		Metric      string `json:"metric"`
		Value       int    `json:"value"`
	} `json:"smells"`
	Hotspots []struct {
		Path string `json:"path"`
	} `json:"hotspots"`
	Notes string `json:"notes"`
}

// The structural-metric tool returns real per-file/per-class metrics on a fixture
// tree, and its smell worklist flags a God class and a deep-nesting long method —
// the structural signals smell-scout hunts (SPEC §3.3). This is criterion (c).
func TestMetricStructuralSmells(t *testing.T) {
	root := t.TempDir()
	writeFile := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// A Go "God class": 22 receiver methods on Monster, each with a branch, plus a
	// deeply nested method — pushes method-count and WMC over threshold and nesting
	// past the deep-nesting limit.
	var b strings.Builder
	b.WriteString("package big\n\ntype Monster struct{}\n\n")
	for i := 0; i < 22; i++ {
		fmt.Fprintf(&b, "func (m *Monster) M%d() {\n\tif cond {\n\t\tprintln(%d)\n\t}\n}\n\n", i, i)
	}
	b.WriteString("func (m *Monster) Deep() {\n")
	for d := 0; d < 6; d++ {
		b.WriteString(strings.Repeat("\t", d+1) + "if c {\n")
	}
	b.WriteString(strings.Repeat("\t", 7) + "println(1)\n")
	for d := 6; d >= 1; d-- {
		b.WriteString(strings.Repeat("\t", d) + "}\n")
	}
	b.WriteString("}\n")
	writeFile("big.go", b.String())

	// A small TS class to exercise class detection in a second language.
	writeFile("widget.ts", "class Widget {\n  render() { if (x) { return 1 } }\n  update() {}\n}\n")

	tl, ok := metric.Tool("metric", fs.Workspace{Root: root})
	if !ok {
		t.Fatal("metric.Tool(metric) not found")
	}
	out, err := tl.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("metric execute: %v", err)
	}

	var rep report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse metric json: %v\n%s", err, out)
	}
	if rep.FilesAnalyzed < 2 {
		t.Errorf("files_analyzed = %d, want >= 2", rep.FilesAnalyzed)
	}
	if rep.Languages["go"] < 1 || rep.Languages["ts"] < 1 {
		t.Errorf("languages = %v, want go and ts", rep.Languages)
	}
	if rep.Totals.Classes < 2 {
		t.Errorf("totals.classes = %d, want >= 2 (Monster + Widget)", rep.Totals.Classes)
	}
	if rep.Totals.MaxNesting < 6 {
		t.Errorf("max_nesting = %d, want >= 6 (the Deep method)", rep.Totals.MaxNesting)
	}

	var gotGod, gotDeep bool
	for _, s := range rep.Smells {
		if s.Kind == "god_class" && s.Unit == "Monster" {
			gotGod = true
			if s.Refactoring == "" {
				t.Error("god_class smell must carry a refactoring mapping (§3.3)")
			}
		}
		if s.Kind == "deep_nesting" && strings.Contains(s.Unit, "Deep") {
			gotDeep = true
		}
	}
	if !gotGod {
		t.Errorf("expected a god_class smell for Monster; smells = %+v", rep.Smells)
	}
	if !gotDeep {
		t.Errorf("expected a deep_nesting smell for Deep; smells = %+v", rep.Smells)
	}
	if rep.Notes == "" {
		t.Error("report must carry the honest heuristic-limits note")
	}
}

// A clean, small file produces no structural smells — the tool does not cry wolf,
// so a campaign's before/after delta is meaningful.
func TestMetricCleanTreeNoSmells(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "ok.go"),
		[]byte("package ok\n\nfunc Add(a, b int) int { return a + b }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tl, _ := metric.Tool("metric", fs.Workspace{Root: root})
	out, err := tl.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("metric: %v", err)
	}
	var rep report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rep.Smells) != 0 {
		t.Errorf("clean tree should have no smells, got %+v", rep.Smells)
	}
}
