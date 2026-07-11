// Agix Director — the credential-governed boundary agent, reborn on Bun.
//
// This is the BEHAVIOR layer. Identity, trust=boundary (caste=drone), model
// tiering (queen/worker=sonnet, verifier=haiku), the guard-bee boundary (writes
// only wiki/director/, denies git push/commit/merge + gh pr merge), and
// public=true live in the sibling agent.json. The Director's core intelligence —
// classifying the operator's reply into per-item intents, and drafting the
// artifacts each safe verb produces — runs as GOVERNED hive passes: a DISTINCT
// verifier certifies every classification and every draft (actor≠verifier), which
// is exactly Director's posture — its output is a proposal a distinct grader
// vouched for, never a rubber-stamped self-call. Durable directive memory (the
// classification + each drafted artifact) is attested into the Comb.
//
// The HARD RULE is preserved and now STRUCTURALLY enforced: the reborn Director
// writes only under its own subtree (wiki/director/) and the manifest boundary
// denies git push/commit/merge. It cannot auto-merge — the merge is the human's
// button click.
//
// ── NOT PORTED (faithful reduction — flagged in notPorted[] too) ─────────────
// The governed CLASSIFY + DRAFT core is ported. These legacy modes lean on
// capabilities the reborn contract does not (yet) express and are honestly
// deferred:
//   1. Gmail reply ingestion — getWorkspaceAuth (DWD SA) + googleapis +
//      fetchBriefingReplies + the incremental cursor scan. The contract has no
//      Workspace/Gmail seam. The reborn Director takes the operator reply as
//      --text and loads the brief from the repo (or classifies from the reply
//      alone), instead of autonomously polling the inbox 4x/day.
//   2. Email DELIVERY — runtime.sendEmail (the ack email, the EXPAND email, the
//      deploy-alert email). There is no ctx.sendEmail. EXPAND still DRAFTS and
//      persists the deeper-context note; it just cannot send it.
//   3. Deploy-health check (CI + the hosting platform via git/gh/cloud secret CLI) + the STV
//      telemetry capture — a non-governed side-channel needing shell/network.
//   4. Git custodian (reaps merged claude/cursor/director branches) — non-governed
//      git side-channel.
//   5. Foundational-push detector (auto-opens PRs via gh/MCP) — non-governed
//      side-channel; and opening PRs is beyond the reborn write boundary.
//   6. APPROVE code-drafting → draft branch + commit + push (the lib/agix-git
//      pipeline, Opus pr_model). APPROVE ports the SPEC draft only; drafting code
//      onto a pushed branch has no seam and the boundary forbids the push anyway.
//   7. FIX Curator-review auto-lookup (glob wiki/curator/reviews + extract the
//      finding block). Reduced: the finding context is taken from the brief/reply
//      passed in, not an autonomous review-directory scan.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

// ── Ported output guardrail (pure, dependency-free — from lib/classify.mjs) ────
// This is load-bearing policy: it is Director's hard "never invent IDs" rule
// enforced on OUTPUT, independent of what the classifier returned. Ported
// verbatim so the reborn Director keeps the same guarantee.
const SUPPORTED_VERBS = new Set(["approve", "dive", "defer", "skip", "expand", "fix"]);

interface Intent {
  item_id: string;
  verb: string;
  scope_hints: string;
  raw_reply_excerpt: string;
}

function extractItemIds(markdown: string): string[] {
  if (!markdown) return [];
  const re = /\b(\d{4}-\d{2}-\d{2}\.[A-Z]\d+)\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) out.add(m[1]);
  return [...out];
}

function filterValidIntents(intents: unknown[], briefMarkdown: string): Intent[] {
  const validIds = new Set(extractItemIds(briefMarkdown));
  const out: Intent[] = [];
  for (const raw of intents) {
    if (!raw || typeof raw !== "object") continue;
    const intent = raw as Record<string, unknown>;
    const verb = String(intent.verb ?? "").toLowerCase();
    if (!SUPPORTED_VERBS.has(verb)) continue;
    if (!intent.item_id || typeof intent.item_id !== "string") continue;
    // No brief on disk (e.g. a Secretary digest) → accept any well-formed ID.
    // Brief present → only IDs that actually appear in it. Never invent IDs.
    const wellFormed = /^\d{4}-\d{2}-\d{2}\.[A-Z]\d+$/.test(intent.item_id);
    if (!wellFormed) continue;
    if (validIds.size > 0 && !validIds.has(intent.item_id)) continue;
    out.push({
      item_id: intent.item_id,
      verb,
      scope_hints: typeof intent.scope_hints === "string" ? intent.scope_hints : "",
      raw_reply_excerpt: typeof intent.raw_reply_excerpt === "string" ? intent.raw_reply_excerpt : "",
    });
  }
  return out;
}

