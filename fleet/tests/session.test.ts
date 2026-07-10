// Interactive turn-loop tests — HERMETIC ($0/offline, no Go binary, no key, no
// network). Exercise converse() over a ScriptedIO + MockEngine and assert:
//   - the loop maintains conversation HISTORY across ≥2 turns (turn 2's governed
//     task carries turn 1's user text AND turn 1's certified answer);
//   - every turn is GOVERNED — one ctx.hive.run per turn, actor≠verifier per turn,
//     and an ungoverned engine trips the tripwire ON A TURN (not just at load);
//   - exit handling: an exit command ends the loop; NullIO yields zero turns so a
//     conversational mode invoked non-interactively is a clean no-op.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { buildContext } from "../runtime/context.ts";
import { MockEngine, type EngineDriver, type GovernedResult, type HiveRunOptions } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { DryRunNotifier } from "../runtime/notify.ts";
import { converse, ScriptedIO, NullIO, type TurnIO } from "../runtime/session.ts";
import type { Manifest } from "../runtime/manifest.ts";

function ctxWith(io: TurnIO, engine: EngineDriver) {
  const manifest: Manifest = {
    name: "mentor",
    public: true,
    role: "conductor",
    trust: "conductor",
    instructions: "converse",
    tools: [],
  };
  return buildContext({
    manifest,
    input: { args: [], text: "", flags: {} },
    engine,
    comb: new MemComb(),
    notifier: new DryRunNotifier(() => {}),
    io,
    dir: "agents",
    provider: "mock",
    publicOnly: false,
    smoke: false,
    repoRoot: "/tmp",
  });
}

// A trivial task shaper that embeds the running history — so an assertion can prove
// the history threaded into the NEXT turn's governed task.
function threadedBuildTask(history: { role: string; text: string }[], user: string): string {
  const h = history.map((t) => `${t.role}: ${t.text}`).join("\n");
  return `HISTORY:\n${h}\nUSER: ${user}`;
}

describe("interactive turn-loop (converse)", () => {
  test("maintains history across ≥2 turns; each turn is a governed hive pass", async () => {
    // A MockEngine whose answer varies per turn, so the threaded answer is identifiable.
    let n = 0;
    const engine = new MockEngine(() => `mentor-answer-${++n}`);
    const io = new ScriptedIO(["what's my north star?", "and the biggest risk?", null]);
    const ctx = ctxWith(io, engine);

    const conv = await converse(ctx, { buildTask: threadedBuildTask });

    // Two turns ran; the transcript holds 2 user + 2 agent entries (the maintained history).
    expect(conv.turns).toBe(2);
    expect(conv.transcript.length).toBe(4);
    expect(conv.transcript[0]).toMatchObject({ role: "user", text: "what's my north star?" });
    expect(conv.transcript[1].role).toBe("agent");
    expect(conv.transcript[2]).toMatchObject({ role: "user", text: "and the biggest risk?" });

    // Exactly one governed hive run per turn.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls.every((c) => c.agent === "mentor")).toBe(true);

    // HISTORY THREADING: turn 2's governed task carries turn 1's user message AND
    // turn 1's certified answer — proving history is maintained across turns.
    const turn2Task = engine.calls[1].task;
    expect(turn2Task).toContain("what's my north star?");
    expect(turn2Task).toContain("mentor-answer-1");

    // GOVERNED per turn: a distinct verifier certified each turn (actor≠verifier).
    expect(conv.governed).toBe(true);
    expect(conv.verifiers.length).toBe(2);
    for (const v of conv.verifiers) {
      expect(v).toBe("mentor/worker/verifier-1");
      expect(v).not.toBe("mentor/queen/root"); // verifier ≠ queen
    }
  });

  test("an ungoverned engine trips the actor≠verifier tripwire ON A TURN", async () => {
    // The engine collapses the verifier into the queen — governance must fail per turn.
    const ungoverned: EngineDriver = {
      async run(agent: string, _task: string, _opts?: HiveRunOptions): Promise<GovernedResult> {
        return {
          agent,
          verified: true,
          verdict: { approved: true, by: `${agent}/queen/root`, notes: "self-graded" },
          answer: "trust me",
          queenActor: `${agent}/queen/root`,
          verifierActor: `${agent}/queen/root`, // same as queen: NOT governed
          tools: [],
          unresolvedTools: [],
          boundary: [],
          cost: { usd: 0, inputTokens: 0, outputTokens: 0, bees: 1 },
          subtasks: [],
          degraded: [],
        };
      },
    };
    const ctx = ctxWith(new ScriptedIO(["hello", null]), ungoverned);
    await expect(converse(ctx, { buildTask: threadedBuildTask })).rejects.toThrow(/actor≠verifier/);
  });

  test("an exit command ends the loop before consuming later turns", async () => {
    const engine = new MockEngine();
    const io = new ScriptedIO(["first question", "/exit", "never reached", null]);
    const ctx = ctxWith(io, engine);

    const conv = await converse(ctx, { buildTask: threadedBuildTask });
    expect(conv.turns).toBe(1); // only the first question ran; /exit stopped the loop
    expect(engine.calls.length).toBe(1);
  });

  test("NullIO yields zero turns — a conversational mode is a clean no-op non-interactively", async () => {
    const engine = new MockEngine();
    const ctx = ctxWith(new NullIO(), engine);
    const conv = await converse(ctx, { buildTask: threadedBuildTask });
    expect(conv.turns).toBe(0);
    expect(engine.calls.length).toBe(0);
    expect(ctx.io.interactive).toBe(false);
  });
});
