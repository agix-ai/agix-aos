// SPDX-License-Identifier: Apache-2.0
// This file is the report-home SENDER: the pure-Go client that maps an agent
// result into a cross-hive Envelope and POSTs it, authenticated, to a hive's
// report-home gateway. It closes the federated-apiary loop — the receiver
// (services/hive-gateway) already exists; this is the door on the other side.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package apiary

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/agix-ai/agix/core/secrets"
)

// egress redacts a credential shape before an envelope leaves the hive. A
// report-home POST is a cross-hive egress door — the same boundary the
// EgressScanner header promises to guard. Wired here (value-level in
// EnvelopeFromResult, wire-level in ReportHome), not left to the manual CLI.
var egress = secrets.NewEgressScanner()

// defaultTimeout bounds a report-home POST. Envelopes are tiny governance
// records; a report that cannot land in this window is a network problem, not a
// slow body.
const defaultTimeout = 30 * time.Second

// Client posts cross-hive envelopes to a hive's report-home gateway. HTTP is
// injectable so tests can drive it against an httptest server; a nil HTTP falls
// back to a client with a sane timeout.
type Client struct {
	HTTP     *http.Client
	Endpoint string // full URL of the gateway's POST /apiary/report
	Key      string // per-hive bearer key (AGIX_HIVE_KEY)
}

// NewClient builds a Client with a default timeout HTTP client.
func NewClient(endpoint, key string) *Client {
	return &Client{
		HTTP:     &http.Client{Timeout: defaultTimeout},
		Endpoint: endpoint,
		Key:      key,
	}
}

// Receipt is the gateway's acknowledgement of an accepted envelope: the ledger
// entry id it minted and the envelope id it echoes back.
type Receipt struct {
	Accepted   bool   `json:"accepted"`
	EntryID    string `json:"entry_id"`
	EnvelopeID string `json:"envelope_id"`
}

// SendError is a typed non-2xx response from the gateway — the perimeter
// rejected the envelope (401 unauthorized, 403 non-drone, 409 wrong hive, 422
// malformed) or the gateway failed internally. Status and Body are preserved so
// the caller can act on them.
type SendError struct {
	Status int
	Body   string
}

func (e *SendError) Error() string {
	return fmt.Sprintf("apiary: report-home rejected: http %d: %s", e.Status, e.Body)
}

// ReportHome validates env locally (fail fast, before any network) and POSTs it
// as JSON to c.Endpoint with an Authorization: Bearer key. It returns the
// parsed Receipt on a 2xx, a *SendError on a non-2xx, or a wrapped error on a
// local validation / transport / decode failure.
//
// Local validation uses the envelope's own ToHive as the reference hive: every
// check except the receiver-only "is this my hive" perimeter check applies —
// required fields, kind, RFC3339 ts, actor format, and (crucially) the
// drone-only crossing rule, so a mis-casted actor is caught here instead of
// costing a round-trip to a 403.
func (c *Client) ReportHome(ctx context.Context, env Envelope) (Receipt, error) {
	if err := env.Validate(env.ToHive); err != nil {
		return Receipt{}, fmt.Errorf("apiary: envelope invalid: %w", err)
	}

	buf, err := json.Marshal(env)
	if err != nil {
		return Receipt{}, fmt.Errorf("apiary: marshal envelope: %w", err)
	}
	// Final egress guard over the exact wire bytes: even an envelope built
	// directly (not via EnvelopeFromResult) cannot ship a credential shape in its
	// payload. Known-shape redaction is JSON-safe, so the body stays valid.
	buf = []byte(egress.RedactKnown(string(buf)))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint, bytes.NewReader(buf))
	if err != nil {
		return Receipt{}, fmt.Errorf("apiary: build request: %w", err)
	}
	// Mirror the provider adapters' header idiom (see core/provider/anthropic):
	// content-type + the auth header. The gateway reads a bearer token from the
	// Authorization header (services/go-common/auth PresentedKey).
	req.Header.Set("content-type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Key)

	httpc := c.HTTP
	if httpc == nil {
		httpc = &http.Client{Timeout: defaultTimeout}
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return Receipt{}, fmt.Errorf("apiary: http: %w", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return Receipt{}, &SendError{Status: resp.StatusCode, Body: truncate(data)}
	}

	var receipt Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return Receipt{}, fmt.Errorf("apiary: decode receipt: %w", err)
	}
	return receipt, nil
}

// ResultLike is the minimal, dependency-free view of an agent run the envelope
// builder needs. The CALLER (which knows core/agent) copies an agent.Result
// into this struct — apiary never imports agent, so the only dependency edge is
// agent → apiary and there is no cycle.
type ResultLike struct {
	Text     string
	Provider string
	Model    string
	Degraded []string

	InputTokens  int
	OutputTokens int
	CachedTokens int
	CostUSD      float64
}

// ReportMeta carries the cross-hive addressing an agent result does not itself
// know: who is reporting, to which hive, under what authority, and the lineage
// back to a human-rooted queen. Now and NewID are injectable seams (tests pin
// them; production leaves them nil for a real clock + UUIDv7).
type ReportMeta struct {
	FromHive      string
	ToHive        string
	Actor         string   // "<hive>/drone/<designation>" — MUST be a drone to cross
	Lineage       []string // index 0 = sender actor, last = human-rooted queen
	AuthorityUsed string

	Now   func() time.Time // nil → time.Now
	NewID func() string    // nil → NewEnvelopeID (UUIDv7)
}

// EnvelopeFromResult maps an agent result + addressing metadata into a
// report-kind Envelope. The result rides in the payload as a compact JSON
// object; ts is stamped from meta.Now and envelope_id from meta.NewID.
func EnvelopeFromResult(r ResultLike, meta ReportMeta) Envelope {
	now := meta.Now
	if now == nil {
		now = time.Now
	}
	newID := meta.NewID
	if newID == nil {
		newID = NewEnvelopeID
	}

	payload := map[string]any{
		// Redact the model output before it becomes envelope payload: worker text
		// is the most likely place a leaked credential rides cross-hive.
		"text":     egress.RedactKnown(r.Text),
		"provider": r.Provider,
		"model":    r.Model,
		"usage": map[string]any{
			"input_tokens":  r.InputTokens,
			"output_tokens": r.OutputTokens,
			"cached_tokens": r.CachedTokens,
			"cost_usd":      r.CostUSD,
		},
	}
	if len(r.Degraded) > 0 {
		payload["degraded"] = r.Degraded
	}
	// map[string]any marshal is infallible for these types; ignore the error.
	raw, _ := json.Marshal(payload)

	return Envelope{
		EnvelopeID:    newID(),
		TS:            now().UTC().Format(time.RFC3339),
		FromHive:      meta.FromHive,
		ToHive:        meta.ToHive,
		Kind:          KindReport,
		Actor:         meta.Actor,
		Lineage:       meta.Lineage,
		AuthorityUsed: meta.AuthorityUsed,
		Payload:       raw,
	}
}

// NewEnvelopeID returns a UUIDv7 (time-ordered, RFC 9562) string — the same
// time-sortable id family the gateway ledger uses, so a sent envelope_id and
// the entry_id it earns sort by creation order. Stdlib-only: unix-millis prefix
// + crypto/rand tail.
func NewEnvelopeID() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		// crypto/rand never fails on supported platforms; a zeroed tail still
		// yields a well-formed, time-ordered id if it somehow does.
		_ = err
	}
	b[6] = (b[6] & 0x0f) | 0x70 // version 7
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func truncate(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}
