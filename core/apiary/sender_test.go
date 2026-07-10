// SPDX-License-Identifier: Apache-2.0
package apiary

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeGateway stands in for services/hive-gateway's POST /apiary/report: it
// asserts the request shape (method, bearer, JSON body) and answers with the
// gateway's real acknowledgement body so the round-trip is exercised end-to-end
// in-process, with no network.
func TestReportHomeRoundTrip(t *testing.T) {
	var gotMethod, gotAuth, gotCT string
	var gotEnv Envelope

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("content-type")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &gotEnv); err != nil {
			t.Errorf("gateway: decode envelope: %v (body=%s)", err, body)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accepted":    true,
			"entry_id":    "018f9c2a-1111-7000-8000-000000000abc",
			"envelope_id": gotEnv.EnvelopeID,
		})
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client(), Endpoint: srv.URL, Key: "local-dev"}

	env := EnvelopeFromResult(
		ResultLike{
			Text:         "forage complete",
			Provider:     "mock",
			Model:        "mock-1",
			InputTokens:  12,
			OutputTokens: 34,
		},
		ReportMeta{
			FromHive:      "agix",
			ToHive:        "agix",
			Actor:         ActorRef("agix", "drone", "forager"),
			Lineage:       []string{"agix/drone/forager", "agix/queen/root"},
			AuthorityUsed: "cross-hive-report",
			Now:           func() time.Time { return time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC) },
			NewID:         func() string { return "018f9c2a-0000-7000-8000-000000000001" },
		},
	)

	receipt, err := c.ReportHome(context.Background(), env)
	if err != nil {
		t.Fatalf("ReportHome() error = %v", err)
	}

	// Request shape.
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotAuth != "Bearer local-dev" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer local-dev")
	}
	if gotCT != "application/json" {
		t.Errorf("content-type = %q, want application/json", gotCT)
	}

	// Body round-tripped byte-faithfully into the canonical Envelope.
	if gotEnv.EnvelopeID != "018f9c2a-0000-7000-8000-000000000001" {
		t.Errorf("envelope_id = %q", gotEnv.EnvelopeID)
	}
	if gotEnv.TS != "2026-07-04T12:00:00Z" {
		t.Errorf("ts = %q, want 2026-07-04T12:00:00Z", gotEnv.TS)
	}
	if gotEnv.Kind != KindReport {
		t.Errorf("kind = %q, want report", gotEnv.Kind)
	}
	if gotEnv.Actor != "agix/drone/forager" {
		t.Errorf("actor = %q", gotEnv.Actor)
	}
	var payload struct {
		Text  string `json:"text"`
		Usage struct {
			InputTokens int `json:"input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(gotEnv.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Text != "forage complete" || payload.Usage.InputTokens != 12 {
		t.Errorf("payload = %+v, want text=forage complete input_tokens=12", payload)
	}

	// Receipt parsed.
	if !receipt.Accepted {
		t.Error("receipt.Accepted = false, want true")
	}
	if receipt.EntryID != "018f9c2a-1111-7000-8000-000000000abc" {
		t.Errorf("receipt.EntryID = %q", receipt.EntryID)
	}
	if receipt.EnvelopeID != env.EnvelopeID {
		t.Errorf("receipt.EnvelopeID = %q, want %q", receipt.EnvelopeID, env.EnvelopeID)
	}
}

// TestReportHomeRedactsSecret is the SECURITY regression for BUG 1: a credential
// shape in worker output (r.Text) must be redacted before the envelope crosses
// the hive boundary — the EgressScanner is wired into the report-home sender.
func TestReportHomeRedactsSecret(t *testing.T) {
	const key = "AIzaSyLEAK0123456789abcdefghijklmnopqrs"
	var rawBody []byte
	var gotEnv Envelope
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawBody, _ = io.ReadAll(r.Body)
		_ = json.Unmarshal(rawBody, &gotEnv)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "entry_id": "e", "envelope_id": gotEnv.EnvelopeID})
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client(), Endpoint: srv.URL, Key: "local-dev"}
	env := EnvelopeFromResult(
		ResultLike{Text: "here is the leaked config key=" + key + " end", Provider: "mock", Model: "m"},
		ReportMeta{
			FromHive: "agix", ToHive: "agix",
			Actor:         ActorRef("agix", "drone", "forager"),
			Lineage:       []string{"agix/drone/forager", "agix/queen/root"},
			AuthorityUsed: "cross-hive-report",
			Now:           func() time.Time { return time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC) },
			NewID:         func() string { return "018f9c2a-0000-7000-8000-000000000002" },
		},
	)
	if _, err := c.ReportHome(context.Background(), env); err != nil {
		t.Fatalf("ReportHome: %v", err)
	}

	// The exact bytes on the wire must not carry the key.
	if strings.Contains(string(rawBody), key) {
		t.Fatalf("SECURITY: report-home POST shipped the API key cross-hive:\n%s", rawBody)
	}
	var payload struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(gotEnv.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if strings.Contains(payload.Text, key) || !strings.Contains(payload.Text, "[REDACTED:google-api-key]") {
		t.Fatalf("payload text not redacted: %q", payload.Text)
	}
}

// A non-2xx from the gateway becomes a typed *SendError carrying status + body.
func TestReportHomeNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accepted": false,
			"error":    "rejected",
			"reason":   "actor caste worker may not cross a hive boundary (drones only)",
		})
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client(), Endpoint: srv.URL, Key: "local-dev"}
	env := validEnvelope()
	env.ToHive = "agix" // so local validation passes; the SERVER is the one rejecting

	_, err := c.ReportHome(context.Background(), env)
	if err == nil {
		t.Fatal("ReportHome() = nil error, want *SendError")
	}
	var se *SendError
	if !errors.As(err, &se) {
		t.Fatalf("error = %T, want *SendError", err)
	}
	if se.Status != http.StatusForbidden {
		t.Errorf("SendError.Status = %d, want 403", se.Status)
	}
	if !strings.Contains(se.Body, "drones only") {
		t.Errorf("SendError.Body = %q, want it to carry the gateway reason", se.Body)
	}
}

// ReportHome fails fast on a locally-invalid envelope — no request is made.
func TestReportHomeFailsFastLocally(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client(), Endpoint: srv.URL, Key: "local-dev"}
	env := validEnvelope()
	env.Actor = "widgetco/worker/forager" // not a drone → must be caught locally

	_, err := c.ReportHome(context.Background(), env)
	if err == nil {
		t.Fatal("ReportHome() = nil, want local validation error")
	}
	if hits != 0 {
		t.Errorf("gateway hit %d times, want 0 (fail fast before the network)", hits)
	}
	var re *RejectError
	if !errors.As(err, &re) || re.Status != http.StatusForbidden {
		t.Errorf("want wrapped *RejectError 403, got %v", err)
	}
}

func TestNewEnvelopeIDShape(t *testing.T) {
	id := NewEnvelopeID()
	// 8-4-4-4-12 hex, version nibble 7.
	parts := strings.Split(id, "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[2]) != 4 || parts[2][0] != '7' {
		t.Fatalf("NewEnvelopeID() = %q, not a UUIDv7-shaped string", id)
	}
	if NewEnvelopeID() == id {
		t.Error("NewEnvelopeID() returned the same id twice")
	}
}
