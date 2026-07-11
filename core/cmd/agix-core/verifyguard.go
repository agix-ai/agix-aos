// verify-guard — the general independent-verifier gate (actor ≠ verifier,
// enforced) as an agix verb. This is the born-clean, zero-Node replacement
// for `node lib/agix-verifier-guard.mjs` in .github/workflows/verifier-guard.yml.
//
//	agix verify-guard [--review <path>] [--repo owner/repo] [--pr N]
//	                       [--allowlist <path>] [--risk <path>]
//
// It asserts that a PR touching a RISK-AREA path carries an APPROVING code-host
// review from a login that is (a) ≠ the PR author AND (b) on the curated
// allow-list — and, for HIGHEST-risk classes, that the approver is a HUMAN.
// Non-risk PRs pass immediately. Exits 0 on pass, 1 on fail, and fails CLOSED
// (exit 1) on any internal error (a red check a maintainer can inspect, never a
// silent pass).
//
// INPUT (two modes, same decision):
//   - live:    reads the code host via `gh` (repo+PR from --repo/--pr or the
//     GITHUB_REPOSITORY / PR_NUMBER / GITHUB_EVENT_PATH environment).
//     Needs GH_TOKEN. This is the CI path.
//   - injected: --review <path> supplies {files, author, reviews, headSha}
//     directly — the $0/offline path used by tests (and usable in CI).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	vg "github.com/agix-ai/agix/core/verifierguard"
)

const (
	defaultAllowlistPath = ".github/agix-verifier-allowlist.json"
	defaultRiskPath      = ".github/agix-verifier-risk.json"
)

func cmdVerifyGuard(args []string) int {
	reviewPath, repo, pr, allowlistPath, riskPath, err := parseVerifyGuardArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	// Resolve the PR review context FIRST — validate the input the user explicitly passed
	// (--review must be a JSON review context) before the mandatory config, so a bad review
	// file blames the review, not the allow-list path the user never mentioned.
	var rc vg.ReviewContext
	if reviewPath != "" {
		rc, err = vg.LoadReviewContext(reviewPath)
		if err != nil {
			return failClosed(err)
		}
	} else {
		if repo == "" {
			repo = os.Getenv("GITHUB_REPOSITORY")
		}
		if pr == "" {
			pr = resolvePRNumberFromEnv()
		}
		if repo == "" || pr == "" {
			// No PR context — nothing to check (matches the .mjs skip).
			fmt.Println("verify-guard: no PR context (repo/number) — nothing to check. Skipping.")
			return 0
		}
		rc, err = vg.FetchLive(repo, pr)
		if err != nil {
			return failClosed(err)
		}
	}

	taxonomy, err := vg.LoadTaxonomy(riskPath)
	if err != nil {
		return failClosed(err)
	}

	// Classify risk BEFORE requiring the allow-list. A non-risk PR passes immediately (as the
	// help promises) and needs no allow-list; only a risk-area PR must satisfy one, so a missing
	// allow-list fails closed only when it actually gates something.
	var allowlist vg.Allowlist
	if len(vg.ClassifyRisk(rc.Files, &taxonomy).RiskClasses) > 0 {
		allowlist, err = vg.LoadAllowlist(allowlistPath)
		if err != nil {
			return failClosed(err)
		}
	}

	decision := vg.Decide(vg.DecideInput{
		Files:     rc.Files,
		Author:    rc.Author,
		Reviews:   rc.Reviews,
		Allowlist: allowlist,
		HeadSha:   rc.HeadSha,
		Taxonomy:  &taxonomy,
	})

	summary := formatVerifyGuardReport(decision, pr, rc.Author)
	fmt.Println(summary)
	appendToEnvFile("GITHUB_STEP_SUMMARY", summary+"\n")
	appendToEnvFile("GITHUB_OUTPUT", verifyGuardOutputs(decision, rc.Author))

	if decision.Outcome == vg.OutcomeFail {
		vgError(fmt.Sprintf("Risk-area PR blocked — no independent %sapproval from an allow-listed verifier (%s).",
			vgHumanWord(decision.HumanRequired), decision.GateVerdict))
		return 1
	}
	return 0
}

// failClosed reports an internal error as a red check and returns a blocking exit
// code — a risk-area gate must never silently pass on an internal error.
func failClosed(err error) int {
	vgError(err.Error())
	return 1
}

// vgError writes a verify-guard error. Under GitHub Actions it emits the `::error::`
// workflow-command annotation (so the check renders red in the UI); elsewhere — a human at
// a terminal running it on a local review — it prints a plain, readable message.
func vgError(msg string) {
	if os.Getenv("GITHUB_ACTIONS") == "true" {
		fmt.Fprintf(os.Stderr, "::error title=verify-guard::%s\n", msg)
		return
	}
	fmt.Fprintf(os.Stderr, "verify-guard: %s\n", msg)
}

