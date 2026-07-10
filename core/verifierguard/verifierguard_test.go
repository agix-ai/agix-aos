// SPDX-License-Identifier: Apache-2.0
// Tests for the verifier-guard gate's pure decision brain — the Go port of
// test/agix-verifier-guard.test.mjs. Fully synthetic + deterministic (no gh, git,
// or network), so it is fast and never flakes. Also the "prove the gate gates"
// self-test: a gate that can't FAIL is worthless.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package verifierguard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A representative allow-list: three humans who are all also verifiers, plus one
// agent-only verifier ("codex-bot") that is NOT human (so it cannot clear a
// highest-risk PR).
func allow() Allowlist {
	return ParseAllowlist([]string{"alice", "bob", "carol", "codex-bot"}, []string{"alice", "bob", "carol"})
}

const head = "sha-head-current"

func approved(login string, commit ...string) Review {
	c := head
	if len(commit) > 0 {
		c = commit[0]
	}
	return review("APPROVED", login, c)
}
func changes(login string, commit ...string) Review {
	c := head
	if len(commit) > 0 {
		c = commit[0]
	}
	return review("CHANGES_REQUESTED", login, c)
}
func commented(login string) Review { return review("COMMENTED", login, head) }
func review(state, login, commit string) Review {
	r := Review{State: state, CommitID: commit}
	r.User.Login = login
	return r
}

// ─── GlobToRegExp / MatchesAny ─────────────────────────────────────────────────

func TestGlobSpansDirectories(t *testing.T) {
	cases := []struct {
		glob, path string
		want       bool
	}{
		{"**/migrations/**", "packages/db/migrations/0104_x.sql", true},
		{"**/migrations/**", "packages/db/migrations/sub/deep.sql", true},
		{"**/auth*.ts", "src/routes/auth/index.ts", false}, // * does not cross /
		{"**/auth*.ts", "src/routes/auth-magic-link.ts", true},
		{"**/auth/**", "src/routes/auth/index.ts", true},
		{"**/*secret*.*", "src/lib/secret-store.ts", true},
	}
	for _, c := range cases {
		if got := GlobToRegExp(c.glob).MatchString(c.path); got != c.want {
			t.Errorf("GlobToRegExp(%q).MatchString(%q) = %v, want %v", c.glob, c.path, got, c.want)
		}
	}
}

func TestMatchesAny(t *testing.T) {
	if !MatchesAny("packages/auth/src/jwt.ts", []string{"**/auth/**", "**/secrets/**"}) {
		t.Error("auth path should match any-of")
	}
	if MatchesAny("apps/web/src/routes/home.tsx", []string{"**/auth/**"}) {
		t.Error("home path should not match auth")
	}
}

// ─── ClassifyRisk (default taxonomy) ────────────────────────────────────────────

func TestClassifyMigrationsHighest(t *testing.T) {
	r := ClassifyRisk([]string{"packages/db/migrations/0106_x.sql"}, nil)
	if !r.IsRisk || !r.IsHighest {
		t.Fatalf("migration should be highest-risk: %+v", r)
	}
	if !reflect.DeepEqual(r.HighestClasses, []string{"migrations"}) {
		t.Errorf("highestClasses = %v, want [migrations]", r.HighestClasses)
	}
}

func TestClassifyAuthAndBillingHighest(t *testing.T) {
	if r := ClassifyRisk([]string{"apps/api/src/routes/auth-magic-link.ts"}, nil); !r.IsHighest || !contains(r.HighestClasses, "security") {
		t.Errorf("auth path should be highest-risk security: %+v", r)
	}
	if r := ClassifyRisk([]string{"apps/api/src/billing/charge.ts"}, nil); !r.IsHighest || !contains(r.HighestClasses, "billing") {
		t.Errorf("billing path should be highest-risk billing: %+v", r)
	}
}