// Parse the classifier's governed answer into intents (mirrors classifyReply's
// tolerant JSON extraction: pull the first {...} block, parse, default safely).
function parseClassification(answer: string): { intents: unknown[]; unresolved: string[] } {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return { intents: [], unresolved: ["classifier returned no JSON"] };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : [],
    };
  } catch {
    return { intents: [], unresolved: ["classifier returned malformed JSON"] };
  }
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return (
    (s || "item")
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item"
  );
}

// Source-agent detection from a subject/brief-path hint (reduced from the Node
// AGENT_SUBJECT_PATTERNS). Used only to tag queue/log items with their origin.
function detectSourceAgent(hint: string): string {
  if (/curator/i.test(hint)) return "curator";
  if (/mentor/i.test(hint)) return "mentor";
  if (/secretary/i.test(hint)) return "secretary";
  if (/research/i.test(hint)) return "research";
  return "agent";
}

interface Brief {
  markdown: string;
  agent: string;
  date: string | null;
  path: string | null;
}

// Load the brief the reply is answering. Explicit --brief path wins; else probe
// the recent research briefs (the boundary posture gives a worker no directory
// glob, so we probe conventional names, like the investigator does); else empty
// (classify from the reply alone — the guardrail then accepts any well-formed ID).
async function loadBrief(ctx: AgentContext): Promise<Brief> {
  const f = ctx.input.flags ?? {};
  const explicit = typeof f.brief === "string" ? (f.brief as string) : "";
  const source = typeof f.source === "string" ? (f.source as string) : "";

  if (explicit) {
    const md = await ctx.readRepoFile(explicit);
    if (md) {
      const dm = explicit.match(/(\d{4}-\d{2}-\d{2})/);
      return { markdown: md, agent: source || detectSourceAgent(explicit), date: dm ? dm[1] : null, path: explicit };
    }
    ctx.log(`--brief ${explicit} not found; classifying from the reply alone`);
  }

  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const rel = `wiki/research/${isoDate(d)}-brief.md`;
    const md = await ctx.readRepoFile(rel);
    if (md) {
      ctx.log(`no --brief; using recent research brief`, { brief: rel });
      return { markdown: md, agent: source || "research", date: isoDate(d), path: rel };
    }
  }
  return { markdown: "", agent: source || "agent", date: null, path: null };
}