// resolvePRNumberFromEnv reads the PR number from PR_NUMBER, or falls back to the
// GitHub Actions event payload (pull_request.number / number).
func resolvePRNumberFromEnv() string {
	if n := strings.TrimSpace(os.Getenv("PR_NUMBER")); n != "" {
		return n
	}
	evPath := os.Getenv("GITHUB_EVENT_PATH")
	if evPath == "" {
		return ""
	}
	data, err := os.ReadFile(evPath)
	if err != nil {
		return ""
	}
	var ev struct {
		PullRequest *struct {
			Number json.Number `json:"number"`
		} `json:"pull_request"`
		Number json.Number `json:"number"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return ""
	}
	if ev.PullRequest != nil && ev.PullRequest.Number != "" {
		return ev.PullRequest.Number.String()
	}
	if ev.Number != "" {
		return ev.Number.String()
	}
	return ""
}

// formatVerifyGuardReport builds the human/markdown report (mirrors the .mjs
// main() summary).
func formatVerifyGuardReport(d vg.Decision, prNumber, author string) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("## verify-guard — %s (%s)", strings.ToUpper(d.Outcome), d.GateVerdict))
	lines = append(lines, "")
	if !d.Applicable {
		lines = append(lines, "This PR touches no risk-area paths. verify-guard is not applicable.")
	} else {
		prLabel := prNumber
		if prLabel == "" {
			prLabel = "?"
		}
		lines = append(lines, fmt.Sprintf("PR #%s · author `%s` · risk classes: `%s`",
			prLabel, author, strings.Join(d.RiskClasses, ", ")))
		if d.HumanRequired {
			lines = append(lines, fmt.Sprintf("Highest-risk classes present: `%s` → **human** reviewer required.",
				strings.Join(d.HighestClasses, ", ")))
		}
		lines = append(lines, "")
	}
	for _, r := range d.Reasons {
		lines = append(lines, "- "+r)
	}
	return strings.Join(lines, "\n")
}

// verifyGuardOutputs builds the GITHUB_OUTPUT key=value block (mirrors the .mjs).
func verifyGuardOutputs(d vg.Decision, author string) string {
	return strings.Join([]string{
		fmt.Sprintf("applicable=%t", d.Applicable),
		fmt.Sprintf("outcome=%s", d.Outcome),
		fmt.Sprintf("gate_verdict=%s", d.GateVerdict),
		fmt.Sprintf("human_required=%t", d.HumanRequired),
		fmt.Sprintf("approver=%s", d.Approver),
		fmt.Sprintf("author=%s", author),
		fmt.Sprintf("risk_classes=%s", strings.Join(d.RiskClasses, ",")),
		fmt.Sprintf("highest_classes=%s", strings.Join(d.HighestClasses, ",")),
	}, "\n") + "\n"
}

// appendToEnvFile best-effort appends to a GitHub Actions env file named by the
// given environment variable (GITHUB_STEP_SUMMARY / GITHUB_OUTPUT). A no-op when
// the variable is unset (i.e. outside Actions).
func appendToEnvFile(envVar, content string) {
	path := os.Getenv(envVar)
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(content)
}

func vgHumanWord(humanRequired bool) string {
	if humanRequired {
		return "human "
	}
	return ""
}

// parseVerifyGuardArgs pulls the verb's flags in any order (same hand-rolled
// scheme as parseRunArgs/parseFlowArgs).
func parseVerifyGuardArgs(args []string) (review, repo, pr, allowlist, risk string, err error) {
	allowlist = defaultAllowlistPath
	risk = defaultRiskPath
	take := func(i int, name string) (string, error) {
		if i+1 >= len(args) {
			return "", fmt.Errorf("verify-guard: %s needs a value", name)
		}
		return args[i+1], nil
	}
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--review":
			if review, err = take(i, "--review"); err != nil {
				return "", "", "", "", "", err
			}
			i += 2
		case strings.HasPrefix(a, "--review="):
			review = strings.TrimPrefix(a, "--review=")
			i++
		case a == "--repo":
			if repo, err = take(i, "--repo"); err != nil {
				return "", "", "", "", "", err
			}
			i += 2
		case strings.HasPrefix(a, "--repo="):
			repo = strings.TrimPrefix(a, "--repo=")
			i++
		case a == "--pr":
			if pr, err = take(i, "--pr"); err != nil {
				return "", "", "", "", "", err
			}
			i += 2
		case strings.HasPrefix(a, "--pr="):
			pr = strings.TrimPrefix(a, "--pr=")
			i++
		case a == "--allowlist":
			if allowlist, err = take(i, "--allowlist"); err != nil {
				return "", "", "", "", "", err
			}
			i += 2
		case strings.HasPrefix(a, "--allowlist="):
			allowlist = strings.TrimPrefix(a, "--allowlist=")
			i++
		case a == "--risk":
			if risk, err = take(i, "--risk"); err != nil {
				return "", "", "", "", "", err
			}
			i += 2
		case strings.HasPrefix(a, "--risk="):
			risk = strings.TrimPrefix(a, "--risk=")
			i++
		case a == "help" || a == "-h" || a == "--help":
			verifyGuardUsage()
			return "", "", "", "", "", fmt.Errorf("verify-guard: help")
		case strings.HasPrefix(a, "--"):
			return "", "", "", "", "", fmt.Errorf("verify-guard: unknown flag %q", a)
		default:
			return "", "", "", "", "", fmt.Errorf("verify-guard: unexpected argument %q", a)
		}
	}
	return review, repo, pr, allowlist, risk, nil
}

func verifyGuardUsage() {
	fmt.Fprint(os.Stderr, `agix verify-guard — the independent-verifier gate (actor ≠ verifier)

usage:
  agix verify-guard [--review <path>] [--repo owner/repo] [--pr N] \
                         [--allowlist <path>] [--risk <path>]

input modes:
  live (CI):  reads the code host via gh; repo/PR from --repo/--pr or the
              GITHUB_REPOSITORY / PR_NUMBER / GITHUB_EVENT_PATH environment.
              Requires GH_TOKEN.
  injected:   --review <path> supplies {files, author, reviews, headSha} directly
              ($0/offline).

exit: 0 pass · 1 fail (or internal error, fail-closed) · 2 usage
defaults: --allowlist .github/agix-verifier-allowlist.json
          --risk      .github/agix-verifier-risk.json (absent → built-in taxonomy)
`)
}
