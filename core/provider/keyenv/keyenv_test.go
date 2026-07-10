// Tests for the provider-key resolver seam: the dev env fallback (back-compat),
// the guard-bee vault path (precedence + audit + typed errors), and the
// invariant that the mock provider needs no key resolution at all. No test hits a
// real keychain or gcloud — the vault is always an injected in-memory fake.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package keyenv

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
	"github.com/agix-ai/agix/core/secrets"
)

// fakeVault is an in-memory vaultResolver. It never shells out, so tests never
// touch the OS keychain or gcloud.
type fakeVault struct {
	values map[secrets.Ref]string
	err    error
	src    string
	calls  int
}

func (f *fakeVault) Resolve(_ context.Context, ref secrets.Ref) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	if v, ok := f.values[ref]; ok {
		return v, nil
	}
	return "", &secrets.ResolveError{Backend: "fake", Ref: ref, Reason: "not found"}
}

func (f *fakeVault) Source() string {
	if f.src != "" {
		return f.src
	}
	return "fake"
}

// With AGIX_SECRET_BACKEND unset, the resolver returns the os.Getenv value —
// byte-for-byte the pre-vault dev behavior — and never builds a vault.
func TestResolve_DevFallback_ReturnsEnvWhenBackendUnset(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "") // explicitly no secure backend
	t.Setenv("ANTHROPIC_API_KEY", "env-key-dev")

	r := &KeyResolver{
		// A NewVault that fails the test if ever called: the dev path must not build one.
		NewVault: func() (vaultResolver, error) {
			t.Fatal("dev fallback must not construct a vault")
			return nil, nil
		},
	}
	got, err := r.Resolve(context.Background(), "anthropic", "ANTHROPIC_API_KEY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "env-key-dev" {
		t.Fatalf("dev fallback = %q, want env value %q", got, "env-key-dev")
	}
}

// Package-level Load keeps the exact legacy contract when the backend is unset.
func TestLoad_DevFallback_BackCompat(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "")
	t.Setenv("OPENAI_API_KEY", "  env-openai  ") // legacy path TrimSpaces
	if got := Load("openai", "OPENAI_API_KEY"); got != "env-openai" {
		t.Fatalf("Load = %q, want trimmed env value %q", got, "env-openai")
	}
}

// With a vault present, the vault value wins over the environment: the guard bee
// is load-bearing, not shadowed by a stray env var.
func TestResolve_VaultTakesPrecedenceOverEnv(t *testing.T) {
	// A conflicting env value must NOT be returned when the vault resolves.
	t.Setenv("ANTHROPIC_API_KEY", "env-should-lose")

	fake := &fakeVault{
		values: map[secrets.Ref]string{"ANTHROPIC_API_KEY": "vault-wins"},
		src:    "gsm:test-project",
	}
	r := &KeyResolver{Vault: fake}

	got, err := r.Resolve(context.Background(), "anthropic", "ANTHROPIC_API_KEY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "vault-wins" {
		t.Fatalf("resolved %q, want vault value %q (env must not win)", got, "vault-wins")
	}
	if fake.calls != 1 {
		t.Fatalf("vault Resolve called %d times, want 1", fake.calls)
	}
}

// A missing key on the vault path is a clear typed error — no panic, no value.
func TestResolve_MissingKey_TypedError(t *testing.T) {
	fake := &fakeVault{values: map[secrets.Ref]string{}} // empty → ResolveError
	r := &KeyResolver{Vault: fake}

	got, err := r.Resolve(context.Background(), "gemini", "GEMINI_API_KEY")
	if got != "" {
		t.Fatalf("value on error = %q, want empty", got)
	}
	var re *secrets.ResolveError
	if !errors.As(err, &re) {
		t.Fatalf("error = %v, want *secrets.ResolveError", err)
	}
	if re.Ref != "GEMINI_API_KEY" {
		t.Fatalf("ResolveError.Ref = %q, want %q", re.Ref, "GEMINI_API_KEY")
	}
}

