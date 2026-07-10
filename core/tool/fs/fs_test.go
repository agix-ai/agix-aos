package fs_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/tool"
	"github.com/agix-ai/agix/core/tool/fs"
)

// fixture writes a small repo tree and returns its root. It includes a .git dir
// (which the bounded walk must skip) and files in several subtrees so boundary
// scoping has something to include and exclude.
func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("hello.txt", "hello world\nsecond line\n")
	write("src/app.go", "package src\n\nfunc Main() {\n\tif cond {\n\t\tprintln(\"x\")\n\t}\n}\n")
	write("src/util/helper.go", "package util\n\nfunc Help() string { return \"h\" }\n")
	write("wiki/investigator/prior.md", "old note\n")
	write(".git/config", "[core]\n")
	return root
}

func exec(t *testing.T, tl tool.Tool, args string) (string, error) {
	t.Helper()
	return tl.Execute(context.Background(), json.RawMessage(args))
}

func mustTool(t *testing.T, name string, ws fs.Workspace) tool.Tool {
	t.Helper()
	tl, ok := fs.Tool(name, ws)
	if !ok {
		t.Fatalf("fs.Tool(%q) not found", name)
	}
	return tl
}

// read honors the read boundary and refuses any path that escapes the repo root.
func TestReadBoundaryAndTraversal(t *testing.T) {
	root := fixture(t)
	ws := fs.Workspace{Root: root, Read: []string{"src/", "wiki/"}}
	read := mustTool(t, "read", ws)

	out, err := exec(t, read, `{"path":"src/app.go"}`)
	if err != nil {
		t.Fatalf("read src/app.go: %v", err)
	}
	if !strings.Contains(out, "func Main()") {
		t.Errorf("read returned %q, want the file contents", out)
	}

	// hello.txt is outside the read allowlist → denied (present on disk, but the
	// capability does not cover it).
	if _, err := exec(t, read, `{"path":"hello.txt"}`); err == nil {
		t.Error("read of a path outside the read boundary should be denied")
	}
	// Traversal out of the root is refused before any fs touch.
	for _, bad := range []string{`{"path":"../secret"}`, `{"path":"src/../../etc/passwd"}`, `{"path":""}`} {
		if _, err := exec(t, read, bad); err == nil {
			t.Errorf("read(%s) should be refused", bad)
		}
	}
}

// glob lists readable files, skips the .git noise dir, and filters by pattern.
func TestGlobDiscovers(t *testing.T) {
	root := fixture(t)
	glob := mustTool(t, "glob", fs.Workspace{Root: root}) // empty Read → whole tree

	all, err := exec(t, glob, `{}`) // the {}-tolerant path the mock loop drives
	if err != nil {
		t.Fatalf("glob {}: %v", err)
	}
	if !strings.Contains(all, "src/app.go") || !strings.Contains(all, "hello.txt") {
		t.Errorf("glob {} missing expected files:\n%s", all)
	}
	if strings.Contains(all, ".git/") {
		t.Errorf("glob must skip the .git noise dir, got:\n%s", all)
	}

	gos, err := exec(t, glob, `{"pattern":"**/*.go"}`)
	if err != nil {
		t.Fatalf("glob **/*.go: %v", err)
	}
	if !strings.Contains(gos, "src/app.go") || !strings.Contains(gos, "src/util/helper.go") {
		t.Errorf("glob **/*.go missing .go files:\n%s", gos)
	}
	if strings.Contains(gos, "hello.txt") {
		t.Errorf("glob **/*.go should not match hello.txt:\n%s", gos)
	}
}

// grep finds matching lines with path:line:text, and requires a pattern.
func TestGrepSearches(t *testing.T) {
	root := fixture(t)
	grep := mustTool(t, "grep", fs.Workspace{Root: root})

	out, err := exec(t, grep, `{"pattern":"func "}`)
	if err != nil {
		t.Fatalf("grep: %v", err)
	}
	if !strings.Contains(out, "src/app.go:3:") {
		t.Errorf("grep missing app.go match:\n%s", out)
	}
	if _, err := exec(t, grep, `{}`); err == nil {
		t.Error("grep with no pattern should error")
	}
}

