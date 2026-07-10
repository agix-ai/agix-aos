// Package metric is the reborn fleet's structural code-health tool — the numbers
// the refactoring pack's smell-scout hunts with (SPEC §3.3) instead of vibes. It
// walks a bounded workspace and extracts per-file and per-"class" structural
// metrics — Class-LOC, method count / WMC, cyclomatic complexity, nesting depth,
// import fan-out, and a cheap import-graph fan-in — then ranks the results into a
// worklist of STRUCTURAL smells (God class, long method, deep nesting, tight
// coupling), each mapped to the high-payoff refactoring §3.3 calls for. The point
// is not to match a commercial analyzer on day one; it is to give the metric-
// guided loop a consistent before/after delta to optimize, which is what turns
// "exploratory edits" into "measurable uplift".
//
// First-cut honesty (flagged in every result's "notes"): this is a HEURISTIC
// brace/keyword analyzer, not a real AST. It lexes comments and string/char
// literals out first (so braces and keywords inside them are not miscounted), then
// tracks brace depth to segment functions and classes. It is accurate for the
// fleet's C-family languages (Go/TS/JS/Java/C#/Rust/Swift/Kotlin/C/C++); brace-free
// languages (Python and friends) get file-level LOC only, with class/method
// segmentation reported as unsupported. Go has no `class`, so receiver methods are
// grouped by their receiver TYPE into a synthetic class for WMC.
//
// It is a stdlib-plus-core leaf built on core/tool/fs's Workspace, so it inherits
// the exact same guard-bee boundary as the filesystem tools and adds no dependency.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package metric

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/agix-ai/agix/core/tool"
	"github.com/agix-ai/agix/core/tool/fs"
)

// Analysis caps — a structural scan of a large tree must stay bounded so its
// result fits a model turn.
const (
	maxFilesAnalyzed = 4000
	maxSmells        = 60
	maxHotspots      = 20
)

// Smell thresholds. These are deliberate, documented first-cut values (the same
// order-of-magnitude the empirical study's tools use), not tuned constants; the
// value that matters is the CONSISTENT delta, so a campaign can watch them fall.
const (
	godClassLOC  = 300
	godClassWMC  = 50
	godClassMeth = 20
	longMethLOC  = 60
	longMethCyc  = 10
	deepNesting  = 4
	highFanOut   = 20
	highFanIn    = 15
)

// Tool returns the structural-metric tool if name matches ("metric",
// "structural-metric", or "metrics"), scoped to the workspace, and whether the
// name was recognized. It mirrors fs.Tool's (Tool, bool) contract so one resolver
// can try fs then metric.
func Tool(name string, ws fs.Workspace) (tool.Tool, bool) {
	switch strings.TrimSpace(name) {
	case "metric", "structural-metric", "metrics":
		return metricTool{ws: ws}, true
	}
	return nil, false
}

type metricTool struct{ ws fs.Workspace }

