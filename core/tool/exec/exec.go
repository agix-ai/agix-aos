// Package exec is the reborn fleet's GOVERNED command-execution tool — the
// credentialed capability that lets a boundary bee run a real command (a repo's
// test suite, a read-only `gh`/`git`, a build) without ever holding a shell or a
// raw key. Until now the ported tester/ci-warden/release-engineer/git-orchestrator
// agents could reason about a run but never DO it; declaring `tools: ["exec"]` was
// a name with nothing behind it. This closes that gap under the guard-bee boundary.
//
// The governance model has four load-bearing rules, all fail-CLOSED:
//
//   - Allowlist, deny-by-default. A command runs only if its argv begins with one
//     of the agent's allowed command-prefixes ("go test", "gh") AND begins with
//     NONE of its denied prefixes ("git push", "gh pr merge"). An EMPTY allowlist
//     permits nothing. The allow/deny prefixes are lifted verbatim from the spec's
//     Boundary (Exec = allow, Deny = the op-style denies that already sit beside the
//     path-style ones), so one boundary declares both the fs and the exec limits.
//   - No shell, ever. The model supplies a bare program NAME plus an argv array;
//     the tool execs argv DIRECTLY (os/exec, no `sh -c`). Model-supplied args are
//     passed as literal, separate argv elements — never concatenated into a command
//     line and never interpreted — so a `; rm -rf /` inside an argument is an inert
//     string to the program, not a second command. This is the injection boundary.
//   - Bounded. A per-exec timeout SIGKILLs a runaway; stdout/stderr are captured
//     with a size cap; the working directory resolves UNDER the repo root and can
//     never escape it (no `..`, no absolute-path break-out).
//   - Least-privilege secrets. A credentialed command (`gh` wanting GH_TOKEN) gets
//     its secret through a guard-bee CAPABILITY, not a raw key: the Broker resolves
//     the granted ref and injects it ONLY into this child's env, scoped to the run
//     and zeroed after. No grant → the secret is simply absent (the command runs
//     unauthenticated and degrades honestly). The child inherits a curated env
//     allowlist, not the parent's full environment, so an ambient key never rides in.
//
// It is a stdlib-plus-core leaf: it imports os/exec + core/tool (the interface) +
// core/secrets (the capability primitive) and nothing heavier, so wiring it into
// the runner introduces no cycle. Every exec is audited by the agent tool-use loop
// as a KindToolCall (tool + args + ok), egress-redacted, so the ledger carries the
// provenance without this package touching the ledger.
//
// First-cut honesty (see the package tests and the port notes): this is process
// isolation by allowlist + a scoped env, NOT a sandbox — there is no container,
// seccomp, cgroup, or filesystem jail, and a killed command's grandchild processes
// are not reaped as a group. A governed exec fails closed; full isolation is the
// tracked next rung.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package exec

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/secrets"
	"github.com/agix-ai/agix/core/tool"
)

// Defaults. A tool result threads back into a model turn, so output is capped; a
// command must complete inside the timeout or it is SIGKILLed.
const (
	// DefaultTimeout bounds a single exec; the process is killed past it.
	DefaultTimeout = 120 * time.Second
	// DefaultMaxOutput caps captured stdout and stderr (each) in bytes.
	DefaultMaxOutput = 64 * 1024
	// waitGrace is how long Wait tolerates I/O after a kill before giving up, so a
	// timed-out command cannot wedge the tool loop.
	waitGrace = 2 * time.Second
)

// defaultEnvPassthrough is the curated allowlist of PARENT env var NAMES a child
// inherits. It is deliberately NOT the full environment: a child gets the minimum
// to find and run a tool (PATH/HOME + locale/tmp + the Go toolchain's cache vars)
// plus any guard-bee-granted secret — nothing else. So an ambient ANTHROPIC_API_KEY
// sourced into the parent never rides into a subprocess. Non-secret env passthrough
// beyond this curated set is a documented first-cut limit, not full inheritance.
var defaultEnvPassthrough = []string{
	"PATH", "HOME", "USER", "LOGNAME",
	"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "TERM",
	"GOPATH", "GOMODCACHE", "GOCACHE", "GOROOT", "GOFLAGS", "GOTOOLCHAIN", "GOWORK",
}

