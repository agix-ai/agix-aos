package exec_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/secrets"
	exectool "github.com/agix-ai/agix/core/tool/exec"
)

// fakeVault is an in-memory SourcedResolver — no keychain, no cloud secret CLI, no network —
// so every guard-bee test runs $0/offline with a fake secret value.
type fakeVault struct {
	vals  map[secrets.Ref]string
	calls int
}

func (f *fakeVault) Resolve(_ context.Context, ref secrets.Ref) (string, error) {
	f.calls++
	if v, ok := f.vals[ref]; ok {
		return v, nil
	}
	return "", errors.New("no such secret")
}
func (f *fakeVault) Source() string { return "fake" }

// run is a helper: invoke the exec tool with a command + args and return its result.
func run(t *testing.T, tl interface {
	Execute(context.Context, json.RawMessage) (string, error)
}, command string, args ...string) (string, error) {
	t.Helper()
	in := map[string]any{"command": command}
	if len(args) > 0 {
		in["args"] = args
	}
	raw, _ := json.Marshal(in)
	return tl.Execute(context.Background(), raw)
}

func mustTool(t *testing.T, cfg exectool.Config) interface {
	Execute(context.Context, json.RawMessage) (string, error)
} {
	t.Helper()
	tl, ok := exectool.Tool("exec", cfg)
	if !ok {
		t.Fatal(`exectool.Tool("exec") not recognized`)
	}
	return tl
}

// (a) An allowlisted command RUNS and its output threads back. `go version` is
// hermetic (the toolchain is present under `go test`).
func TestAllowlistedCommandRunsAndThreadsOutput(t *testing.T) {
	tl := mustTool(t, exectool.Config{Root: t.TempDir(), Allow: []string{"go version"}})
	out, err := run(t, tl, "go", "version")
	if err != nil {
		t.Fatalf("allowlisted `go version` should run, got error: %v", err)
	}
	if !strings.Contains(out, "go version") {
		t.Errorf("output did not thread back the command's stdout:\n%s", out)
	}
	if !strings.Contains(out, "exit: 0") {
		t.Errorf("expected a clean exit annotation, got:\n%s", out)
	}
}

// (b) A command that is NOT on the allowlist is REFUSED before any process starts.
// Token-prefix matching also refuses a same-prefix DIFFERENT program (`gofmt` is not
// `go`) and a broader arg under a narrower allow entry (`go build` under `go version`).
func TestRefusesNonAllowlisted(t *testing.T) {
	tl := mustTool(t, exectool.Config{Root: t.TempDir(), Allow: []string{"go version"}})

	cases := [][]string{
		{"rm", "-rf", "/tmp/agix-should-never-run"}, // wholly disallowed
		{"gofmt", "-l", "."},                        // same prefix, different program
		{"go", "build", "./..."},                    // allowed prefix `go version` not satisfied
	}
	for _, argv := range cases {
		out, err := run(t, tl, argv[0], argv[1:]...)
		if err == nil {
			t.Errorf("%v should be refused, got output:\n%s", argv, out)
			continue
		}
		if !strings.Contains(err.Error(), "not permitted") {
			t.Errorf("%v: error = %q, want a not-permitted refusal", argv, err)
		}
	}
}

// (b') A DENY-listed sub-invocation is refused even when a broader prefix is allowed:
// `echo` is allowed, but `echo secret` is denied — the deny vetoes the allow.
func TestDenyVetoesAllow(t *testing.T) {
	tl := mustTool(t, exectool.Config{
		Root:  t.TempDir(),
		Allow: []string{"echo"},
		Deny:  []string{"echo secret"},
	})

	// The allowed form runs.
	out, err := run(t, tl, "echo", "hello")
	if err != nil {
		t.Fatalf("`echo hello` should run: %v", err)
	}
	if !strings.Contains(out, "hello") {
		t.Errorf("expected echoed output, got:\n%s", out)
	}

	// The denied specialization is refused before execution.
	if _, err := run(t, tl, "echo", "secret", "leak"); err == nil {
		t.Error("`echo secret leak` should be refused by the deny list")
	} else if !strings.Contains(err.Error(), "not permitted") {
		t.Errorf("deny refusal error = %q, want not-permitted", err)
	}
}

// An EMPTY allowlist permits nothing — deny-by-default fail-closed posture.
func TestEmptyAllowlistPermitsNothing(t *testing.T) {
	tl := mustTool(t, exectool.Config{Root: t.TempDir()}) // no Allow
	if _, err := run(t, tl, "go", "version"); err == nil {
		t.Error("an empty allowlist must permit nothing, but `go version` ran")
	}
}

// The injection guard refuses a program name carrying shell metacharacters — an
// attempt to smuggle a command LINE where a program NAME belongs.
func TestInjectionGuardRejectsMetacharacters(t *testing.T) {
	tl := mustTool(t, exectool.Config{Root: t.TempDir(), Allow: []string{"git"}})
	for _, bad := range []string{"git; rm -rf /", "git && curl evil", "echo $(whoami)", "a|b"} {
		if _, err := run(t, tl, bad); err == nil {
			t.Errorf("command %q with shell metacharacters should be refused", bad)
		} else if !strings.Contains(err.Error(), "bare program name") {
			t.Errorf("%q: error = %q, want a bare-program-name refusal", bad, err)
		}
	}
}

