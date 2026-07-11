// Agix Secretary — the operator's personal inbox secretary, reborn on Bun.
//
// This is the BEHAVIOR layer. Identity, trust=boundary (caste=drone), model
// tiering (queen=sonnet for quality summaries + drafts, worker=haiku for cheap
// classification, verifier=haiku), the guard-bee boundary (writes only
// wiki/secretary/, denies git push/commit + gh pr merge + cloud secret CLI secrets), and
// public=true live in the sibling agent.json. The Secretary's core intelligence —
// triaging the inbox into per-thread classifications, summarizing what matters,
// and drafting replies in the operator's voice — runs as GOVERNED hive passes: a
// DISTINCT verifier certifies every classification, summary, and draft
// (actor≠verifier), so nothing is a rubber-stamped self-call. Durable memory (the
// triage, the digest, the run cursor) is attested into the Comb.
//
// The credential-governed boundary is preserved and now STRUCTURALLY enforced: the
// reborn Secretary writes only under wiki/secretary/ and the manifest boundary
// forbids the shell/git escalations. It now DELIVERS the digest through the governed
// notify seam (dry-run/queued by default — nothing actually sent offline; a live
// transport plugs in fail-closed), and it still never archives — that remains the
// human's surface with no reborn seam yet.
//
// PORTED via the reborn seams (previously deferred):
//   - Email DELIVERY — the digest is now handed to the governed notify seam
//     (ctx.sendEmail), the orchestration twin of the Go core/tool/email tool. It is
//     DRY-RUN by default (recorded + queued, nothing actually sent — the $0/offline
//     posture), and a credentialed live transport (SMTP/Gmail) plugs in fail-closed
//     as a deployment config. `sent` now reflects the delivery result (false under
//     dry-run); `queued` reports the digest was handed to the transport.
//   - Interactive ASK — an operator can converse with the Secretary about the inbox
//     over the reborn turn-loop seam (mode "ask"/"chat"): each turn is a governed
//     hive pass (actor≠verifier), history is threaded across turns.
//
// ── NOT PORTED (faithful reduction — mirrored in the port's notPorted[]) ─────────
// The governed CLASSIFY + SUMMARIZE + DRAFT core is ported. These legacy surfaces
// lean on capabilities the reborn contract does not (yet) express and are honestly
// deferred:
//   1. Gmail INGESTION — getWorkspaceAuth (domain-wide-delegation SA) + googleapis
//      + fetchThreadsSince + parseThread/extractTextBody + the incremental
//      -label:agix/secretary-seen scan. The contract has no Workspace/Gmail read
//      seam. The reborn Secretary takes the inbox snapshot as --text instead of
//      autonomously polling Gmail 2x/day.
//   2. Auto-ARCHIVE + labeling — gmail.users.threads.modify + ensureLabel (mutates
//      the live inbox: add agix/secretary-archived, remove INBOX). No Gmail write
//      seam. The reborn agent COUNTS the archivable newsletter/noise threads and
//      reports them; it never touches the inbox.
//   3. Per-CALL model ROUTING — legacy split classify=claude-haiku-4-5
//      (cheap-classification) vs summarize/draft=claude-sonnet-4-6 (default-quality)
//      per model.chat. The reborn tiering is per-AGENT (manifest models), not
//      per-call, so the split collapses into queen=sonnet / worker=haiku /
//      verifier=haiku and each classify/summarize/draft becomes a full governed pass.
//   4. JSONL run log to ~/.cache/agix-secretary/runs/ — an out-of-repo cache path
//      with no reborn seam. Reduced to the attested Comb leaves + the digest file.
//   5. Legacy CLI knobs --since / --max-threads / --archive — Gmail-scan controls
//      with nothing to control here. --dry-run's posture is the reborn default:
//      nothing is ever archived, and delivery is dry-run/queued.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, converse, type AgentContext, type AgentResult, type Turn } from "../../fleet/runtime/sdk.ts";

const DIGEST_DIR = "wiki/secretary/digests";
const CURSOR_ID = "secretary/cursor";

// The closed category + priority taxonomy (ported verbatim from the Node
// CLASSIFY_SYSTEM_PROMPT). This is Secretary's hard output guardrail: whatever the
// governed triage returns, an out-of-taxonomy category collapses to noise.
const THREAD_CATEGORIES = new Set(["client", "vendor", "newsletter", "personal", "agix-internal", "noise"]);
const PRIORITIES = new Set(["high", "normal", "low"]);

interface Thread {
  id: string;
  subject: string;
  from: string;
  category: string;
  requires_response: boolean;
  priority: string;
  reason: string;
}