interface Executed {
  verb: string;
  item_id: string;
  status: string;
  artifact: string | null;
  note: string;
  verifier: string | null;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0), no draft, no
  // delegation, no file write. Mirrors the Node smoke contract (which exercised
  // auth + model + the classifier prompt; the reborn surface is the governed hive).
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the reply-classification surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const reply = ctx.input.text.trim();
  if (!reply) {
    ctx.log("no operator reply (pass the reply text as --text; optionally --brief <path>)");
    return { ok: false, reason: "no-reply" };
  }

  const date = typeof ctx.input.flags?.date === "string" ? (ctx.input.flags.date as string) : isoDate();
  const brief = await loadBrief(ctx);

  // ── 1. ONE governed classify pass → per-item intents (JSON) ───────────────
  const classifyTask =
    `CLASSIFY the operator's reply against the brief. Emit STRICT JSON only ` +
    `({"intents":[{"item_id","verb","scope_hints","raw_reply_excerpt"}],"unresolved":[...]}). ` +
    `Only emit intents for item IDs that appear in the brief; never invent IDs; ` +
    `add an unresolved entry on ambiguity instead of guessing.\n\n` +
    `BRIEF:\n${brief.markdown || "(no brief on disk — classify from the reply alone)"}\n\n` +
    `OPERATOR REPLY (quoted prior message stripped):\n${reply}`;

  const cr = await ctx.hive.run(classifyTask);
  const { intents, unresolved } = parseClassification(cr.answer);
  const valid = filterValidIntents(intents, brief.markdown);
  ctx.log(`classified ${valid.length} intent(s)`, { unresolved: unresolved.length, source: brief.agent });

  // Feed the hive: record the classification itself as an attested leaf, so the
  // directive trail stands even when every verb is a pure-state defer/skip.
  await ctx.comb
    .put({
      content: `director/classify ${date} (${brief.agent}): ${valid.length} intent(s) [${valid
        .map((v) => `${v.verb}:${v.item_id}`)
        .join(", ")}] — ${cr.answer.slice(0, 300)}`,
      branch: "business", // TOGAF Business Architecture — operator directives
      author: cr.queenActor,
      verifier: cr.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put (classify) skipped: ${(e as Error).message}`));

  // ── 2. Dispatch each valid intent to its safe verb ────────────────────────
  const executed: Executed[] = [];
  for (const intent of valid) {
    try {
      executed.push(await dispatch(ctx, intent, brief, date));
    } catch (e) {
      ctx.log(`${intent.verb} ${intent.item_id} failed: ${(e as Error).message}`);
      executed.push({ verb: intent.verb, item_id: intent.item_id, status: "failed", artifact: null, note: (e as Error).message, verifier: null });
    }
  }
  for (const u of unresolved) {
    executed.push({ verb: "unresolved", item_id: "", status: "unresolved", artifact: null, note: u, verifier: null });
  }

  // ── 3. Write the actions log (bounded by boundary.write = wiki/director/) ──
  const actionsRel = `wiki/director/${date}-actions.md`;
  try {
    await ctx.writeRepoFile(actionsRel, buildActionsLog(executed, date, brief));
  } catch (e) {
    ctx.log(`actions log write skipped: ${(e as Error).message}`);
  }

  return {
    ok: cr.verified,
    verifier: cr.verifierActor,
    queen: cr.queenActor,
    source_agent: brief.agent,
    intents: valid.length,
    unresolved: unresolved.length,
    executed,
    actionsLog: actionsRel,
    costUSD: cr.cost.usd,
  };
});

// ── Verb dispatch ──────────────────────────────────────────────────────────
async function dispatch(ctx: AgentContext, intent: Intent, brief: Brief, date: string): Promise<Executed> {
  const { verb, item_id, scope_hints } = intent;
  const excerpt = intent.raw_reply_excerpt || "";

  switch (verb) {
    // Pure-state verbs — no governed pass; the actions log is the artifact.
    case "defer":
      return { verb, item_id, status: "deferred", artifact: null, note: scope_hints ? `deferred (${scope_hints})` : "deferred 7d", verifier: null };
    case "skip":
      return { verb, item_id, status: "dismissed", artifact: null, note: scope_hints ? `dismissed (${scope_hints})` : "dismissed", verifier: null };

    // EXPAND — governed draft of deeper context (email delivery NOT ported).
    case "expand": {
      const r = await ctx.hive.run(
        `Draft a deeper-context follow-up for item ${item_id}. In under ~250 words of prose: what it is, ` +
          `why it matters now, and 2-3 concrete sources or next steps. Ground it in the operator's hints and the brief.\n\n` +
          `SCOPE HINTS: ${scope_hints || "(none)"}\n\nBRIEF:\n${brief.markdown || "(none on disk)"}`,
      );
      const rel = `wiki/director/expansions/${date}-${item_id}.md`;
      await writeDoc(ctx, rel, `# Expand · ${item_id} · ${date}\n\n- source: ${brief.agent}\n- verifier: ${r.verifierActor} (actor≠verifier)\n\n${r.answer}\n`);
      await attest(ctx, `director/expand ${item_id}: ${r.answer.slice(0, 300)}`, "business", r.queenActor, r.verifierActor, 0.7);
      return { verb, item_id, status: "drafted", artifact: rel, note: "expansion drafted (email delivery not ported)", verifier: r.verifierActor };
    }

    // APPROVE — governed draft of an implementation SPEC (code-drafting + draft
    // branch push NOT ported; the boundary forbids the push).
    case "approve": {
      const r = await ctx.hive.run(
        `Draft an implementation spec for approved item ${item_id}. Sections: ## Goal, ## Approach, ` +
          `## Files likely to change, ## How to verify, ## Rollback. Be concrete and name files. ` +
          `Do NOT write code — a spec only.\n\nSCOPE HINTS: ${scope_hints || "(none)"}\n\nBRIEF:\n${brief.markdown || "(none on disk)"}`,
      );
      const slug = slugify(scope_hints || item_id);
      const rel = `wiki/director/specs/${date}-${slug}.md`;
      await writeDoc(ctx, rel, r.answer.endsWith("\n") ? r.answer : r.answer + "\n");
      await attest(ctx, `director/spec ${item_id} (${slug}): ${r.answer.slice(0, 300)}`, "software", r.queenActor, r.verifierActor, 0.75);
      return { verb, item_id, status: "in-progress", artifact: rel, note: "spec drafted (code-drafting + draft-branch not ported)", verifier: r.verifierActor };
    }

    // FIX — governed draft of a fix-spec for an approved Curator finding
    // (Curator-review auto-lookup reduced: context comes from the reply/brief).
    case "fix": {
      const r = await ctx.hive.run(
        `Draft a fix-spec for approved Curator finding ${item_id}. Sections: ## Finding, ## Why it matters, ` +
          `## Proposed fix, ## Files likely to change, ## How to verify. Concrete; name files and rule IDs.\n\n` +
          `FINDING CONTEXT:\n${excerpt || brief.markdown || "(finding context not on disk)"}`,
      );
      const date10 = item_id.slice(0, 10) || date;
      const idTail = item_id.slice(11) || item_id;
      const rel = `wiki/director/fixes/${date10}-${idTail}-${slugify(scope_hints || idTail)}.md`;
      await writeDoc(
        ctx,
        rel,
        `---\ndate: ${date10}\nfinding_id: ${item_id}\nverb: fix\nstatus: spec-drafted\nverifier: ${r.verifierActor}\n---\n\n${r.answer}\n`,
      );
      await attest(ctx, `director/fix ${item_id}: ${r.answer.slice(0, 300)}`, "software", r.queenActor, r.verifierActor, 0.7);
      return { verb, item_id, status: "in-progress", artifact: rel, note: `fix spec drafted from Curator finding ${item_id}`, verifier: r.verifierActor };
    }

    // DIVE — delegate a focused research run (the `fire` capability). Research
    // writes its own sub-brief; Director records the fired verifier.
    case "dive": {
      const title = scope_hints || `item ${item_id}`;
      const sub = await ctx.fire("research", `Run a focused research dive on: ${title}. Return the 3 most decision-relevant findings.`);
      await attest(ctx, `director/dive ${item_id}: delegated to research — ${title} — ${sub.answer.slice(0, 200)}`, "knowledge", sub.queenActor, sub.verifierActor, 0.7);
      return { verb, item_id, status: "in-progress", artifact: null, note: `dive delegated to research — ${title}`, verifier: sub.verifierActor };
    }

    default:
      return { verb, item_id, status: "unresolved", artifact: null, note: `unsupported verb ${verb}`, verifier: null };
  }
}

