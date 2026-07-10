// SPDX-License-Identifier: Apache-2.0
// Package otelinit boots OpenTelemetry → Cloud Trace for Agix Go services.
// Posture (BINDING):
//
//   - INERT BY DEFAULT — AGIX_OTEL_ENABLED != "1" (or OTEL_SDK_DISABLED=1)
//     installs nothing; Middleware returns the handler unchanged; Shutdown is
//     a no-op. Flipping the flag off is the rollback for the whole pillar.
//   - FAIL-OPEN — any init error logs ONE structured line
//     ({kind:"agix.observability", event:"boot_failure"}) and returns an
//     inert handle. Observability NEVER crashes the service.
//   - BOUNDED ATTRIBUTES — spans carry method/path/status only. No query
//     strings, headers, bodies, or high-cardinality identity (see semconv.go).
//
// otelinit is a SEPARATE Go module from go-common on purpose: its dependency
// tree (OTel SDK + the GCP trace exporter) is wide, and a service that does
// not trace must not inherit it. Importing go-common alone adds zero external
// dependencies; importing go-common/otelinit is the deliberate opt-in.
package otelinit

import (
	"context"
	"fmt"
	"os"
	"time"

	texporter "github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/trace"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/agix-ai/agix/services/go-common/logging"
)

// EnabledEnv is the master flag.
const EnabledEnv = "AGIX_OTEL_ENABLED"

// Config identifies the service on every span's resource.
type Config struct {
	// Service is the logical service name.
	Service string
	// Version is the git SHA / version tag → service.version.
	Version string
	// Env → deployment.environment (development / staging / production).
	Env string
	// Logger for the boot/shutdown lines; nil uses a package default with
	// kind "agix.observability".
	Logger *logging.Logger
}

// Handle owns the booted tracer provider. The zero value is inert.
type Handle struct {
	tp     *sdktrace.TracerProvider
	tracer trace.Tracer
	log    *logging.Logger
}

// Enabled reports the master gate: AGIX_OTEL_ENABLED=1 and not
// OTEL_SDK_DISABLED=1.
func Enabled() bool {
	return os.Getenv(EnabledEnv) == "1" && os.Getenv("OTEL_SDK_DISABLED") != "1"
}

// Enabled reports whether this handle actually traces.
func (h *Handle) Enabled() bool { return h != nil && h.tp != nil }

// Init boots the SDK. It NEVER returns an error: when the gate is off or any
// init step fails, it logs (fail-open) and returns an inert handle.
func Init(ctx context.Context, cfg Config) *Handle {
	log := cfg.Logger
	if log == nil {
		log = logging.New("agix.observability", nil)
	}
	if !Enabled() {
		return &Handle{log: log}
	}
	_ = ctx // reserved: exporter/resource detectors may become ctx-aware
	h, err := boot(cfg, log, nil)
	if err != nil {
		// FAIL-OPEN: one structured line, inert handle, app keeps running.
		log.Warn("boot_failure", logging.Fields{"op": "init", "error": err.Error()})
		return &Handle{log: log}
	}
	log.Info("otel_booted", logging.Fields{
		"service":  cfg.Service,
		"version":  cfg.Version,
		"env":      cfg.Env,
		"exporter": "cloud-trace",
	})
	return h
}

// newCloudTraceExporter builds the GCP exporter (swapped in tests to force
// the fail-open path / record spans in memory).
var newCloudTraceExporter = func() (sdktrace.SpanExporter, error) {
	var opts []texporter.Option
	// The exporter auto-detects the project from ADC; honor the explicit
	// env vars first.
	if project := firstEnv("GCP_PROJECT", "GOOGLE_CLOUD_PROJECT"); project != "" {
		opts = append(opts, texporter.WithProjectID(project))
	}
	return texporter.New(opts...)
}

// boot wires resource → exporter → provider → globals. exporter non-nil
// overrides the Cloud Trace exporter (tests).
func boot(cfg Config, log *logging.Logger, exporter sdktrace.SpanExporter) (*Handle, error) {
	if exporter == nil {
		var err error
		if exporter, err = newCloudTraceExporter(); err != nil {
			return nil, fmt.Errorf("cloud trace exporter: %w", err)
		}
	}

	// Schemaless resource: attribute keys are the stable OTel strings, so a
	// semconv schema-version bump can never make resource.Merge error out.
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		attribute.String("service.name", cfg.Service),
		attribute.String("service.version", cfg.Version),
		attribute.String("deployment.environment", cfg.Env),
	))
	if err != nil {
		return nil, fmt.Errorf("resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		// Sampler default: parent-based, 100%. Override via the standard
		// OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG envs, which the Go
		// SDK reads when no sampler is forced.
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	// Exporter runtime errors (quota, network) must never crash or spam:
	// route them through the structured logger.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		log.Warn("otel_error", logging.Fields{"error": err.Error()})
	}))

	return &Handle{
		tp:     tp,
		tracer: tp.Tracer("go-common/otelinit"),
		log:    log,
	}, nil
}

// Shutdown flushes and stops the provider. NEVER panics or propagates —
// failures are one structured warn line (fail-open).
func (h *Handle) Shutdown(ctx context.Context) {
	if !h.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := h.tp.Shutdown(ctx); err != nil && h.log != nil {
		h.log.Warn("boot_failure", logging.Fields{"op": "shutdown", "error": err.Error()})
	}
}

func firstEnv(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}
