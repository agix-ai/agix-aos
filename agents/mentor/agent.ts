// Agix Mentor — the strategic conductor (queen caste), reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=conductor,
// model tiering opus/haiku/sonnet, the guard-bee boundary, public=true) lives in
// the sibling agent.json, which the Go engine reads. Every unit of strategic
// reasoning here is delegated to the GOVERNED hive (ctx.hive.run → the Go swarm:
// queen decompose → workers forage → synthesize → DISTINCT verifier), so Mentor's
// synthesis is certified, not a raw model call. Durable strategic memory is kept
// in the Comb (ctx.comb).
//
// Faithful reduction of agents/mentor/agent.mjs. The single-shot modes (goals,
// brief, plan) run one governed pass each; the doc-review mode (review) reads a doc
// and runs one governed alignment pass; and the CONVERSATIONAL modes (chat, session)
// now run over the reborn interactive turn-loop seam (fleet/runtime/session.ts):
// each turn is its own governed hive pass (a distinct verifier certifies — actor≠
// verifier per turn), and the conversation history is threaded into every turn. All
// five modes are ported; nothing is deferred.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, converse, type AgentContext, type AgentResult, type Turn } from "../../fleet/runtime/sdk.ts";
import type { GovernedResult } from "../../fleet/runtime/sdk.ts";

// The whitelist of agents Mentor may fire from plan/brief (ported from the Node
// manifest's defaults.fire_allowlist — this is behavior policy, so it lives here).
const FIRE_ALLOWLIST = ["research", "secretary"];

const JOURNAL_DIR = "wiki/mentor-journal";

function yearMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const mode = ctx.input.mode;

  // Smoke short-circuit: exercise the governed surface once (one $0 governed
  // pass), no journal write, no delegation. Mirrors the Node smoke contract
  // ("exercise the surfaces", not "preview the help").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the strategic reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, mode: mode ?? null, verifier: r.verifierActor };
  }

  if (!mode) {
    ctx.log("modes: goals | brief | plan <topic> | chat | session [name] | review --file <path>");
    return { ok: true, mode: null, help: true };
  }

  switch (mode) {
    case "goals":
      return goalsMode(ctx);
    case "brief":
      return briefMode(ctx);
    case "plan":
      return planMode(ctx);
    case "chat":
      return chatMode(ctx);
    case "session":
      return sessionMode(ctx);
    case "review":
      return reviewMode(ctx);
    default:
      ctx.log(`unknown mode: ${mode}`);
      return { ok: false, mode, unknown: true };
  }
});

// ── goals: synthesize the Goal Tree from the North Star, grounded in Comb ──────
async function goalsMode(ctx: AgentContext): Promise<AgentResult> {
  const priors = await ctx.comb.retrieve("north star goal tree mission", 5).catch(() => []);
  const context = priors.length
    ? `\n\nPrior ratified north-star notes:\n${priors.map((p) => `- ${p.content}`).join("\n")}`
    : "";

  const r = await ctx.hive.run(
    `Synthesize the operator's Goal Tree from the canonical North Star. Return the trunk (the mission), ` +
      `the active branches, and where current execution diverges. Cite specifics.${context}`,
  );

  // Feed the hive: record the synthesis as a Comb leaf, attested by the run's
  // DISTINCT verifier (actor≠verifier), so tomorrow's pass stands on today's.
  await journal(ctx, "goals", r.answer, r.queenActor, r.verifierActor);

  return {
    ok: r.verified,
    mode: "goals",
    verifier: r.verifierActor,
    priorsUsed: priors.length,
    answer: r.answer,
    costUSD: r.cost.usd,
  };
}

// ── brief: the daily strategic briefing, grounded in recent repo activity ──────
async function briefMode(ctx: AgentContext): Promise<AgentResult> {
  const handoff = (await ctx.readRepoFile("docs/reborn/HANDOFF-2026-07-07-reborn-and-oss-release.md")) ?? "";
  const recent = handoff.slice(0, 4000);
  const r = await ctx.hive.run(
    `Produce today's strategic briefing. Re-ground execution against the North Star: what advanced, ` +
      `what drifted, and the single most reversible next move. Ground it in this recent state:\n\n${recent}`,
  );
  const path = await journal(ctx, "brief", r.answer, r.queenActor, r.verifierActor);
  return { ok: r.verified, mode: "brief", verifier: r.verifierActor, journal: path, costUSD: r.cost.usd };
}