async function writeDoc(ctx: AgentContext, rel: string, body: string): Promise<void> {
  try {
    await ctx.writeRepoFile(rel, body);
  } catch (e) {
    ctx.log(`write skipped (${rel}): ${(e as Error).message}`);
  }
}

async function attest(ctx: AgentContext, content: string, branch: string, author: string, verifier: string, trust: number): Promise<void> {
  await ctx.comb.put({ content, branch, author, verifier, trust }).catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));
}

// Reduced actions log (grouped by outcome), mirroring the Node buildActionsLog.
function buildActionsLog(executed: Executed[], date: string, brief: Brief): string {
  const LABELS: Record<string, string> = {
    completed: "Completed",
    drafted: "Drafted",
    "in-progress": "In progress",
    deferred: "Deferred",
    dismissed: "Dismissed",
    failed: "Failed",
    unresolved: "Unresolved",
  };
  const lines: string[] = [];
  lines.push(`# Director — Actions ${date}`, "");
  lines.push(
    `> reborn: read + classify + execute safe verbs (defer, skip, expand, approve-spec, dive, fix). ` +
      `Governed classification + drafts (actor≠verifier). No merges to main, ever.`,
    "",
  );
  lines.push(`> Source brief: ${brief.path ?? "(none on disk — classified from the reply alone)"}`, "");

  if (executed.length === 0) {
    lines.push("_No actions this run._", "");
    return lines.join("\n");
  }

  const byOutcome = new Map<string, Executed[]>();
  for (const e of executed) {
    if (!byOutcome.has(e.status)) byOutcome.set(e.status, []);
    byOutcome.get(e.status)!.push(e);
  }
  for (const outcome of ["completed", "drafted", "in-progress", "deferred", "dismissed", "failed", "unresolved"]) {
    const list = byOutcome.get(outcome);
    if (!list || list.length === 0) continue;
    lines.push(`## ${LABELS[outcome] ?? outcome} (${list.length})`, "");
    for (const e of list) {
      const id = e.item_id ? `**${e.item_id}**` : "_(no ID)_";
      const artifact = e.artifact ? ` — \`${e.artifact}\`` : "";
      const verifier = e.verifier ? ` · verifier ${e.verifier}` : "";
      lines.push(`- \`${e.verb.toUpperCase()}\` ${id}${artifact} · ${e.note}${verifier}`);
    }
    lines.push("");
  }
  lines.push("---", "", "No merges to main — every draft is a proposal awaiting the operator's button click.");
  return lines.join("\n") + "\n";
}
