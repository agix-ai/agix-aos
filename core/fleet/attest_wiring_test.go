// Copyright 2026 Agix AI LLC. Apache-2.0.
package fleet_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/fleet"
	"github.com/agix-ai/agix/core/kmstore"
)

// oracleTool is a $0 stand-in for a deterministic external oracle (a passing test
// suite / exec exit-0). It tolerates the mock's empty ({}) args so the mock's
// tool-use loop drives it, emits the exit-0 shape, and implements tool.Grounder
// so the agent loop classifies its result as a PASSING oracle — making the
// governed run externally grounded.
type oracleTool struct{ pass bool }

func (oracleTool) Name() string                 { return "testsuite" }
func (oracleTool) Description() string          { return "run the repo test suite" }
func (oracleTool) InputSchema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (o oracleTool) Execute(context.Context, json.RawMessage) (string, error) {
	if o.pass {
		return "$ go test ./...\nexit: 0\n--- stdout ---\nok\n", nil
	}
	return "$ go test ./...\nexit: 1\n--- stdout ---\nFAIL\n", nil
}
func (oracleTool) Grounds(result string) bool {
	for _, line := range strings.Split(result, "\n") {
		if strings.TrimSpace(line) == "exit: 0" {
			return true
		}
	}
	return false
}

func openFleetStore(t *testing.T) *kmstore.KMStore {
	t.Helper()
	st, err := kmstore.Open(filepath.Join(t.TempDir(), "km.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// The FLEET PATH now attests: a governed run whose worker ran a passing external
// oracle produces an externally-grounded verdict, and the runner writes an
// ATTESTED leaf into the Comb — km stats attested 0 -> 1. This is the single
// unblock the overnight report flagged (no fleet path set/honored the roster, so
// nothing was ever attested).
func TestFleetPathAttestsExternallyGroundedRun(t *testing.T) {
	st := openFleetStore(t)

	spec := proposerSpec()
	spec.Tools = []string{"testsuite"}
	spec.Models.Workers = 1

	// The operator's trusted-verifier roster (the AGIX_KM_VERIFIERS-equivalent):
	// the hive is named for the spec, so its verifier caste actor is what must be
	// trusted for auto-attestation.
	verifier := caste.Actor(spec.Name, caste.Worker, "verifier", 1)

	r := fleet.New()
	r.RepoRoot = t.TempDir()
	r.Comb = st
	r.Verifiers = []string{verifier}
	r.Register("testsuite", oracleTool{pass: true})

	if s, _ := st.Stats(); s.Attested != 0 {
		t.Fatalf("baseline attested = %d, want 0", s.Attested)
	}

	res, err := r.Run(context.Background(), spec, "refactor the billing module")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.VerifierActor != verifier {
		t.Fatalf("verifier actor = %q, want %q", res.VerifierActor, verifier)
	}
	if res.Result.Verdict.Grounding != "external" {
		t.Fatalf("grounding = %q, want external (worker ran a passing oracle)", res.Result.Verdict.Grounding)
	}
	if !res.Attestation.Attested {
		t.Fatalf("attestation = %+v, want attested", res.Attestation)
	}
	if s, _ := st.Stats(); s.Attested != 1 {
		t.Fatalf("km stats attested = %d, want 1 (0 -> 1)", s.Attested)
	}
}

// A judgment-only governed run (no oracle) is HELD pending a human co-sign: the
// runner records the artifact un-attested + pending_cosign, so the corpus stays
// clean and attested does NOT move.
func TestFleetPathHoldsJudgmentOnlyRunPending(t *testing.T) {
	st := openFleetStore(t)

	spec := proposerSpec()
	spec.Tools = nil // no tools → no oracle → the verifier's approval is prose-only
	spec.Models.Workers = 1

	r := fleet.New()
	r.RepoRoot = t.TempDir()
	r.Comb = st
	r.Verifiers = []string{caste.Actor(spec.Name, caste.Worker, "verifier", 1)}

	res, err := r.Run(context.Background(), spec, "summarize the module")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Result.Verdict.Grounding != "judgment" {
		t.Fatalf("grounding = %q, want judgment", res.Result.Verdict.Grounding)
	}
	if res.Attestation.Attested || !res.Attestation.PendingCosign {
		t.Fatalf("attestation = %+v, want pending_cosign (judgment-only)", res.Attestation)
	}
	if s, _ := st.Stats(); s.Attested != 0 || s.PendingCosign != 1 {
		t.Fatalf("km stats attested=%d pending=%d, want 0/1", s.Attested, s.PendingCosign)
	}
}
