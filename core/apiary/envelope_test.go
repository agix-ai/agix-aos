// SPDX-License-Identifier: Apache-2.0
package apiary

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

// validEnvelope is a fresh, admissible report envelope for hive "agix". Each
// test case mutates a copy so cases stay isolated.
func validEnvelope() Envelope {
	return Envelope{
		EnvelopeID:    "018f9c2a-0000-7000-8000-000000000001",
		TS:            "2026-07-04T12:00:00Z",
		FromHive:      "widgetco",
		ToHive:        "agix",
		Kind:          KindReport,
		Actor:         "widgetco/drone/report-home",
		Lineage:       []string{"widgetco/drone/report-home", "widgetco/queen/root"},
		AuthorityUsed: "cross-hive-report",
		Payload:       json.RawMessage(`{"summary":"forage complete"}`),
	}
}

func TestEnvelopeValidate(t *testing.T) {
	const hive = "agix"

	tests := []struct {
		name       string
		mutate     func(*Envelope)
		wantErr    bool
		wantStatus int
	}{
		{
			name:    "valid report envelope",
			mutate:  func(*Envelope) {},
			wantErr: false,
		},
		{
			name:       "wrong to_hive rejected",
			mutate:     func(e *Envelope) { e.ToHive = "someone-else" },
			wantErr:    true,
			wantStatus: http.StatusConflict, // 409
		},
		{
			name: "non-drone actor rejected",
			mutate: func(e *Envelope) {
				e.Actor = "widgetco/worker/forager"
				e.Lineage[0] = "widgetco/worker/forager"
			},
			wantErr:    true,
			wantStatus: http.StatusForbidden, // 403
		},
		{
			name:       "bad kind rejected",
			mutate:     func(e *Envelope) { e.Kind = "gossip" },
			wantErr:    true,
			wantStatus: http.StatusUnprocessableEntity, // 422
		},
		{
			name:       "bad ts rejected",
			mutate:     func(e *Envelope) { e.TS = "last tuesday" },
			wantErr:    true,
			wantStatus: http.StatusUnprocessableEntity, // 422
		},
		{
			name:       "malformed actor rejected",
			mutate:     func(e *Envelope) { e.Actor = "not-an-actor" },
			wantErr:    true,
			wantStatus: http.StatusUnprocessableEntity, // 422
		},
		{
			name:       "missing payload rejected",
			mutate:     func(e *Envelope) { e.Payload = nil },
			wantErr:    true,
			wantStatus: http.StatusUnprocessableEntity, // 422
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := validEnvelope()
			tt.mutate(&env)

			err := env.Validate(hive)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}

			if err == nil {
				t.Fatalf("Validate() = nil, want error")
			}
			var re *RejectError
			if !errors.As(err, &re) {
				t.Fatalf("Validate() error = %T, want *RejectError", err)
			}
			if re.Status != tt.wantStatus {
				t.Fatalf("RejectError.Status = %d, want %d (reason: %s)", re.Status, tt.wantStatus, re.Reason)
			}
		})
	}
}

func TestActorRefRoundTrip(t *testing.T) {
	ref := ActorRef("agix", "drone", "forager")
	if ref != "agix/drone/forager" {
		t.Fatalf("ActorRef = %q, want agix/drone/forager", ref)
	}
	hive, caste, desig, ok := ParseActorRef(ref)
	if !ok || hive != "agix" || caste != "drone" || desig != "forager" {
		t.Fatalf("ParseActorRef(%q) = (%q,%q,%q,%v), want (agix,drone,forager,true)", ref, hive, caste, desig, ok)
	}
}

func TestParseActorRefDesignationWithSlash(t *testing.T) {
	// The designation may itself carry slashes; only the first two segments are
	// structural.
	hive, caste, desig, ok := ParseActorRef("agix/drone/team/forager-3")
	if !ok || hive != "agix" || caste != "drone" || desig != "team/forager-3" {
		t.Fatalf("ParseActorRef = (%q,%q,%q,%v), want (agix,drone,team/forager-3,true)", hive, caste, desig, ok)
	}
}

func TestParseActorRefRejectsBad(t *testing.T) {
	bad := []string{
		"",
		"agix",
		"agix/drone",     // no designation
		"agix/queen/",    // empty designation
		"/drone/forager", // empty hive
		"agix/wizard/x",  // unknown caste
	}
	for _, s := range bad {
		if _, _, _, ok := ParseActorRef(s); ok {
			t.Errorf("ParseActorRef(%q) ok = true, want false", s)
		}
	}
}

func TestIsDrone(t *testing.T) {
	if !IsDrone("agix/drone/forager") {
		t.Error("IsDrone(agix/drone/forager) = false, want true")
	}
	for _, s := range []string{"agix/worker/forager", "agix/queen/root", "garbage"} {
		if IsDrone(s) {
			t.Errorf("IsDrone(%q) = true, want false", s)
		}
	}
}
