// Package fs is the reborn fleet's bounded-filesystem tool catalog: the concrete
// tool.Tool implementations that turn a manifest's `tools: ["read","grep","glob",
// "write"]` from a name into a real, GOVERNED capability. Until now a worker bee
// offered those names had nothing behind them (only model providers registered);
// it could reason from the task brief but never touch a repo. These tools close
// that gap.
//
// The governance model is the guard-bee capability boundary
// (project-agix-guard-bee-secrets): a bee never holds raw filesystem access, it
// holds a boundary-scoped TOOL. Every tool is constructed with a Workspace — a
// repo Root that every path resolves under (no `..` escape) plus the agent's
// guard-bee boundary (read/write allow-globs and a deny list lifted verbatim from
// the spec's Boundary). Read tools honor Read; write honors Write and is
// deny-by-default (the risky capability); Deny path-globs veto both. An op-style
// deny entry ("git push") simply never matches a path, so a spec can mix path and
// operation denies in one list, exactly as the ported manifests do.
//
// It is a stdlib-plus-core/tool leaf — it imports only encoding/json, the os/path
// stdlib, and core/tool for the interface — so nothing in the engine pulls a
// dependency to gain repo capability, and metric (the structural analyzer) builds
// on the same Workspace without an import cycle.
//
// First-cut honesty: glob/grep support `*`/`?`/`**` (via path.Match per segment,
// `**` spanning separators); character-class globs and .gitignore parsing are not
// modeled — a fixed VCS/build ignore set stands in. See the package tests.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/agix-ai/agix/core/tool"
)

// Default output caps. A tool result is threaded back into a model turn, so an
// unbounded dump would blow the context budget; every tool truncates with an
// honest marker instead.
const (
	defaultReadCap = 64 * 1024 // bytes returned by read before truncation
	defaultGlobMax = 500       // paths returned by glob
	defaultGrepMax = 200       // match lines returned by grep
	defaultWalkMax = 2000      // entries returned by walk
	maxScanBytes   = 1 << 20   // per-file bytes grep/metric will scan
)

// ignoredDirs is the fixed VCS/build/noise set the bounded walk skips. It stands
// in for .gitignore parsing (a documented first-cut limit): the sidecar model
// symlinks the target as repo/, so this list is about not foraging our own or the
// tooling's plumbing, not about honoring the target's ignore rules precisely.
var ignoredDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true, "dist": true, "build": true,
	".next": true, ".cache": true, ".venv": true, "venv": true,
	"__pycache__": true, "target": true, ".agix": true, ".idea": true,
}

// Workspace is the boundary-scoped capability every filesystem tool holds. The
// tool IS the capability: it can only touch what the Workspace permits, so a bee
// never holds raw fs access. Root is the repo the run is scoped to (the sidecar
// `--repoRoot`); Read/Write/Deny are the agent's guard-bee boundary, lifted from
// its spec's Boundary. Empty Read means the whole tree is readable; empty Write
// means writes are denied (deny-by-default for the risky capability).
type Workspace struct {
	Root  string   // repo root; every path resolves under it (default ".")
	Read  []string // read-allow globs relative to Root; empty = whole tree readable
	Write []string // write-allow globs relative to Root; empty = writes denied
	Deny  []string // deny path-globs; op-style entries (e.g. "git push") never match a path
}

// Tool returns the boundary-scoped filesystem tool registered under name, and
// whether name is a known filesystem tool. Unknown names return (nil, false) so a
// resolver can fall through to other builtins (e.g. metric) or report the name
// unresolved — mirroring the runner's "declared-but-un-ported is reported, not
// fatal" posture. "list" is an alias for "walk" (the repo-walk enumeration).
func Tool(name string, ws Workspace) (tool.Tool, bool) {
	switch strings.TrimSpace(name) {
	case "read":
		return readTool{ws: ws}, true
	case "glob":
		return globTool{ws: ws}, true
	case "grep":
		return grepTool{ws: ws}, true
	case "walk", "list":
		return walkTool{ws: ws}, true
	case "write":
		return writeTool{ws: ws}, true
	}
	return nil, false
}

// ── Workspace: path resolution + boundary predicates ─────────────────────────