func (t metricTool) Name() string { return "metric" }
func (t metricTool) Description() string {
	return "Extract structural code-health metrics over a repository subtree (Class-LOC, WMC, cyclomatic complexity, nesting depth, fan-in/out) and rank structural smells (God class, long method, deep nesting, tight coupling) to a refactoring worklist. Args: {\"path\":\"optional/subtree\"}. Heuristic (brace/keyword), not an AST."
}
func (t metricTool) InputSchema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"optional subtree to analyze; empty analyzes the whole repo"}}}`)
}

func (t metricTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(args, &in)

	rep := report{Root: rootLabel(t.ws), Languages: map[string]int{}, Notes: heuristicNote}
	files := make([]fileMetric, 0, 64)
	imports := map[string]int{} // slash-relative target path → times imported (fan-in)

	err := t.ws.WalkReadable(in.Path, func(rel string, _ int64) error {
		lang := languageOf(rel)
		if lang == langUnknown {
			return nil
		}
		data, rerr := t.ws.ReadFileRel(rel)
		if rerr != nil || isBinary(data) {
			return nil
		}
		fm := analyze(rel, lang, string(data))
		files = append(files, fm)
		rep.Languages[lang]++
		for _, imp := range fm.importTargets {
			imports[imp]++
		}
		if len(files) >= maxFilesAnalyzed {
			return errStop
		}
		return nil
	})
	if err != nil && err != errStop {
		return "", err
	}

	// Cheap fan-in: resolve each recorded import target against known files and
	// stamp the count back onto the imported file. Approximate — it only sees
	// imports the heuristic parsed, and resolves by path suffix — so it is
	// reported as an estimate, not ground truth.
	byPath := make(map[string]int, len(files))
	for i, f := range files {
		byPath[trimExt(f.Path)] = i
	}
	for target, count := range imports {
		if idx, ok := resolveImport(target, byPath); ok {
			files[idx].FanIn += count
		}
	}

	buildReport(&rep, files)
	out, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ── report shape ─────────────────────────────────────────────────────────────

type report struct {
	Root          string         `json:"root"`
	FilesAnalyzed int            `json:"files_analyzed"`
	Languages     map[string]int `json:"languages"`
	Totals        totals         `json:"totals"`
	Smells        []smell        `json:"smells"`
	Hotspots      []hotspot      `json:"hotspots"`
	Notes         string         `json:"notes"`
}

type totals struct {
	LOC        int `json:"loc"`
	SLOC       int `json:"sloc"`
	Classes    int `json:"classes"`
	Functions  int `json:"functions"`
	MaxNesting int `json:"max_nesting"`
}

// smell is one ranked structural finding mapped to its high-payoff refactoring
// (SPEC §3.3) — exactly what the scout's worklist consumes.
type smell struct {
	Kind        string `json:"kind"`
	Refactoring string `json:"refactoring"`
	Path        string `json:"path"`
	Unit        string `json:"unit,omitempty"`
	Metric      string `json:"metric"`
	Value       int    `json:"value"`
	rank        int    // internal sort key (severity); not serialized
}

type hotspot struct {
	Path       string `json:"path"`
	Cyclomatic int    `json:"cyclomatic"`
	LOC        int    `json:"loc"`
	MaxNesting int    `json:"max_nesting"`
	Classes    int    `json:"classes"`
}

// buildReport folds per-file metrics into totals, hotspots, and the ranked smell
// worklist.
func buildReport(rep *report, files []fileMetric) {
	rep.FilesAnalyzed = len(files)
	var smells []smell
	for _, f := range files {
		rep.Totals.LOC += f.LOC
		rep.Totals.SLOC += f.SLOC
		rep.Totals.Functions += len(f.Functions)
		rep.Totals.Classes += len(f.Classes)
		if f.MaxNesting > rep.Totals.MaxNesting {
			rep.Totals.MaxNesting = f.MaxNesting
		}
		smells = append(smells, fileSmells(f)...)
	}
	// Severity-rank the worklist and cap it. A worklist that is all renames means
	// the scout failed (§3.3) — this tool only ever emits STRUCTURAL smells.
	sort.SliceStable(smells, func(i, j int) bool { return smells[i].rank > smells[j].rank })
	if len(smells) > maxSmells {
		smells = smells[:maxSmells]
	}
	rep.Smells = smells

	hs := make([]hotspot, 0, len(files))
	for _, f := range files {
		hs = append(hs, hotspot{Path: f.Path, Cyclomatic: f.Cyclomatic, LOC: f.LOC, MaxNesting: f.MaxNesting, Classes: len(f.Classes)})
	}
	sort.SliceStable(hs, func(i, j int) bool { return hs[i].Cyclomatic > hs[j].Cyclomatic })
	if len(hs) > maxHotspots {
		hs = hs[:maxHotspots]
	}
	rep.Hotspots = hs
	if rep.Smells == nil {
		rep.Smells = []smell{}
	}
	if rep.Hotspots == nil {
		rep.Hotspots = []hotspot{}
	}
}

// fileSmells derives the structural smells for one file's metrics.
func fileSmells(f fileMetric) []smell {
	var out []smell
	for _, c := range f.Classes {
		switch {
		case c.LOC >= godClassLOC || c.WMC >= godClassWMC || c.Methods >= godClassMeth:
			metricName, val := "class_loc", c.LOC
			if c.WMC >= godClassWMC && c.WMC >= val {
				metricName, val = "wmc", c.WMC
			}
			out = append(out, smell{Kind: "god_class", Refactoring: "Extract Class / Extract Subclass / Split Class",
				Path: f.Path, Unit: c.Name, Metric: metricName, Value: val, rank: 400 + val})
		}
	}
	for _, fn := range f.Functions {
		if fn.LOC >= longMethLOC || fn.Cyclomatic >= longMethCyc {
			metricName, val := "method_loc", fn.LOC
			if fn.Cyclomatic >= longMethCyc && fn.Cyclomatic*6 >= val {
				metricName, val = "cyclomatic", fn.Cyclomatic
			}
			out = append(out, smell{Kind: "long_method", Refactoring: "Extract Method / decompose conditional",
				Path: f.Path, Unit: fn.Name, Metric: metricName, Value: val, rank: 200 + val})
		}
		if fn.MaxNesting >= deepNesting {
			out = append(out, smell{Kind: "deep_nesting", Refactoring: "Extract Method / guard clauses / decompose conditional",
				Path: f.Path, Unit: fn.Name, Metric: "nesting_depth", Value: fn.MaxNesting, rank: 150 + fn.MaxNesting*10})
		}
	}
	if f.FanOut >= highFanOut {
		out = append(out, smell{Kind: "high_fan_out", Refactoring: "break the cycle / introduce a seam (reduce coupling)",
			Path: f.Path, Metric: "fan_out", Value: f.FanOut, rank: 100 + f.FanOut})
	}
	if f.FanIn >= highFanIn {
		out = append(out, smell{Kind: "high_fan_in", Refactoring: "stabilize the interface / introduce a seam (it is a hub)",
			Path: f.Path, Metric: "fan_in", Value: f.FanIn, rank: 100 + f.FanIn})
	}
	return out
}

// ── per-file analysis ────────────────────────────────────────────────────────

type fileMetric struct {
	Path       string
	Lang       string
	LOC        int
	SLOC       int
	Cyclomatic int // file-total decision points + 1
	MaxNesting int
	FanOut     int // import count
	FanIn      int // times imported (approximate, filled post-walk)
	Functions  []unitMetric
	Classes    []classMetric

	importTargets []string // parsed import paths (for the fan-in graph)
}

type unitMetric struct {
	Name       string
	LOC        int
	Cyclomatic int
	MaxNesting int
}

type classMetric struct {
	Name    string
	LOC     int
	Methods int
	WMC     int // sum of contained methods' cyclomatic complexity
}

// analyze extracts structural metrics for one source file. Brace-family languages
// get full segmentation; others get LOC + a coarse file cyclomatic only.
func analyze(rel, lang, src string) fileMetric {
	fm := fileMetric{Path: rel, Lang: lang}
	rawLines := strings.Split(src, "\n")
	fm.LOC = len(rawLines)
	if fm.LOC > 0 && rawLines[fm.LOC-1] == "" {
		fm.LOC-- // trailing newline does not count as a line
	}

	fm.importTargets = parseImports(lang, src)
	fm.FanOut = len(fm.importTargets)

	if !braceFamily[lang] {
		// Indent/other languages: LOC + a light SLOC only. Segmentation is not
		// modeled (honest degrade); cyclomatic stays 1 so it never masquerades.
		for _, ln := range rawLines {
			if s := strings.TrimSpace(ln); s != "" && !strings.HasPrefix(s, "#") {
				fm.SLOC++
			}
		}
		fm.Cyclomatic = 1
		return fm
	}

	clean := stripCommentsAndStrings(src)
	fm.SLOC = countSLOC(clean)
	fm.MaxNesting, fm.Functions, fm.Classes, fm.Cyclomatic = segment(lang, clean)
	return fm
}

// segment brace-tracks the (comment/string-stripped) source to find functions and
// classes and measure their complexity. It returns the file's max nesting, the
// per-function metrics, the per-class metrics, and the file-total cyclomatic.
// Methods are attributed to their enclosing class at close time (not by a coarse
// line-span scan), so class WMC sums exactly the methods declared inside it.
func segment(lang, clean string) (maxNest int, funcs []unitMetric, classes []classMetric, fileCyclo int) {
	lines := strings.Split(clean, "\n")
	fileCyclo = 1

	type frame struct {
		kind      string // "func" | "class" | "block"
		name      string
		startLine int
		openDepth int
		cyclo     int
		maxNest   int
		methods   int // class frames only: methods declared directly inside
		wmc       int // class frames only: sum of contained method cyclomatic
	}
	var stack []frame
	depth := 0

	// Track a synthetic class per Go receiver type (Go has no class keyword).
	goClasses := map[string]*classMetric{}

	// enclosingClass returns the index of the nearest class frame on the stack, or
	// -1. Used to attribute a closing method to its class.
	enclosingClass := func() int {
		for j := len(stack) - 1; j >= 0; j-- {
			if stack[j].kind == "class" {
				return j
			}
		}
		return -1
	}

	for i, line := range lines {
		lineNo := i + 1
		trimmed := strings.TrimSpace(line)

		// Count decision points on this line and attribute them to the innermost
		// function frame and the file total.
		dp := decisionPoints(trimmed)
		fileCyclo += dp
		for j := len(stack) - 1; j >= 0; j-- {
			if stack[j].kind == "func" {
				stack[j].cyclo += dp
				break
			}
		}

		// Walk braces on the line to open/close frames and track nesting. `pending`
		// accumulates the text since the last brace/semicolon so the SPECIFIC brace
		// is classified from its own signature, not the whole line — this is what
		// makes dense one-liners (`m() { if (x) { … } }`) segment correctly. It is
		// line-scoped: a multi-LINE signature may be under-detected (documented).
		var pending strings.Builder
		for _, ch := range line {
			switch ch {
			case '{':
				sig := strings.TrimSpace(pending.String())
				pending.Reset()
				if kind, name := classifyOpener(lang, sig); kind != "" {
					stack = append(stack, frame{kind: kind, name: name, startLine: lineNo, openDepth: depth})
				} else {
					// A non-declaration block ({ } inside a body) still deepens
					// nesting for the enclosing function.
					stack = append(stack, frame{kind: "block", startLine: lineNo, openDepth: depth})
				}
				depth++
				if depth > maxNest {
					maxNest = depth
				}
				// Update enclosing function's max nesting relative to its open depth.
				for j := len(stack) - 1; j >= 0; j-- {
					if stack[j].kind == "func" {
						if n := depth - stack[j].openDepth; n > stack[j].maxNest {
							stack[j].maxNest = n
						}
						break
					}
				}
			case '}':
				pending.Reset()
				if depth > 0 {
					depth--
				}
				n := len(stack)
				if n == 0 {
					continue
				}
				top := stack[n-1]
				stack = stack[:n-1]
				switch top.kind {
				case "func":
					um := unitMetric{Name: top.name, LOC: lineNo - top.startLine + 1, Cyclomatic: top.cyclo + 1, MaxNesting: top.maxNest}
					funcs = append(funcs, um)
					if ci := enclosingClass(); ci >= 0 {
						stack[ci].methods++
						stack[ci].wmc += um.Cyclomatic
					} else if lang == langGo {
						if recv := goReceiver(top.name); recv != "" {
							c := goClasses[recv]
							if c == nil {
								c = &classMetric{Name: recv}
								goClasses[recv] = c
							}
							c.Methods++
							c.WMC += um.Cyclomatic
							c.LOC += um.LOC
						}
					}
				case "class":
					classes = append(classes, classMetric{Name: top.name, LOC: lineNo - top.startLine + 1, Methods: top.methods, WMC: top.wmc})
				}
			case ';':
				pending.Reset()
			default:
				if pending.Len() < 4096 {
					pending.WriteRune(ch)
				}
			}
		}
	}
	for _, c := range goClasses {
		classes = append(classes, *c)
	}
	return maxNest, funcs, classes, fileCyclo
}

// classifyOpener decides whether the `{` following this signature text opens a
// class or a function/method block, and returns its name. `sig` is the text since
// the last brace/semicolon (not the whole line), so a specific brace is judged by
// its own signature. It rejects control-flow openers (if/for/while/…) so a body
// block does not masquerade as a function. Heuristic and language-lite by design.
func classifyOpener(lang, sig string) (kind, name string) {
	if m := classRe.FindStringSubmatch(sig); m != nil {
		return "class", m[1]
	}
	if lang == langGo && goTypeStructRe.MatchString(sig) {
		return "class", goTypeStructRe.FindStringSubmatch(sig)[1]
	}
	// A function opener: has a parameter list and is not a control keyword.
	if !strings.Contains(sig, "(") || !strings.Contains(sig, ")") {
		return "", ""
	}
	head := strings.TrimSpace(sig[:strings.Index(sig, "(")])
	if head == "" {
		return "", ""
	}
	fields := strings.Fields(head)
	last := fields[len(fields)-1]
	if controlKeywords[last] || controlKeywords[fields[0]] {
		return "", ""
	}
	return "func", funcName(lang, sig)
}

// funcName pulls a readable function/method name out of a signature line.
func funcName(lang, sig string) string {
	if lang == langGo {
		if m := goFuncRe.FindStringSubmatch(sig); m != nil {
			return strings.TrimSpace(m[0])
		}
	}
	if m := nameBeforeParenRe.FindStringSubmatch(sig); m != nil {
		return m[1]
	}
	return "anonymous"
}

// ── lexing helpers ───────────────────────────────────────────────────────────

// stripCommentsAndStrings replaces the contents of // and /* */ comments and of
// "…"/'…'/`…` literals with spaces (keeping newlines), so brace/keyword counting
// is not fooled by a brace inside a string or a keyword inside a comment. It is a
// best-effort lexer (no escape-sequence subtleties beyond \" \' \\), which is the
// documented precision limit.
func stripCommentsAndStrings(src string) string {
	var b strings.Builder
	b.Grow(len(src))
	rs := []rune(src)
	n := len(rs)
	i := 0
	blank := func(r rune) {
		if r == '\n' {
			b.WriteByte('\n')
		} else {
			b.WriteByte(' ')
		}
	}
	for i < n {
		r := rs[i]
		switch {
		case r == '/' && i+1 < n && rs[i+1] == '/':
			for i < n && rs[i] != '\n' {
				i++
			}
		case r == '/' && i+1 < n && rs[i+1] == '*':
			b.WriteString("  ")
			i += 2
			for i < n && !(rs[i] == '*' && i+1 < n && rs[i+1] == '/') {
				blank(rs[i])
				i++
			}
			if i < n {
				b.WriteString("  ")
				i += 2
			}
		case r == '"' || r == '\'' || r == '`':
			quote := r
			b.WriteByte(' ')
			i++
			for i < n && rs[i] != quote {
				if rs[i] == '\\' && quote != '`' && i+1 < n {
					blank(rs[i])
					i++
				}
				blank(rs[i])
				i++
			}
			if i < n {
				b.WriteByte(' ')
				i++
			}
		default:
			b.WriteRune(r)
			i++
		}
	}
	return b.String()
}