interface Processed extends Thread {
  summary: string | null;
  draft: string | null;
}

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function slotOf(ctx: AgentContext): string {
  const f = ctx.input.flags ?? {};
  if (typeof f.slot === "string" && f.slot) return f.slot as string;
  return new Date().getHours() < 12 ? "morning" : "afternoon";
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Tolerant JSON extraction (mirrors the Node parseClassification): pull the first
// {...} block, parse, and read the threads array; default safely to empty.
function parseTriage(answer: string): unknown[] {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed.threads) ? parsed.threads : [];
  } catch {
    return [];
  }
}

// Coerce one raw triage entry to a well-formed Thread, enforcing the taxonomy on
// OUTPUT regardless of what the classifier returned (the Iron-Law-style guardrail).
function coerceThread(raw: unknown, i: number): Thread {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const category = THREAD_CATEGORIES.has(String(o.category)) ? String(o.category) : "noise";
  const priority = PRIORITIES.has(String(o.priority)) ? String(o.priority) : "normal";
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id : `t${i + 1}`,
    subject: typeof o.subject === "string" && o.subject.trim() ? o.subject : "(no subject)",
    from: typeof o.from === "string" ? o.from : "",
    category,
    requires_response: Boolean(o.requires_response),
    priority,
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}

// Cursor (state output). The Node agent kept a { last_run_at } cursor in state I/O;
// the reborn agent keeps it as a single stable, attested Comb leaf.
async function readCursor(ctx: AgentContext): Promise<string | null> {
  const hits = await ctx.comb.retrieve(CURSOR_ID, 1, false).catch(() => []);
  const m = hits[0]?.content.match(/last_run_at=(\S+)/);
  return m ? m[1] : null;
}

