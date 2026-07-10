// Package email is the reborn fleet's GOVERNED email/notification tool — the
// credentialed capability that lets a boundary bee DELIVER a message (a digest to
// the operator, a budget-exhaustion alert) without ever holding a raw credential.
// Until now the ported secretary/ci-warden agents could COMPOSE a digest or detect
// an alert-worthy signature but never DELIVER it; declaring `tools: ["email"]` or
// `["notify"]` was a name with nothing behind it. This closes that gap under the
// same guard-bee boundary the exec tool uses.
//
// The governance model mirrors exec, and is fail-CLOSED at every gate:
//
//   - Pluggable transport. The tool holds a Sender (an interface), not a hard-wired
//     SMTP/Gmail client. The $0/offline DEFAULT is a DryRunSender that RECORDS the
//     message and sends NOTHING. A deployment wires a live transport by injecting a
//     Sender (SenderFunc adapts a plain function — an SMTP client, the Gmail API, a
//     Slack webhook — into the interface). The live adapter is a config follow-up;
//     the interface IS the seam.
//   - Least-privilege credentials via the guard-bee, EXACTLY like exec. A live
//     transport that needs a credential (an SMTP app-password, a Gmail token) gets
//     it through a scoped grant: the Broker resolves the granted refs and passes
//     them to the Sender as an ephemeral, zeroed credential map — the agent never
//     holds the raw key. No Broker/grant → the credential is simply ABSENT, and a
//     credential-needing Sender degrades to a QUEUED (not-sent) state rather than
//     sending with a missing/raw key. Credentialed sending FAILS CLOSED: no grant,
//     no send.
//   - Bounded recipients. An optional recipient allowlist constrains who may be
//     mailed; a recipient off the list is REFUSED before any send (nothing leaves).
//     An empty allowlist is unconstrained (the reborn default; the "to whom"
//     constraint is a deployment seam).
//   - Egress-redacted output. The model-facing result is scrubbed of known
//     credential shapes before it threads back into a turn, so a transport that
//     echoes a token in its detail can never leak it to the model.
//
// It is a stdlib-plus-core leaf: it imports encoding/json + core/tool (the
// interface) + core/secrets (the capability primitive) and nothing heavier, so
// wiring it into the runner introduces no cycle. Every send is audited by the agent
// tool-use loop as a KindToolCall (tool + args + ok), and every credential the
// guard-bee resolves is audited by the Broker as a secret_access record — so the
// ledger carries the provenance without this package touching the ledger (the exact
// posture core/tool/exec keeps).
//
// First-cut honesty (see the package tests and the port notes): the DEFAULT is a
// dry-run recorder — no live mail leaves the box offline. The live SMTP/Gmail
// adapter, streaming/threaded delivery, retry/backoff, and multi-channel fan-out
// (Slack/PagerDuty) are tracked next rungs; this package ships the governed seam +
// the fail-closed credential path they plug into.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package email

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/agix-ai/agix/core/secrets"
	"github.com/agix-ai/agix/core/tool"
)

// DefaultTimeout bounds a single send; a transport that wedges is cancelled past it.
const DefaultTimeout = 30 * time.Second

// Message is one email/notification to deliver. It is the JSON contract the model
// produces AND the value a Sender delivers. Body is required; To defaults to the
// tool's DefaultTo when the model names no recipient. Channel/Level carry the
// generic-notification framing (an email is just channel="email").
type Message struct {
	To      []string `json:"to,omitempty"`
	Cc      []string `json:"cc,omitempty"`
	From    string   `json:"from,omitempty"`
	Subject string   `json:"subject,omitempty"`
	Body    string   `json:"body"`
	Channel string   `json:"channel,omitempty"` // "email" (default) | a notify channel label
	Level   string   `json:"level,omitempty"`   // info | warn | critical (notify severity)
}

