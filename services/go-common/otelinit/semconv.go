// SPDX-License-Identifier: Apache-2.0
// Semantic-convention discipline for Go services — the ALLOWED / FORBIDDEN
// attribute rule (BINDING).
//
// High-cardinality identity (tenant_id / run_id / user_id / ...) must NEVER
// appear as metric labels, and the Go substrate's HTTP middleware is stricter
// still: it emits only the bounded attribute set below.
package otelinit

import "fmt"

// The bounded attribute keys the HTTP middleware emits.
const (
	AttrHTTPMethod = "http.request.method"
	AttrURLPath    = "url.path"
	AttrHTTPStatus = "http.response.status_code"
)

// AllowedSpanAttrs is the full set the substrate's middleware may emit —
// anything else must be justified against the observability design first.
var AllowedSpanAttrs = map[string]bool{
	AttrHTTPMethod: true,
	AttrURLPath:    true,
	AttrHTTPStatus: true,
}

// ForbiddenAttrKeys names identity keys that must never appear on
// substrate-emitted spans or metric labels (high cardinality + PII risk).
var ForbiddenAttrKeys = map[string]bool{
	"tenant_id":   true,
	"run_id":      true,
	"run.id":      true,
	"user_id":     true,
	"user.id":     true,
	"draft_id":    true,
	"campaign_id": true,
	"campaign.id": true,
	"brand_id":    true,
	"brand.id":    true,
}

// AssertBoundedAttrs errors when a key is outside the bounded set — used by
// tests to keep a future high-cardinality attribute from sneaking into the
// middleware.
func AssertBoundedAttrs(keys ...string) error {
	for _, k := range keys {
		if ForbiddenAttrKeys[k] {
			return fmt.Errorf("attribute %q is forbidden high-cardinality identity", k)
		}
		if !AllowedSpanAttrs[k] {
			return fmt.Errorf("attribute %q is not in the bounded substrate set (%v)", k, boundedList())
		}
	}
	return nil
}

func boundedList() []string {
	return []string{AttrHTTPMethod, AttrURLPath, AttrHTTPStatus}
}
