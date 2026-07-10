package secrets_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/secrets"
)

// auditSink captures secret_access records so tests can assert the guard bee
// audits by ref + decision + source, never by value.
type auditRecord struct {
	role    string
	ref     secrets.Ref
	allowed bool
	source  string
}

func newBroker(policy secrets.Policy) (*secrets.Broker, *fakeResolver, *[]auditRecord) {
	fake := &fakeResolver{
		vals: map[secrets.Ref]string{
			"anthropic-api-key": "sk-ant-secret-value",
			"github-token":      "ghp_secret_value",
		},
		src: "fake",
	}
	var log []auditRecord
	audit := func(role string, ref secrets.Ref, allowed bool, source string) {
		log = append(log, auditRecord{role, ref, allowed, source})
	}
	return secrets.NewBroker(fake, policy, audit), fake, &log
}

func TestBrokerDeniesNonAllowlistedRef(t *testing.T) {
	policy := secrets.Policy{"forager": {"anthropic-api-key"}}
	b, fake, log := newBroker(policy)

	_, err := b.Grant(context.Background(), "forager", "github-token")
	if err == nil {
		t.Fatal("Grant of non-allowlisted ref returned nil error, want ErrDenied")
	}
	if !errors.Is(err, secrets.ErrDenied) {
		t.Fatalf("err = %v, want ErrDenied", err)
	}
	if fake.calls != 0 {
		t.Errorf("vault was resolved %d times on a denial; must be 0 (never touch the store)", fake.calls)
	}
	if strings.Contains(err.Error(), "sk-ant") || strings.Contains(err.Error(), "ghp_") {
		t.Errorf("denial error leaked a secret value: %q", err.Error())
	}
	if len(*log) != 1 || (*log)[0].allowed {
		t.Fatalf("audit = %+v, want one allowed=false record", *log)
	}
	if (*log)[0].source != "fake" {
		t.Errorf("audit source = %q, want %q", (*log)[0].source, "fake")
	}
}

func TestBrokerAllowsAllowlistedRef(t *testing.T) {
	policy := secrets.Policy{"forager": {"anthropic-api-key"}}
	b, fake, log := newBroker(policy)

	val, err := b.Grant(context.Background(), "forager", "anthropic-api-key")
	if err != nil {
		t.Fatalf("Grant of allowlisted ref: %v", err)
	}
	if val != "sk-ant-secret-value" {
		t.Errorf("Grant returned %q, want the resolved value", val)
	}
	if fake.calls != 1 {
		t.Errorf("vault resolved %d times, want 1", fake.calls)
	}
	if len(*log) != 1 || !(*log)[0].allowed || (*log)[0].ref != "anthropic-api-key" {
		t.Fatalf("audit = %+v, want one allowed=true record for anthropic-api-key", *log)
	}
}

func TestBrokerDenyByDefaultUnknownRole(t *testing.T) {
	// A role absent from the policy map is denied outright.
	b, fake, _ := newBroker(secrets.Policy{"forager": {"anthropic-api-key"}})
	if _, err := b.Grant(context.Background(), "intruder", "anthropic-api-key"); !errors.Is(err, secrets.ErrDenied) {
		t.Fatalf("unknown role err = %v, want ErrDenied", err)
	}
	if fake.calls != 0 {
		t.Errorf("vault touched for an unknown role; must be deny-by-default")
	}
}

func TestWithSecretEnvPassesOnlyGrantedKeysAndDoesNotLeak(t *testing.T) {
	const parentKey = "AGIX_TEST_GUARD_SECRET_DO_NOT_SET"
	os.Unsetenv(parentKey)

	b, _, log := newBroker(secrets.Policy{}) // policy irrelevant: WithSecretEnv is role-less
	grants := map[string]secrets.Ref{parentKey: "anthropic-api-key"}

	var seen []string
	err := b.WithSecretEnv(context.Background(), grants, func(env []string) error {
		seen = append([]string(nil), env...)
		return nil
	})
	if err != nil {
		t.Fatalf("WithSecretEnv: %v", err)
	}

	// Only the one granted key, exactly.
	if len(seen) != 1 {
		t.Fatalf("fn saw %d env entries, want 1: %v", len(seen), seen)
	}
	if seen[0] != parentKey+"=sk-ant-secret-value" {
		t.Errorf("env entry = %q, want %q", seen[0], parentKey+"=sk-ant-secret-value")
	}

	// The parent process env must be untouched.
	if v, ok := os.LookupEnv(parentKey); ok {
		t.Errorf("WithSecretEnv leaked %s=%q into the parent environment", parentKey, v)
	}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, parentKey+"=") {
			t.Errorf("granted key found in os.Environ(): %q", kv)
		}
	}

	// Every touched secret is audited (under the subprocess-env role).
	if len(*log) != 1 || !(*log)[0].allowed {
		t.Fatalf("audit = %+v, want one allowed=true record", *log)
	}
}