// The audit hook fires once per vault resolution with the ref and backend source,
// and NEVER the secret value.
func TestResolve_AuditEmitsRefAndSource_NeverValue(t *testing.T) {
	const secret = "sk-ant-TOPSECRET-value"
	fake := &fakeVault{
		values: map[secrets.Ref]string{"ANTHROPIC_API_KEY": secret},
		src:    "keychain",
	}

	var gotProvider, gotSource string
	var gotRef secrets.Ref
	captured := 0
	r := &KeyResolver{
		Vault: fake,
		Audit: func(provider string, ref secrets.Ref, source string) {
			captured++
			gotProvider, gotRef, gotSource = provider, ref, source
		},
	}

	val, err := r.Resolve(context.Background(), "anthropic", "ANTHROPIC_API_KEY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val != secret {
		t.Fatalf("returned value mismatch")
	}
	if captured != 1 {
		t.Fatalf("audit fired %d times, want 1", captured)
	}
	if gotProvider != "anthropic" || gotRef != "ANTHROPIC_API_KEY" || gotSource != "keychain" {
		t.Fatalf("audit record = (%q, %q, %q), want (anthropic, ANTHROPIC_API_KEY, keychain)", gotProvider, gotRef, gotSource)
	}
	// The value must never appear in any audited field.
	for _, field := range []string{gotProvider, string(gotRef), gotSource} {
		if strings.Contains(field, secret) || strings.Contains(field, "TOPSECRET") {
			t.Fatalf("SECRET LEAK: audit field %q contains the secret value", field)
		}
	}
}

// No audit fires when resolution stays on the dev path (nothing went through the
// vault to record).
func TestResolve_DevPath_NoAudit(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "")
	t.Setenv("OPENAI_API_KEY", "env-openai")
	fired := false
	r := &KeyResolver{Audit: func(string, secrets.Ref, string) { fired = true }}
	if _, err := r.Resolve(context.Background(), "openai", "OPENAI_API_KEY"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fired {
		t.Fatal("audit fired on the dev fallback path; it must fire only for vault resolutions")
	}
}

// A configured-but-unbuildable backend (gsm without a project) surfaces a typed
// build error rather than panicking — via the real secrets.NewVault, no network.
func TestResolve_BackendMisconfigured_Error(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "gsm")
	t.Setenv(secrets.EnvGSMProject, "") // gsm requires a project
	r := &KeyResolver{}                  // default NewVault → secrets.NewVault
	got, err := r.Resolve(context.Background(), "anthropic", "ANTHROPIC_API_KEY")
	if got != "" {
		t.Fatalf("value = %q, want empty on build error", got)
	}
	if !errors.Is(err, secrets.ErrNoProject) {
		t.Fatalf("error = %v, want ErrNoProject", err)
	}
}

// Load swallows a vault resolution failure to "" (preserving the constructor
// contract: New() never errors; the missing key surfaces at call time).
func TestLoad_VaultError_SwallowedToEmpty(t *testing.T) {
	prev := defaultResolver
	t.Cleanup(func() { defaultResolver = prev })
	defaultResolver = &KeyResolver{Vault: &fakeVault{err: errors.New("boom")}}

	if got := Load("anthropic", "ANTHROPIC_API_KEY"); got != "" {
		t.Fatalf("Load on vault error = %q, want empty", got)
	}
}

// The mock provider needs no key resolution: it constructs and Chats even with a
// secure backend selected that would FAIL to build (gsm, no project) and no
// provider env keys set — proving mock never routes through keyenv/the vault.
func TestMockProvider_NeedsNoKeyResolution(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "gsm")
	t.Setenv(secrets.EnvGSMProject, "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "")

	m := mock.New()
	resp, err := m.Chat(context.Background(), router.ChatRequest{
		Messages: []router.Message{{Role: "user", Content: "hello hive"}},
	})
	if err != nil {
		t.Fatalf("mock Chat errored (should need no key): %v", err)
	}
	if resp.Text == "" {
		t.Fatal("mock Chat returned empty text")
	}
}
