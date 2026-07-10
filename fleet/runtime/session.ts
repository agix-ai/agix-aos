// The interactive turn-loop seam. Some agent modes are CONVERSATIONAL (mentor's
// chat/session, secretary's ask): the operator and the agent take turns, and the
// agent must carry the conversation HISTORY across turns while every turn stays a
// GOVERNED hive pass (a distinct verifier certifies each reply — actor≠verifier is
// intact turn to turn). This module supplies the two pieces that makes that possible
// without any agent re-implementing a REPL:
//
//   - TurnIO — the input/output seam. NullIO (the non-interactive default: no turns,
//     so single-shot behavior is byte-for-byte unchanged), StdinIO (production: a
//     real terminal REPL, lazily attached so a single-shot run never touches stdin),
//     and ScriptedIO (tests: a fixed list of turns, so the loop is hermetic).
//   - converse() — the governed turn-loop. It reads a turn, runs ONE ctx.hive.run
//     for it (governed), threads the running transcript into the NEXT turn's task,
//     prints the reply, and loops until exit/EOF. History lives in the transcript it
//     returns; each turn is a fresh governed pass, so actor≠verifier holds per turn.
//
// The loop mechanics live here (a runtime concern); the per-turn task SHAPING lives
// in the agent (its behavior), which passes a buildTask closure. Single-shot modes
// never call ctx.io, so they are unaffected.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import type { AgentContext } from "./context.ts";
import type { GovernedResult } from "./engine.ts";
import { createInterface, type Interface } from "node:readline";

/** TurnIO is the conversational input/output seam. `interactive` lets an agent tell
 *  a REPL run from a single-shot one; `ask` reads one user turn (null = EOF/exit);
 *  `say` emits one agent reply. */
export interface TurnIO {
  readonly interactive: boolean;
  ask(label: string): Promise<string | null>;
  say(text: string): void;
}

/** NullIO is the non-interactive default: it yields NO turns and swallows output, so
 *  an agent's conversational mode invoked outside a terminal is a clean zero-turn
 *  no-op and single-shot modes (which never call ctx.io) are byte-for-byte unchanged. */
export class NullIO implements TurnIO {
  readonly interactive = false;
  async ask(): Promise<string | null> {
    return null;
  }
  say(): void {}
}

/** ScriptedIO is the hermetic test double: it replays a fixed list of turns (a null
 *  entry, or running off the end, ends the conversation) and captures everything the
 *  agent `say`s for assertions. */
export class ScriptedIO implements TurnIO {
  readonly interactive = true;
  readonly said: string[] = [];
  private i = 0;

  constructor(private readonly turns: (string | null)[]) {}

  async ask(): Promise<string | null> {
    return this.i < this.turns.length ? this.turns[this.i++] : null;
  }
  say(text: string): void {
    this.said.push(text);
  }
}

/** StdinIO is the production terminal REPL. The readline interface is created LAZILY
 *  on the first `ask`, so a single-shot run (which never asks) never attaches to
 *  stdin — preserving the non-interactive path exactly. Prompts go to stderr (stdout
 *  stays clean for piped/--json consumers); replies go to stdout. */
export class StdinIO implements TurnIO {
  readonly interactive = true;
  private rl?: Interface;
  private closed = false;

  private ensure(): Interface {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stderr });
      this.rl.on("close", () => {
        this.closed = true;
      });
    }
    return this.rl;
  }

  ask(label: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const rl = this.ensure();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      rl.question(`${label}> `, (answer) => done(answer));
      rl.once("close", () => done(null));
    });
  }

  say(text: string): void {
    process.stdout.write(text + "\n");
  }

  close(): void {
    this.rl?.close();
    this.closed = true;
  }
}

/** One entry in a conversation transcript. `verifier` records the distinct verifier
 *  that certified an agent turn (actor≠verifier proof, per turn). */
export interface Turn {
  role: "user" | "agent";
  text: string;
  verifier?: string;
}

/** The outcome of a governed conversation: how many turns ran, the full transcript
 *  (the maintained history), and the per-turn verifiers. `governed` is true because
 *  every turn flowed through ctx.hive.run, which asserts actor≠verifier. */
export interface ConversationResult {
  turns: number;
  transcript: Turn[];
  verifiers: string[];
  governed: boolean;
}

/** Options for a governed conversation. `buildTask` is the agent's per-turn task
 *  shaper: given the prior history and the new user text, it returns the task for
 *  THIS turn (this is where the agent threads the conversation history into the
 *  governed pass). Everything else has a sensible default. */
export interface ConverseOptions {
  /** Prompt label shown before each user turn (default the agent name). */
  label?: string;
  /** Printed once at the start of an interactive session. */
  greeting?: string;
  /** Printed once at the end of an interactive session that ran ≥1 turn. */
  goodbye?: string;
  /** Hard cap on turns (default 50) — a runaway guard, never normally hit. */
  maxTurns?: number;
  /** Recognizes an exit command (default /exit, /quit, exit, quit, /q, bye). */
  isExit?: (text: string) => boolean;
  /** Shape THIS turn's governed task from the prior history + the new user text. */
  buildTask: (history: Turn[], user: string) => string;
  /** Optional per-turn hook (e.g. journal the exchange), given the governed result. */
  onTurn?: (user: string, result: GovernedResult, transcript: Turn[]) => void | Promise<void>;
}

const DEFAULT_EXIT = /^\s*\/?(exit|quit|q|bye)\s*$/i;

/** converse runs a GOVERNED conversational turn-loop. Each turn: read a user turn,
 *  build its task from the running transcript (history threading), run ONE governed
 *  ctx.hive.run (a distinct verifier certifies — actor≠verifier per turn), record +
 *  print the reply, and loop until exit/EOF. It maintains the conversation history in
 *  the transcript it returns; the agent never re-implements the loop and never loses
 *  governance between turns. */
export async function converse(ctx: AgentContext, opts: ConverseOptions): Promise<ConversationResult> {
  const label = opts.label ?? ctx.manifest.name;
  const isExit = opts.isExit ?? ((t: string) => DEFAULT_EXIT.test(t));
  const maxTurns = opts.maxTurns ?? 50;

  const transcript: Turn[] = [];
  const verifiers: string[] = [];

  if (opts.greeting && ctx.io.interactive) ctx.io.say(opts.greeting);

  let turns = 0;
  while (turns < maxTurns) {
    const raw = await ctx.io.ask(label);
    if (raw === null) break; // EOF / no more scripted turns
    const user = raw.trim();
    if (user === "") continue;
    if (isExit(user)) break;

    // History threading: the task for THIS turn is shaped from the transcript BEFORE
    // this turn's user message is appended, plus the new user text.
    const priorHistory = transcript.slice();
    transcript.push({ role: "user", text: user });

    // GOVERNED per turn: one full hive pass, actor≠verifier asserted by ctx.hive.run.
    const result = await ctx.hive.run(opts.buildTask(priorHistory, user));
    verifiers.push(result.verifierActor);
    transcript.push({ role: "agent", text: result.answer, verifier: result.verifierActor });

    if (ctx.io.interactive) ctx.io.say(result.answer);
    await opts.onTurn?.(user, result, transcript);
    turns++;
  }

  if (opts.goodbye && ctx.io.interactive && turns > 0) ctx.io.say(opts.goodbye);
  return { turns, transcript, verifiers, governed: true };
}