// walk (the repo-walk) enumerates readable files with line/byte counts + a total.
func TestWalkEnumerates(t *testing.T) {
	root := fixture(t)
	walk := mustTool(t, "walk", fs.Workspace{Root: root})
	out, err := exec(t, walk, `{}`)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if !strings.Contains(out, "files,") || !strings.Contains(out, "src/app.go") {
		t.Errorf("walk output unexpected:\n%s", out)
	}
	if strings.Contains(out, ".git/config") {
		t.Errorf("walk must skip .git:\n%s", out)
	}
}

// write is REFUSED outside the write boundary and inside a deny path, and permitted
// where the write allowlist covers the path. This is criterion (b).
func TestWriteBoundaryRefused(t *testing.T) {
	root := fixture(t)
	ws := fs.Workspace{
		Root:  root,
		Write: []string{"wiki/investigator/"},
		Deny:  []string{"wiki/investigator/protected.md", "git push"},
	}
	write := mustTool(t, "write", ws)

	// Inside the write allowlist → permitted.
	if _, err := exec(t, write, `{"path":"wiki/investigator/out.md","content":"new"}`); err != nil {
		t.Fatalf("write inside boundary: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "wiki/investigator/out.md")); string(b) != "new" {
		t.Errorf("write did not land, got %q", string(b))
	}

	// Outside the write allowlist → REFUSED and never touches disk.
	if _, err := exec(t, write, `{"path":"src/app.go","content":"HACKED"}`); err == nil {
		t.Error("write outside the boundary must be refused")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "src/app.go")); strings.Contains(string(b), "HACKED") {
		t.Fatal("REFUSED write must not have mutated the file")
	}

	// A path-style deny entry vetoes even inside the write allowlist.
	if _, err := exec(t, write, `{"path":"wiki/investigator/protected.md","content":"x"}`); err == nil {
		t.Error("write to a denied path must be refused")
	}

	// A spec that declares write but no write boundary is deny-by-default.
	noWrite := mustTool(t, "write", fs.Workspace{Root: root})
	if _, err := exec(t, noWrite, `{"path":"anything.md","content":"x"}`); err == nil {
		t.Error("write with no write boundary should deny by default")
	}
}

// A GOVERNED worker bee running the tested tool-use loop invokes `read` and threads
// the real file contents back into its transcript. This is criterion (a), proven
// precisely (a scripted provider drives read with a real path), complementing the
// end-to-end fleet test where the mock provider drives glob under the swarm.
func TestGovernedBeeThreadsReadResult(t *testing.T) {
	root := fixture(t)
	reg, err := tool.New(mustTool(t, "read", fs.Workspace{Root: root, Read: []string{"src/"}}))
	if err != nil {
		t.Fatalf("registry: %v", err)
	}

	// The bee's model: call 0 asks to read src/app.go; call 1 answers.
	sp := &mock.Scripted{
		Named: "mock",
		Caps:  router.Capabilities{ToolUse: true},
		Reply: func(_ router.ChatRequest, call int) (router.ChatResponse, error) {
			if call == 0 {
				return router.ChatResponse{ToolCalls: []router.ToolCall{{
					ID: "c1", Name: "read", Args: json.RawMessage(`{"path":"src/app.go"}`),
				}}}, nil
			}
			return router.ChatResponse{Text: "done"}, nil
		},
	}
	r := router.NewRouter()
	r.Register(sp)
	r.ForceProvider("mock")

	ag := &agent.Agent{Name: "agix/worker/forager-1", Router: r, Leases: coord.NewMemLedger()}
	res, err := ag.Run(context.Background(), agent.Task{Name: "read-it", Prompt: "read the app", Tools: reg})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %d, want 1 (the read)", len(res.ToolCalls))
	}
	inv := res.ToolCalls[0]
	if inv.Name != "read" || inv.IsError {
		t.Fatalf("invocation = %+v, want a successful read", inv)
	}
	if !strings.Contains(inv.Result, "func Main()") {
		t.Errorf("threaded result = %q, want the file contents", inv.Result)
	}
}