// RootAbs returns the cleaned, absolute repo root (default "." → the cwd). It is
// the anchor every resolve() is confined to.
func (w Workspace) RootAbs() (string, error) {
	r := strings.TrimSpace(w.Root)
	if r == "" {
		r = "."
	}
	abs, err := filepath.Abs(r)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// resolve validates a model-supplied path and returns its absolute form and its
// clean slash-relative form (for boundary matching). It rejects any path that
// escapes Root — a `..` traversal or an absolute path outside the tree — so no
// tool can ever forage beyond the workspace.
func (w Workspace) resolve(p string) (abs, rel string, err error) {
	root, err := w.RootAbs()
	if err != nil {
		return "", "", err
	}
	p = strings.TrimSpace(p)
	if p == "" {
		return "", "", fmt.Errorf("path is required")
	}
	var cand string
	if filepath.IsAbs(p) {
		cand = filepath.Clean(p)
	} else {
		cand = filepath.Clean(filepath.Join(root, filepath.FromSlash(p)))
	}
	rel, rerr := filepath.Rel(root, cand)
	if rerr != nil {
		return "", "", fmt.Errorf("path %q is outside the repo root", p)
	}
	rel = filepath.ToSlash(rel)
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", "", fmt.Errorf("path %q escapes the repo root", p)
	}
	if rel == "." {
		rel = ""
	}
	return cand, rel, nil
}

// readable reports whether rel may be READ under this boundary: not denied, and
// either no Read boundary is declared (whole tree readable) or rel is covered by
// a Read glob.
func (w Workspace) readable(rel string) bool {
	if w.denied(rel) {
		return false
	}
	if len(w.Read) == 0 {
		return true
	}
	return coveredByAny(w.Read, rel)
}

// writable reports whether rel may be WRITTEN under this boundary: not denied and
// covered by a Write glob. An empty Write boundary denies every write — deny by
// default for the one capability that mutates the tree.
func (w Workspace) writable(rel string) bool {
	if w.denied(rel) {
		return false
	}
	return coveredByAny(w.Write, rel)
}

// denied reports whether rel matches any Deny path-glob. Op-style deny entries
// ("git push") never match a path, so they are inert here (enforced, advisorily,
// elsewhere) while path-style entries ("repo/CLAUDE.md", "repo/.claude/") veto.
func (w Workspace) denied(rel string) bool { return coveredByAny(w.Deny, rel) }

// ReadFileRel reads a boundary-checked file by its slash-relative path, capped at
// maxScanBytes. It is the shared read the metric analyzer reuses so it inherits
// the exact same boundary as the read tool.
func (w Workspace) ReadFileRel(rel string) ([]byte, error) {
	abs, clean, err := w.resolve(rel)
	if err != nil {
		return nil, err
	}
	if !w.readable(clean) {
		return nil, fmt.Errorf("read denied by boundary: %s", clean)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if len(data) > maxScanBytes {
		data = data[:maxScanBytes]
	}
	return data, nil
}

// WalkReadable calls fn for every READABLE regular file under the given relative
// subtree (empty = whole root), skipping VCS/build noise directories. It is the
// shared bounded repo-walk the glob/grep/walk tools and the metric tool all build
// on, so one boundary decision governs every enumeration. fn receives the file's
// slash-relative path and byte size; returning an error stops the walk.
func (w Workspace) WalkReadable(subtree string, fn func(rel string, size int64) error) error {
	root, err := w.RootAbs()
	if err != nil {
		return err
	}
	base := root
	if s := strings.TrimSpace(subtree); s != "" {
		abs, clean, rerr := w.resolve(s)
		if rerr != nil {
			return rerr
		}
		if !w.readable(clean) {
			return fmt.Errorf("read denied by boundary: %s", clean)
		}
		base = abs
	}
	return filepath.WalkDir(base, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // heals: skip an unreadable entry rather than abort the walk
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if ignoredDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if !w.readable(rel) {
			return nil
		}
		info, ierr := d.Info()
		var size int64
		if ierr == nil {
			size = info.Size()
		}
		return fn(rel, size)
	})
}

// ── glob matching ────────────────────────────────────────────────────────────

// coveredByAny reports whether rel is covered by any pattern in globs.
func coveredByAny(globs []string, rel string) bool {
	for _, p := range globs {
		if covers(p, rel) {
			return true
		}
	}
	return false
}

// covers reports whether rel (slash-relative) is covered by one boundary pattern.
// A pattern that names a directory (trailing "/", or a plain path with no glob
// metacharacter) covers its whole subtree; a plain path also matches that exact
// file. Otherwise glob semantics apply, with "**" spanning separators.
func covers(pattern, rel string) bool {
	pattern = strings.TrimSpace(filepath.ToSlash(pattern))
	if pattern == "" {
		return false
	}
	if pattern == "." || pattern == "./" {
		return true // the repo root itself → the whole readable tree
	}
	if strings.HasSuffix(pattern, "/") {
		pre := strings.TrimSuffix(pattern, "/")
		return rel == pre || strings.HasPrefix(rel, pre+"/")
	}
	if !strings.ContainsAny(pattern, "*?[") {
		return rel == pattern || strings.HasPrefix(rel, pattern+"/")
	}
	return globMatch(pattern, rel)
}