// ── plan: reason about a topic; fire a whitelisted agent when it's the move ────
async function planMode(ctx: AgentContext): Promise<AgentResult> {
  const topic = ctx.input.text.trim() || "the current top priority";
  const r = await ctx.hive.run(
    `Plan: ${topic}. Give the smallest reversible version, the trade-off that competes with it, ` +
      `and 2-3 candidate directions with a one-line brief each. Recommend one. Never leave a bare question.`,
  );

  // Delegation (the `fire` capability): if the operator asked to research the
  // topic, and research is on the allowlist, fire it as a governed sub-run.
  let fired: string | undefined;
  const wantsResearch = /research|scan|survey|landscape|competitive/i.test(topic);
  if (wantsResearch && FIRE_ALLOWLIST.includes("research")) {
    ctx.log(`firing research (allowlisted) to ground the plan`, { topic });
    const sub = await ctx.fire("research", `Scan the field for: ${topic}. Return the 3 most decision-relevant findings.`);
    fired = sub.verifierActor;
  }

  await journal(ctx, "plan", r.answer, r.queenActor, r.verifierActor);
  return { ok: r.verified, mode: "plan", topic, verifier: r.verifierActor, fired: fired ?? null, costUSD: r.cost.usd };
}

// ── chat: interactive strategic check-in (governed per turn) ───────────────────
// The Node chatMode's rl.question REPL, reborn on the interactive turn-loop seam.
// Each turn is ONE governed hive pass (a distinct verifier certifies — actor≠verifier
// holds turn to turn), and the conversation history is threaded into every turn's
// task, so the mentor reasons with full context without re-implementing a REPL. A
// non-interactive invocation (no TTY, no scripted turns) is a clean zero-turn no-op.
async function chatMode(ctx: AgentContext): Promise<AgentResult> {
  const seed = await strategicSeed(ctx);
  let last: GovernedResult | undefined;

  const conv = await converse(ctx, {
    label: "you",
    greeting: "Mentor · strategic check-in. Ask your question; /exit to end.",
    goodbye: "Logged. Back to the work.",
    buildTask: (history, user) => buildConversationTask("check-in", seed, history, user),
    onTurn: (_u, r) => {
      last = r;
    },
  });

  // Journal the session (bounded write + attested leaf), mirroring the Node
  // chat-summary. Attribution comes from the last governed turn (actor≠verifier).
  if (conv.turns > 0 && last) {
    const summary =
      `chat · ${conv.turns} turn(s):\n` +
      conv.transcript.map((t) => `${t.role === "user" ? "Q" : "A"}: ${t.text.slice(0, 200)}`).join("\n");
    await journal(ctx, "chat", summary, last.queenActor, last.verifierActor);
  } else if (!ctx.io.interactive) {
    ctx.log("chat is interactive — run it on a terminal: bun fleet/runtime/cli.ts run mentor chat");
  }

  return {
    ok: true,
    mode: "chat",
    turns: conv.turns,
    verifier: last?.verifierActor ?? null,
    governed: conv.governed,
    interactive: ctx.io.interactive,
  };
}

// ── session: a governed working session tracked as a conversation ──────────────
// The Node sessionMode was a start/end/status tracker; the reborn session is a
// governed working session over the same turn-loop, framed around a session name
// (positional arg) and re-grounded against the North Star each turn. History is
// maintained across turns; each turn is governed. (The out-of-repo session-cache
// tracker state is reduced to the attested Comb summary + the journal, matching the
// secretary/investigator state reductions.)
async function sessionMode(ctx: AgentContext): Promise<AgentResult> {
  const name = ctx.input.args.filter((a) => a !== "start" && a !== "end" && a !== "status").join(" ").trim() || "working session";
  const seed = await strategicSeed(ctx);
  let last: GovernedResult | undefined;

  const conv = await converse(ctx, {
    label: `session:${name}`,
    greeting: `Mentor · session "${name}". Work out loud; /exit to close and journal it.`,
    goodbye: `Session "${name}" closed and journaled.`,
    buildTask: (history, user) => buildConversationTask(`session "${name}"`, seed, history, user),
    onTurn: (_u, r) => {
      last = r;
    },
  });

  if (conv.turns > 0 && last) {
    const summary =
      `session "${name}" · ${conv.turns} turn(s):\n` +
      conv.transcript.map((t) => `${t.role === "user" ? "Q" : "A"}: ${t.text.slice(0, 200)}`).join("\n");
    await journal(ctx, "session", summary, last.queenActor, last.verifierActor);
  } else if (!ctx.io.interactive) {
    ctx.log(`session is interactive — run it on a terminal: bun fleet/runtime/cli.ts run mentor session ${name}`);
  }

  return {
    ok: true,
    mode: "session",
    session: name,
    turns: conv.turns,
    verifier: last?.verifierActor ?? null,
    governed: conv.governed,
    interactive: ctx.io.interactive,
  };
}