func TestClassifyIntegrationsRiskNotHighest(t *testing.T) {
	r := ClassifyRisk([]string{"apps/api/src/connectors/example-provider.ts"}, nil)
	if !r.IsRisk || r.IsHighest {
		t.Fatalf("integrations should be risk but not highest: %+v", r)
	}
	if !reflect.DeepEqual(r.RiskClasses, []string{"integrations"}) {
		t.Errorf("riskClasses = %v, want [integrations]", r.RiskClasses)
	}
}

func TestClassifyAgentExecutionRiskOnly(t *testing.T) {
	r := ClassifyRisk([]string{"lib/agix-runtime.mjs", "packages/agent-runtime/src/react.ts"}, nil)
	if !r.IsRisk || r.IsHighest {
		t.Fatalf("agent-execution should be risk-only: %+v", r)
	}
	if !reflect.DeepEqual(r.RiskClasses, []string{"agent_execution"}) {
		t.Errorf("riskClasses = %v, want [agent_execution]", r.RiskClasses)
	}
}

func TestClassifyGateItselfHighest(t *testing.T) {
	for _, f := range []string{
		".github/workflows/verifier-guard.yml",
		".github/agix-verifier-allowlist.json",
		".github/CODEOWNERS",
		"lib/agix-verifier-guard.mjs",
	} {
		r := ClassifyRisk([]string{f}, nil)
		if !r.IsHighest || !contains(r.HighestClasses, "gate") {
			t.Errorf("%s must be highest-risk gate: %+v", f, r)
		}
	}
}

func TestClassifyPureDocsNotRisk(t *testing.T) {
	r := ClassifyRisk([]string{"docs/decisions/D-1.md", "apps/web/src/routes/home.tsx", "README.md"}, nil)
	if r.IsRisk || r.IsHighest {
		t.Errorf("docs/FE should not be risk-area: %+v", r)
	}
}

func TestClassifyTaxonomyOverride(t *testing.T) {
	tax := &Taxonomy{Highest: map[string][]string{"infra": {"terraform/**"}}, Risk: map[string][]string{}}
	r := ClassifyRisk([]string{"terraform/prod.tf"}, tax)
	if !r.IsHighest || !reflect.DeepEqual(r.HighestClasses, []string{"infra"}) {
		t.Fatalf("override should classify infra: %+v", r)
	}
	// The default classes no longer apply under the override.
	if ClassifyRisk([]string{"packages/db/migrations/0106_x.sql"}, tax).IsRisk {
		t.Error("under override, a migration path must NOT be risk-area")
	}
}

// ─── EffectiveReviewState (host review semantics) ───────────────────────────────

func TestEffectiveLatestWinsCommentIgnored(t *testing.T) {
	s := EffectiveReviewState([]Review{approved("a"), commented("a"), changes("b"), approved("b")}, head)
	if !reflect.DeepEqual(sorted(s.Approvers), []string{"a", "b"}) {
		t.Errorf("approvers = %v, want [a b]", s.Approvers)
	}
	if len(s.ChangesRequested) != 0 {
		t.Errorf("changesRequested = %v, want none", s.ChangesRequested)
	}
}

func TestEffectiveLaterChangesRemovesApproval(t *testing.T) {
	s := EffectiveReviewState([]Review{approved("a"), changes("a")}, head)
	if len(s.Approvers) != 0 || !reflect.DeepEqual(s.ChangesRequested, []string{"a"}) {
		t.Errorf("later CHANGES_REQUESTED should remove approval: %+v", s)
	}
}

func TestEffectiveDismissedClearsApproval(t *testing.T) {
	dismissed := review("DISMISSED", "a", head)
	nullUser := Review{State: "APPROVED"} // no login
	s := EffectiveReviewState([]Review{approved("a"), dismissed, nullUser}, head)
	if len(s.Approvers) != 0 {
		t.Errorf("DISMISSED should clear approval, null user ignored: %+v", s)
	}
}

func TestEffectiveStaleApprovalDoesNotCount(t *testing.T) {
	s := EffectiveReviewState([]Review{approved("a", "sha-OLD-commit")}, head)
	if len(s.Approvers) != 0 || !reflect.DeepEqual(s.StaleApprovers, []string{"a"}) {
		t.Errorf("stale approval must not count as fresh: %+v", s)
	}
}

