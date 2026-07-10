// The public authoring surface — everything an agent.ts imports. Keep this the
// ONLY module a bee author needs to know: it re-exports the contract types and
// the defineAgent helper. The runner, engine drivers, and Comb clients are
// wiring the runtime owns, not the author.
//
//   import { defineAgent, type AgentContext } from "../../fleet/runtime/sdk.ts";
//   export default defineAgent(async (ctx) => { … });
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import type { AgentContext, AgentInput, AgentResult } from "./context.ts";

export type { AgentContext, AgentInput, AgentResult } from "./context.ts";
export type { Hive } from "./context.ts";
export type {
  GovernedResult,
  Verdict,
  GovernedCost,
  HiveRunOptions,
} from "./engine.ts";
export type { Comb, CombNote, CombLeaf, CombPutResult, CombStats, Provenance } from "./comb.ts";
export type { Manifest, ModelTiers, Boundary, Trust, Caste } from "./manifest.ts";
export { resolveCaste } from "./manifest.ts";

// The delivery seam (ctx.sendEmail / ctx.notify).
export type { Notifier, EmailMessage, NotifyMessage, DeliveryResult } from "./notify.ts";

// The interactive turn-loop seam. `converse` is the ONE helper a conversational
// agent mode calls to run a governed, history-maintaining REPL over ctx.io + ctx.hive.
export { converse } from "./session.ts";
export type { TurnIO, Turn, ConversationResult, ConverseOptions } from "./session.ts";

/** The entrypoint an agent.ts default-exports: given a wired context, do the
 *  work and return a result. */
export type AgentEntry = (ctx: AgentContext) => Promise<AgentResult>;

/** defineAgent is an identity helper that pins the entrypoint's type so an author
 *  gets full inference on `ctx` and a compile error if the signature drifts. It
 *  is where future authoring metadata (declared modes, examples) can hang without
 *  changing the call shape. */
export function defineAgent(entry: AgentEntry): AgentEntry {
  return entry;
}

export type { AgentContext as Context };
export type { AgentInput as Input };
export type { AgentResult as Result };