func countSLOC(clean string) int {
	n := 0
	for _, ln := range strings.Split(clean, "\n") {
		if strings.TrimSpace(ln) != "" {
			n++
		}
	}
	return n
}

// decisionPoints counts cyclomatic decision tokens on a cleaned line: branch
// keywords plus the boolean/ternary operators. `switch` itself is not counted (its
// `case` labels are, which is the branch that matters). Word-boundary matched so an
// identifier like `iffy` is not counted.
func decisionPoints(line string) int {
	n := len(decisionKeywordRe.FindAllString(line, -1))
	n += strings.Count(line, "&&")
	n += strings.Count(line, "||")
	n += strings.Count(line, "?")
	return n
}

// ── language + import parsing ────────────────────────────────────────────────

const (
	langUnknown = ""
	langGo      = "go"
)

var braceFamily = map[string]bool{
	langGo: true, "ts": true, "tsx": true, "js": true, "jsx": true,
	"java": true, "cs": true, "rs": true, "swift": true, "kt": true,
	"c": true, "cc": true, "cpp": true, "h": true, "hpp": true, "scala": true,
}

var extLang = map[string]string{
	".go": langGo, ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx",
	".mjs": "js", ".cjs": "js", ".java": "java", ".cs": "cs", ".rs": "rs",
	".swift": "swift", ".kt": "kt", ".c": "c", ".cc": "cc", ".cpp": "cpp",
	".h": "h", ".hpp": "hpp", ".scala": "scala", ".py": "py", ".rb": "rb",
}

