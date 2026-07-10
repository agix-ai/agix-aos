package email_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/secrets"
	emailtool "github.com/agix-ai/agix/core/tool/email"
)

// fakeVault is an in-memory SourcedResolver — no keychain, no network — so every
// guard-bee test runs $0/offline with a fake credential value. It counts resolves
// so a test can prove a denied/absent grant NEVER touches the store.
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

func send(t *testing.T, tl interface {
	Execute(context.Context, json.RawMessage) (string, error)
}, msg map[string]any) (string, error) {
	t.Helper()
	raw, _ := json.Marshal(msg)
	return tl.Execute(context.Background(), raw)
}

func mustTool(t *testing.T, cfg emailtool.Config) interface {
	Execute(context.Context, json.RawMessage) (string, error)
} {
	t.Helper()
	tl, ok := emailtool.Tool("email", cfg)
	if !ok {
		t.Fatal(`emailtool.Tool("email") not recognized`)
	}
	return tl
}

// (a) The $0/offline default RECORDS a message and delivers NOTHING: the dry-run
// sender queues it, the recorder captures it, and the result says sent=false.
func TestDryRunRecordsAndSendsNothing(t *testing.T) {
	rec := &emailtool.Recorder{}
	tl := mustTool(t, emailtool.Config{Recorder: rec, DefaultTo: []string{"operator"}})

	out, err := send(t, tl, map[string]any{"subject": "Digest", "body": "3 threads need you"})
	if err != nil {
		t.Fatalf("dry-run send should succeed: %v", err)
	}
	if !strings.Contains(out, "status: queued") || !strings.Contains(out, "sent=false") {
		t.Errorf("dry-run result should be queued/not-sent, got:\n%s", out)
	}
	if rec.Len() != 1 {
		t.Fatalf("recorder should hold exactly one message, got %d", rec.Len())
	}
	got := rec.Messages()[0]
	if got.Body != "3 threads need you" || len(got.To) != 1 || got.To[0] != "operator" {
		t.Errorf("recorded message wrong: %+v", got)
	}
}

// A missing body (or no recipient at all) is refused before any transport is touched.
func TestRefusesMalformedMessage(t *testing.T) {
	tl := mustTool(t, emailtool.Config{DefaultTo: []string{"operator"}})
	if _, err := send(t, tl, map[string]any{"subject": "empty"}); err == nil {
		t.Error("a message with no body should be refused")
	}
	noRecip := mustTool(t, emailtool.Config{}) // no DefaultTo
	if _, err := send(t, noRecip, map[string]any{"body": "hi"}); err == nil {
		t.Error("a message with no recipient and no default should be refused")
	}
}

// (b) A credentialed transport WITHOUT a grant FAILS CLOSED: it degrades to queued
// and the transport function is NEVER invoked (no send with a missing key), and the
// vault is never touched.
func TestCredentialedTransportWithoutGrantFailsClosed(t *testing.T) {
	called := false
	live := emailtool.SenderFunc{
		Transport:    "smtp",
		Credentialed: true,
		Fn: func(_ context.Context, _ emailtool.Message, _ map[string]string) (emailtool.Result, error) {
			called = true
			return emailtool.Result{Sent: true, Mode: "smtp"}, nil
		},
	}
	// No Broker, no Grants → deny-by-default.
	tl := mustTool(t, emailtool.Config{Sender: live, DefaultTo: []string{"ops@example.com"}})

	out, err := send(t, tl, map[string]any{"subject": "alert", "body": "budget exhausted"})
	if err != nil {
		t.Fatalf("a no-grant credentialed send should degrade honestly, not error: %v", err)
	}
	if called {
		t.Fatal("SECURITY: the credentialed transport was invoked with NO grant (must fail closed)")
	}
	if !strings.Contains(out, "status: queued") || !strings.Contains(out, "fail-closed") {
		t.Errorf("expected a fail-closed queued result, got:\n%s", out)
	}
}