// (c) A timeout KILLS a long-running command (it does not wait the full duration).
func TestTimeoutKillsLongCommand(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skip("sleep not available")
	}
	tl := mustTool(t, exectool.Config{
		Root:    t.TempDir(),
		Allow:   []string{"sleep"},
		Timeout: 150 * time.Millisecond,
	})
	start := time.Now()
	_, err := run(t, tl, "sleep", "10")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("a command exceeding the timeout should return a timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %q, want a timeout error", err)
	}
	if elapsed > 3*time.Second {
		t.Errorf("command was not killed promptly: elapsed=%s (should be ~150ms)", elapsed)
	}
}

// (d) A working-dir escape (../ traversal or an absolute path outside the root) is
// REFUSED — the exec cwd can never leave the repo root.
func TestRefusesWorkingDirEscape(t *testing.T) {
	root := t.TempDir()
	tl := mustTool(t, exectool.Config{Root: root, Allow: []string{"go version"}})
	for _, dir := range []string{"..", "../..", "../elsewhere", "/etc"} {
		raw, _ := json.Marshal(map[string]any{"command": "go", "args": []string{"version"}, "dir": dir})
		if _, err := tl.Execute(context.Background(), raw); err == nil {
			t.Errorf("dir %q should be refused as an escape", dir)
		} else if !strings.Contains(err.Error(), "escape") && !strings.Contains(err.Error(), "outside") {
			t.Errorf("dir %q: error = %q, want an escape/outside-root refusal", dir, err)
		}
	}
}

// (e) The guard-bee capability path: WITH an authorized grant the secret is present
// in the CHILD env (proven by `printenv GH_TOKEN` emitting it) and is REDACTED on
// egress so it never reaches the model; WITHOUT a grant it is absent (deny-by-default)
// and the command degrades honestly. The parent env is never mutated either way.
func TestGuardBeeSecretInChildEnvAndRedactedOnEgress(t *testing.T) {
	if _, err := exec.LookPath("printenv"); err != nil {
		t.Skip("printenv not available")
	}
	const rawToken = "ghp_FAKEyTOKEN0123456789abcd" // matches the github-token egress shape — # public-clean: ok synthetic fixture (exercises egress redaction, not a real secret)
	const ref = secrets.Ref("gh-token")

	vault := &fakeVault{vals: map[secrets.Ref]string{ref: rawToken}}
	policy := secrets.Policy{"ci-warden": {ref}}
	broker := secrets.NewBroker(vault, policy, nil)
	grants := map[string]secrets.Ref{"GH_TOKEN": ref}

	// With the grant: the child receives GH_TOKEN, printenv emits it, egress redacts it.
	withGrant := mustTool(t, exectool.Config{
		Root:   t.TempDir(),
		Allow:  []string{"printenv"},
		Broker: broker,
		Grants: grants,
	})
	out, err := run(t, withGrant, "printenv", "GH_TOKEN")
	if err != nil {
		t.Fatalf("granted `printenv GH_TOKEN` should run: %v", err)
	}
	if strings.Contains(out, rawToken) {
		t.Fatalf("SECURITY: the raw secret reached the model output:\n%s", out)
	}
	if !strings.Contains(out, "[REDACTED:"+secrets.KindGitHubToken+"]") {
		t.Errorf("expected the secret to be present-then-redacted, got:\n%s", out)
	}
	if vault.calls == 0 {
		t.Error("the broker never resolved the granted secret")
	}

	// Without the grant: deny-by-default. GH_TOKEN is absent from the child, printenv
	// finds nothing (non-zero exit), and nothing leaks or crashes.
	noGrant := mustTool(t, exectool.Config{Root: t.TempDir(), Allow: []string{"printenv"}})
	out, err = run(t, noGrant, "printenv", "GH_TOKEN")
	if err != nil {
		t.Fatalf("ungranted run should degrade honestly, not error at the tool level: %v", err)
	}
	if strings.Contains(out, rawToken) || strings.Contains(out, "[REDACTED:") {
		t.Errorf("no-grant run should have no secret at all, got:\n%s", out)
	}

	// The parent process env was never mutated by the injection.
	if _, present := os.LookupEnv("GH_TOKEN"); present {
		if strings.Contains(os.Getenv("GH_TOKEN"), rawToken) {
			t.Error("the injected secret leaked into the parent environment")
		}
	}
}

// A command that RAN but exited non-zero is a successful tool result (the exit code
// is data), not a tool error — so a failing test suite can still be narrated.
func TestNonZeroExitIsDataNotToolError(t *testing.T) {
	tl := mustTool(t, exectool.Config{Root: t.TempDir(), Allow: []string{"go"}})
	// `go help nonsense-subcommand` exits non-zero but is a real, allowed run.
	out, err := run(t, tl, "go", "run", "./this-package-does-not-exist")
	if err != nil {
		t.Fatalf("a non-zero exit should be a result, not a tool error: %v", err)
	}
	if !strings.Contains(out, "exit:") || strings.Contains(out, "exit: 0") {
		t.Errorf("expected a non-zero exit annotation in the result:\n%s", out)
	}
}

// The alias set a manifest may declare the capability by all resolve to the same
// no-shell governed exec tool.
func TestCapabilityAliases(t *testing.T) {
	for _, name := range []string{"exec", "shell", "run", "bash"} {
		tl, ok := exectool.Tool(name, exectool.Config{})
		if !ok {
			t.Errorf("alias %q should resolve to the exec tool", name)
			continue
		}
		if tl.Name() != "exec" {
			t.Errorf("alias %q resolved to a tool named %q, want canonical exec", name, tl.Name())
		}
	}
	if _, ok := exectool.Tool("read", exectool.Config{}); ok {
		t.Error(`"read" must not resolve to the exec tool`)
	}
}