// Config is the governance envelope one exec tool is constructed with. Every field
// NARROWS what the tool can do; the zero value is SAFE — an empty Allow permits
// nothing (deny-by-default), a nil Broker means no secret is ever injected.
type Config struct {
	// Root is the working-directory root. A command's optional dir resolves under
	// it and can never escape it (default "." → the process cwd).
	Root string
	// Allow is the allowlist of command-prefixes the agent may run ("go test",
	// "gh", "git status"). EMPTY permits NOTHING — a tool with no allowlist refuses
	// every command. This is the primary fail-closed gate.
	Allow []string
	// Deny is the list of command-prefixes that are REFUSED even when an allowed
	// prefix would otherwise permit them ("git push" under an allowed "git"). Lifted
	// from the spec's Boundary.Deny; path-style entries there are inert here (a
	// program is never named ".github/workflows/"), exactly as op-style denies are
	// inert for the filesystem path matcher — one deny list, two enforcers.
	Deny []string
	// Timeout bounds a single exec; <=0 uses DefaultTimeout.
	Timeout time.Duration
	// MaxOutput caps captured stdout and stderr (each), in bytes; <=0 uses DefaultMaxOutput.
	MaxOutput int
	// EnvPassthrough names the PARENT env vars a child inherits; nil uses the
	// curated defaultEnvPassthrough (never the full environment).
	EnvPassthrough []string

	// Broker + Grants are the guard-bee capability. When BOTH are set, each granted
	// secret is resolved by the Broker and injected ONLY into the child's env,
	// scoped to the run and zeroed after — the agent never holds the raw key. A nil
	// Broker or empty Grants means deny-by-default: no secret is present, the
	// command runs unauthenticated, and it degrades honestly rather than crashing.
	Broker *secrets.Broker
	Grants map[string]secrets.Ref // child env var NAME → secret ref

	// Scanner redacts credential shapes from captured output before it threads back
	// into a model turn (the exec output egress boundary). nil uses a default scanner.
	Scanner *secrets.EgressScanner
}

// Tool returns the governed exec tool if name is one of the capability aliases a
// manifest declares it by — "exec", "shell", "run", or "bash" — and whether the
// name was recognized. The aliases name the CAPABILITY ("run a command"); the tool
// itself NEVER invokes a shell regardless of which alias summoned it (a "bash"
// declaration does not get bash — it gets the no-shell governed exec). Mirrors
// fs.Tool's (Tool, bool) contract so one resolver can try fs, then metric, then exec.
func Tool(name string, cfg Config) (tool.Tool, bool) {
	switch strings.TrimSpace(name) {
	case "exec", "shell", "run", "bash":
		return newExecTool(cfg), true
	}
	return nil, false
}

type execTool struct {
	cfg   Config
	allow [][]string // tokenized Allow prefixes
	deny  [][]string // tokenized Deny prefixes
}

func newExecTool(cfg Config) *execTool {
	return &execTool{cfg: cfg, allow: tokenizeAll(cfg.Allow), deny: tokenizeAll(cfg.Deny)}
}

func (t *execTool) Name() string { return "exec" }
func (t *execTool) Description() string {
	return "Run a repository command bounded by the agent's allowlist (no shell). " +
		"Args: {\"command\":\"go\",\"args\":[\"test\",\"./...\"],\"dir\":\"optional/subtree\"}. " +
		"`command` is a bare program name; `args` are passed literally (never shell-interpreted). " +
		"Only allowlisted command-prefixes run; denied prefixes (e.g. git push) are refused. " +
		"Working dir is scoped to the repo root; output is captured and capped; long commands are killed."
}

