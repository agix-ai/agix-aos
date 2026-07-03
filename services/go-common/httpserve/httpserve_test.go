package httpserve

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	return m
}

func TestUpShape(t *testing.T) {
	h := Health{Service: "agix-test", Version: "abc1234"}
	rec := httptest.NewRecorder()
	h.Up()(rec, httptest.NewRequest(http.MethodGet, "/up", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	m := decode(t, rec)
	// the /up shape: {ok, service, version}
	if m["ok"] != true || m["service"] != "agix-test" || m["version"] != "abc1234" {
		t.Fatalf("up body = %v", m)
	}
}

func TestReadyShapeDefaultChecks(t *testing.T) {
	h := Health{Service: "agix-test", Version: "abc1234"}
	rec := httptest.NewRecorder()
	h.Ready()(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	m := decode(t, rec)
	if m["ready"] != true || m["service"] != "agix-test" || m["version"] != "abc1234" {
		t.Fatalf("ready body = %v", m)
	}
	checks, ok := m["checks"].(map[string]any)
	if !ok || checks["process"] != "ok" {
		t.Fatalf("checks = %v", m["checks"])
	}
}

func TestReadyCustomChecksStay200(t *testing.T) {
	h := Health{
		Service: "agix-test",
		Version: "abc1234",
		Checks: func() map[string]string {
			return map[string]string{"persistence": "degraded: snapshot write unconfirmed"}
		},
	}
	rec := httptest.NewRecorder()
	h.Ready()(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	// degraded is LOUD but 200 (the loud-but-200 readiness posture)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	checks := decode(t, rec)["checks"].(map[string]any)
	if checks["persistence"] != "degraded: snapshot write unconfirmed" || checks["process"] != "ok" {
		t.Fatalf("checks = %v", checks)
	}
}

func TestRegister(t *testing.T) {
	mux := http.NewServeMux()
	Health{Service: "s", Version: "v"}.Register(mux)
	for _, path := range []string{"/up", "/readyz"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
	}
}

func TestPort(t *testing.T) {
	t.Setenv("PORT", "")
	if got := Port(); got != "8080" {
		t.Errorf("default Port = %q", got)
	}
	t.Setenv("PORT", "9999")
	if got := Port(); got != "9999" {
		t.Errorf("Port = %q, want 9999", got)
	}
}

func TestNewServerDefaults(t *testing.T) {
	t.Setenv("PORT", "1234")
	srv := NewServer(http.NewServeMux())
	if srv.Addr != ":1234" {
		t.Errorf("Addr = %q", srv.Addr)
	}
	if srv.ReadHeaderTimeout != 10*time.Second {
		t.Errorf("ReadHeaderTimeout = %v", srv.ReadHeaderTimeout)
	}
}

func TestServeGracefulShutdown(t *testing.T) {
	// pick a free port
	t.Setenv("PORT", "0")
	mux := http.NewServeMux()
	Health{Service: "s", Version: "v"}.Register(mux)
	srv := NewServer(mux)
	srv.Addr = "127.0.0.1:0"

	// BaseContext fires once with the bound listener — the deterministic
	// "server is listening" hook (Addr carries the OS-assigned port).
	probe := make(chan string, 1)
	srv.BaseContext = func(l net.Listener) context.Context {
		select {
		case probe <- l.Addr().String():
		default:
		}
		return context.Background()
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, srv) }()

	// wait for the listener
	var addr string
	select {
	case addr = <-probe:
	case <-time.After(5 * time.Second):
		t.Fatal("server never started listening")
	}

	resp, err := http.Get(fmt.Sprintf("http://%s/up", addr))
	if err != nil {
		t.Fatalf("GET /up: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /up = %d (%s)", resp.StatusCode, body)
	}

	cancel() // the SIGTERM analog (SignalContext cancels on SIGTERM)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v on graceful shutdown, want nil", err)
		}
	case <-time.After(ShutdownWindow + 2*time.Second):
		t.Fatal("Serve did not shut down within the drain window")
	}
}

func TestServeListenError(t *testing.T) {
	srv := &http.Server{Addr: "127.0.0.1:1", Handler: http.NewServeMux()} // privileged port → error
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := Serve(ctx, srv); err == nil {
		t.Fatal("expected a listen error")
	}
}
