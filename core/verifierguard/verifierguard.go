// SPDX-License-Identifier: Apache-2.0
//
// Package verifierguard is the born-clean Go port of the general "independent
// verifier" gate (actor ≠ verifier, enforced, un-forgeable) — the structural
// anti-self-certification control of the loop-engineered SDLC, realized as a CI
// gate on a real merge. It is the Go replacement for lib/agix-verifier-guard.mjs
// so the reborn CI can retire Node without weakening the gate.
//
// WHAT IT CHECKS (and its INPUT SOURCE)
//
//	The gate reasons over a pull request's CODE-HOST REVIEW STATE — the author,
//	the changed-file list, the review list, and the current head SHA — NOT over
//	the audit ledger. The approval primitive is the host's native review state,
//	which is un-forgeable: the host structurally forbids a PR author from
//	approving their own PR, and the gate only READS that state. (The runtime
//	actor≠verifier control that DOES read the append-only ledger — a distinct
//	verifier bee certifying through the orchestrator's `ratify` frame — is a
//	separate mechanism in core/swarm + core/orchestrator; see the package's port
//	notes. This gate is the Integrate-gate / CI half.)
//
//	On a PR that touches a RISK-AREA path (auth/secrets · billing · integrations ·
//	schema migrations · agent-execution · the gate's own files) this asserts there
//	is an APPROVING review from a login that is (a) ≠ the PR author AND (b) ∈ a
//	curated verifier allow-list. For the HIGHEST-risk classes (schema migrations ·
//	billing · security/auth · the gate itself) the approver must additionally be a
//	HUMAN. Non-risk PRs PASS immediately — velocity is preserved on the 90%+ of
//	PRs that are not risk-area.
//
// The pure decision logic (ClassifyRisk / EffectiveReviewState / Decide) takes
// plain data and is exercised with no code-host and no network in the tests. The
// thin `gh` I/O shell (io.go) is the only impure surface.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package verifierguard

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// ─── Risk-area path classification (DATA = source of truth; override per repo) ──
//
// A framework-neutral default. These globs are conventions (a "migrations" dir,
// an "auth"/"secrets" package, a "billing" surface), NOT hard assumptions about
// any one codebase — an operator supplies their own taxonomy (or a
// .github/agix-verifier-risk.json read by LoadTaxonomy) to match their tree.

// DefaultHighestRiskGlobs — HIGHEST-RISK classes → an approving review from a
// HUMAN on the allow-list is required. These are the surfaces where a silent
// break is a tenant-isolation / money / secret event.
func DefaultHighestRiskGlobs() map[string][]string {
	return map[string][]string{
		// schema / migration changes that AUTO-APPLY on deploy.
		"migrations": {"**/migrations/**", "**/migrate/**", "**/*.migration.*"},
		// auth core, secrets, credentials, keys — auth IS security (the sharpest surface).
		"security": {
			"**/auth/**",
			"**/auth*.*",
			"**/secrets/**",
			"**/*secret*.*",
			"**/*credential*.*",
			"**/*oauth*.*",
			"**/kms*.*",
			"**/*.pem",
		},
		// money movement + entitlement.
		"billing": {"**/billing/**", "**/*stripe*.*", "**/entitlement*.*"},
		// the verifier-guard machinery ITSELF: workflow, script, allow-list, CODEOWNERS.
		// A PR that edits the gate that reviews it is the sharpest tamper surface → HUMAN.
		"gate": {
			".github/workflows/verifier-guard.yml",
			".github/agix-verifier-allowlist.json",
			".github/agix-verifier-risk.json",
			".github/CODEOWNERS",
			"lib/agix-verifier-guard.mjs",
		},
	}
}

// DefaultRiskOnlyGlobs — RISK-ONLY classes → an approving review from ANY
// allow-listed verifier (human OR a trusted agent identity) ≠ the author is
// sufficient. Sharp, but not the never-noise tier.
func DefaultRiskOnlyGlobs() map[string][]string {
	return map[string][]string{
		"integrations": {"**/connectors/**", "**/integrations/**", "**/connector-*/**"},
		"agent_execution": {
			"**/agents/**",
			"**/agent-runtime/**",
			"lib/agix-runtime.mjs",
			"lib/agix-fleet.mjs",
		},
	}
}

