package logging

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func capture(t *testing.T, l *Logger) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	l.SetOutput(&buf)
	return &buf
}

func parseLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line := strings.TrimSpace(buf.String())
	if strings.Contains(line, "\n") {
		t.Fatalf("expected exactly one line, got: %q", line)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("line is not JSON: %v (%q)", err, line)
	}
	return m
}

func TestLineShape(t *testing.T) {
	l := New("agix.test-service", Fields{"service": "test-service", "version": "abc123"})
	buf := capture(t, l)

	l.Info("server_started", Fields{"port": "8080"})

	m := parseLine(t, buf)
	for k, want := range map[string]any{
		"severity": "INFO",
		"kind":     "agix.test-service",
		"event":    "server_started",
		"service":  "test-service",
		"version":  "abc123",
		"port":     "8080",
	} {
		if m[k] != want {
			t.Errorf("line[%q] = %v, want %v", k, m[k], want)
		}
	}
	if _, ok := m["time"]; !ok {
		t.Error("line missing time field")
	}
}

func TestSeverities(t *testing.T) {
	l := New("agix.test", nil)
	buf := capture(t, l)

	l.Warn("w", nil)
	if got := parseLine(t, buf)["severity"]; got != "WARNING" {
		t.Errorf("Warn severity = %v, want WARNING", got)
	}
	buf.Reset()
	l.Error("e", nil)
	if got := parseLine(t, buf)["severity"]; got != "ERROR" {
		t.Errorf("Error severity = %v, want ERROR", got)
	}
}

func TestFatalLogsCriticalAndExits(t *testing.T) {
	l := New("agix.test", nil)
	buf := capture(t, l)

	exitCode := -1
	orig := osExit
	osExit = func(code int) { exitCode = code }
	defer func() { osExit = orig }()
	l.Fatal("boom", Fields{"why": "test"})

	if exitCode != 1 {
		t.Fatalf("Fatal exit code = %d, want 1", exitCode)
	}
	if got := parseLine(t, buf)["severity"]; got != "CRITICAL" {
		t.Errorf("Fatal severity = %v, want CRITICAL", got)
	}
}

func TestNeverPanicsOnUnmarshalableFields(t *testing.T) {
	l := New("agix.test", nil)
	buf := capture(t, l)

	// channels are not JSON-marshalable
	l.Info("weird", Fields{"ch": make(chan int)})

	m := parseLine(t, buf)
	if m["event"] != "weird" {
		t.Fatalf("fallback line lost the event: %v", m)
	}
}

func TestBaseFieldsAreCopied(t *testing.T) {
	base := Fields{"service": "svc"}
	l := New("agix.test", base)
	base["service"] = "mutated"
	buf := capture(t, l)
	l.Info("x", nil)
	if got := parseLine(t, buf)["service"]; got != "svc" {
		t.Errorf("base fields not copied at New: got %v", got)
	}
}

func TestRequestLog(t *testing.T) {
	l := New("agix.test", nil)
	buf := capture(t, l)

	h := RequestLog(l, false, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/up?secret=never-logged", nil))

	m := parseLine(t, buf)
	if m["event"] != "http_request" || m["method"] != "GET" || m["path"] != "/up" {
		t.Fatalf("request line = %v", m)
	}
	if m["status"] != float64(http.StatusTeapot) {
		t.Errorf("status = %v, want 418", m["status"])
	}
	if _, ok := m["duration_ms"]; !ok {
		t.Error("missing duration_ms")
	}
	if strings.Contains(buf.String(), "secret") {
		t.Error("query string leaked into the request log")
	}
}

func TestRequestLogQuiet(t *testing.T) {
	l := New("agix.test", nil)
	buf := capture(t, l)

	h := RequestLog(l, true, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/up", nil))

	if buf.Len() != 0 {
		t.Fatalf("quiet mode still logged: %q", buf.String())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("quiet mode broke the handler: %d", rec.Code)
	}
}

func TestQuietFromEnv(t *testing.T) {
	t.Setenv(QuietEnv, "1")
	if !QuietFromEnv() {
		t.Error("AGIX_LOG_QUIET=1 should be quiet")
	}
	t.Setenv(QuietEnv, "0")
	if QuietFromEnv() {
		t.Error("AGIX_LOG_QUIET=0 should not be quiet")
	}
}

func TestStatusRecorderFlushPassthrough(t *testing.T) {
	rec := httptest.NewRecorder() // implements http.Flusher
	sr := NewStatusRecorder(rec)
	var _ http.Flusher = sr // SSE (MCP Streamable HTTP) requires Flush
	sr.Flush()
	if !rec.Flushed {
		t.Error("Flush did not pass through to the underlying writer")
	}
	if sr.Status() != http.StatusOK {
		t.Errorf("default status = %d, want 200", sr.Status())
	}
	sr.WriteHeader(http.StatusAccepted)
	if sr.Status() != http.StatusAccepted {
		t.Errorf("recorded status = %d, want 202", sr.Status())
	}
}
