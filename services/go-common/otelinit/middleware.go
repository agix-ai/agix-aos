// SPDX-License-Identifier: Apache-2.0
package otelinit

import (
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/agix-ai/agix/services/go-common/logging"
)

// Middleware wraps next in one SERVER span per request (the Streamable HTTP
// wrapper for services like coord-mcp). When the handle is inert it returns
// next unchanged — zero overhead with the flag off.
//
// Attributes are BOUNDED by contract (semconv.go): method, path, status only.
// Our Go services expose a fixed handful of routes, so url.path is
// low-cardinality; never mount this in front of user-shaped paths without
// switching to a route template. The trace context is extracted from the
// incoming headers (traceparent), so cross-service traces join up.
func (h *Handle) Middleware(next http.Handler) http.Handler {
	if !h.Enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := h.tracer.Start(ctx, r.Method+" "+r.URL.Path,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String(AttrHTTPMethod, r.Method),
				attribute.String(AttrURLPath, r.URL.Path),
			),
		)
		defer span.End()

		rec := logging.NewStatusRecorder(w)
		next.ServeHTTP(rec, r.WithContext(ctx))

		span.SetAttributes(attribute.Int(AttrHTTPStatus, rec.Status()))
		if rec.Status() >= 500 {
			span.SetStatus(codes.Error, http.StatusText(rec.Status()))
		}
	})
}
