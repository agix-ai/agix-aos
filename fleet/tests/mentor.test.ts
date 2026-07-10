// Mentor conversational + review port tests — HERMETIC ($0/offline, no Go binary,
// no key, no network). The single-shot modes (goals/plan/smoke) are covered in
// runner.test.ts; this file covers the newly-ported modes:
//   - chat: an interactive governed REPL that maintains history across turns and
//     journals an attested session summary (actor≠verifier per turn);
//   - session: the same governed turn-loop, framed around a session name;
//   - review: a single-shot governed doc-alignment pass over a bounded-read file.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { ScriptedIO } from "../runtime/session.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-mentor-"));
}

function comb(): MemComb {
  return new MemComb({ roster: ["mentor/worker/verifier-1"], trustFloor: 0.35 });
}

describe("mentor chat (interactive, governed per turn)", () => {
  test("maintains history across turns and journals an attested summary", async () => {
    let n = 0;
    const engine = new MockEngine(() => `strategic-reply-${++n}`);
    const c = comb();
    const io = new ScriptedIO(["what is the north star?", "what breaks if we ship Friday?", null]);

    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: tmpRepo(),
      io,
      input: { mode: "chat", args: [], text: "", flags: {} },
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("chat");
    expect(result.turns).toBe(2);
    expect(result.governed).toBe(true);
    expect(result.verifier).toBe("mentor/worker/verifier-1");

    // Two governed turns; turn 2's task carried turn 1's user text + certified answer.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[1].task).toContain("what is the north star?");
    expect(engine.calls[1].task).toContain("strategic-reply-1");

    // The session was journaled as an attested Comb leaf (actor≠verifier).
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("non-interactive chat is a clean zero-turn no-op (no journal, still ok)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      // no io → NullIO default
      input: { mode: "chat", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.turns).toBe(0);
    expect(engine.calls.length).toBe(0);
  });
});

describe("mentor session (interactive, governed per turn)", () => {
  test("runs a named governed working session over the turn-loop", async () => {
    const engine = new MockEngine();
    const io = new ScriptedIO(["let's plan the release", null]);
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      io,
      input: { mode: "session", args: ["release-cut"], text: "release-cut", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("session");
    expect(result.session).toBe("release-cut");
    expect(result.turns).toBe(1);
    expect(engine.calls.length).toBe(1);
  });
});

describe("mentor review (single-shot governed doc pass)", () => {
  test("reviews a doc under the read boundary and journals the review", async () => {
    const engine = new MockEngine(() => "Alignment: strong. Sequencing risk: none. Smallest reversible improvement: X.");
    const c = comb();
    const repo = tmpRepo();
    await Bun.write(join(repo, "docs/handoffs/spec.md"), "# Spec\nThis proposes a large refactor.");

    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { mode: "review", args: [], text: "", flags: { file: "docs/handoffs/spec.md" } },
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("review");
    expect(result.file).toBe("docs/handoffs/spec.md");
    expect(result.verifier).toBe("mentor/worker/verifier-1");
    // Exactly one governed pass; the review was journaled + attested.
    expect(engine.calls.length).toBe(1);
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("review with no file is a graceful no-op (no governed run)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("mentor", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { mode: "review", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-file");
    expect(engine.calls.length).toBe(0);
  });
});

// ─── Ported from agents/mentor/eval/role-governance.suite.mjs ─────────────────
// The legacy suite drove agents/mentor/lib/policy.mjs's four ALLOW/DENY
// checkpoints (operator, edit, fire, git) across THREE role personas
// (cto/cpo/ceo), each a full policies/*.yaml permission table. The reborn
// Mentor (agent.ts) collapsed that multi-role system into ONE conductor:
// there is no --role switch, no policies/*.yaml, no operator-email
// allowlist, and no per-role edit/fire/git table. What actually survived
// into the reborn behavior is:
//   - a single hardcoded FIRE_ALLOWLIST (["research","secretary"]), of which
//     only "research" is ever the target of a real ctx.fire() call in
//     planMode — so the honest "fire" port is: verify that bounded,
//     deny-by-default delegation surface;
//   - a single write boundary (agent.json boundary.write), enforced
//     generically for every write by fleet/runtime/context.ts's
//     writeRepoFile — so the honest "edit" port is: verify every mode's
//     write lands inside it, and note why the DENY side is unreachable
//     through agent.ts's own inputs.
// The "operator" and "git" checkpoints have NO reborn equivalent at all
// (see the two test.todo blocks below) — agent.ts is left untouched per the
// hard constraint; the gap is recorded, not papered over.
describe("mentor role-governance (ported from eval/role-governance.suite.mjs)", () => {
  describe("fire — bounded delegation surface (legacy: fire-* checkpoint, MAST=Coordination)", () => {
    test("fire-deny-no-signal: a topic with no research intent fires nothing (deny-by-default)", async () => {
      const engine = new MockEngine();
      const { result } = await runAgent("mentor", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { mode: "plan", text: "tighten the release checklist for Friday", args: [], flags: {} },
      });
      expect(result.ok).toBe(true);
      expect(result.fired).toBeNull();
      // exactly one governed run — the plan itself; no delegation attempted.
      expect(engine.calls.length).toBe(1);
      expect(engine.calls[0].agent).toBe("mentor");
    });

    test("fire-allow-research: a research-flavored topic fires exactly the allowlisted research agent", async () => {
      const engine = new MockEngine();
      const { result } = await runAgent("mentor", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { mode: "plan", text: "survey the competitive landscape for cheap-model swarms", args: [], flags: {} },
      });
      expect(engine.calls.map((c) => c.agent)).toEqual(["mentor", "research"]);
      expect(result.fired).toBe("research/worker/verifier-1");
    });

    test("fire-no-overreach: naming an allowlisted-but-unwired agent in the topic never fires it — only research is ever a real fire target", async () => {
      const engine = new MockEngine();
      // "secretary" is in FIRE_ALLOWLIST but no code path ever fires it; mentioning
      // it by name (with a research keyword present) must still route to research.
      const { result } = await runAgent("mentor", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { mode: "plan", text: "have secretary schedule a research review", args: [], flags: {} },
      });
      const agents = engine.calls.map((c) => c.agent);
      expect(agents).not.toContain("secretary");
      expect(agents.every((a) => a === "mentor" || a === "research")).toBe(true);
      expect(result.fired).toBe("research/worker/verifier-1");
    });

    test("fire-no-overreach-no-keyword: naming secretary WITHOUT a research keyword fires nothing at all", async () => {
      const engine = new MockEngine();
      const { result } = await runAgent("mentor", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { mode: "plan", text: "just have the secretary handle scheduling", args: [], flags: {} },
      });
      expect(result.fired).toBeNull();
      expect(engine.calls.map((c) => c.agent)).toEqual(["mentor"]);
    });
  });

  describe("edit — write-boundary discipline (legacy: edit-* checkpoint, MAST=Specification)", () => {
    test("edit-allow-journal: goals/brief/plan/review all funnel through the same journal() write, and it lands under the declared boundary (wiki/mentor-journal/) with nothing else touched", async () => {
      const engine = new MockEngine(() => "synthesis");
      const repo = tmpRepo();
      const { result } = await runAgent("mentor", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: repo,
        input: { mode: "goals", args: [], text: "", flags: {} },
      });
      expect(result.ok).toBe(true);

      const entries = await readdir(repo, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => relative(repo, join((e as { parentPath?: string; path?: string }).parentPath ?? (e as { path: string }).path, e.name)));

      // Exactly one artifact exists in the whole repo tree, and it is the journal
      // file under the manifest's declared write boundary — agent.json's
      // boundary.write includes "wiki/" (agents/mentor/agent.json), and this is
      // the ONLY path agent.ts ever passes to ctx.writeRepoFile (JOURNAL_DIR is
      // hardcoded), so every mode (goals/brief/plan/chat/session/review) shares
      // this identical, in-bounds write surface.
      expect(files.length).toBe(1);
      expect(files[0].startsWith(join("wiki", "mentor-journal"))).toBe(true);
      expect(files[0].endsWith(".md")).toBe(true);
    });

    test.todo(
      "edit-deny-out-of-scope (legacy: edit-cto-out-of-scope-secret / edit-ceo-read-only) — " +
        "GAP: the legacy suite denied writes outside a role's edit_paths glob (e.g. .env, " +
        "or a read-only role's edit_paths: []). The reborn Mentor's write path is NOT " +
        "operator-controlled: JOURNAL_DIR is a hardcoded constant in agent.ts and no mode " +
        "accepts a write-path argument (review's --file is READ-only, ctx.readRepoFile). " +
        "There is therefore no input that can drive agent.ts into attempting an " +
        "out-of-boundary write, so this DENY case cannot be honestly reproduced by " +
        "exercising the agent. The underlying mechanism (fleet/runtime/context.ts " +
        "writeRepoFile's boundary-glob check) still exists and would throw if called " +
        "directly with an out-of-scope path, but reaching it that way tests the runtime " +
        "context, not agent.ts, so it is left as a gap rather than faked.",
    );
  });

  describe("operator identity checkpoint (legacy: operator-*, MAST=Specification) — no reborn equivalent", () => {
    test.todo(
      "operator-* (legacy: operator-cto-basic-tier-any / operator-cpo-wrong-role / " +
        "operator-ceo-intruder-denied / operator-ceo-missing-identity / etc.) — GAP: the " +
        "legacy suite gated on a per-role operator email allowlist (cto: wildcard '*'; " +
        "cpo/ceo: pinned emails), enforced by assertOperatorAllowed in " +
        "agents/mentor/lib/policy.mjs. The reborn Mentor has no role concept at all — no " +
        "--role cto|cpo|ceo, no policies/*.yaml, no operators_allowed list — and neither " +
        "agent.ts nor fleet/runtime resolves or checks an operator identity anywhere in " +
        "the run path. There is no enforcement left to assert ALLOW/DENY against; " +
        "reproducing this honestly would mean inventing an operator-identity gate that " +
        "does not exist in the reborn agent, which the hard constraint (no agent.ts edits) " +
        "correctly forbids.",
    );
  });

  describe("git-operation ceiling (legacy: git-*, MAST=Verification) — no reborn equivalent", () => {
    test.todo(
      "git-* (legacy: git-cto-commit-allowed / git-cto-branch-allowed / git-cto-push-denied / " +
        "git-ceo-commit-denied / git-unknown-operation) — GAP: agent.json declares " +
        "boundary.deny=['git push'], and manifest.test.ts already asserts that DECLARATION, " +
        "but no code in fleet/runtime (grepped context.ts/runner.ts/engine.ts/manifest.ts) " +
        "or in agent.ts ever READS boundary.deny or gates/performs a git commit, push, or " +
        "branch_create — unlike boundary.write, which context.ts actively enforces on every " +
        "writeRepoFile call. Mentor's agent.ts never shells out to git at all. There is no " +
        "assertGitOperationAllowed-equivalent function anywhere in the reborn runtime to " +
        "exercise, so the legacy commit/push/branch_create ALLOW/DENY ladder has no reborn " +
        "behavior left to port.",
    );
  });
});