// ── review: one-shot strategic-alignment review of a doc/spec ──────────────────
// Node reviewMode reduced to a single governed pass over a bounded-read doc. No
// editor seam is needed — the mentor reads the doc and returns an alignment review;
// the result is journaled (bounded write + attested leaf), exactly like brief/goals.
async function reviewMode(ctx: AgentContext): Promise<AgentResult> {
  const file =
    (typeof ctx.input.flags.file === "string" && (ctx.input.flags.file as string)) || ctx.input.args[0] || ctx.input.text.trim();
  if (!file) {
    ctx.log("review needs a doc: --file <path> (or pass a path)");
    return { ok: false, mode: "review", reason: "no-file" };
  }
  const doc = await ctx.readRepoFile(file);
  if (doc === null) {
    ctx.log(`review: cannot read ${file} (outside the read boundary or absent)`);
    return { ok: false, mode: "review", reason: "not-found", file };
  }
  const section = typeof ctx.input.flags.section === "string" ? (ctx.input.flags.section as string) : "";
  const r = await ctx.hive.run(
    `Strategic-alignment review of ${file}${section ? ` (focus: ${section})` : ""}. Assess: alignment with the ` +
      `North Star, sequencing concerns, scope drift, and the single most reversible improvement. Cite specifics; ` +
      `name the competing trade-off; never leave a bare question.\n\nDOCUMENT:\n${doc.slice(0, 8000)}`,
  );
  await journal(ctx, "review", r.answer, r.queenActor, r.verifierActor);
  return { ok: r.verified, mode: "review", file, verifier: r.verifierActor, costUSD: r.cost.usd };
}

// strategicSeed retrieves the North Star priors that ground turn 1 of a conversation
// (the reborn analogue of the Node buildSystemPrompt's Goal Tree context).
async function strategicSeed(ctx: AgentContext): Promise<string> {
  const priors = await ctx.comb.retrieve("north star goal tree mission", 3).catch(() => []);
  return priors.length ? priors.map((p) => `- ${p.content}`).join("\n") : "(no ratified north-star priors yet)";
}

// buildConversationTask threads the running transcript into each turn's governed
// task, so the mentor answers with full conversation context. This is where history
// is maintained across turns (the seam keeps the transcript; the agent shapes it).
function buildConversationTask(frame: string, seed: string, history: Turn[], user: string): string {
  const convo = history.length
    ? history.map((t) => `${t.role === "user" ? "Operator" : "Mentor"}: ${t.text}`).join("\n")
    : "(start of conversation)";
  return (
    `Continue this strategic ${frame} as the Mentor. Re-ground against the North Star; cite specifics; ` +
    `name the competing trade-off; never leave a bare question.\n\n` +
    `[NORTH STAR PRIORS]\n${seed}\n\n[CONVERSATION SO FAR]\n${convo}\n\n[OPERATOR]\n${user}`
  );
}

// journal writes the synthesis to the mentor journal file (bounded by the
// manifest's boundary.write) AND records it as an attested Comb leaf — the two
// output surfaces the Node mentor kept (a human-readable log + durable memory).
async function journal(
  ctx: AgentContext,
  kind: string,
  body: string,
  author: string,
  verifier: string,
): Promise<string> {
  const rel = `${JOURNAL_DIR}/${yearMonth()}.md`;
  const existing = (await ctx.readRepoFile(rel)) ?? `# Mentor journal ${yearMonth()}\n`;
  const entry = `\n## ${isoDate()} · ${kind}\n\n${body.trim()}\n`;
  try {
    await ctx.writeRepoFile(rel, existing + entry);
  } catch (e) {
    ctx.log(`journal write skipped: ${(e as Error).message}`);
  }
  await ctx.comb
    .put({
      content: `mentor/${kind} ${isoDate()}: ${body.slice(0, 500)}`,
      branch: "business", // TOGAF Business Architecture — strategy lives here
      author,
      verifier,
      trust: 0.8,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
  return rel;
}