// Result is the outcome of one delivery attempt. A dry-run/degraded send is
// Queued (recorded, not delivered); a live send is Sent. Mode names the transport
// path taken ("dry-run" | "queued" | the Sender's own mode).
type Result struct {
	Sent    bool   `json:"sent"`
	Queued  bool   `json:"queued"`
	Mode    string `json:"mode"`
	Channel string `json:"channel"`
	ID      string `json:"id,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// Sender is the pluggable transport — the seam a deployment wires its live mail path
// through. The tool NEVER hard-wires SMTP/Gmail; it holds a Sender and delivers
// through it. NeedsCredentials declares whether Send requires the guard-bee to
// resolve a credential grant first; a credential-needing Sender is NEVER invoked
// without one (fail-closed — see the tool's Execute).
type Sender interface {
	// Name identifies the transport for the result + audit ("dry-run", "smtp", …).
	Name() string
	// NeedsCredentials reports whether Send requires a resolved credential grant.
	NeedsCredentials() bool
	// Send delivers msg. creds is the guard-bee-resolved, scoped credential set
	// (empty when the transport needs none). An implementation MUST NOT deliver with
	// a required credential missing — it returns a Queued result instead.
	Send(ctx context.Context, msg Message, creds map[string]string) (Result, error)
}

// Recorder is the in-memory sink the DryRunSender writes to, so a caller (or a test)
// can read exactly what WOULD have been sent. It is concurrency-safe because the
// swarm's worker bees run in parallel.
type Recorder struct {
	mu   sync.Mutex
	msgs []Message
}

// Record appends a message. Messages returns a copy of everything recorded so far.
func (r *Recorder) Record(m Message) {
	r.mu.Lock()
	r.msgs = append(r.msgs, m)
	r.mu.Unlock()
}

// Messages returns a snapshot copy of the recorded messages.
func (r *Recorder) Messages() []Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Message, len(r.msgs))
	copy(out, r.msgs)
	return out
}

// Len reports how many messages have been recorded.
func (r *Recorder) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.msgs)
}

// DryRunSender is the $0/offline default transport: it RECORDS the message and
// delivers NOTHING. It never needs a credential, so it always runs — the honest
// zero-cost posture. A nil Recorder is fine (the message is simply not retained).
type DryRunSender struct{ Recorder *Recorder }

func (d *DryRunSender) Name() string           { return "dry-run" }
func (d *DryRunSender) NeedsCredentials() bool { return false }
func (d *DryRunSender) Send(_ context.Context, msg Message, _ map[string]string) (Result, error) {
	if d.Recorder != nil {
		d.Recorder.Record(msg)
	}
	return Result{
		Sent:    false,
		Queued:  true,
		Mode:    "dry-run",
		Channel: channelOf(msg),
		Detail:  "recorded, not sent ($0 offline default)",
	}, nil
}

// SenderFunc adapts a plain function to a Sender — the generic pluggable seam a
// deployment wires its live transport through (an SMTP client, the Gmail API, a
// webhook). Credentialed declares whether the function requires a guard-bee grant;
// when true the tool resolves the grant and passes it as creds, and refuses to call
// the function at all when no grant is available (fail-closed).
type SenderFunc struct {
	Transport    string
	Credentialed bool
	Fn           func(ctx context.Context, msg Message, creds map[string]string) (Result, error)
}

func (s SenderFunc) Name() string           { return orDefault(s.Transport, "custom") }
func (s SenderFunc) NeedsCredentials() bool { return s.Credentialed }
func (s SenderFunc) Send(ctx context.Context, msg Message, creds map[string]string) (Result, error) {
	if s.Fn == nil {
		return Result{Queued: true, Mode: "queued", Channel: channelOf(msg), Detail: "no transport function wired"}, nil
	}
	return s.Fn(ctx, msg, creds)
}

// Config is the governance envelope one email tool is constructed with. The zero
// value is SAFE: a nil Sender means a dry-run recorder (records, never sends), a nil
// Broker/empty Grants means no credential is ever resolved, and an empty
// AllowRecipients is unconstrained. Every field NARROWS or WIRES a capability.
type Config struct {
	// Sender is the delivery transport; nil → a DryRunSender (records, never sends).
	Sender Sender
	// Recorder is attached to the default DryRunSender when Sender is nil, so a
	// caller can read what was queued. Ignored when Sender is set.
	Recorder *Recorder
	// DefaultTo is the fallback recipient when a message names none (e.g. "operator").
	DefaultTo []string
	// AllowRecipients constrains who may be mailed. Empty → unconstrained. An entry
	// may be an exact address, an "@domain" suffix, or "*" (any). A recipient off the
	// list FAILS CLOSED (refused before any send).
	AllowRecipients []string

	// Broker + Grants are the guard-bee credential capability, exactly like exec.
	// When BOTH are set AND the Sender needs credentials, each granted ref is resolved
	// by the Broker and passed to the Sender as a scoped, zeroed credential map — the
	// agent never holds the raw key. A nil Broker or empty Grants means no credential:
	// a credential-needing Sender degrades to QUEUED (never sends with a missing key).
	Broker *secrets.Broker
	Grants map[string]secrets.Ref // credential env NAME → secret ref

	// Scanner redacts credential shapes from the model-facing result; nil → default.
	Scanner *secrets.EgressScanner
	// Timeout bounds a single send; <=0 → DefaultTimeout.
	Timeout time.Duration
}

// Tool returns the governed email tool if name is one of the capability aliases a
// manifest declares it by — "email", "notify", "send", or "mail" — and whether the
// name was recognized. The aliases name the CAPABILITY ("deliver a message"); the
// tool is the same governed, fail-closed sender regardless of which alias summoned
// it. Mirrors exec.Tool's (Tool, bool) contract so one resolver can try fs, metric,
// exec, then email.
func Tool(name string, cfg Config) (tool.Tool, bool) {
	switch strings.TrimSpace(name) {
	case "email", "notify", "send", "mail", "alert":
		return &emailTool{cfg: cfg}, true
	}
	return nil, false
}

type emailTool struct{ cfg Config }

func (t *emailTool) Name() string { return "email" }
func (t *emailTool) Description() string {
	return "Deliver an email or notification through the agent's governed transport. " +
		"Args: {\"to\":[\"operator\"],\"subject\":\"…\",\"body\":\"…\",\"channel\":\"email\",\"level\":\"info\"}. " +
		"The default transport is a dry-run recorder (records the message, sends nothing) — a live " +
		"transport is a deployment config. Credentialed sending requires a guard-bee grant and fails " +
		"closed without one (the message is queued, never sent with a missing key). Recipients may be " +
		"constrained by an allowlist."
}

var schema = json.RawMessage(`{"type":"object","properties":{` +
	`"to":{"type":"array","items":{"type":"string"},"description":"recipient addresses (or a logical name like \"operator\"); defaults to the agent's configured recipient"},` +
	`"cc":{"type":"array","items":{"type":"string"},"description":"optional cc recipients"},` +
	`"from":{"type":"string","description":"optional sender identity; the transport supplies a default"},` +
	`"subject":{"type":"string","description":"the subject line (email channel)"},` +
	`"body":{"type":"string","description":"the message body (required)"},` +
	`"channel":{"type":"string","description":"delivery channel; \"email\" (default) or a notify channel label"},` +
	`"level":{"type":"string","description":"notify severity: info | warn | critical"}` +
	`},"required":["body"]}`)

func (t *emailTool) InputSchema() json.RawMessage { return schema }

// Execute delivers one model-requested message under the full governance envelope.
// It fails CLOSED at every gate: a missing body/recipient, a recipient off the
// allowlist, or a credential-needing transport with no grant is refused or queued
// BEFORE anything leaves. Only a permitted, credential-satisfied (or credential-free)
// send reaches the transport, and its result is egress-redacted before it threads
// back into a model turn.
func (t *emailTool) Execute(ctx context.Context, raw json.RawMessage) (string, error) {
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil && len(raw) > 0 {
		return "", fmt.Errorf("email: invalid arguments: %v", err)
	}

	msg.To = cleanList(msg.To)
	if len(msg.To) == 0 {
		msg.To = cleanList(t.cfg.DefaultTo)
	}
	msg.Cc = cleanList(msg.Cc)

	if strings.TrimSpace(msg.Body) == "" {
		return "", fmt.Errorf("email: body is required")
	}
	if len(msg.To) == 0 {
		return "", fmt.Errorf("email: at least one recipient is required (none given and no default recipient configured)")
	}
	// Recipient allowlist — fail closed BEFORE any send.
	if bad := t.disallowed(msg.To, msg.Cc); bad != "" {
		return "", fmt.Errorf("email: recipient %q is not permitted by this agent's recipient allowlist (refused, nothing sent)", bad)
	}

	sender := t.cfg.Sender
	if sender == nil {
		sender = &DryRunSender{Recorder: t.cfg.Recorder}
	}

	timeout := t.cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var res Result
	var sendErr error
	var degraded string

	if sender.NeedsCredentials() {
		// Credentialed transport: FAIL CLOSED. It is only ever invoked with a resolved
		// guard-bee grant; with no grant (or a grant the vault cannot resolve) it is NOT
		// called at all — the message degrades to queued rather than sending with a
		// missing/raw key. This is the "no grant → no send" invariant.
		if t.cfg.Broker != nil && len(t.cfg.Grants) > 0 {
			ran := false
			injErr := t.cfg.Broker.WithSecretEnv(runCtx, t.cfg.Grants, func(env []string) error {
				ran = true
				creds := envToMap(env)
				var e error
				res, e = sender.Send(runCtx, msg, creds)
				return e
			})
			if ran {
				sendErr = injErr
			} else {
				degraded = "granted credential unavailable; queued, not sent"
				res = queued(msg, degraded)
			}
		} else {
			degraded = "no credential grant for a credentialed transport; queued, not sent (fail-closed)"
			res = queued(msg, degraded)
		}
	} else {
		res, sendErr = sender.Send(runCtx, msg, nil)
	}

	if sendErr != nil {
		scanner := t.scanner()
		// Never let a transport error leak a credential shape back to the model.
		return "", fmt.Errorf("email: send via %s failed: %s", sender.Name(), scanner.RedactKnown(sendErr.Error()))
	}
	return t.render(sender, msg, res, degraded), nil
}

// render composes the model-facing result and egress-redacts it: known credential
// shapes (a token a transport echoed into its detail) are stripped before the text
// threads into a model turn. Mirrors exec's RedactKnown egress boundary.
func (t *emailTool) render(sender Sender, msg Message, res Result, degraded string) string {
	var b strings.Builder
	if degraded != "" {
		fmt.Fprintf(&b, "note: %s\n", degraded)
	}
	status := "queued"
	if res.Sent {
		status = "sent"
	}
	fmt.Fprintf(&b, "email via %s → %s\n", sender.Name(), strings.Join(msg.To, ", "))
	if len(msg.Cc) > 0 {
		fmt.Fprintf(&b, "cc: %s\n", strings.Join(msg.Cc, ", "))
	}
	fmt.Fprintf(&b, "channel: %s\n", channelOf(msg))
	if s := strings.TrimSpace(msg.Subject); s != "" {
		fmt.Fprintf(&b, "subject: %s\n", s)
	}
	fmt.Fprintf(&b, "status: %s (mode=%s, sent=%v, queued=%v)\n", status, orDefault(res.Mode, "unknown"), res.Sent, res.Queued)
	if res.ID != "" {
		fmt.Fprintf(&b, "id: %s\n", res.ID)
	}
	if d := strings.TrimSpace(res.Detail); d != "" {
		fmt.Fprintf(&b, "detail: %s\n", d)
	}
	return t.scanner().RedactKnown(b.String())
}

func (t *emailTool) scanner() *secrets.EgressScanner {
	if t.cfg.Scanner != nil {
		return t.cfg.Scanner
	}
	return secrets.NewEgressScanner()
}

// disallowed returns the first recipient (to or cc) not permitted by the allowlist,
// or "" when every recipient is allowed (or the allowlist is empty/unconstrained).
func (t *emailTool) disallowed(to, cc []string) string {
	if len(t.cfg.AllowRecipients) == 0 {
		return ""
	}
	for _, r := range append(append([]string{}, to...), cc...) {
		if !t.recipientAllowed(r) {
			return r
		}
	}
	return ""
}

func (t *emailTool) recipientAllowed(r string) bool {
	rl := strings.ToLower(strings.TrimSpace(r))
	for _, a := range t.cfg.AllowRecipients {
		a = strings.ToLower(strings.TrimSpace(a))
		switch {
		case a == "*":
			return true
		case a == rl:
			return true
		case strings.HasPrefix(a, "@") && strings.HasSuffix(rl, a):
			return true
		}
	}
	return false
}

// ── helpers ──────────────────────────────────────────────────────────────────

func queued(msg Message, detail string) Result {
	return Result{Sent: false, Queued: true, Mode: "queued", Channel: channelOf(msg), Detail: detail}
}

func channelOf(msg Message) string {
	if c := strings.TrimSpace(msg.Channel); c != "" {
		return c
	}
	return "email"
}

func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// envToMap parses the Broker's scoped KEY=value env slice into a credential map.
func envToMap(env []string) map[string]string {
	m := make(map[string]string, len(env))
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

var _ tool.Tool = (*emailTool)(nil)