async function writeCursor(ctx: AgentContext, iso: string, author: string, verifier: string): Promise<void> {
  await ctx.comb
    .put({ id: CURSOR_ID, content: `${CURSOR_ID} last_run_at=${iso}`, branch: "business", author, verifier, trust: 0.7 })
    .catch((e) => ctx.log(`cursor write skipped: ${(e as Error).message}`));
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke short-circuit: exercise the governed surface once ($0) and touch the
  // cursor state path, no triage, no drafts, no file write. Mirrors the Node smoke
  // contract (which exercised the model surface + read the cursor); the reborn
  // model surface is the governed hive.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the inbox-triage surface is live");
    await readCursor(ctx);
    ctx.log("smoke short-circuit · governed surface + cursor verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor, sent: false, threadCount: 0 };
  }

  // Interactive ASK: converse about the inbox over the governed turn-loop seam.
  if (ctx.input.mode === "ask" || ctx.input.mode === "chat") {
    return askMode(ctx);
  }

  const inbox = ctx.input.text.trim();
  if (!inbox) {
    ctx.log("no inbox snapshot (pass the threads to triage as --text; Gmail ingestion is not ported)");
    return { ok: false, reason: "no-inbox" };
  }

  const date = typeof ctx.input.flags?.date === "string" ? (ctx.input.flags.date as string) : isoDate();
  const slot = slotOf(ctx);
  const since = await readCursor(ctx); // provenance only (the Gmail since-scan is not ported)

  // ── 1. ONE governed TRIAGE pass → per-thread classification (JSON) ──────────
  const triageTask =
    `TRIAGE the operator's inbox snapshot. Emit STRICT JSON only ` +
    `({"threads":[{"id","subject","from","category","requires_response","priority","reason"}]}). ` +
    `Category is exactly one of client|vendor|newsletter|personal|agix-internal|noise; ` +
    `requires_response is true only when a human reply is genuinely needed; ` +
    `priority is high|normal|low. One entry per thread, nothing else.\n\n` +
    `INBOX SNAPSHOT:\n${inbox}`;

  const triage = await ctx.hive.run(triageTask);
  const threads = parseTriage(triage.answer).map(coerceThread);
  ctx.log(`triaged ${threads.length} thread(s)`, { since: since ?? "(no cursor)", slot });

  // Feed the hive: record the triage itself as an attested leaf, so the inbox
  // trail stands even when every thread is pure noise.
  await ctx.comb
    .put({
      content:
        `secretary/triage ${date} (${slot}): ${threads.length} thread(s) ` +
        `[${threads.map((t) => `${t.category}${t.requires_response ? "!" : ""}`).join(", ")}] — ${triage.answer.slice(0, 300)}`,
      branch: "business", // TOGAF Business Architecture — the operator's correspondence
      author: triage.queenActor,
      verifier: triage.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put (triage) skipped: ${(e as Error).message}`));

  // ── 2. Per-thread SUMMARIZE (client/internal) + DRAFT (needs a reply) ───────
  const inboxCtx = inbox.slice(0, 4000);
  const processed: Processed[] = [];
  for (const t of threads) {
    let summary: string | null = null;
    let draft: string | null = null;
    try {
      if (t.category === "client" || t.category === "agix-internal") {
        const s = await ctx.hive.run(
          `SUMMARIZE the thread "${t.subject}" from ${t.from} for the operator's digest in 1-3 sentences ` +
            `of plain prose: what the sender wants, the context the operator needs, and any decision required. ` +
            `No preamble, no bullets.\n\nINBOX SNAPSHOT:\n${inboxCtx}`,
        );
        summary = s.answer.trim();
      }
      if (t.requires_response) {
        const d = await ctx.hive.run(
          `DRAFT a complete reply body in the operator's voice for the thread "${t.subject}" from ${t.from}. ` +
            `Direct, concrete, builder-to-builder; short sentences; no filler; close with a clear next step. ` +
            `Sign as the operator; plain text body only, no subject, no headers.\n\nINBOX SNAPSHOT:\n${inboxCtx}`,
        );
        draft = d.answer.trim();
      }
    } catch (e) {
      ctx.log(`thread ${t.id} (${truncate(t.subject, 40)}) failed: ${(e as Error).message}`);
    }
    processed.push({ ...t, summary, draft });
  }

  // ── 3. Assemble the digest (grouped like the Node buildDigest) ──────────────
  const high = processed.filter((p) => p.priority === "high" || p.requires_response);
  const normal = processed.filter((p) => !high.includes(p) && (p.category === "client" || p.category === "agix-internal"));
  const noise = processed.filter((p) => !high.includes(p) && (p.category === "newsletter" || p.category === "noise"));
  const digestMd = buildDigest(processed, high, normal, noise, date, slot);

  // ── 4. Write the digest (bounded by boundary.write = wiki/secretary/) ───────
  const digestRel = `${DIGEST_DIR}/${date}-${slot}.md`;
  try {
    await ctx.writeRepoFile(digestRel, digestMd);
  } catch (e) {
    ctx.log(`digest write skipped: ${(e as Error).message}`);
  }

  // ── 4b. Deliver the digest via the governed notify seam ─────────────────────
  // The Node runtime.sendEmail, reborn: dry-run/queued by default (nothing sent
  // offline), a live SMTP/Gmail transport plugs in fail-closed. Failure to deliver
  // never fails the run — the digest file is the durable deliverable either way.
  let delivered: { sent: boolean; queued: boolean; mode: string } = { sent: false, queued: false, mode: "none" };
  try {
    const to = typeof ctx.input.flags?.to === "string" && ctx.input.flags.to ? (ctx.input.flags.to as string) : "operator";
    const r = await ctx.sendEmail({
      to,
      subject: `Agix Secretary — Digest ${date} (${slot}) · ${high.length} need attention`,
      body: digestMd,
    });
    delivered = { sent: r.sent, queued: r.queued, mode: r.mode };
    ctx.log(`digest delivery · mode=${r.mode} sent=${r.sent} queued=${r.queued}`, { to });
  } catch (e) {
    ctx.log(`digest delivery skipped: ${(e as Error).message}`);
  }

  // ── 5. Attest the digest + advance the cursor (actor≠verifier) ──────────────
  await ctx.comb
    .put({
      content:
        `secretary/digest ${date} (${slot}): ${high.length} needs-attention, ${normal.length} fyi, ` +
        `${noise.length} newsletter/noise (archivable), ${processed.filter((p) => p.draft).length} draft(s)`,
      branch: "business",
      author: triage.queenActor,
      verifier: triage.verifierActor,
      trust: 0.7,
    })
    .catch((e) => ctx.log(`comb put (digest) skipped: ${(e as Error).message}`));
  await writeCursor(ctx, new Date().toISOString(), triage.queenActor, triage.verifierActor);

  return {
    ok: triage.verified,
    verifier: triage.verifierActor,
    queen: triage.queenActor,
    threadCount: processed.length,
    needsAttention: high.length,
    fyi: normal.length,
    archivable: noise.length, // would be auto-archived if the Gmail write seam were wired
    summarized: processed.filter((p) => p.summary).length,
    drafted: processed.filter((p) => p.draft).length,
    digest: digestRel,
    sent: delivered.sent, // dry-run default → false; a live transport flips this true
    queued: delivered.queued, // the digest was handed to the notify seam
    deliveryMode: delivered.mode,
    costUSD: triage.cost.usd,
  };
});

