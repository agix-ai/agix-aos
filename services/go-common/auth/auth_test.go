package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// coordHeaders mirrors coord-mcp's wire contract — the same fixture the
// coord-mcp handlers use, proving the substrate preserves it.
var coordHeaders = Headers{Key: "X-Coord-Key", Agent: "X-Coord-Agent"}

func TestAuthenticate(t *testing.T) {
	keys := Keys{FleetKey: "fleet-secret", CoordinatorKey: "coord-secret"}
	tests := []struct {
		name            string
		bearer          string
		wantOK          bool
		wantCoordinator bool
	}{
		{"fleet key", "fleet-secret", true, false},
		{"coordinator key", "coord-secret", true, true},
		{"wrong key", "nope", false, false},
		{"empty bearer", "", false, false},
		{"prefix of key", "fleet", false, false},
		{"key plus suffix", "fleet-secret-x", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			coordinator, ok := keys.Authenticate(tt.bearer)
			if ok != tt.wantOK || coordinator != tt.wantCoordinator {
				t.Fatalf("Authenticate(%q) = (%v, %v), want (%v, %v)",
					tt.bearer, coordinator, ok, tt.wantCoordinator, tt.wantOK)
			}
		})
	}
}

func TestEmptyKeysNeverAuthenticate(t *testing.T) {
	keys := Keys{} // no keys configured
	if _, ok := keys.Authenticate(""); ok {
		t.Fatal("empty key must never authenticate an empty bearer")
	}
	if _, ok := keys.Authenticate("anything"); ok {
		t.Fatal("empty key must never authenticate")
	}
}

func TestMiddleware(t *testing.T) {
	keys := Keys{FleetKey: "fleet-secret", CoordinatorKey: "coord-secret"}
	var got Identity
	h := Middleware(keys, coordHeaders, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	// unauthenticated → 401, handler not reached
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no bearer: want 401, got %d", rec.Code)
	}

	// fleet key + agent header → identity in context
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer fleet-secret")
	req.Header.Set(coordHeaders.Agent, "agent-a")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fleet key: want 200, got %d", rec.Code)
	}
	if got.Agent != "agent-a" || got.Coordinator {
		t.Fatalf("identity = %+v", got)
	}

	// coordinator key
	req = httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer coord-secret")
	req.Header.Set(coordHeaders.Agent, "ops")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got.Agent != "ops" || !got.Coordinator {
		t.Fatalf("coordinator identity = %+v", got)
	}

	// the key header wins over Authorization (a platform IAM layer owns
	// Authorization behind --no-allow-unauthenticated)
	req = httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer some-google-identity-token")
	req.Header.Set(coordHeaders.Key, "fleet-secret")
	req.Header.Set(coordHeaders.Agent, "agent-b")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("key header auth: want 200, got %d", rec.Code)
	}
	if got.Agent != "agent-b" || got.Coordinator {
		t.Fatalf("key header identity = %+v", got)
	}
}

func TestMiddlewareDefaultHeaders(t *testing.T) {
	keys := Keys{FleetKey: "fleet-secret"}
	var got Identity
	h := Middleware(keys, DefaultHeaders, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Agix-Key", "fleet-secret")
	req.Header.Set("X-Agix-Agent", "  agent-c  ") // trimmed
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("default headers: want 200, got %d", rec.Code)
	}
	if got.Agent != "agent-c" || got.Coordinator {
		t.Fatalf("identity = %+v", got)
	}
}

func TestPresentedKeyWithNoKeyHeaderConfigured(t *testing.T) {
	hs := Headers{Agent: "X-Agix-Agent"} // Key unset → Authorization only
	h := http.Header{}
	h.Set("Authorization", "Bearer tok")
	if got := hs.PresentedKey(h); got != "tok" {
		t.Fatalf("PresentedKey = %q, want tok", got)
	}
}