func TestEffectiveReapprovalSupersedes(t *testing.T) {
	s := EffectiveReviewState([]Review{approved("a", "sha-OLD-commit"), approved("a", head)}, head)
	if !reflect.DeepEqual(s.Approvers, []string{"a"}) || len(s.StaleApprovers) != 0 {
		t.Errorf("re-approval on head should supersede stale: %+v", s)
	}
}

func TestEffectiveUnknownHeadFailsClosed(t *testing.T) {
	s := EffectiveReviewState([]Review{approved("a")}, "")
	if len(s.Approvers) != 0 || !reflect.DeepEqual(s.StaleApprovers, []string{"a"}) {
		t.Errorf("unknown head SHA must fail closed (all approvals stale): %+v", s)
	}
}

// ─── Decide ─────────────────────────────────────────────────────────────────────

func TestDecideNonRiskPasses(t *testing.T) {
	d := Decide(DecideInput{Files: []string{"apps/web/src/x.tsx"}, Author: "alice", Reviews: nil, Allowlist: allow(), HeadSha: head})
	if d.Applicable || d.Outcome != OutcomePass || d.GateVerdict != VerdictGo {
		t.Errorf("non-risk PR should pass immediately (not applicable): %+v", d)
	}
}

func TestDecideRiskIndependentApprovalPasses(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"apps/api/src/connectors/example-provider.ts"}, Author: "agent-x",
		Reviews: []Review{approved("bob")}, Allowlist: allow(), HeadSha: head,
	})
	if d.Outcome != OutcomePass || d.Approver != "bob" {
		t.Errorf("independent allow-listed approval should pass with approver bob: %+v", d)
	}
}

func TestDecideSelfApproveFailsHold(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"apps/api/src/connectors/example-provider.ts"}, Author: "alice",
		Reviews: []Review{approved("alice")}, Allowlist: allow(), HeadSha: head,
	})
	if d.Outcome != OutcomeFail || d.GateVerdict != VerdictHold {
		t.Fatalf("author self-approval must FAIL (hold): %+v", d)
	}
	if !anyReason(d, "cannot self-approve") {
		t.Errorf("expected a self-approve reason, got %v", d.Reasons)
	}
}

func TestDecideNonAllowlistedApproverFails(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"apps/api/src/connectors/example-provider.ts"}, Author: "agent-x",
		Reviews: []Review{approved("random-collaborator")}, Allowlist: allow(), HeadSha: head,
	})
	if d.Outcome != OutcomeFail {
		t.Fatalf("approval from a non-allow-listed reviewer must FAIL: %+v", d)
	}
	if !anyReason(d, "NOT on the") || !anyReason(d, "allow-list") {
		t.Errorf("expected a not-on-allow-list reason, got %v", d.Reasons)
	}
}

func TestDecideHighestRiskAgentApproverFails(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"packages/db/migrations/0106_x.sql"}, Author: "agent-x",
		Reviews:   []Review{approved("codex-bot")}, // on verifiers but not on humans
		Allowlist: allow(), HeadSha: head,
	})
	if !d.HumanRequired || d.Outcome != OutcomeFail {
		t.Errorf("highest-risk approved by a non-human verifier must FAIL: %+v", d)
	}
}

func TestDecideHighestRiskHumanApproverPasses(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"packages/db/migrations/0106_x.sql"}, Author: "agent-x",
		Reviews: []Review{approved("alice")}, Allowlist: allow(), HeadSha: head,
	})
	if !d.HumanRequired || d.Outcome != OutcomePass || d.Approver != "alice" {
		t.Errorf("highest-risk approved by a human must PASS: %+v", d)
	}
}

func TestDecideChangesRequestedRecycles(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"apps/api/src/connectors/example-provider.ts"}, Author: "agent-x",
		Reviews: []Review{changes("bob")}, Allowlist: allow(), HeadSha: head,
	})
	if d.Outcome != OutcomeFail || d.GateVerdict != VerdictRecycle {
		t.Errorf("allow-listed CHANGES_REQUESTED should FAIL (recycle): %+v", d)
	}
}