// Taxonomy is the risk-area map: `{ highest: { class → globs[] }, risk: {…} }`.
type Taxonomy struct {
	Highest map[string][]string `json:"highest"`
	Risk    map[string][]string `json:"risk"`
}

// DefaultTaxonomy returns a fresh copy of the framework-neutral default taxonomy.
func DefaultTaxonomy() Taxonomy {
	return Taxonomy{Highest: DefaultHighestRiskGlobs(), Risk: DefaultRiskOnlyGlobs()}
}

// ─── Glob → RegExp (supports **, *, ?; anchored full-path match) ────────────────

// GlobToRegExp compiles a path glob to an anchored RegExp. `**` spans
// directories; `*`/`?` do not cross `/`. Faithful port of the .mjs compiler.
func GlobToRegExp(glob string) *regexp.Regexp {
	const special = ".+^${}()|[]\\"
	var b strings.Builder
	b.WriteByte('^')
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		switch {
		case c == '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				i++ // consume the second `*`
				if i+1 < len(glob) && glob[i+1] == '/' {
					// `**/` = zero or more leading/intermediate directory segments.
					i++
					b.WriteString("(?:.*/)?")
				} else {
					// trailing/standalone `**` = anything, including `/` and empty.
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case c == '?':
			b.WriteString("[^/]")
		case strings.IndexByte(special, c) >= 0:
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('$')
	return regexp.MustCompile(b.String())
}

// MatchesAny is TRUE when path matches ANY glob in the list.
func MatchesAny(path string, globs []string) bool {
	for _, g := range globs {
		if GlobToRegExp(g).MatchString(path) {
			return true
		}
	}
	return false
}

// RiskResult is the outcome of classifying a changed-file list.
type RiskResult struct {
	IsRisk         bool     // is this a risk-area PR at all
	IsHighest      bool     // did any HIGHEST-risk class match (→ human reviewer required)
	RiskClasses    []string // all matched risk classes (sorted)
	HighestClasses []string // matched highest-risk classes (sorted)
}

// ClassifyRisk classifies a changed-file list against a risk taxonomy. A nil
// taxonomy means "use the default" (mirrors the .mjs default parameter); a
// non-nil taxonomy with a missing Highest/Risk map means that tier is EMPTY (not
// defaulted) — an explicit override fully replaces the defaults.
func ClassifyRisk(files []string, tax *Taxonomy) RiskResult {
	if tax == nil {
		d := DefaultTaxonomy()
		tax = &d
	}
	highestSet := map[string]bool{}
	riskSet := map[string]bool{}
	for _, file := range files {
		for cls, globs := range tax.Highest {
			if MatchesAny(file, globs) {
				highestSet[cls] = true
				riskSet[cls] = true
			}
		}
		for cls, globs := range tax.Risk {
			if MatchesAny(file, globs) {
				riskSet[cls] = true
			}
		}
	}
	return RiskResult{
		IsRisk:         len(riskSet) > 0,
		IsHighest:      len(highestSet) > 0,
		RiskClasses:    sortedKeys(riskSet),
		HighestClasses: sortedKeys(highestSet),
	}
}

// ─── Code-host review-state fold (un-forgeable approval primitive) ──────────────

// Review is one code-host review, in the shape the host's reviews API returns
// (state, the reviewed commit, and the reviewer login).
type Review struct {
	State    string `json:"state"`
	CommitID string `json:"commit_id"`
	User     struct {
		Login string `json:"login"`
	} `json:"user"`
}

// ReviewState is the per-reviewer effective state, bound to the current head SHA.
// The slices preserve first-decisive-review order (mirrors the .mjs Set order).
type ReviewState struct {
	Approvers        []string // fresh approvals ON the current head
	ChangesRequested []string
	StaleApprovers   []string // approvals whose commit_id ≠ head (stale-approval defense)
}

// EffectiveReviewState folds a PR's review list into per-reviewer EFFECTIVE
// state, bound to the CURRENT head SHA. A reviewer's effective state is their
// most recent APPROVED / CHANGES_REQUESTED / DISMISSED review; COMMENTED and
// PENDING never change it. Reviews arrive chronologically.
//
// STALE-APPROVAL DEFENSE: an APPROVED review counts ONLY when its commit_id
// equals the PR's current head SHA — otherwise "approve@A → push malicious B →
// stale APPROVED still counts" would be a bypass. A stale approval is surfaced
// separately (StaleApprovers). An unknown (empty) head SHA fails closed (every
// approval treated as stale).
func EffectiveReviewState(reviews []Review, headSha string) ReviewState {
	type lr struct{ state, commitID string }
	order := []string{}
	latest := map[string]lr{}
	for _, r := range reviews {
		login := r.User.Login
		if login == "" {
			continue // deleted user — ignore
		}
		state := strings.ToUpper(r.State)
		if state == "APPROVED" || state == "CHANGES_REQUESTED" || state == "DISMISSED" {
			if _, seen := latest[login]; !seen {
				order = append(order, login)
			}
			latest[login] = lr{state: state, commitID: r.CommitID}
		}
	}
	var st ReviewState
	for _, login := range order {
		v := latest[login]
		switch v.state {
		case "APPROVED":
			// Only a fresh approval on the CURRENT head counts. If we can't
			// determine the head SHA, fail closed by treating every approval as stale.
			if headSha != "" && v.commitID == headSha {
				st.Approvers = append(st.Approvers, login)
			} else {
				st.StaleApprovers = append(st.StaleApprovers, login)
			}
		case "CHANGES_REQUESTED":
			st.ChangesRequested = append(st.ChangesRequested, login)
		}
	}
	return st
}

// Allowlist is the curated verifier allow-list, normalized to lowercased sets.
type Allowlist struct {
	Verifiers map[string]bool // logins authorized to satisfy the gate (author always excluded)
	Humans    map[string]bool // the SUBSET that are real people (required for highest-risk)
}

// ParseAllowlist normalizes the raw allow-list (verifiers + humans string lists)
// into two lowercased sets.
func ParseAllowlist(verifiers, humans []string) Allowlist {
	return Allowlist{Verifiers: lowerSet(verifiers), Humans: lowerSet(humans)}
}

// ─── The decision (pure) ────────────────────────────────────────────────────────

// Cooper stage-gate verdict strings carried in the gate output.
const (
	VerdictGo      = "go"
	VerdictHold    = "hold"
	VerdictRecycle = "recycle"
)

// Outcome strings.
const (
	OutcomePass = "pass"
	OutcomeFail = "fail"
)

// DecideInput is the plain data the pure decision reasons over.
type DecideInput struct {
	Files     []string
	Author    string
	Reviews   []Review
	Allowlist Allowlist
	HeadSha   string
	Taxonomy  *Taxonomy // nil → DefaultTaxonomy
}

// Decision is the verifier-guard verdict for a PR.
type Decision struct {
	Applicable     bool     // is this a risk-area PR at all
	Outcome        string   // pass | fail
	GateVerdict    string   // go | hold | recycle (Cooper verdict for the audit mirror)
	HumanRequired  bool     // did a highest-risk class trigger the human requirement
	Approver       string   // the eligible approver's login, when pass ("" otherwise)
	RiskClasses    []string // sorted
	HighestClasses []string // sorted
	Reasons        []string
}

// Decide decides the verifier-guard outcome for a PR. Pure — takes plain data,
// returns a verdict. Faithful port of decideVerifierGuard.
func Decide(in DecideInput) Decision {
	risk := ClassifyRisk(in.Files, in.Taxonomy)
	if !risk.IsRisk {
		return Decision{
			Applicable:     false,
			Outcome:        OutcomePass,
			GateVerdict:    VerdictGo,
			HumanRequired:  false,
			Approver:       "",
			RiskClasses:    []string{},
			HighestClasses: []string{},
			Reasons: []string{
				"No risk-area paths touched — verifier-guard not applicable (fleet velocity preserved).",
			},
		}
	}

	authorLogin := strings.ToLower(in.Author)
	state := EffectiveReviewState(in.Reviews, in.HeadSha)
	approverLogins := lowerAll(state.Approvers)
	humanRequired := risk.IsHighest

	// The required verifier set for this PR: the allow-list, minus the author,
	// and for the highest-risk classes narrowed to the HUMAN subset.
	requiredSet := in.Allowlist.Verifiers
	if humanRequired {
		requiredSet = in.Allowlist.Humans
	}
	var eligible []string
	for _, l := range approverLogins {
		if l != authorLogin && requiredSet[l] {
			eligible = append(eligible, l)
		}
	}

	reasons := []string{fmt.Sprintf("Risk-area classes: %s.", strings.Join(risk.RiskClasses, ", "))}
	if humanRequired {
		reasons = append(reasons, fmt.Sprintf(
			"Highest-risk classes (%s) → a HUMAN approver on the allow-list is required.",
			strings.Join(risk.HighestClasses, ", ")))
	}

	if len(eligible) > 0 {
		authorDisplay := authorLogin
		if authorDisplay == "" {
			authorDisplay = "?"
		}
		reasons = append(reasons, fmt.Sprintf(
			"Independent approving review present from allow-listed %sverifier(s): %s (≠ author %s).",
			humanWord(humanRequired), strings.Join(eligible, ", "), authorDisplay))
		return Decision{
			Applicable:     true,
			Outcome:        OutcomePass,
			GateVerdict:    VerdictGo,
			HumanRequired:  humanRequired,
			Approver:       eligible[0],
			RiskClasses:    risk.RiskClasses,
			HighestClasses: risk.HighestClasses,
			Reasons:        reasons,
		}
	}

	// No eligible approval. Explain precisely why, and pick the Cooper verdict.
	var nonAuthorApprovers []string
	authorSelfApproved := false
	for _, l := range approverLogins {
		if l == authorLogin {
			authorSelfApproved = true
		} else {
			nonAuthorApprovers = append(nonAuthorApprovers, l)
		}
	}
	if authorSelfApproved {
		reasons = append(reasons, fmt.Sprintf(
			"The author (%s) cannot self-approve (actor≠verifier). Their own approval does not count.",
			authorLogin))
	}
	var staleEligible []string
	for _, l := range lowerAll(state.StaleApprovers) {
		if l != authorLogin && requiredSet[l] {
			staleEligible = append(staleEligible, l)
		}
	}
	if len(staleEligible) > 0 {
		reasons = append(reasons, fmt.Sprintf(
			"STALE approval(s) from %s — a new commit landed AFTER their review, so it no longer applies to the current head SHA. Re-approval of the current head is required (stale-approval defense).",
			strings.Join(staleEligible, ", ")))
	}
	if len(nonAuthorApprovers) > 0 {
		reasons = append(reasons, fmt.Sprintf(
			"Approving reviewer(s) present but NOT on the %sallow-list: %s. Add them via a CODEOWNERS-gated edit to .github/agix-verifier-allowlist.json, or get a review from an existing verifier.",
			humanWord(humanRequired), strings.Join(nonAuthorApprovers, ", ")))
	}
	// CHANGES_REQUESTED from an allow-listed verifier ⇒ Recycle (back to author);
	// otherwise Hold (awaiting an independent review — retryable with no code change).
	var blockingChanges []string
	for _, l := range lowerAll(state.ChangesRequested) {
		if requiredSet[l] {
			blockingChanges = append(blockingChanges, l)
		}
	}
	gateVerdict := VerdictHold
	if len(blockingChanges) > 0 {
		gateVerdict = VerdictRecycle
		reasons = append(reasons, fmt.Sprintf(
			"Allow-listed verifier(s) requested changes: %s → back to the author (Recycle).",
			strings.Join(blockingChanges, ", ")))
	} else {
		reasons = append(reasons, fmt.Sprintf(
			"Awaiting an independent approving review from an allow-listed %sverifier (Hold).",
			humanWord(humanRequired)))
	}
	return Decision{
		Applicable:     true,
		Outcome:        OutcomeFail,
		GateVerdict:    gateVerdict,
		HumanRequired:  humanRequired,
		Approver:       "",
		RiskClasses:    risk.RiskClasses,
		HighestClasses: risk.HighestClasses,
		Reasons:        reasons,
	}
}

// ─── small helpers ──────────────────────────────────────────────────────────────

func humanWord(humanRequired bool) string {
	if humanRequired {
		return "human "
	}
	return ""
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func lowerAll(xs []string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = strings.ToLower(x)
	}
	return out
}

func lowerSet(xs []string) map[string]bool {
	s := map[string]bool{}
	for _, x := range xs {
		s[strings.ToLower(x)] = true
	}
	return s
}
