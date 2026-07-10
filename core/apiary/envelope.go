// SPDX-License-Identifier: Apache-2.0
// Package apiary defines the canonical cross-hive envelope — the wire type a
// remote/cloud swarm POSTs to another hive's report-home gateway — plus its
// validation and the pure-Go sender that ships it. The envelope is the ONLY
// thing that crosses a hive boundary, so its validation IS the perimeter:
// destination must match the receiving hive, the actor must be well-formed, and
// only a drone (the RBAC-governed boundary bee) may cross — workers and queens
// never leave their hive.
//
// This package is the single source of truth for the contract: both the sender
// (core, this package) and the receiver (services/hive-gateway) import it, so
// the snake_case wire shape can never drift between the two sides. It is a
// stdlib-only leaf — it imports nothing from the rest of core, so the callers
// that DO know about agents wire an agent result into the builder without ever
// creating an import cycle.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package apiary

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Kind is the closed set of cross-hive envelope kinds. An unknown kind is a
// caller bug, not a thing to silently accept.
type Kind string

const (
	KindReport    Kind = "report"
	KindTask      Kind = "task"
	KindHeartbeat Kind = "heartbeat"
)

var validKinds = map[Kind]bool{KindReport: true, KindTask: true, KindHeartbeat: true}

// validCastes is the closed set of hive castes. Only a drone may cross a hive
// boundary; queens and workers stay home.
var validCastes = map[string]bool{"queen": true, "worker": true, "drone": true}

// Envelope is the canonical cross-hive wire type (snake_case JSON). Payload is
// carried opaque so the receiving gateway never has to understand a foreign
// hive's body.
type Envelope struct {
	EnvelopeID    string          `json:"envelope_id"`
	TS            string          `json:"ts"` // RFC3339
	FromHive      string          `json:"from_hive"`
	ToHive        string          `json:"to_hive"`
	Kind          Kind            `json:"kind"`
	Actor         string          `json:"actor"` // "<hive>/<caste>/<designation>"
	Lineage       []string        `json:"lineage"`
	AuthorityUsed string          `json:"authority_used"`
	Payload       json.RawMessage `json:"payload"`
}

// RejectError carries the HTTP status a rejected envelope maps to, so the
// receiving handler can translate a validation failure straight into a
// response.
type RejectError struct {
	Status int
	Reason string
}

func (e *RejectError) Error() string { return e.Reason }

// ActorRef builds the canonical actor reference "<hive>/<caste>/<designation>".
func ActorRef(hive, caste, designation string) string {
	return hive + "/" + caste + "/" + designation
}

// ParseActorRef splits an actor reference into its parts. ok is false when the
// string is not a well-formed "<hive>/<caste>/<designation>" with a non-empty
// hive and designation and a known caste. Designation may itself contain
// slashes; only the first two segments are structural.
func ParseActorRef(actor string) (hive, caste, designation string, ok bool) {
	parts := strings.SplitN(actor, "/", 3)
	if len(parts) != 3 {
		return "", "", "", false
	}
	hive, caste, designation = parts[0], parts[1], parts[2]
	if hive == "" || designation == "" || !validCastes[caste] {
		return "", "", "", false
	}
	return hive, caste, designation, true
}

// IsDrone reports whether actor's caste is drone — the only caste permitted to
// cross a hive boundary.
func IsDrone(actor string) bool {
	_, caste, _, ok := ParseActorRef(actor)
	return ok && caste == "drone"
}

// Caste returns the actor's caste (queen|worker|drone), or "" if the actor is
// malformed.
func (e *Envelope) Caste() string {
	_, caste, _, ok := ParseActorRef(e.Actor)
	if !ok {
		return ""
	}
	return caste
}

// Validate checks the envelope against the receiving gateway's hive name. It
// returns a *RejectError whose Status is the response code to send (422
// malformed, 409 wrong destination, 403 non-drone sender), or nil when the
// envelope may be admitted. A sender validates fail-fast against the envelope's
// own ToHive; a receiver validates against the hive it serves.
func (e *Envelope) Validate(hiveName string) error {
	// Required string fields, in a fixed order so the rejection reason is
	// deterministic.
	required := []struct{ name, val string }{
		{"envelope_id", e.EnvelopeID},
		{"ts", e.TS},
		{"from_hive", e.FromHive},
		{"to_hive", e.ToHive},
		{"actor", e.Actor},
		{"authority_used", e.AuthorityUsed},
	}
	for _, f := range required {
		if strings.TrimSpace(f.val) == "" {
			return &RejectError{http.StatusUnprocessableEntity, "missing required field: " + f.name}
		}
	}
	if len(e.Payload) == 0 {
		return &RejectError{http.StatusUnprocessableEntity, "missing required field: payload"}
	}

	// kind ∈ {report, task, heartbeat}
	if !validKinds[e.Kind] {
		return &RejectError{http.StatusUnprocessableEntity, "invalid kind: " + string(e.Kind)}
	}

	// ts must be a real RFC3339 timestamp.
	if _, err := time.Parse(time.RFC3339, e.TS); err != nil {
		return &RejectError{http.StatusUnprocessableEntity, "ts must be an RFC3339 timestamp"}
	}

	// The perimeter check: this envelope must be addressed to the hive the
	// gateway serves. Misrouted mail is a conflict, not a malformed body.
	if e.ToHive != hiveName {
		return &RejectError{http.StatusConflict, "to_hive " + e.ToHive + " is not this hive (" + hiveName + ")"}
	}

	// actor must be "<hive>/<caste>/<designation>".
	caste := e.Caste()
	if caste == "" {
		return &RejectError{http.StatusUnprocessableEntity, "actor must match <hive>/<caste>/<designation>"}
	}

	// Only a drone — the boundary bee — may cross a hive boundary. Workers and
	// queens never cross; reject them at the perimeter.
	if caste != "drone" {
		return &RejectError{http.StatusForbidden, "actor caste " + caste + " may not cross a hive boundary (drones only)"}
	}

	return nil
}
