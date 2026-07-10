// SPDX-License-Identifier: Apache-2.0
// Package httpserve provides the standard Agix Go service HTTP shell:
// /up + /readyz handlers, PORT-env listening, and graceful SIGTERM shutdown
// within a bounded drain window.
//
// Endpoint convention: liveness is /up, NOT /healthz (some platforms — e.g.
// Cloud Run's queue-proxy — reserve /healthz); readiness is /readyz.
package httpserve

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// ShutdownWindow is the graceful-drain budget. Cloud Run, for example,
// delivers SIGTERM and allows 10 seconds before SIGKILL.
const ShutdownWindow = 10 * time.Second

// Health identifies the service for the /up and /readyz handlers.
type Health struct {
	// Service is the logical service name.
	Service string
	// Version is the git SHA / version tag stamped into the binary.
	Version string
	// Checks optionally reports named readiness checks (value "ok" or a
	// human-readable degradation reason). Informational — /readyz stays 200
	// (loud-but-200 posture: a degraded dependency is reported, not fatal).
	Checks func() map[string]string
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// Up is the liveness handler: {"ok":true,"service":...,"version":...}.
func (h Health) Up() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"ok":      true,
			"service": h.Service,
			"version": h.Version,
		})
	}
}

// Ready is the readiness handler:
// {"ready":true,"service":...,"version":...,"checks":{...}}. With no Checks
// configured it reports {"process":"ok"}.
func (h Health) Ready() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		checks := map[string]string{"process": "ok"}
		if h.Checks != nil {
			for k, v := range h.Checks() {
				checks[k] = v
			}
		}
		writeJSON(w, map[string]any{
			"ready":   true,
			"service": h.Service,
			"version": h.Version,
			"checks":  checks,
		})
	}
}

// Register mounts Up at /up and Ready at /readyz.
func (h Health) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /up", h.Up())
	mux.HandleFunc("GET /readyz", h.Ready())
}

// Port returns the listen port: $PORT, defaulting to 8080.
func Port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8080"
}

// NewServer builds the standard *http.Server: addr :$PORT and a 10s
// ReadHeaderTimeout (slow-loris guard).
func NewServer(handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              ":" + Port(),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

// SignalContext returns a context canceled on SIGTERM/SIGINT. Pass it to Serve.
func SignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
}

// Serve runs srv until it fails or ctx is canceled, then drains in-flight
// requests within ShutdownWindow. Returns nil on a clean shutdown.
func Serve(ctx context.Context, srv *http.Server) error {
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), ShutdownWindow)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
