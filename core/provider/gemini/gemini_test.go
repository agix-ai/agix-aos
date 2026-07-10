// SECURITY regression tests for the Gemini adapter. No real API calls — every
// test drives an httptest server. The load-bearing assertion is that the API key
// travels in the x-goog-api-key HEADER and NEVER in the URL query, so a
// transport error's *url.Error string can't carry the key into the ledger/stderr.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package gemini

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/router"
)

const fakeKey = "AIzaSyFAKE0123456789abcdefghijklmnopqrs" // fake; never a real key

// TestChatSendsKeyInHeaderNotURL is the core regression: the key must ride in
// the header and the request URL must carry no key= query.
func TestChatSendsKeyInHeaderNotURL(t *testing.T) {
	var gotURL, gotHeader, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		gotQuery = r.URL.RawQuery
		gotHeader = r.Header.Get("x-goog-api-key")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],` +
			`"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}`))
	}))
	defer srv.Close()

	p := &Provider{APIKey: fakeKey, BaseURL: srv.URL, HTTP: srv.Client()}
	resp, err := p.Chat(context.Background(), router.ChatRequest{
		Model:    "gemini-2.5-flash",
		Messages: []router.Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if resp.Text != "pong" {
		t.Errorf("text = %q, want pong", resp.Text)
	}

	// The key must NOT appear in the URL (query string) at all.
	if gotQuery != "" {
		t.Errorf("request URL carried a query string %q — the key must not be in the URL", gotQuery)
	}
	if strings.Contains(gotURL, fakeKey) || strings.Contains(gotURL, "key=") {
		t.Errorf("SECURITY: request URL %q must not embed the API key or a key= param", gotURL)
	}
	// The key MUST be presented in the header instead.
	if gotHeader != fakeKey {
		t.Errorf("x-goog-api-key header = %q, want the API key", gotHeader)
	}
}

// TestTransportErrorDoesNotLeakKey proves the leak is closed at the source: on a
// transport failure the returned *url.Error string embeds the URL, and that URL
// must not contain the key (because the key is a header, not a query param).
func TestTransportErrorDoesNotLeakKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // force a connection-refused transport error against a dead server

	p := &Provider{APIKey: fakeKey, BaseURL: url, HTTP: srv.Client()}
	_, err := p.Chat(context.Background(), router.ChatRequest{
		Model:    "gemini-2.5-flash",
		Messages: []router.Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected a transport error against the closed server")
	}
	if strings.Contains(err.Error(), fakeKey) {
		t.Fatalf("SECURITY: transport error leaked the API key: %q", err.Error())
	}
}
