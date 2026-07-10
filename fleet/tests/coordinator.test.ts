// Coordinator tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// They load the real reborn coordinator (agents/coordinator/agent.ts) and drive
// its five modes against a scratch state dir (never the operator's real cache).
//
// The coordinator is DETERMINISTIC infrastructure: it makes ZERO governed hive
// calls, so unlike mentor/investigator there is no actor≠verifier verifier to
// assert. The honest inverse is asserted instead — every mode runs with
// engine.calls.length === 0 (no intelligence surface was touched). The MockEngine
// + MemComb are wired exactly as in runner.test.ts to mirror the harness; the
// coordinator simply never reaches them.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function newStateDir(): string {
  return mkdtempSync(join(tmpdir(), "agix-coord-"));
}

// Drive one coordinator mode against a scratch state dir. Returns the result AND
// the engine, so a caller can assert NO governed intelligence ran.
async function coord(
  stateDir: string,
  mode: string | undefined,
  flags: Record<string, string | boolean> = {},
  opts: { smoke?: boolean } = {},
) {
  const engine = new MockEngine();
  const { result } = await runAgent("coordinator", {
    dir: AGENTS,
    engine,
    comb: new MemComb(),
    repoRoot: mkdtempSync(join(tmpdir(), "agix-coord-repo-")),
    smoke: opts.smoke ?? false,
    input: { mode, flags: { "state-dir": stateDir, ...flags }, args: [], text: "" },
  });
  return { result, engine };
}

const START = { "agent-name": "claude-code", "agent-kind": "session", branch: "claude/feat-x" };

describe("coordinator (spawn-gate / boundary drone) — deterministic, zero intelligence", () => {
  test("start registers an agent, status then lists it active (no governed pass)", async () => {
    const dir = newStateDir();
    const { result: started, engine } = await coord(dir, "start", { ...START, "agent-id": "a-1", files: "src/foo.ts", tags: "billing" });
    expect(started.ok).toBe(true);
    expect(started.mode).toBe("start");
    expect(started.agent_id).toBe("a-1");
    // the state file was actually written to the scratch dir…
    expect(existsSync(join(dir, "a-1.json"))).toBe(true);
    // …and NO governed intelligence ran (the honest inverse of "distinct verifier").
    expect(engine.calls.length).toBe(0);

    const { result: status } = await coord(dir, "status");
    expect(status.ok).toBe(true);
    expect((status.counts as { active: number }).active).toBe(1);
    expect((status.active as { agent_id: string }[])[0].agent_id).toBe("a-1");
  });

  test("check is the spawn-gate: HARD file-overlap refuses, --force cannot silence it", async () => {
    const dir = newStateDir();
    await coord(dir, "start", { ...START, "agent-id": "holder", files: "architecture/COORDINATOR.md" });

    // Overlapping file → hard collision, ok:false.
    const { result: clash } = await coord(dir, "check", { branch: "claude/other", files: "architecture/COORDINATOR.md", tags: "docs" });
    expect(clash.ok).toBe(false);
    expect((clash.hard as unknown[]).length).toBe(1);
    expect((clash.hard as { with_agent_id: string }[])[0].with_agent_id).toBe("holder");

    // --force NEVER downgrades a hard collision.
    const { result: forced } = await coord(dir, "check", { files: "architecture/COORDINATOR.md", force: true });
    expect(forced.ok).toBe(false);

    // A non-overlapping proposal is clear.
    const { result: clear } = await coord(dir, "check", { files: "architecture/OTHER.md", tags: "unrelated" });
    expect(clear.ok).toBe(true);
    expect((clear.hard as unknown[]).length).toBe(0);
  });

  test("check SOFT tag-overlap warns but --force overrides it", async () => {
    const dir = newStateDir();
    await coord(dir, "start", { ...START, "agent-id": "holder", tags: "billing" });

    const { result: soft } = await coord(dir, "check", { tags: "billing", files: "src/unrelated.ts" });
    expect(soft.ok).toBe(false);
    expect((soft.soft as unknown[]).length).toBe(1);
    expect((soft.hard as unknown[]).length).toBe(0);

    const { result: forced } = await coord(dir, "check", { tags: "billing", files: "src/unrelated.ts", force: true });
    expect(forced.ok).toBe(true);
    expect(forced.forced).toBe(true);
  });

  test("check rejects an empty proposal (input-error contract)", async () => {
    const dir = newStateDir();
    const { result } = await coord(dir, "check", {});
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("at least one");
  });

  test("start refuses a duplicate agent-id while the first is still fresh", async () => {
    const dir = newStateDir();
    const first = await coord(dir, "start", { ...START, "agent-id": "dup" });
    expect(first.result.ok).toBe(true);
    const second = await coord(dir, "start", { ...START, "agent-id": "dup" });
    expect(second.result.ok).toBe(false);
    expect(second.result.error).toBe("duplicate-agent-id");
  });

  test("end removes the state file; status then shows an empty fleet", async () => {
    const dir = newStateDir();
    await coord(dir, "start", { ...START, "agent-id": "bye" });
    expect(existsSync(join(dir, "bye.json"))).toBe(true);

    const { result: ended } = await coord(dir, "end", { "agent-id": "bye", reason: "completed" });
    expect(ended.ok).toBe(true);
    expect(existsSync(join(dir, "bye.json"))).toBe(false);

    const { result: status } = await coord(dir, "status");
    expect((status.counts as { active: number }).active).toBe(0);
  });

  test("repair reaps an entry whose heartbeat is past the reap floor", async () => {
    const dir = newStateDir();
    // Drop a valid-but-ancient state file directly (last heartbeat in 2020).
    writeFileSync(
      join(dir, "ghost.json"),
      JSON.stringify({
        schema_version: 1,
        agent_id: "ghost",
        agent_name: "claude-code",
        agent_kind: "session",
        started_at: "2020-01-01T00:00:00Z",
        last_heartbeat_at: "2020-01-01T00:00:00Z",
      }) + "\n",
    );
    const { result, engine } = await coord(dir, "repair");
    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(1);
    expect((result.reapedList as { agent_id: string }[])[0].agent_id).toBe("ghost");
    expect(existsSync(join(dir, "ghost.json"))).toBe(false);
    expect(engine.calls.length).toBe(0);
  });

  test("smoke short-circuits with ZERO fs mutation and zero governed passes", async () => {
    const dir = newStateDir();
    const { result, engine } = await coord(dir, "status", { "agent-id": "x" }, { smoke: true });
    expect(result.ok).toBe(true);
    expect(result.smoke).toBe(true);
    // smoke wrote nothing to the scratch dir…
    expect(readdirSync(dir).length).toBe(0);
    // …and never touched the (unused) intelligence surface.
    expect(engine.calls.length).toBe(0);
  });
});