var schema = json.RawMessage(`{"type":"object","properties":{` +
	`"command":{"type":"string","description":"the program to run, a bare name like \"go\" or \"gh\" (never a full command line)"},` +
	`"args":{"type":"array","items":{"type":"string"},"description":"arguments passed to the program verbatim; never shell-interpreted"},` +
	`"dir":{"type":"string","description":"optional repo-relative working directory; defaults to the repo root and may not escape it"}` +
	`},"required":["command"]}`)

func (t *execTool) InputSchema() json.RawMessage { return schema }

// Execute runs one model-requested command under the full governance envelope. It
// fails CLOSED at every gate: a malformed program name, a command off the allowlist
// or on the deny list, or a working-dir escape is REFUSED before any process is
// started. Only past every gate is argv exec'd directly (no shell), bounded by the
// timeout and output cap, with granted secrets scoped to the child.
func (t *execTool) Execute(ctx context.Context, raw json.RawMessage) (string, error) {
	var in struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
		Dir     string   `json:"dir"`
	}
	if err := json.Unmarshal(raw, &in); err != nil && len(raw) > 0 {
		return "", fmt.Errorf("exec: invalid arguments: %v", err)
	}

	cmdName := strings.TrimSpace(in.Command)
	if cmdName == "" {
		return "", fmt.Errorf("exec: command is required")
	}
	// Injection guard: the program must be a BARE token. No shell is ever used, so a
	// metacharacter-bearing "command" cannot spawn a second process — but it signals
	// an attempt to smuggle a command LINE where a program NAME belongs, so refuse it
	// outright rather than let it fail obscurely. Arguments carry no such restriction:
	// they are passed as literal, separate argv elements and are never interpreted.
	if i := strings.IndexAny(cmdName, " \t\n\r;|&<>$`(){}[]*?!\\\"'~"); i >= 0 {
		return "", fmt.Errorf("exec: command %q must be a bare program name with no shell metacharacters; pass arguments via \"args\"", cmdName)
	}

	argv := make([]string, 0, len(in.Args)+1)
	argv = append(argv, cmdName)
	argv = append(argv, in.Args...)

	// Allow/deny decision — deny-by-default. An empty allowlist permits nothing.
	if !t.permitted(argv) {
		return "", fmt.Errorf("exec: %q is not permitted by this agent's command allowlist (refused before execution)", strings.Join(argv, " "))
	}

	workDir, err := t.resolveDir(in.Dir)
	if err != nil {
		return "", err
	}

	timeout := t.cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	maxOut := t.cfg.MaxOutput
	if maxOut <= 0 {
		maxOut = DefaultMaxOutput
	}
	stdout := &capBuffer{max: maxOut}
	stderr := &capBuffer{max: maxOut}

	run := func(secretEnv []string) error {
		cmd := exec.CommandContext(runCtx, argv[0], argv[1:]...)
		cmd.Dir = workDir
		// Explicit env: the curated base allowlist + only the granted secrets. Never
		// nil (which would inherit the parent's FULL environment).
		cmd.Env = append(t.baseEnv(), secretEnv...)
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		cmd.WaitDelay = waitGrace // bound the reap after a kill so the loop can't wedge
		return cmd.Run()
	}

	// Guard-bee capability: inject granted secrets ONLY into this child, via the
	// Broker's scoped WithSecretEnv (resolves, injects, zeroes). Deny-by-default: no
	// Broker/Grants → the command runs with no secret present. If a grant is present
	// but the vault has no value, degrade to an unauthenticated run rather than abort.
	var runErr error
	var degraded string
	if t.cfg.Broker != nil && len(t.cfg.Grants) > 0 {
		ran := false
		injErr := t.cfg.Broker.WithSecretEnv(runCtx, t.cfg.Grants, func(env []string) error {
			ran = true
			return run(env)
		})
		if ran {
			runErr = injErr
		} else {
			// Resolution failed before the command started: honest degrade.
			degraded = "granted secret unavailable; ran unauthenticated"
			runErr = run(nil)
		}
	} else {
		runErr = run(nil)
	}

	return t.result(argv, in.Dir, stdout, stderr, runCtx, runErr, timeout, degraded)
}

