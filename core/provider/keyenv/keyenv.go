// Package keyenv resolves a provider API key. It is the single seam every
// provider adapter reads its key through, so where the key comes from is decided
// in ONE place — not scattered os.Getenv calls in each adapter.
//
// Resolution has two modes:
//
//   - Secure (AGIX_SECRET_BACKEND set): the key is pulled through the guard-bee
//     vault (core/secrets) — the OS keychain or a cloud secret manager — so worker
//     bees never read a raw key straight from the process environment. A value-free
//     provenance line (provider + ref + backend source, NEVER the value) is audited
//     on each vault resolution.
//   - Dev fallback (AGIX_SECRET_BACKEND UNSET): byte-for-byte the pre-vault
//     behavior — the environment variable first, then a KEY=VALUE line in
//     ~/.config/agix/<provider>.env. Setting nothing keeps the exact old path.
//
// A missing key never fails at construction or in tests: Load returns "" and the
// adapter errors only when a live call actually routes to that provider.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package keyenv

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/agix-ai/agix/core/secrets"
)

// vaultResolver is the subset of *secrets.Vault this package needs: resolve a
// logical Ref and name its backend for audit. *secrets.Vault satisfies it; tests
// inject a fake so no keychain/cloud secret CLI call is ever made under `go test`.
type vaultResolver interface {
	Resolve(ctx context.Context, ref secrets.Ref) (string, error)
	Source() string
}

// AuditFunc receives one provenance record each time a provider key is resolved
// THROUGH THE VAULT: the provider name, the logical ref, and the backend source
// (e.g. "gsm:<your-gcp-project>"). It is handed the ref and source for
// provenance — NEVER the secret value.
type AuditFunc func(provider string, ref secrets.Ref, source string)

// KeyResolver resolves a provider's API key, preferring the guard-bee vault when
// a secure backend is configured and falling back to the dev env/file path
// otherwise. The zero value is usable: it consults AGIX_SECRET_BACKEND on each
// call and builds a real *secrets.Vault when a secure backend is set. All fields
// are injectable so tests can drive it without touching the OS keychain or cloud secret CLI.
type KeyResolver struct {
	// Vault, when non-nil, is used directly and unconditionally (tests inject a
	// fake here). When nil, a vault is built via NewVault only if a backend is set.
	Vault vaultResolver
	// Backend overrides the configured backend name. "" (the default) means read
	// AGIX_SECRET_BACKEND; still-empty means no secure backend → dev fallback.
	Backend string
	// NewVault builds the vault when Vault is nil and a backend is configured. nil
	// uses secrets.NewVault. Injectable so tests never construct a real backend.
	NewVault func() (vaultResolver, error)
	// Audit receives one value-free record per vault resolution. nil writes a
	// structured line to stderr via defaultAudit.
	Audit AuditFunc
}

// Resolve returns the API key for provider. envVar is BOTH the environment
// variable read on the dev path AND the vault Ref on the secure path: the GSM
// secret names and keychain accounts use the same identity name as the env var,
// so the provider→Ref mapping is simply anthropic→ANTHROPIC_API_KEY,
// openai→OPENAI_API_KEY, gemini→GEMINI_API_KEY.
//
// On the secure path a resolution failure returns the vault's typed error
// (*secrets.ResolveError) — which never contains the value — and no key. On the
// dev path a missing key returns "" with a nil error (the adapter fails later).
func (r *KeyResolver) Resolve(ctx context.Context, provider, envVar string) (string, error) {
	vault, useVault, err := r.selectVault()
	if err != nil {
		return "", err
	}
	if !useVault {
		return devFallback(provider, envVar), nil
	}
	ref := secrets.Ref(envVar)
	val, err := vault.Resolve(ctx, ref)
	if err != nil {
		return "", err // typed *secrets.ResolveError; carries no value
	}
	r.audit(provider, ref, vault.Source())
	return val, nil
}

// selectVault decides whether this resolution routes through the vault. It
// returns (vault, true, nil) on the secure path, (nil, false, nil) for the dev
// fallback, and a build error only when a configured backend cannot be
// constructed (e.g. gsm without a project).
func (r *KeyResolver) selectVault() (vaultResolver, bool, error) {
	if r.Vault != nil {
		return r.Vault, true, nil
	}
	backend := r.Backend
	if backend == "" {
		backend = strings.TrimSpace(os.Getenv(secrets.EnvBackendVar))
	}
	if backend == "" {
		return nil, false, nil // no secure backend configured → dev fallback
	}
	newVault := r.NewVault
	if newVault == nil {
		newVault = defaultNewVault
	}
	vault, err := newVault()
	if err != nil {
		return nil, false, err
	}
	return vault, true, nil
}

func (r *KeyResolver) audit(provider string, ref secrets.Ref, source string) {
	if r.Audit != nil {
		r.Audit(provider, ref, source)
		return
	}
	defaultAudit(provider, ref, source)
}

// defaultNewVault adapts secrets.NewVault to the vaultResolver seam, avoiding a
// non-nil interface wrapping a nil *Vault on error.
func defaultNewVault() (vaultResolver, error) {
	v, err := secrets.NewVault()
	if err != nil {
		return nil, err
	}
	return v, nil
}

// defaultAudit writes a structured, value-free provenance line to stderr. The
// guard bee's append-only ledger is not wired here (that needs a role→refs
// Broker policy, out of scope for this seam); this line carries the ref and the
// backend source — enough for provenance — and never the secret value.
func defaultAudit(provider string, ref secrets.Ref, source string) {
	fmt.Fprintf(os.Stderr, "agix/keyenv: resolved %s key via vault (ref=%s backend=%s)\n", provider, ref, source)
}

// defaultResolver backs Load. It carries no injected vault, so each call consults
// AGIX_SECRET_BACKEND afresh and builds a real *secrets.Vault only when a secure
// backend is configured.
var defaultResolver = &KeyResolver{}

// Load returns the API key for provider, routing through the guard-bee vault when
// AGIX_SECRET_BACKEND is set and otherwise using the legacy dev path (env var,
// then ~/.config/agix/<provider>.env) with UNCHANGED behavior. It returns "" —
// never an error, never a panic — so a missing key (or a vault resolution
// failure) only surfaces when a live call is made, exactly as before. Callers
// that want the typed error use KeyResolver.Resolve directly.
func Load(provider, envVar string) string {
	val, err := defaultResolver.Resolve(context.Background(), provider, envVar)
	if err != nil {
		return ""
	}
	return val
}

// devFallback is the pre-vault resolution path, kept byte-for-byte: the
// environment variable envVar first, then a KEY=VALUE line in
// ~/.config/agix/<provider>.env. Returns "" when neither is present.
func devFallback(provider, envVar string) string {
	if v := strings.TrimSpace(os.Getenv(envVar)); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".config", "agix", provider+".env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if strings.TrimSpace(k) == envVar {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}
