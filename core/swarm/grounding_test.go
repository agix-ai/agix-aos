// Copyright 2026 Agix AI LLC. Apache-2.0.
package swarm_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/swarm"
	"github.com/agix-ai/agix/core/tool"
)

// passOracle is a $0 stand-in for a deterministic external oracle (a passing test
// suite / exec exit-0). It tolerates the mock provider's empty ({}) tool args so
// the mock's tool-use loop drives it, emits the exact exit-0 shape the real exec
// tool produces, and implements tool.Grounder so the agent loop classifies its
// result as a PASSING external oracle — the evidence that turns a prose-only
// verifier approval into an externally-grounded verdict.
type passOracle struct{ pass bool }

func (passOracle) Name() string                 { return "testsuite" }
func (passOracle) Description() string          { return "run the repo test suite" }
func (passOracle) InputSchema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (o passOracle) Execute(context.Context, json.RawMessage) (string, error) {
	if o.pass {
		return "$ go test ./...\nexit: 0\n--- stdout ---\nok\n", nil
	}
	return "$ go test ./...\nexit: 1\n--- stdout ---\nFAIL\n", nil
}
func (passOracle) Grounds(result string) bool {
	for _, line := range strings.Split(result, "\n") {
		if strings.TrimSpace(line) == "exit: 0" {
			return true
		}
	}
	return false
}

var _ tool.Grounder = passOracle{}

// A governed run in which a worker ran a PASSING external oracle produces an
// externally-grounded verdict — the signal the attestation policy auto-attests.
func TestRunExternalGroundingFromPassingOracle(t *testing.T) {
	reg, err := tool.New(passOracle{pass: true})
	if err != nil {
		t.Fatal(err)
	}
	res, err := swarm.Run(context.Background(), swarm.Options{
		Task: "refactor the billing module", Provider: "mock", Workers: 1, Tools: reg,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Verified {
		t.Fatal("run should be verified under the mock verifier")
	}
	if res.Verdict.Grounding != swarm.GroundingExternal {
		t.Fatalf("grounding = %q, want %q (a worker ran a passing oracle)", res.Verdict.Grounding, swarm.GroundingExternal)
	}
}

// With no oracle in the run, the verifier's prose approval is judgment-only — the
// class the policy holds out of the corpus (pending a human co-sign).
func TestRunJudgmentGroundingWithoutOracle(t *testing.T) {
	res, err := swarm.Run(context.Background(), swarm.Options{
		Task: "refactor the billing module", Provider: "mock", Workers: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Grounding != swarm.GroundingJudgment {
		t.Fatalf("grounding = %q, want %q (no external oracle fired)", res.Verdict.Grounding, swarm.GroundingJudgment)
	}
}

// A FAILING oracle (exit≠0) is real data but NOT grounding: the verdict stays
// judgment-only, so a broken change can never auto-attest on the strength of a
// prose approval alone.
func TestRunFailingOracleIsNotGrounding(t *testing.T) {
	reg, err := tool.New(passOracle{pass: false})
	if err != nil {
		t.Fatal(err)
	}
	res, err := swarm.Run(context.Background(), swarm.Options{
		Task: "refactor the billing module", Provider: "mock", Workers: 1, Tools: reg,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Grounding != swarm.GroundingJudgment {
		t.Fatalf("grounding = %q, want %q (the oracle FAILED — exit≠0)", res.Verdict.Grounding, swarm.GroundingJudgment)
	}
}
