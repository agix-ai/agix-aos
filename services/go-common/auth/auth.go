// SPDX-License-Identifier: Apache-2.0
// Package auth is the shared-key authentication middleware for Agix Go
// services.
//
// Trust model (documented level: FLEET-INTERNAL): the bearer key gates access
// — only holders of the fleet key or the coordinator key can reach the
// service at all. The per-agent identity in the agent header ATTRIBUTES
// actions but is claimed, not proven: any key holder could assert any agent
// name. Per-agent credentials (short-TTL minted tokens) are a cutover-time
// hardening — see services/coord-mcp/DESIGN.md (the hosted, multi-tenant
// control plane is where identity becomes authenticated rather than asserted).
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// Headers names the request headers a service reads. coord-mcp uses
// {Key: "X-Coord-Key", Agent: "X-Coord-Agent"}; new services default to
// DefaultHeaders.
type Headers struct {
	// Key optionally carries the shared bearer key. Behind a platform that
	// puts an IAM identity token on the Authorization header (e.g. Cloud Run
	// --no-allow-unauthenticated), the app-level key moves here (defense in
	// depth: the platform gates the door, this key gates the tools).
	Key string
	// Agent carries the caller's claimed agent identity (attribution).
	Agent string
}

// DefaultHeaders is the convention for new services (coord-mcp keeps its own
// X-Coord-* names as its wire contract).
var DefaultHeaders = Headers{Key: "X-Agix-Key", Agent: "X-Agix-Agent"}

// Identity is the resolved caller identity for a request.
type Identity struct {
	// Agent is the claimed agent name (attribution).
	Agent string
	// Coordinator is true when the caller authenticated with the coordinator
	// key — it may act on resources it does not own.
	Coordinator bool
}

type ctxKey struct{}

// WithIdentity stores an Identity in ctx.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// FromContext returns the Identity previously stored by WithIdentity.
func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// Keys holds the configured shared keys. Empty CoordinatorKey disables the
// coordinator role.
type Keys struct {
	FleetKey       string
	CoordinatorKey string
}

// equalConstantTime compares secrets without leaking length or content timing:
// both sides are hashed to fixed width first, then compared constant-time.
func equalConstantTime(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// Authenticate checks a presented bearer token against the configured keys.
// Returns (identity-role, ok).
func (k Keys) Authenticate(bearer string) (coordinator bool, ok bool) {
	if equalConstantTime(bearer, k.CoordinatorKey) {
		return true, true
	}
	if equalConstantTime(bearer, k.FleetKey) {
		return false, true
	}
	return false, false
}

// PresentedKey extracts the shared key from request headers: the configured
// key header wins (a platform IAM layer owns Authorization there), else the
// Authorization bearer.
func (hs Headers) PresentedKey(h http.Header) string {
	if hs.Key != "" {
		if k := h.Get(hs.Key); k != "" {
			return k
		}
	}
	return strings.TrimPrefix(h.Get("Authorization"), "Bearer ")
}

// Identity resolves the claimed identity from request headers for a caller
// whose key already authenticated with the given coordinator role.
func (hs Headers) Identity(h http.Header, coordinator bool) Identity {
	return Identity{
		Agent:       strings.TrimSpace(h.Get(hs.Agent)),
		Coordinator: coordinator,
	}
}

// Middleware wraps an http.Handler with the shared-key check and stores the
// resolved Identity in the request context. Unauthenticated → 401.
func Middleware(keys Keys, hs Headers, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		coordinator, ok := keys.Authenticate(hs.PresentedKey(r.Header))
		if !ok {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		id := hs.Identity(r.Header, coordinator)
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}