func languageOf(rel string) string { return extLang[strings.ToLower(path.Ext(rel))] }

var (
	classRe           = regexp.MustCompile(`\b(?:class|interface|enum|struct)\s+([A-Za-z_]\w*)`)
	goTypeStructRe    = regexp.MustCompile(`^type\s+([A-Za-z_]\w*)\s+struct\b`)
	goFuncRe          = regexp.MustCompile(`func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*`)
	goReceiverRe      = regexp.MustCompile(`func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)`)
	nameBeforeParenRe = regexp.MustCompile(`([A-Za-z_]\w*)\s*\(`)
	decisionKeywordRe = regexp.MustCompile(`\b(if|for|while|case|catch)\b`)
	goImportRe        = regexp.MustCompile(`"([^"]+)"`)
	jsImportRe        = regexp.MustCompile(`(?:import|require)\s*[^'"]*['"]([^'"]+)['"]`)
)

var controlKeywords = map[string]bool{
	"if": true, "for": true, "while": true, "switch": true, "catch": true,
	"else": true, "do": true, "return": true, "select": true, "defer": true, "go": true,
}

// parseImports pulls import target strings for the fan-in/out graph. Heuristic and
// language-scoped; only local (relative) targets meaningfully resolve to fan-in.
func parseImports(lang, src string) []string {
	var out []string
	switch lang {
	case langGo:
		in := false
		for _, ln := range strings.Split(src, "\n") {
			t := strings.TrimSpace(ln)
			switch {
			case strings.HasPrefix(t, "import ("):
				in = true
			case in && t == ")":
				in = false
			case in:
				if m := goImportRe.FindStringSubmatch(t); m != nil {
					out = append(out, m[1])
				}
			case strings.HasPrefix(t, "import "):
				if m := goImportRe.FindStringSubmatch(t); m != nil {
					out = append(out, m[1])
				}
			}
		}
	case "ts", "tsx", "js", "jsx":
		for _, m := range jsImportRe.FindAllStringSubmatch(src, -1) {
			out = append(out, m[1])
		}
	default:
		// Other languages: count imports coarsely by line prefix for fan-out only.
		for _, ln := range strings.Split(src, "\n") {
			t := strings.TrimSpace(ln)
			if strings.HasPrefix(t, "import ") || strings.HasPrefix(t, "#include") || strings.HasPrefix(t, "use ") {
				out = append(out, t)
			}
		}
	}
	return out
}