// ── ask: interactive inbox conversation (governed per turn) ────────────────────
// The operator converses with the Secretary about the inbox/digest over the reborn
// turn-loop seam. Each turn is a governed hive pass (a distinct verifier certifies —
// actor≠verifier), and the conversation history is threaded across turns. Recent
// attested triage/digest leaves seed turn 1 so the answers are grounded.
async function askMode(ctx: AgentContext): Promise<AgentResult> {
  const priors = await ctx.comb.retrieve("secretary/digest secretary/triage", 3, false).catch(() => []);
  const seed = priors.length ? priors.map((p) => `- ${p.content}`).join("\n") : "(no recent digest on record)";
  const inbox = ctx.input.text.trim();
  let lastVerifier: string | null = null;

  const conv = await converse(ctx, {
    label: "you",
    greeting: "Secretary · ask about your inbox. /exit to end.",
    goodbye: "Done.",
    buildTask: (history, user) => buildAskTask(seed, inbox, history, user),
    onTurn: (_u, r) => {
      lastVerifier = r.verifierActor;
    },
  });

  if (!conv.turns && !ctx.io.interactive) {
    ctx.log("ask is interactive — run it on a terminal: bun fleet/runtime/cli.ts run secretary ask");
  }
  return { ok: true, mode: "ask", turns: conv.turns, verifier: lastVerifier, governed: conv.governed, sent: false };
}

// buildAskTask threads the running transcript (history) plus the recent-inbox seed
// into each governed turn, so the Secretary answers with full conversation context.
function buildAskTask(seed: string, inbox: string, history: Turn[], user: string): string {
  const convo = history.length
    ? history.map((t) => `${t.role === "user" ? "Operator" : "Secretary"}: ${t.text}`).join("\n")
    : "(start of conversation)";
  const inboxCtx = inbox ? `\n\n[INBOX SNAPSHOT]\n${inbox.slice(0, 3000)}` : "";
  return (
    `Answer the operator's question about their inbox as the Secretary: compact, evidence-first, no filler. ` +
    `Ground your answer in the recent digest + any inbox snapshot below.\n\n` +
    `[RECENT DIGEST/TRIAGE]\n${seed}${inboxCtx}\n\n[CONVERSATION SO FAR]\n${convo}\n\n[OPERATOR]\n${user}`
  );
}

// buildDigest reduces the Node buildDigest: the needs-attention / FYI / newsletters
// sections, plus a note that archiving is not ported. Errors collapse into the
// per-thread try/catch above (a failed thread simply carries no summary/draft).
function buildDigest(
  processed: Processed[],
  high: Processed[],
  normal: Processed[],
  noise: Processed[],
  date: string,
  slot: string,
): string {
  const lines: string[] = [];
  lines.push(`# Agix Secretary — Digest ${date} (${slot})`, "");
  lines.push(
    `> reborn: governed triage + summaries + drafts (actor≠verifier). ` +
      `Delivery is via the governed notify seam (dry-run by default: the digest is queued, not sent). ` +
      `Inbox archiving is not ported — every draft is a proposal awaiting the operator.`,
    "",
  );
  lines.push(`${processed.length} thread${processed.length === 1 ? "" : "s"} triaged.`, "");

  if (high.length > 0) {
    lines.push(`## Needs your attention (${high.length})`, "");
    for (const p of high) {
      lines.push(`### ${p.subject}`);
      lines.push(`**From**: ${p.from}`);
      lines.push(`**Category**: ${p.category} · **Priority**: ${p.priority}${p.reason ? ` · ${p.reason}` : ""}`);
      if (p.summary) lines.push("", p.summary);
      if (p.draft) lines.push("", "**Suggested reply draft:**", "", "```", p.draft, "```");
      lines.push("");
    }
  }

  if (normal.length > 0) {
    lines.push(`## FYI — client + internal (${normal.length})`, "");
    for (const p of normal) {
      lines.push(`- **${p.subject}** · ${p.from}`);
      if (p.summary) lines.push(`  ${p.summary}`);
    }
    lines.push("");
  }

  if (noise.length > 0) {
    lines.push(`## Newsletters + noise (${noise.length}) — archivable (archiving not ported)`, "");
    for (const p of noise) lines.push(`- ${truncate(p.subject, 80)} · ${truncate(p.from, 40)}`);
    lines.push("");
  }

  lines.push("---", "", "Digest queued for delivery (dry-run by default); no thread archived — every draft is a proposal awaiting the operator.");
  return lines.join("\n") + "\n";
}
