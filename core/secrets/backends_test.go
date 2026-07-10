package secrets_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/secrets"
)

func TestEnvBackendEmitsInsecureWarningOnce(t *testing.T) {
	const envName = "AGIX_TEST_ENV_BACKEND_SECRET"
	t.Setenv(envName, "dev-value")

	var warnings []string
	b := &secrets.EnvBackend{Warn: func(m string) { warnings = append(warnings, m) }}

	// Resolve twice — the loud warning must fire exactly once.
	if _, err := b.Resolve(context.Background(), secrets.Ref(envName)); err != nil {
		t.Fatalf("first Resolve: %v", err)
	}
	if _, err := b.Resolve(context.Background(), secrets.Ref(envName)); err != nil {
		t.Fatalf("second Resolve: %v", err)
	}

	if len(warnings) != 1 {
		t.Fatalf("insecure warning fired %d times, want exactly 1", len(warnings))
	}
	if !strings.Contains(warnings[0], "insecure") || !strings.Contains(warnings[0], "dev only") {
		t.Errorf("warning = %q, want a loud insecure/dev-only notice", warnings[0])
	}
}

func TestEnvBackendResolvesAndMapsRef(t *testing.T) {
	t.Setenv("MAPPED_ANTHROPIC_KEY", "sk-ant-from-env")
	b := &secrets.EnvBackend{
		Table: secrets.RefTable{"anthropic-api-key": "MAPPED_ANTHROPIC_KEY"},
		Warn:  func(string) {}, // silence in tests
	}
	got, err := b.Resolve(context.Background(), "anthropic-api-key")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != "sk-ant-from-env" {
		t.Errorf("Resolve = %q, want the env value via the ref map", got)
	}
}

func TestEnvBackendUnsetReturnsTypedError(t *testing.T) {
	b := &secrets.EnvBackend{Warn: func(string) {}}
	_, err := b.Resolve(context.Background(), "AGIX_TEST_DEFINITELY_UNSET_XYZ")
	if err == nil {
		t.Fatal("Resolve of unset var returned nil error")
	}
	var re *secrets.ResolveError
	if !errors.As(err, &re) {
		t.Fatalf("err = %T, want *secrets.ResolveError", err)
	}
	if strings.Contains(re.Reason, "sk-") {
		t.Errorf("ResolveError.Reason leaked value material: %q", re.Reason)
	}
}
