// SPDX-License-Identifier: Apache-2.0
// End-to-end tests for `agix-core verify-guard` — the CI gate verb. Fully
// offline ($0): every case injects a PR review context via --review and a curated
// allow-list via --allowlist, so no `gh` and no network are touched. Proves the
// gate GATES: a distinct verifier passes, self-certification / trust-floor /
// missing-approval fail with a blocking exit code.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeJSON marshals v to a file under dir and returns its path.
func writeJSON(t *testing.T, dir, name string, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %s: %v", name, err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

// review builds one code-host review in the gh shape.
func rev(state, login, commit string) map[string]any {
	return map[string]any{"state": state, "commit_id": commit, "user": map[string]any{"login": login}}
}

func TestVerifyGuardGates(t *testing.T) {
	dir := t.TempDir()
	const head = "sha-head"

	// A curated allow-list: alice+bob are humans (∴ verifiers); codex-bot is an
	// agent-only verifier (NOT human).
	allowlist := writeJSON(t, dir, "allowlist.json", map[string]any{
		"verifiers": []string{"alice", "bob", "codex-bot"},
		"humans":    []string{"alice", "bob"},
	})

	cases := []struct {
		name     string
		review   map[string]any
		wantCode int
		wantOut  string // substring required in stdout
	}{
		{
			name: "distinct allow-listed verifier PASSES",
			review: map[string]any{
				"files":   []string{"apps/api/src/connectors/example-provider.ts"},
				"author":  "agent-x",
				"reviews": []map[string]any{rev("APPROVED", "bob", head)},
				"headSha": head,
			},
			wantCode: 0,
			wantOut:  "PASS",
		},
		{
			name: "self-certification (verifier == author) FAILS",
			review: map[string]any{
				"files":   []string{"apps/api/src/connectors/example-provider.ts"},
				"author":  "alice",
				"reviews": []map[string]any{rev("APPROVED", "alice", head)},
				"headSha": head,
			},
			wantCode: 1,
			wantOut:  "cannot self-approve",
		},
		{
			name: "trust floor: approver not on the allow-list FAILS",
			review: map[string]any{
				"files":   []string{"apps/api/src/connectors/example-provider.ts"},
				"author":  "agent-x",
				"reviews": []map[string]any{rev("APPROVED", "random-collaborator", head)},
				"headSha": head,
			},
			wantCode: 1,
			wantOut:  "NOT on the",
		},
		{
			name: "highest-risk migration, no approval (missing ratify) FAILS (hold)",
			review: map[string]any{
				"files":   []string{"packages/db/migrations/0106_x.sql"},
				"author":  "agent-x",
				"reviews": []map[string]any{},
				"headSha": head,
			},
			wantCode: 1,
			wantOut:  "human",
		},
		{
			name: "highest-risk migration approved by an AGENT verifier (non-human) FAILS",
			review: map[string]any{
				"files":   []string{"packages/db/migrations/0106_x.sql"},
				"author":  "agent-x",
				"reviews": []map[string]any{rev("APPROVED", "codex-bot", head)},
				"headSha": head,
			},
			wantCode: 1,
			wantOut:  "human",
		},
		{
			name: "highest-risk migration approved by a HUMAN PASSES",
			review: map[string]any{
				"files":   []string{"packages/db/migrations/0106_x.sql"},
				"author":  "agent-x",
				"reviews": []map[string]any{rev("APPROVED", "alice", head)},
				"headSha": head,
			},
			wantCode: 0,
			wantOut:  "PASS",
		},
		{
			name: "stale approval (approve@A, head=B) FAILS",
			review: map[string]any{
				"files":   []string{"packages/db/migrations/0106_x.sql"},
				"author":  "agent-x",
				"reviews": []map[string]any{rev("APPROVED", "alice", "sha-OLD")},
				"headSha": head,
			},
			wantCode: 1,
			wantOut:  "STALE approval",
		},
		{
			name: "non-risk PR PASSES immediately (not applicable)",
			review: map[string]any{
				"files":   []string{"docs/x.md", "apps/web/src/home.tsx"},
				"author":  "agent-x",
				"reviews": []map[string]any{},
				"headSha": head,
			},
			wantCode: 0,
			wantOut:  "not applicable",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reviewPath := writeJSON(t, dir, "review.json", c.review)
			out, code := captureStdout(t, func() int {
				return cmdVerifyGuard([]string{"--review", reviewPath, "--allowlist", allowlist})
			})
			if code != c.wantCode {
				t.Fatalf("exit = %d, want %d\noutput:\n%s", code, c.wantCode, out)
			}
			if !strings.Contains(out, c.wantOut) {
				t.Errorf("stdout missing %q\noutput:\n%s", c.wantOut, out)
			}
		})
	}
}

// A missing allow-list must FAIL CLOSED (exit 1), never silently pass a risk PR.
func TestVerifyGuardMissingAllowlistFailsClosed(t *testing.T) {
	dir := t.TempDir()
	reviewPath := writeJSON(t, dir, "review.json", map[string]any{
		"files":   []string{"packages/db/migrations/0106_x.sql"},
		"author":  "agent-x",
		"reviews": []map[string]any{},
		"headSha": "sha-head",
	})
	_, code := captureStdout(t, func() int {
		return cmdVerifyGuard([]string{"--review", reviewPath, "--allowlist", filepath.Join(dir, "nope.json")})
	})
	if code != 1 {
		t.Errorf("missing allow-list must fail closed with exit 1, got %d", code)
	}
}

// No PR context (no --review, no repo/PR env) → skip cleanly (exit 0).
func TestVerifyGuardNoContextSkips(t *testing.T) {
	dir := t.TempDir()
	allowlist := writeJSON(t, dir, "allowlist.json", map[string]any{
		"verifiers": []string{"alice"}, "humans": []string{"alice"},
	})
	// Ensure the live-mode env is clear so it can't resolve a PR.
	for _, k := range []string{"GITHUB_REPOSITORY", "PR_NUMBER", "GITHUB_EVENT_PATH"} {
		t.Setenv(k, "")
	}
	out, code := captureStdout(t, func() int {
		return cmdVerifyGuard([]string{"--allowlist", allowlist})
	})
	if code != 0 {
		t.Errorf("no PR context should skip with exit 0, got %d\n%s", code, out)
	}
	if !strings.Contains(out, "no PR context") {
		t.Errorf("expected a skip message, got:\n%s", out)
	}
}