// globMatch matches name against a slash-separated pattern where "**" matches
// zero or more path segments and each remaining segment is matched by path.Match
// (so "*"/"?"/"[…]" apply WITHIN a segment, never across "/").
func globMatch(pattern, name string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func matchSegments(pat, name []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			if len(pat) == 1 {
				return true
			}
			for i := 0; i <= len(name); i++ {
				if matchSegments(pat[1:], name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		if ok, _ := path.Match(pat[0], name[0]); !ok {
			return false
		}
		pat, name = pat[1:], name[1:]
	}
	return len(name) == 0
}

// ── input schemas ────────────────────────────────────────────────────────────

var (
	schemaRead  = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"repo-relative file path to read"}},"required":["path"]}`)
	schemaGlob  = json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string","description":"glob (e.g. **/*.go); empty lists all files"},"path":{"type":"string","description":"optional subtree to scope the listing"}}}`)
	schemaGrep  = json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string","description":"RE2 regular expression to search for"},"path":{"type":"string","description":"optional subtree to scope the search"},"glob":{"type":"string","description":"optional filename glob to filter files"}},"required":["pattern"]}`)
	schemaWalk  = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"optional subtree to enumerate; empty walks the whole repo"}}}`)
	schemaWrite = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"repo-relative file path to write"},"content":{"type":"string","description":"full file contents to write"}},"required":["path","content"]}`)
)

// ── read ─────────────────────────────────────────────────────────────────────

type readTool struct{ ws Workspace }

