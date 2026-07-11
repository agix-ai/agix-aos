package secrets_test

import (
	"context"
	"errors"
	"testing"

	"github.com/agix-ai/agix/core/secrets"
)

// fakeResolver is an in-memory SourcedResolver — no keychain, no cloud secret CLI, no
// network. Broker/vault-selection tests use it so nothing hits the OS store.
type fakeResolver struct {
	vals  map[secrets.Ref]string
	src   string
	calls int
}

func (f *fakeResolver) Resolve(_ context.Context, ref secrets.Ref) (string, error) {
	f.calls++
	if v, ok := f.vals[ref]; ok {
		return v, nil
	}
	return "", errors.New("no such secret")
}

func (f *fakeResolver) Source() string {
	if f.src == "" {
		return "fake"
	}
	return f.src
}

func TestVaultBackendSelection(t *testing.T) {
	tests := []struct {
		name       string
		backend    string
		project    string
		wantSource string
		wantErr    bool
	}{
		{name: "default is keychain", backend: "", wantSource: "keychain"},
		{name: "explicit keychain", backend: "keychain", wantSource: "keychain"},
		{name: "gsm with project", backend: "gsm", project: "acme-hive", wantSource: "gsm:acme-hive"},
		{name: "env", backend: "env", wantSource: "env"},
		{name: "gsm without project errors", backend: "gsm", wantErr: true},
		{name: "unknown backend errors", backend: "vault-of-doom", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(secrets.EnvBackendVar, tc.backend)
			t.Setenv(secrets.EnvGSMProject, tc.project)

			v, err := secrets.NewVault()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NewVault(%q) = nil error, want error", tc.backend)
				}
				return
			}
			if err != nil {
				t.Fatalf("NewVault(%q): %v", tc.backend, err)
			}
			if got := v.Source(); got != tc.wantSource {
				t.Errorf("Source() = %q, want %q", got, tc.wantSource)
			}
		})
	}
}

func TestVaultGSMMissingProjectIsTyped(t *testing.T) {
	t.Setenv(secrets.EnvBackendVar, "gsm")
	t.Setenv(secrets.EnvGSMProject, "")
	_, err := secrets.NewVault()
	if !errors.Is(err, secrets.ErrNoProject) {
		t.Fatalf("err = %v, want ErrNoProject", err)
	}
}