// result renders the run into a model-facing string (or an error the loop threads
// back). A refusal/timeout/start-failure is an ERROR (audited ok=false); a command
// that RAN — even with a non-zero exit — is a successful tool result whose exit code
// is part of the payload (a failing test suite is DATA the agent must narrate, not a
// tool failure). All output is egress-redacted so no credential shape reaches the model.
func (t *execTool) result(argv []string, dir string, stdout, stderr *capBuffer, runCtx context.Context, runErr error, timeout time.Duration, degraded string) (string, error) {
	scanner := t.cfg.Scanner
	if scanner == nil {
		scanner = secrets.NewEgressScanner()
	}

	// Timeout: the deadline fired and the process was killed.
	if runCtx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("exec: %q timed out after %s and was killed\n%s",
			strings.Join(argv, " "), timeout, scanner.RedactKnown(streams(stdout, stderr)))
	}

	exitCode := 0
	if runErr != nil {
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			exitCode = ee.ExitCode()
		} else {
			// Could not start (binary not found, permission, etc.) — a tool error.
			return "", fmt.Errorf("exec: could not run %q: %v", strings.Join(argv, " "), runErr)
		}
	}

	var b strings.Builder
	if degraded != "" {
		fmt.Fprintf(&b, "note: %s\n", degraded)
	}
	fmt.Fprintf(&b, "$ %s\n", strings.Join(argv, " "))
	if d := strings.TrimSpace(dir); d != "" {
		fmt.Fprintf(&b, "dir: %s\n", d)
	}
	fmt.Fprintf(&b, "exit: %d\n", exitCode)
	b.WriteString("--- stdout ---\n")
	b.WriteString(stdout.render())
	b.WriteString("\n--- stderr ---\n")
	b.WriteString(stderr.render())
	// Egress redaction over the captured output: KNOWN credential shapes (the injected
	// GH_TOKEN, an API key a command echoes) are stripped before the text threads into
	// a model turn. This deliberately mirrors the ledger/apiary boundaries' RedactKnown
	// (not the high-entropy catch-all), so a legitimate 40-char git SHA or a UUID in
	// `git log`/`gh` output survives for the model to reason over — over-redacting the
	// tool result is its own harm. A non-standard high-entropy secret in subprocess
	// stdout is NOT swept here (documented residual gap; a hardened deployment can pass
	// a full-scan Scanner).
	return scanner.RedactKnown(b.String()), nil
}

// Grounds implements tool.Grounder: it classifies a completed exec result as a
// PASSING external oracle iff the command RAN TO A ZERO EXIT. A non-zero exit (a
// failing test suite) is real data the agent must narrate but is NOT grounding;
// a refused/timed-out/could-not-start command never reaches here (it is returned
// as a tool error, not a result). This is the "code executed / tests passed"
// oracle the Comb attestation policy names — the only thing that lets a governed
// verdict auto-attest without a human co-sign.
func (t *execTool) Grounds(result string) bool { return execExitZero(result) }

// execExitZero reports whether an exec result's metadata region carries an
// `exit: 0` line. It reads only the region BEFORE the "--- stdout ---" marker
// (where result() writes the exit line), so a subprocess whose stdout happens to
// print "exit: 0" cannot spoof grounding.
func execExitZero(result string) bool {
	head := result
	if i := strings.Index(result, "\n--- stdout ---"); i >= 0 {
		head = result[:i]
	}
	for _, line := range strings.Split(head, "\n") {
		if strings.TrimSpace(line) == "exit: 0" {
			return true
		}
	}
	return false
}