func goReceiver(sig string) string {
	if m := goReceiverRe.FindStringSubmatch(sig); m != nil {
		return m[1]
	}
	return ""
}

// resolveImport maps a parsed import target to a known file index by matching the
// target's tail against a known trimmed-extension path (e.g. a JS `./foo/bar`
// import resolves to `foo/bar`). Approximate by construction.
func resolveImport(target string, byPath map[string]int) (int, bool) {
	t := strings.TrimSpace(target)
	t = strings.TrimPrefix(t, "./")
	t = strings.TrimPrefix(t, "../")
	t = strings.TrimSuffix(t, "/")
	if idx, ok := byPath[t]; ok {
		return idx, true
	}
	// Suffix match: the import tail is a known file's tail.
	for p, idx := range byPath {
		if strings.HasSuffix(p, "/"+t) || path.Base(p) == path.Base(t) {
			return idx, true
		}
	}
	return 0, false
}

func trimExt(p string) string { return strings.TrimSuffix(p, path.Ext(p)) }

func rootLabel(ws fs.Workspace) string {
	if r, err := ws.RootAbs(); err == nil {
		return r
	}
	return ws.Root
}

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

const heuristicNote = "heuristic brace/keyword analysis, not an AST: comments and string/char literals are lexed out, then braces track function/class spans. Accurate for C-family languages (Go/TS/JS/Java/C#/Rust/Swift/Kotlin/C/C++); brace-free languages (Python/Ruby) get file LOC only. Fan-in is an estimate over parsed imports."

// errStop halts the bounded walk once the file cap is reached.
var errStop = fmt.Errorf("metric: file cap reached")

var _ tool.Tool = metricTool{}