func (t readTool) Name() string { return "read" }
func (t readTool) Description() string {
	return "Read one repository file's contents. Args: {\"path\":\"relative/path\"}. Read-only and scoped to the agent's boundary; large files are truncated."
}
func (t readTool) InputSchema() json.RawMessage { return schemaRead }
func (t readTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(args, &in)
	abs, rel, err := t.ws.resolve(in.Path)
	if err != nil {
		return "", err
	}
	if !t.ws.readable(rel) {
		return "", fmt.Errorf("read denied by boundary: %s", rel)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory (use glob or walk)", rel)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	truncated := false
	if len(data) > defaultReadCap {
		data, truncated = data[:defaultReadCap], true
	}
	out := string(data)
	if truncated {
		out += fmt.Sprintf("\n…[truncated at %dKB]", defaultReadCap/1024)
	}
	return out, nil
}

// ── glob ─────────────────────────────────────────────────────────────────────

type globTool struct{ ws Workspace }

func (t globTool) Name() string { return "glob" }
func (t globTool) Description() string {
	return "List repository files matching a glob. Args: {\"pattern\":\"**/*.go\",\"path\":\"optional/subtree\"}. Empty pattern lists every readable file. Results are boundary-scoped and capped."
}
func (t globTool) InputSchema() json.RawMessage { return schemaGlob }
func (t globTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
	}
	_ = json.Unmarshal(args, &in)
	pattern := strings.TrimSpace(in.Pattern)
	var matches []string
	capped := false
	err := t.ws.WalkReadable(in.Path, func(rel string, _ int64) error {
		if pattern != "" && !globMatch(pattern, rel) {
			if ok, _ := path.Match(pattern, path.Base(rel)); !ok {
				return nil
			}
		}
		matches = append(matches, rel)
		if len(matches) >= defaultGlobMax {
			capped = true
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(matches)
	if len(matches) == 0 {
		return "(no files matched)", nil
	}
	out := strings.Join(matches, "\n")
	if capped {
		out += fmt.Sprintf("\n…[capped at %d paths]", defaultGlobMax)
	}
	return out, nil
}

// ── grep ─────────────────────────────────────────────────────────────────────

type grepTool struct{ ws Workspace }

func (t grepTool) Name() string { return "grep" }
func (t grepTool) Description() string {
	return "Search repository file contents by RE2 regular expression. Args: {\"pattern\":\"regex\",\"path\":\"optional/subtree\",\"glob\":\"optional *.ts filter\"}. Returns path:line:text, boundary-scoped and capped."
}
func (t grepTool) InputSchema() json.RawMessage { return schemaGrep }
func (t grepTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
		Glob    string `json:"glob"`
	}
	_ = json.Unmarshal(args, &in)
	if strings.TrimSpace(in.Pattern) == "" {
		return "", fmt.Errorf("pattern is required")
	}
	re, err := regexp.Compile(in.Pattern)
	if err != nil {
		return "", fmt.Errorf("invalid regexp: %v", err)
	}
	fileGlob := strings.TrimSpace(in.Glob)
	var hits []string
	capped := false
	werr := t.ws.WalkReadable(in.Path, func(rel string, _ int64) error {
		if fileGlob != "" {
			if ok, _ := path.Match(fileGlob, path.Base(rel)); !ok {
				return nil
			}
		}
		data, rerr := t.ws.ReadFileRel(rel)
		if rerr != nil || isBinary(data) {
			return nil
		}
		for i, line := range strings.Split(string(data), "\n") {
			if re.MatchString(line) {
				hits = append(hits, fmt.Sprintf("%s:%d:%s", rel, i+1, strings.TrimRight(line, "\r")))
				if len(hits) >= defaultGrepMax {
					capped = true
					return filepath.SkipAll
				}
			}
		}
		return nil
	})
	if werr != nil {
		return "", werr
	}
	if len(hits) == 0 {
		return "(no matches)", nil
	}
	out := strings.Join(hits, "\n")
	if capped {
		out += fmt.Sprintf("\n…[capped at %d matches]", defaultGrepMax)
	}
	return out, nil
}

// ── walk (repo-walk / list) ──────────────────────────────────────────────────

type walkTool struct{ ws Workspace }

func (t walkTool) Name() string { return "walk" }
func (t walkTool) Description() string {
	return "Enumerate a repository subtree (the bounded repo-walk). Args: {\"path\":\"optional/subtree\"}. Returns each readable file with its line count and size, plus a total, boundary-scoped and capped."
}
func (t walkTool) InputSchema() json.RawMessage { return schemaWalk }
func (t walkTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(args, &in)
	var lines []string
	var files int
	var totalLOC int
	capped := false
	err := t.ws.WalkReadable(in.Path, func(rel string, size int64) error {
		loc := 0
		if data, rerr := t.ws.ReadFileRel(rel); rerr == nil && !isBinary(data) {
			loc = countLines(data)
		}
		files++
		totalLOC += loc
		lines = append(lines, fmt.Sprintf("%s\t%dL\t%dB", rel, loc, size))
		if len(lines) >= defaultWalkMax {
			capped = true
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(lines)
	header := fmt.Sprintf("%d files, %d lines", files, totalLOC)
	if capped {
		header += fmt.Sprintf(" (listing capped at %d)", defaultWalkMax)
	}
	if files == 0 {
		return "(empty subtree)", nil
	}
	return header + "\n" + strings.Join(lines, "\n"), nil
}

// ── write ────────────────────────────────────────────────────────────────────

type writeTool struct{ ws Workspace }

func (t writeTool) Name() string { return "write" }
func (t writeTool) Description() string {
	return "Write (create or replace) one repository file. Args: {\"path\":\"relative/path\",\"content\":\"…\"}. REFUSED unless the path is inside the agent's write boundary and not denied."
}
func (t writeTool) InputSchema() json.RawMessage { return schemaWrite }
func (t writeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &in); err != nil && len(args) > 0 {
		return "", fmt.Errorf("invalid arguments: %v", err)
	}
	abs, rel, err := t.ws.resolve(in.Path)
	if err != nil {
		return "", err
	}
	if !t.ws.writable(rel) {
		// The boundary refusal: a write outside Write (or inside Deny) never
		// touches the disk. This is the guard-bee gate the whole slice exists for.
		return "", fmt.Errorf("write denied by boundary: %s (not inside the agent's write allowlist)", rel)
	}
	if dir := filepath.Dir(abs); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(abs, []byte(in.Content), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("wrote %d bytes to %s", len(in.Content), rel), nil
}

// ── shared helpers ───────────────────────────────────────────────────────────

// isBinary reports whether data looks non-textual (a NUL byte in the first 8KB).
// grep/walk skip binary files rather than emit garbage into a model turn.
func isBinary(data []byte) bool {
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// countLines counts newline-delimited lines (a trailing partial line counts).
func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	n := strings.Count(string(data), "\n")
	if !strings.HasSuffix(string(data), "\n") {
		n++
	}
	return n
}

// Interface conformance — every tool is a tool.Tool.
var (
	_ tool.Tool = readTool{}
	_ tool.Tool = globTool{}
	_ tool.Tool = grepTool{}
	_ tool.Tool = walkTool{}
	_ tool.Tool = writeTool{}
)
