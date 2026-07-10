// Minimal public reference agent — one governed pass, used by the runner tests.
import { defineAgent, type AgentContext, type AgentResult } from "../../../runtime/sdk.ts";

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const r = await ctx.hive.run(ctx.input.text || "probe: confirm the governed surface");
  return { ok: r.verified, verifier: r.verifierActor, queen: r.queenActor, answer: r.answer };
});
