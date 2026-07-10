// Backends are the pluggable secret stores the Vault selects between. Each
// implements Resolver. None reads a plaintext secrets file, and each keeps the
// raw value inside a single call — never logging it, never returning it in an
// error.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package secrets

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// KeychainBackend resolves secrets from the OS keychain. This is the OSS default:
// end users need no cloud account. On macOS it shells out to `security`; on Linux
// to libsecret's `secret-tool`. Any other OS returns ErrUnsupportedOS.
//
// The keychain "service" groups the hive's secrets; the Ref (mapped through
// Table) is the account/name within it.
type KeychainBackend struct {
	// Service is the keychain service name (default DefaultKeychainService).
	Service string
	// Table maps a logical Ref to the account name stored in the keychain.
	Table RefTable
}

func (b *KeychainBackend) service() string {
	if strings.TrimSpace(b.Service) != "" {
		return b.Service
	}
	return DefaultKeychainService
}

// Resolve looks the secret up in the OS keychain. The child process inherits the
// current environment (so it is hive-scoped via CLOUDSDK_CONFIG / login session).
func (b *KeychainBackend) Resolve(ctx context.Context, ref Ref) (string, error) {
	account := b.Table.name(ref)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// -w prints ONLY the password to stdout; the value never appears in argv.
		cmd = exec.CommandContext(ctx, "security",
			"find-generic-password", "-s", b.service(), "-a", account, "-w")
	case "linux":
		// libsecret: attributes mirror the macOS service/account pair.
		cmd = exec.CommandContext(ctx, "secret-tool",
			"lookup", "service", b.service(), "account", account)
	default:
		return "", &ResolveError{Backend: "keychain", Ref: ref, Reason: ErrUnsupportedOS.Error()}
	}
	return runSecretCmd(cmd, "keychain", ref)
}

// GSMBackend resolves secrets from Google Secret Manager via the gcloud CLI. This
// is the internal-testing backend: the operator keeps the real Anthropic key in
// GSM. The child process inherits the current environment, so CLOUDSDK_CONFIG (a
// per-hive gcloud config dir) scopes which account and project credentials apply.
type GSMBackend struct {
	// Project is the Google Cloud project the secret lives in.
	Project string
	// Table maps a logical Ref to the Secret Manager secret id.
	Table RefTable
}

// Resolve fetches the latest version of the named secret. On a non-zero gcloud
// exit it returns a typed ResolveError that echoes neither the secret nor the
// full command line — only the backend, ref, and a short diagnostic.
func (b *GSMBackend) Resolve(ctx context.Context, ref Ref) (string, error) {
	name := b.Table.name(ref)
	cmd := exec.CommandContext(ctx, "gcloud", "secrets", "versions", "access", "latest",
		"--secret="+name, "--project="+b.Project)
	cmd.Env = os.Environ() // inherit the (hive-scoped) process env explicitly
	return runSecretCmd(cmd, "gsm", ref)
}

// runSecretCmd runs a backend command whose stdout is the raw secret. It returns
// the trimmed value on success. On failure it returns a scrubbed ResolveError:
// the secret (stdout) is discarded, and only a short single-line stderr
// diagnostic is surfaced — enough to tell "not found" from "permission denied"
// without echoing the command or any value.
func runSecretCmd(cmd *exec.Cmd, backend string, ref Ref) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		// Deliberately drop stdout entirely (it may hold partial secret bytes).
		return "", &ResolveError{Backend: backend, Ref: ref, Reason: scrub(stderr.String(), err)}
	}
	// A successful lookup yields the value on stdout; keep it out of every log.
	return strings.TrimRight(stdout.String(), "\r\n"), nil
}

// scrub condenses a backend failure into one safe line: the process error plus
// the first non-empty stderr line, capped. Backend diagnostics ("NOT_FOUND",
// "PERMISSION_DENIED") do not contain the secret value.
func scrub(stderrText string, runErr error) string {
	line := ""
	for _, l := range strings.Split(stderrText, "\n") {
		if s := strings.TrimSpace(l); s != "" {
			line = s
			break
		}
	}
	const cap = 200
	if len(line) > cap {
		line = line[:cap] + "…"
	}
	if line == "" {
		return runErr.Error()
	}
	return fmt.Sprintf("%v: %s", runErr, line)
}

// envWarnMsg is the loud, one-time notice the insecure env backend prints.
const envWarnMsg = "agix/secrets: WARNING — insecure secret backend (env) — dev only; secrets are read from the process environment"

// EnvBackend resolves secrets from the process environment via os.Getenv. It is
// an INSECURE dev-only fallback and announces itself loudly, exactly once per
// backend instance, the first time it resolves anything.
type EnvBackend struct {
	// Table maps a logical Ref to the environment variable name.
	Table RefTable
	// Warn receives the one-time insecure-backend notice. When nil it is printed
	// to os.Stderr. Injectable so tests (and a future ledger) can capture it.
	Warn func(msg string)

	once sync.Once
}

// Resolve reads the mapped environment variable. It emits the insecure-backend
// warning once, then returns the value or a typed ResolveError if unset.
func (b *EnvBackend) Resolve(_ context.Context, ref Ref) (string, error) {
	b.warnOnce()
	name := b.Table.name(ref)
	val, ok := os.LookupEnv(name)
	if !ok || val == "" {
		return "", &ResolveError{Backend: "env", Ref: ref, Reason: "environment variable unset"}
	}
	return val, nil
}

func (b *EnvBackend) warnOnce() {
	b.once.Do(func() {
		if b.Warn != nil {
			b.Warn(envWarnMsg)
			return
		}
		fmt.Fprintln(os.Stderr, envWarnMsg)
	})
}
