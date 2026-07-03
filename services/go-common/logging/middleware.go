// SPDX-License-Identifier: Apache-2.0
package logging

import (
	"math"
	"net/http"
	"os"
	"time"
)

// QuietEnv is the switch that silences the request-log middleware (set it
// during load runs so the logger itself isn't benchmarked). App-event logging
// (Info/Warn/Error) is unaffected.
const QuietEnv = "AGIX_LOG_QUIET"

// QuietFromEnv reports whether request logging should be silenced.
func QuietFromEnv() bool { return os.Getenv(QuietEnv) == "1" }

// StatusRecorder captures the response status code for after-the-fact log or
// span attributes. It passes Flush through so streaming responses (SSE — the
// MCP Streamable HTTP transport) keep working under the wrapper.
type StatusRecorder struct {
	http.ResponseWriter
	status int
}

// NewStatusRecorder wraps w; Status() defaults to 200 until WriteHeader runs.
func NewStatusRecorder(w http.ResponseWriter) *StatusRecorder {
	return &StatusRecorder{ResponseWriter: w, status: http.StatusOK}
}

// Status returns the recorded (or default 200) status code.
func (s *StatusRecorder) Status() int { return s.status }

// WriteHeader records the status and forwards it.
func (s *StatusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush forwards to the underlying writer when it supports streaming.
func (s *StatusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// RequestLog emits one {"event":"http_request"} line per request with method,
// path, status, and duration_ms. quiet (see QuietFromEnv) disables it entirely.
// BOUNDED by construction: the path set of these services is a handful of fixed
// routes; no query strings, headers, bodies, or identity are ever logged.
func RequestLog(l *Logger, quiet bool, next http.Handler) http.Handler {
	if quiet {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		rec := NewStatusRecorder(w)
		next.ServeHTTP(rec, r)
		l.Info("http_request", Fields{
			"method":      r.Method,
			"path":        r.URL.Path,
			"status":      rec.Status(),
			"duration_ms": math.Round(float64(time.Since(t0).Microseconds())/10) / 100,
		})
	})
}
