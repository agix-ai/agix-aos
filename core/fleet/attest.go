// attest — the fleet's invocation of the flywheel WRITE side. When a Runner is
// wired with a Comb store, a completed governed run's certified artifact flows
// through the attestation policy (comb.AttestRun) into the durable corpus. This
// is the "make the fleet path actually invoke this" seam the overnight report
// flagged: before it, nothing set/honored AGIX_KM_VERIFIERS, so no leaf was ever
// attested and distill-export returned zero.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package fleet

import (
	"os"
	"strings"

	"github.com/agix-ai/agix/core/comb"
)

// verifierEnv is the CLI/runtime out-of-band roster seed (comma-separated actor
// refs) — the same env kmstore's `km` CLI reads. Honoring it here is what wires
// AGIX_KM_VERIFIERS into the fleet path: the operator names the trusted verifier
// actors once, and every fleet run's verdict is attested against that roster.
const verifierEnv = "AGIX_KM_VERIFIERS"

// defaultCombBranch is the TOGAF branch attested run artifacts land on when a
// Runner sets none — "software", where refactoring records live and
// distill-export reads by default.
const defaultCombBranch = "software"

// attest applies the attestation policy to one completed run, writing its
// certified artifact into the Comb. It seeds the store's attestation roster from
// the operator's trusted-verifier set (Runner.Verifiers + AGIX_KM_VERIFIERS)
// FIRST — so an externally-grounded verdict from a trusted verifier can attest —
// then maps the run's verdict + grounding onto a comb.RunLeaf and records it. A
// write/store error degrades to a recorded reason rather than failing the run:
// attestation is the flywheel's write side, not the run's success contract.
func (r *Runner) attest(out RunResult) comb.AttestOutcome {
	c := comb.New(r.Comb)
	c.RegisterVerifier(r.verifierRoster()...)

	branch := strings.TrimSpace(r.CombBranch)
	if branch == "" {
		branch = defaultCombBranch
	}

	res := out.Result
	outcome, err := c.AttestRun(comb.RunLeaf{
		Content:   res.Answer,
		Branch:    branch,
		Author:    out.QueenActor,
		Verifier:  out.VerifierActor,
		Approved:  res.Verified,
		Grounding: res.Verdict.Grounding,
	})
	if err != nil {
		return comb.AttestOutcome{Reason: "attestation write failed: " + err.Error()}
	}
	return outcome
}

// verifierRoster is the operator's trusted-verifier set: the Runner's explicit
// Verifiers plus any named in AGIX_KM_VERIFIERS. Deduped, whitespace-trimmed;
// empties dropped. An empty roster means nothing is a trusted verifier and every
// leaf stays un-attested (fail-closed).
func (r *Runner) verifierRoster() []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(a string) {
		a = strings.TrimSpace(a)
		if a == "" {
			return
		}
		if _, ok := seen[a]; ok {
			return
		}
		seen[a] = struct{}{}
		out = append(out, a)
	}
	for _, v := range r.Verifiers {
		add(v)
	}
	if env := strings.TrimSpace(os.Getenv(verifierEnv)); env != "" {
		for _, v := range strings.Split(env, ",") {
			add(v)
		}
	}
	return out
}