// permitted reports whether argv is allowed to run: it begins with at least one
// allowed prefix AND with no denied prefix. Both are TOKEN-prefix matches (a prefix
// ["git","push"] matches argv ["git","push","origin"] but not ["git","pushover"] or
// ["gitx"]), so a broadly-allowed program can still have a dangerous sub-invocation
// denied. An empty allowlist permits nothing (deny-by-default).
func (t *execTool) permitted(argv []string) bool {
	if !anyPrefix(argv, t.allow) {
		return false
	}
	if anyPrefix(argv, t.deny) {
		return false
	}
	return true
}

// resolveDir validates the optional working directory and returns its absolute
// form, refusing any path that escapes the repo root (a `..` traversal or an
// absolute path outside the tree) — mirroring the filesystem tools' resolve.
func (t *execTool) resolveDir(dir string) (string, error) {
	root := strings.TrimSpace(t.cfg.Root)
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absRoot = filepath.Clean(absRoot)
	d := strings.TrimSpace(dir)
	if d == "" {
		return absRoot, nil
	}
	var cand string
	if filepath.IsAbs(d) {
		cand = filepath.Clean(d)
	} else {
		cand = filepath.Clean(filepath.Join(absRoot, filepath.FromSlash(d)))
	}
	rel, rerr := filepath.Rel(absRoot, cand)
	if rerr != nil {
		return "", fmt.Errorf("exec: working dir %q is outside the repo root", dir)
	}
	rel = filepath.ToSlash(rel)
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("exec: working dir %q escapes the repo root (refused)", dir)
	}
	return cand, nil
}

// baseEnv builds the child's base environment from the curated passthrough
// allowlist — the minimum to find and run a tool, and NEVER the parent's full env.
func (t *execTool) baseEnv() []string {
	names := t.cfg.EnvPassthrough
	if names == nil {
		names = defaultEnvPassthrough
	}
	env := make([]string, 0, len(names))
	for _, k := range names {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// ── command matching ─────────────────────────────────────────────────────────

// tokenizeAll splits each prefix pattern into whitespace tokens, dropping empties.
func tokenizeAll(patterns []string) [][]string {
	out := make([][]string, 0, len(patterns))
	for _, p := range patterns {
		if toks := strings.Fields(p); len(toks) > 0 {
			out = append(out, toks)
		}
	}
	return out
}

// anyPrefix reports whether argv begins with any of the token-prefix patterns.
func anyPrefix(argv []string, patterns [][]string) bool {
	for _, p := range patterns {
		if hasTokenPrefix(argv, p) {
			return true
		}
	}
	return false
}

// hasTokenPrefix reports whether argv begins with the exact token sequence prefix.
func hasTokenPrefix(argv, prefix []string) bool {
	if len(prefix) == 0 || len(prefix) > len(argv) {
		return false
	}
	for i := range prefix {
		if argv[i] != prefix[i] {
			return false
		}
	}
	return true
}

// ── output capture ───────────────────────────────────────────────────────────

// capBuffer is a size-capped io.Writer: it keeps at most max bytes and records
// that it truncated. Write ALWAYS reports a full write (len(p), nil) so a chatty
// child is never blocked or errored by a short write — we simply stop keeping bytes.
type capBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if c.max <= 0 {
		c.buf.Write(p)
		return len(p), nil
	}
	if remain := c.max - c.buf.Len(); remain > 0 {
		if len(p) > remain {
			c.buf.Write(p[:remain])
			c.truncated = true
		} else {
			c.buf.Write(p)
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	return len(p), nil
}

// render returns the captured text with a truncation marker if it overflowed.
func (c *capBuffer) render() string {
	s := c.buf.String()
	if s == "" && !c.truncated {
		return "(empty)"
	}
	if c.truncated {
		s += fmt.Sprintf("\n…[truncated at %dKB]", c.max/1024)
	}
	return s
}

// streams joins stdout and stderr for the timeout/partial-output path.
func streams(stdout, stderr *capBuffer) string {
	return "stdout:\n" + stdout.render() + "\nstderr:\n" + stderr.render()
}

var (
	_ tool.Tool     = (*execTool)(nil)
	_ tool.Grounder = (*execTool)(nil)
)
