// SPDX-License-Identifier: Apache-2.0
//
// io.go — the thin, impure I/O shell for verifier-guard: the config loaders and
// the `gh` code-host reads. The pure decision brain (verifierguard.go) never
// touches disk or network; everything that does lives here so the gate's rules
// stay exercised with no code-host and no network in the tests.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package verifierguard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ReviewContext is the PR review state the gate reasons over. It is the exact
// shape accepted by --review (offline injection) and the exact shape FetchLive
// assembles from the code host.
type ReviewContext struct {
	Files   []string `json:"files"`
	Author  string   `json:"author"`
	Reviews []Review `json:"reviews"`
	HeadSha string   `json:"headSha"`
}

// ─── Config loaders (allow-list + optional taxonomy override) ───────────────────

type allowlistFile struct {
	Verifiers []string `json:"verifiers"`
	Humans    []string `json:"humans"`
}

// LoadAllowlist reads and parses the curated allow-list JSON. A missing or
// malformed file is an ERROR (the caller fails closed — a risk-area gate never
// silently proceeds without its allow-list).
func LoadAllowlist(path string) (Allowlist, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Allowlist{}, fmt.Errorf("verifier allow-list not found at %s: %w", path, err)
	}
	var f allowlistFile
	if err := json.Unmarshal(data, &f); err != nil {
		return Allowlist{}, fmt.Errorf("verifier allow-list %s is not valid JSON: %w", path, err)
	}
	return ParseAllowlist(f.Verifiers, f.Humans), nil
}

// LoadTaxonomy reads an optional per-repo risk taxonomy override. Absent →
// DefaultTaxonomy. Present but with a missing Highest/Risk tier → that tier
// falls back to the default (mirrors the .mjs per-key `|| DEFAULT` at load time).
func LoadTaxonomy(path string) (Taxonomy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultTaxonomy(), nil
		}
		return Taxonomy{}, fmt.Errorf("read risk taxonomy %s: %w", path, err)
	}
	var t Taxonomy
	if err := json.Unmarshal(data, &t); err != nil {
		return Taxonomy{}, fmt.Errorf("risk taxonomy %s is not valid JSON: %w", path, err)
	}
	if t.Highest == nil {
		t.Highest = DefaultHighestRiskGlobs()
	}
	if t.Risk == nil {
		t.Risk = DefaultRiskOnlyGlobs()
	}
	return t, nil
}

// LoadReviewContext reads an injected PR review context (the --review file). This
// is the $0/offline path: no code host, no network — the same data FetchLive
// would produce, supplied directly.
func LoadReviewContext(path string) (ReviewContext, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ReviewContext{}, fmt.Errorf("read review context %s: %w", path, err)
	}
	var rc ReviewContext
	if err := json.Unmarshal(data, &rc); err != nil {
		return ReviewContext{}, fmt.Errorf("review context %s is not valid JSON: %w", path, err)
	}
	return rc, nil
}

// ─── The `gh` I/O shell (pagination-safe; not exercised by unit tests) ──────────

// NormalizeSlurpedPages normalizes `gh api --paginate --slurp` output. For a list
// endpoint `--slurp` wraps EACH page's response, yielding an array-of-pages
// (`[[…p1…],[…p2…]]`); flatten one level to a flat item array. Robust to the
// single-page (`[[…]]`) and already-flat shapes, and to a non-array body (→ []).
// Faithful port of the unit-tested normalizeSlurpedPages.
func NormalizeSlurpedPages(raw []byte) []json.RawMessage {
	var top []json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return []json.RawMessage{} // not a JSON array → [] (mirrors !Array.isArray)
	}
	if len(top) == 0 {
		return []json.RawMessage{}
	}
	allArrays := true
	for _, el := range top {
		t := bytes.TrimLeft(el, " \t\r\n")
		if len(t) == 0 || t[0] != '[' {
			allArrays = false
			break
		}
	}
	if !allArrays {
		return top
	}
	out := []json.RawMessage{}
	for _, page := range top {
		var items []json.RawMessage
		if err := json.Unmarshal(page, &items); err != nil {
			// A page that claimed to be an array but won't parse: keep the
			// unflattened form rather than dropping data (fail loud upstream).
			return top
		}
		out = append(out, items...)
	}
	return out
}

// runGH shells out to `gh` and returns stdout. A non-zero exit is an ERROR — the
// caller fails closed on it (a code-host read that fails must block, never pass).
func runGH(args ...string) ([]byte, error) {
	cmd := exec.Command("gh", args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("gh %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// ghListAll reads every page of a `gh api` LIST endpoint into a flat array of
// raw items (pagination-safe: a PR with >30 files or >30 reviews spans pages).
func ghListAll(endpoint string) ([]json.RawMessage, error) {
	raw, err := runGH("api", "--paginate", "--slurp", endpoint)
	if err != nil {
		return nil, err
	}
	return NormalizeSlurpedPages(raw), nil
}

// FetchLive assembles the PR review context from the code host via `gh`. It reads
// the changed files, the reviews, and the PR's author + head SHA. This is the
// live-CI path (the born-clean equivalent of the .mjs main()'s gh reads).
func FetchLive(repo, prNumber string) (ReviewContext, error) {
	rc := ReviewContext{}

	// Changed files (filename per item).
	fileItems, err := ghListAll(fmt.Sprintf("repos/%s/pulls/%s/files", repo, prNumber))
	if err != nil {
		return rc, err
	}
	for _, it := range fileItems {
		var f struct {
			Filename string `json:"filename"`
		}
		if err := json.Unmarshal(it, &f); err != nil {
			return rc, fmt.Errorf("decode file item: %w", err)
		}
		if f.Filename != "" {
			rc.Files = append(rc.Files, f.Filename)
		}
	}

	// Reviews.
	reviewItems, err := ghListAll(fmt.Sprintf("repos/%s/pulls/%s/reviews", repo, prNumber))
	if err != nil {
		return rc, err
	}
	for _, it := range reviewItems {
		var r Review
		if err := json.Unmarshal(it, &r); err != nil {
			return rc, fmt.Errorf("decode review item: %w", err)
		}
		rc.Reviews = append(rc.Reviews, r)
	}

	// PR author + head SHA.
	prRaw, err := runGH("api", fmt.Sprintf("repos/%s/pulls/%s", repo, prNumber))
	if err != nil {
		return rc, err
	}
	var pr struct {
		User struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := json.Unmarshal(prRaw, &pr); err != nil {
		return rc, fmt.Errorf("decode pull request: %w", err)
	}
	rc.Author = pr.User.Login
	rc.HeadSha = pr.Head.SHA
	return rc, nil
}
