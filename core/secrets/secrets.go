// Package secrets is the guard bee — the security caste that holds the hive's
// secrets so worker bees NEVER see raw keys.
//
// It is the ONLY code that touches raw secret material. Secrets are pulled from
// a pluggable vault backend (an OS keychain, Google Secret Manager, …) — never a
// plaintext file sourced into every bee's environment. A Broker brokers
// least-privilege, just-in-time access (a role only gets the refs its policy
// allowlist names), and an EgressScanner inspects anything crossing the hive
// boundary so a secret can't leak out in a PR diff, a message, or a ledger write.
//
// Design invariants:
//   - A secret VALUE is never logged, never stored in an audit record, never
//     placed in a Finding, and never written to disk by this package.
//   - Backends resolve lazily: constructing a Vault or Broker performs no
//     keychain/gcloud call, so tests and unrelated code never hit the OS store.
//   - The env-var backend is dev-only and announces itself loudly, once.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package secrets

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Ref is a logical secret name (e.g. "anthropic-api-key"). It is deliberately
// NOT the value and NOT a backend-specific path — a Resolver maps it to whatever
// its store calls the secret.
type Ref string

// Resolver returns the raw secret value for a logical Ref. Implementations must
// never log or persist the returned value. A resolution failure returns a typed
// error whose message does NOT contain the secret.
type Resolver interface {
	Resolve(ctx context.Context, ref Ref) (string, error)
}

// SourcedResolver is a Resolver that can name its backend for audit records
// (e.g. "keychain", "gsm:my-project"). Vault satisfies it; the Broker takes one
// so every secret_access record carries provenance.
type SourcedResolver interface {
	Resolver
	// Source names the backend for audit — never the secret, never a path.
	Source() string
}

// RefTable maps a logical Ref to a backend-specific name. A nil table, or a Ref
// with no entry, resolves to the identity (the Ref used verbatim).
type RefTable map[Ref]string

// name returns the backend-specific name for ref (identity by default).
func (t RefTable) name(ref Ref) string {
	if t != nil {
		if n, ok := t[ref]; ok {
			return n
		}
	}
	return string(ref)
}

// Environment variables that select and configure the backend.
const (
	// EnvBackendVar selects the backend: "keychain" (default), "gsm", or "env".
	EnvBackendVar = "AGIX_SECRET_BACKEND"
	// EnvGSMProject names the Google Cloud project for the gsm backend.
	EnvGSMProject = "AGIX_GSM_PROJECT"
)

// DefaultKeychainService is the keychain "service" the guard bee stores secrets
// under when none is configured (macOS -s / libsecret service attribute).
const DefaultKeychainService = "agix"

// Typed errors. Callers use errors.Is to branch without parsing messages, and no
// error message ever carries a secret value.
var (
	// ErrDenied is returned by the Broker when policy forbids a role a ref.
	ErrDenied = errors.New("secret access denied by policy")
	// ErrUnsupportedOS is returned by the keychain backend off macOS/Linux.
	ErrUnsupportedOS = errors.New("keychain backend unsupported on this OS")
	// ErrNoProject is returned when the gsm backend is selected without a project.
	ErrNoProject = errors.New("gsm backend requires " + EnvGSMProject)
)

// ResolveError is a backend resolution failure. Its Reason is scrubbed: it names
// the backend, the ref, and a short diagnostic — never the secret value.
type ResolveError struct {
	Backend string
	Ref     Ref
	Reason  string
}

func (e *ResolveError) Error() string {
	return fmt.Sprintf("secrets: %s: resolve %q: %s", e.Backend, e.Ref, e.Reason)
}

// Vault selects a backend from configuration and delegates Resolve to it. It is
// the single seam the rest of the runtime asks for a secret through.
type Vault struct {
	backend Resolver
	source  string
}

// NewVault builds a Vault from the environment: AGIX_SECRET_BACKEND in
// {keychain (default), gsm, env}; the gsm backend also reads AGIX_GSM_PROJECT.
// Construction performs NO backend call — a missing key only surfaces when a
// value is actually resolved.
func NewVault() (*Vault, error) {
	switch backend := strings.ToLower(strings.TrimSpace(os.Getenv(EnvBackendVar))); backend {
	case "", "keychain":
		return &Vault{
			backend: &KeychainBackend{Service: DefaultKeychainService},
			source:  "keychain",
		}, nil
	case "gsm":
		project := strings.TrimSpace(os.Getenv(EnvGSMProject))
		if project == "" {
			return nil, ErrNoProject
		}
		return &Vault{
			backend: &GSMBackend{Project: project},
			source:  "gsm:" + project,
		}, nil
	case "env":
		return &Vault{
			backend: &EnvBackend{},
			source:  "env",
		}, nil
	default:
		return nil, fmt.Errorf("secrets: unknown %s=%q (keychain|gsm|env)", EnvBackendVar, backend)
	}
}

// Resolve delegates to the selected backend.
func (v *Vault) Resolve(ctx context.Context, ref Ref) (string, error) {
	return v.backend.Resolve(ctx, ref)
}

// Source names the selected backend for audit ("keychain", "gsm:<project>",
// "env"). It never reveals a secret.
func (v *Vault) Source() string { return v.source }