func TestDecideMixedDiffTriggersHighest(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"apps/web/src/x.tsx", "packages/db/migrations/0106_x.sql"}, Author: "agent-x",
		Reviews: nil, Allowlist: allow(), HeadSha: head,
	})
	if !d.HumanRequired || d.Outcome != OutcomeFail {
		t.Errorf("a mixed diff containing a migration must trigger highest-risk: %+v", d)
	}
}

func TestDecideStaleBypassDefeated(t *testing.T) {
	d := Decide(DecideInput{
		Files: []string{"packages/db/migrations/0106_x.sql"}, Author: "agent-x",
		Reviews: []Review{approved("alice", "sha-commit-A")}, Allowlist: allow(), HeadSha: "sha-commit-B-new-head",
	})
	if d.Outcome != OutcomeFail || d.Approver != "" {
		t.Fatalf("approve@A then push B must FAIL (stale): %+v", d)
	}
	if !anyReason(d, "STALE approval") {
		t.Errorf("expected a STALE-approval reason, got %v", d.Reasons)
	}
}

func TestDecideReapprovalOnNewHeadClears(t *testing.T) {
	d := Decide(DecideInput{
		Files:     []string{"packages/db/migrations/0106_x.sql"},
		Author:    "agent-x",
		Reviews:   []Review{approved("alice", "sha-commit-A"), approved("alice", "sha-head-B")},
		Allowlist: allow(), HeadSha: "sha-head-B",
	})
	if d.Outcome != OutcomePass || d.Approver != "alice" {
		t.Errorf("re-approval on the new head must clear the gate: %+v", d)
	}
}

// ─── NormalizeSlurpedPages (multi-page gh --slurp) ──────────────────────────────

func TestNormalizeSlurpedPages(t *testing.T) {
	page1 := make([]map[string]string, 30)
	for i := range page1 {
		page1[i] = map[string]string{"filename": "f"}
	}
	page2 := make([]map[string]string, 12)
	for i := range page2 {
		page2[i] = map[string]string{"filename": "g"}
	}
	raw, _ := json.Marshal([]any{page1, page2})
	if flat := NormalizeSlurpedPages(raw); len(flat) != 42 {
		t.Errorf("array-of-pages should flatten to 42, got %d", len(flat))
	}

	flatRaw, _ := json.Marshal([]map[string]string{{"filename": "a"}, {"filename": "b"}})
	if flat := NormalizeSlurpedPages(flatRaw); len(flat) != 2 {
		t.Errorf("already-flat array should pass through as 2, got %d", len(flat))
	}
	if got := NormalizeSlurpedPages([]byte("null")); len(got) != 0 {
		t.Errorf("non-array → [], got %d", len(got))
	}
	if got := NormalizeSlurpedPages([]byte("{}")); len(got) != 0 {
		t.Errorf("object → [], got %d", len(got))
	}
}

// ─── The shipped allow-list file is well-formed (humans ⊆ verifiers) ────────────

func TestShippedAllowlistWellFormed(t *testing.T) {
	// Locate the repo root's .github/agix-verifier-allowlist.json (../../.github
	// from core/verifierguard).
	path := filepath.Join("..", "..", ".github", "agix-verifier-allowlist.json")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("shipped allow-list not found at %s (%v) — skipping", path, err)
	}
	a, err := LoadAllowlist(path)
	if err != nil {
		t.Fatalf("LoadAllowlist: %v", err)
	}
	if len(a.Verifiers) < 1 || len(a.Humans) < 1 {
		t.Fatalf("need at least one verifier and one human: %+v", a)
	}
	for h := range a.Humans {
		if !a.Verifiers[h] {
			t.Errorf("human %q must also be a verifier", h)
		}
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────────

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func sorted(xs []string) []string {
	out := append([]string(nil), xs...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func anyReason(d Decision, substr string) bool {
	for _, r := range d.Reasons {
		if strings.Contains(r, substr) {
			return true
		}
	}
	return false
}