// (c) The guard-bee capability path: WITH an authorized grant the credential is
// resolved and passed to the transport (proving delivery is credentialed), and a
// token the transport echoes is REDACTED on egress so it never reaches the model.
func TestGuardBeeGrantDeliversScopedCredentialAndRedacts(t *testing.T) {
	const rawSecret = "ghp_FAKEyTOKEN0123456789abcd" // matches the github-token egress shape — # public-clean: ok synthetic github-token fixture (exercises egress redaction, not a real secret)
	const ref = secrets.Ref("smtp-app-password")

	var sawCred string
	live := emailtool.SenderFunc{
		Transport:    "smtp",
		Credentialed: true,
		Fn: func(_ context.Context, _ emailtool.Message, creds map[string]string) (emailtool.Result, error) {
			sawCred = creds["SMTP_PASSWORD"]
			// A hostile/naive transport echoes the credential into its detail — egress
			// redaction must strip it before the model ever sees the result.
			return emailtool.Result{Sent: true, Mode: "smtp", Detail: "authed with " + creds["SMTP_PASSWORD"]}, nil
		},
	}
	vault := &fakeVault{vals: map[secrets.Ref]string{ref: rawSecret}}
	policy := secrets.Policy{"secretary": {ref}}
	broker := secrets.NewBroker(vault, policy, nil)

	tl := mustTool(t, emailtool.Config{
		Sender:    live,
		DefaultTo: []string{"operator@example.com"},
		Broker:    broker,
		Grants:    map[string]secrets.Ref{"SMTP_PASSWORD": ref},
	})

	out, err := send(t, tl, map[string]any{"subject": "Digest", "body": "your morning digest"})
	if err != nil {
		t.Fatalf("granted credentialed send should succeed: %v", err)
	}
	if sawCred != rawSecret {
		t.Fatalf("the transport did not receive the scoped credential (got %q)", sawCred)
	}
	if !strings.Contains(out, "status: sent") || !strings.Contains(out, "sent=true") {
		t.Errorf("expected a sent result, got:\n%s", out)
	}
	if strings.Contains(out, rawSecret) {
		t.Fatalf("SECURITY: the raw credential reached the model output:\n%s", out)
	}
	if !strings.Contains(out, "[REDACTED:"+secrets.KindGitHubToken+"]") {
		t.Errorf("expected the echoed credential to be redacted on egress, got:\n%s", out)
	}
	if vault.calls == 0 {
		t.Error("the broker never resolved the granted credential")
	}
}

// (d) A recipient off the allowlist is REFUSED before any send (fail-closed), while
// an allowed recipient (exact or @domain) goes through.
func TestRecipientAllowlistFailsClosed(t *testing.T) {
	rec := &emailtool.Recorder{}
	tl := mustTool(t, emailtool.Config{
		Recorder:        rec,
		AllowRecipients: []string{"operator", "@example.com"},
	})

	// Off-list recipient: refused, nothing recorded.
	if _, err := send(t, tl, map[string]any{"to": []string{"stranger@example.org"}, "body": "leak"}); err == nil {
		t.Error("an off-allowlist recipient should be refused")
	}
	if rec.Len() != 0 {
		t.Errorf("a refused send must record nothing, recorder has %d", rec.Len())
	}

	// Allowed by @domain suffix: goes through.
	if _, err := send(t, tl, map[string]any{"to": []string{"founder@example.com"}, "body": "ok"}); err != nil {
		t.Errorf("an @example.com recipient should be allowed: %v", err)
	}
	if rec.Len() != 1 {
		t.Errorf("the allowed send should have recorded one message, got %d", rec.Len())
	}
}

// The alias set a manifest may declare the capability by all resolve to the same
// governed email tool; an unrelated name does not.
func TestCapabilityAliases(t *testing.T) {
	for _, name := range []string{"email", "notify", "send", "mail", "alert"} {
		tl, ok := emailtool.Tool(name, emailtool.Config{})
		if !ok {
			t.Errorf("alias %q should resolve to the email tool", name)
			continue
		}
		if tl.Name() != "email" {
			t.Errorf("alias %q resolved to a tool named %q, want canonical email", name, tl.Name())
		}
	}
	if _, ok := emailtool.Tool("read", emailtool.Config{}); ok {
		t.Error(`"read" must not resolve to the email tool`)
	}
}
