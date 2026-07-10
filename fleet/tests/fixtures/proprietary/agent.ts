// A proprietary reference agent — behavior is irrelevant; the public-only runner
// must refuse it before this ever runs (the genericization seam).
import { defineAgent, type AgentContext, type AgentResult } from "../../../runtime/sdk.ts";

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const r = await ctx.hive.run("proprietary work");
  return { ok: r.verified };
});
