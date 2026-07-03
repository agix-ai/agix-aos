package otelinit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/agix-ai/agix/services/go-common/logging"
)

func testLogger(t *testing.T) (*logging.Logger, *bytes.Buffer) {
	t.Helper()
	l := logging.New("agix.observability", nil)
	var buf bytes.Buffer
	l.SetOutput(&buf)
	return l, &buf
}

func TestInertByDefault(t *testing.T) {
	t.Setenv(EnabledEnv, "") // flag off
	l, buf := testLogger(t)
	h := Init(context.Background(), Config{Service: "s", Version: "v", Env: "development", Logger: l})

	if h.Enabled() {
		t.Fatal("flag off must yield an inert handle")
	}
	// middleware is a pure pass-through
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true })
	mw := h.Middleware(next)
	mw.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/up", nil))
	if !called {
		t.Fatal("inert middleware must still call next")
	}
	h.Shutdown(context.Background()) // must not panic
	if buf.Len() != 0 {
		t.Errorf("inert init must not log, got %q", buf.String())
	}
}

func TestKillSwitchWins(t *testing.T) {
	t.Setenv(EnabledEnv, "1")
	t.Setenv("OTEL_SDK_DISABLED", "1")
	if Enabled() {
		t.Fatal("OTEL_SDK_DISABLED=1 must override AGIX_OTEL_ENABLED=1")
	}
}

func TestFailOpenOnExporterError(t *testing.T) {
	t.Setenv(EnabledEnv, "1")
	t.Setenv("OTEL_SDK_DISABLED", "")
	orig := newCloudTraceExporter
	newCloudTraceExporter = func() (sdktrace.SpanExporter, error) {
		return nil, errors.New("no ADC in test")
	}
	defer func() { newCloudTraceExporter = orig }()

	l, buf := testLogger(t)
	h := Init(context.Background(), Config{Service: "s", Version: "v", Env: "production", Logger: l})

	if h.Enabled() {
		t.Fatal("exporter failure must yield an inert handle (fail-open)")
	}
	var line map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &line); err != nil {
		t.Fatalf("expected one structured line, got %q", buf.String())
	}
	if line["event"] != "boot_failure" || line["kind"] != "agix.observability" {
		t.Fatalf("fail-open line = %v", line)
	}
}

// bootRecording boots a real provider against an in-memory exporter.
func bootRecording(t *testing.T) (*Handle, *tracetest.InMemoryExporter) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	l, _ := testLogger(t)
	h, err := boot(Config{Service: "s", Version: "v", Env: "development", Logger: l}, l, exp)
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	t.Cleanup(func() { h.Shutdown(context.Background()) })
	return h, exp
}

func flushed(t *testing.T, h *Handle, exp *tracetest.InMemoryExporter) []tracetest.SpanStub {
	t.Helper()
	if err := h.tp.ForceFlush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return exp.GetSpans()
}

func TestMiddlewareEmitsBoundedServerSpan(t *testing.T) {
	h, exp := bootRecording(t)

	mw := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	mw.ServeHTTP(httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/up?tenant_id=t1", nil))

	spans := flushed(t, h, exp)
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	s := spans[0]
	if s.Name != "GET /up" {
		t.Errorf("span name = %q", s.Name)
	}
	if s.SpanKind != trace.SpanKindServer {
		t.Errorf("span kind = %v", s.SpanKind)
	}
	got := map[string]any{}
	keys := []string{}
	for _, a := range s.Attributes {
		got[string(a.Key)] = a.Value.AsInterface()
		keys = append(keys, string(a.Key))
	}
	// the bounded contract: method/path/status, nothing else, never the query
	if err := AssertBoundedAttrs(keys...); err != nil {
		t.Fatalf("attribute discipline violated: %v", err)
	}
	if got[AttrHTTPMethod] != "GET" || got[AttrURLPath] != "/up" || got[AttrHTTPStatus] != int64(200) {
		t.Fatalf("attrs = %v", got)
	}
}

func TestMiddlewareJoinsIncomingTraceparent(t *testing.T) {
	h, exp := bootRecording(t)

	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")

	mw := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	mw.ServeHTTP(httptest.NewRecorder(), req)

	spans := flushed(t, h, exp)
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	if got := spans[0].SpanContext.TraceID().String(); got != traceID {
		t.Errorf("trace ID = %s, want %s (traceparent not joined)", got, traceID)
	}
}

func TestMiddlewareMarks5xxAsError(t *testing.T) {
	h, exp := bootRecording(t)

	mw := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	mw.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/mcp", nil))

	spans := flushed(t, h, exp)
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	if spans[0].Status.Code.String() != "Error" {
		t.Errorf("status = %v, want Error", spans[0].Status)
	}
}

func TestAssertBoundedAttrs(t *testing.T) {
	if err := AssertBoundedAttrs(AttrHTTPMethod, AttrURLPath, AttrHTTPStatus); err != nil {
		t.Errorf("bounded set rejected: %v", err)
	}
	if err := AssertBoundedAttrs("tenant_id"); err == nil {
		t.Error("tenant_id must be forbidden (high-cardinality identity)")
	}
	if err := AssertBoundedAttrs("some.random.attr"); err == nil {
		t.Error("unknown attrs must be rejected until justified against the design")
	}
}
