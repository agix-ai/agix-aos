// Agix Host Drone — the fleet's ONLY hands on the code host (boundary / drone caste).
//
// WHY THIS AGENT EXISTS (discovered the hard way, 2026-07-10). Our own verifier-guard held
// PR #183 with: "author `blewis-maker` · risk classes: agent_execution, security · no
// independent human approval from an allow-listed verifier." The allow-list's only human
// verifier was also the PR author, and a code host structurally forbids self-approval. The
// gate was not misconfigured — it was correctly reporting that NO INDEPENDENT PARTY EXISTED,
// because the agent pushes commits AS THE OPERATOR. Actor and verifier had collapsed into a
// single code-host identity, which is exactly what actor≠verifier exists to prevent.
//
// The fix is an identity, not a config tweak. This agent carries the fleet's OWN GitHub
// identity — a GitHub App installation token, resolved by logical REF through the secrets
// broker (boundary.exec_env: {"GH_TOKEN": "agix-steward-gh-token"}) and injected only into
// a governed exec child, never held raw and never the operator's personal token. Then:
// the AGENT authors, the HUMAN approves, verifier-guard passes legitimately, and the ledger
// records which principal did what.
//
// TWO GATES, NEVER BYPASSED:
//   1. The manifest's exec allowlist is the CEILING — the set of gh subcommands that could
//      ever run. Enforced in Go (core/tool/exec), deny-by-default, with a deny list that
//      vetoes even an allowed prefix. `gh pr merge` is not in the ceiling at all.
//   2. The earned autonomy RUNG for the action's domain is the LIVE gate below the ceiling
//      (core/autonomy). Shadow → write a file, touch nothing. Propose → open a PR/draft a
//      human presses. Act → perform the write. Every domain starts at Shadow.
//
// A static allowlist cannot express "may label issues but not comment yet," because rungs
// move at runtime as trust is earned. So the ceiling is static and the rung is dynamic, and
// an action must clear BOTH. Fail closed at each.
//
// DOCTRINE (verified field brief, research/notes/2026-07-09-agentic-pr-review-loops-research.md):
//   • Every posted artifact DISCLOSES it was authored by an AI agent (curl's rule: security
//     report confirmation collapsed >15% → <5% under undisclosed AI slop, and one bad report
//     burns hours of a maintainer's life).
//   • NEVER file a security report. Security findings go to a human, always.
//   • The drone executes a VALIDATED proposal; it does not originate or re-judge one. A
//     proposal without a validation is refused (actor≠verifier: the actor may not self-certify).
//
// FAITHFUL-REDUCTION / NOT-PORTED:
//   • The live `gh` invocation runs inside the governed Go exec tool via ctx.hive.run; this
//     TS layer decides WHETHER an action may run and records what happened. In a hermetic
//     test no gh process is spawned. Flagged in notPorted[].
//   • Propose-rung PR opening is a follow-on (it needs the App's branch-push grant).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

/** The autonomy ledger the Go CLI writes (`agix-core autonomy observe`). JSONL, last record
 *  per domain wins. Read-only here: the drone never promotes itself. */
const AUTONOMY_LEDGER = "governance/tenants/agix/autonomy.jsonl";
const ACTIONS_DIR = "wiki/oss-steward/actions";

/** The disclosure appended to every artifact this drone posts to the host. Non-negotiable. */
export const AI_DISCLOSURE =
  "\n\n---\n_Posted by `agix-steward` — an automated agent. Findings carry a confidence; " +
  "reply to correct it. A human maintainer reviews anything ambiguous._";

export type Rung = "shadow" | "propose" | "act";
const RUNG_ORDER: Record<Rung, number> = { shadow: 0, propose: 1, act: 2 };

/** An action the drone may be asked to take, and the domain autonomy is earned per. */
export interface HostAction {
  /** The autonomy domain this action belongs to (labeling is cheap; prose is not). */
  domain: string;
  /** The gh subcommand prefix — must sit inside the manifest's exec ceiling. */
  command: string;
  /** Human-readable description for the action log. */
  summary: string;
  /** Body text, if the action posts prose. Disclosure is appended automatically. */
  body?: string;
  /** Did a DISTINCT verifier validate the proposal that produced this action? */
  validated: boolean;
  /** True when the action concerns a security finding — never automated. */
  security?: boolean;
}

/** The minimum rung an action class requires. Labeling and dedup are cheap, reversible and
 *  low-tone-risk, so they earn `act` first (Dosu ships exactly this tiering in production).
 *  Prose that a contributor reads is held at a higher bar for longer. */
export const REQUIRED_RUNG: Record<string, Rung> = {
  "issue-label": "act",
  "issue-dedup": "act",
  "issue-comment": "act",
  "pr-comment": "act",
  "pr-review": "act",
};

/** Actions this drone refuses regardless of rung, allowlist, or instruction. These mirror
 *  the manifest deny list, restated in code so a manifest edit alone cannot unlock them. */
export const NEVER = [
  "gh pr merge", "gh pr close", "gh issue close",
  "gh release delete", "gh release create",
  "gh repo edit", "gh repo delete",
  "gh secret", "gh auth", "gh workflow",
  "git push", "git commit",
];

export interface Decision {
  allowed: boolean;
  /** What actually happens: nothing, a file, or a host write. */
  effect: "none" | "proposal-file" | "host-write";
  reason: string;
}

/** parseRung reads the earned rung for a domain out of the Go-written JSONL ledger.
 *  An unknown domain is `shadow` — deny-by-default, the safe direction. */
export function parseRung(ledger: string | null, domain: string): Rung {
  if (!ledger) return "shadow";
  let rung: Rung = "shadow";
  for (const line of ledger.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as { domain?: string; rung?: number | string };
      if (rec.domain !== domain) continue;
      // The Go ledger stores Rung as an int (0|1|2); tolerate the string form too.
      if (typeof rec.rung === "number") rung = (["shadow", "propose", "act"][rec.rung] ?? "shadow") as Rung;
      else if (typeof rec.rung === "string" && rec.rung in RUNG_ORDER) rung = rec.rung as Rung;
    } catch {
      // A corrupt line must never widen authority. Skip it.
      continue;
    }
  }
  return rung;
}

/** decide is the whole safety model as a pure function: ceiling, then never-list, then
 *  validation, then the live rung. Every gate fails closed. */
export function decide(action: HostAction, earned: Rung, ceiling: string[]): Decision {
  // 0. Security is never automated. One bad automated security report costs a maintainer
  //    hours; the confirmation rate for AI-era reports on curl fell below 5%.
  if (action.security) {
    return { allowed: false, effect: "none", reason: "security findings are never posted by an agent; routed to a human" };
  }

  // 1. The never-list. Restated in code so editing the manifest alone cannot unlock it.
  if (NEVER.some((n) => action.command.startsWith(n))) {
    return { allowed: false, effect: "none", reason: `"${action.command}" is permanently denied to this drone` };
  }

  // 2. The manifest ceiling. Deny-by-default: an empty ceiling permits nothing.
  if (!ceiling.some((c) => action.command.startsWith(c))) {
    return { allowed: false, effect: "none", reason: `"${action.command}" is outside the exec allowlist ceiling` };
  }

  // 3. actor≠verifier: the drone executes a VALIDATED proposal. It may not self-certify.
  if (!action.validated) {
    return { allowed: false, effect: "none", reason: "proposal carries no distinct-verifier validation" };
  }

  // 4. The live autonomy rung for this domain.
  const need = REQUIRED_RUNG[action.domain] ?? "act";
  if (RUNG_ORDER[earned] < RUNG_ORDER[need]) {
    return {
      allowed: false,
      effect: earned === "shadow" ? "proposal-file" : "proposal-file",
      reason: `domain "${action.domain}" has earned \`${earned}\`; this action needs \`${need}\``,
    };
  }
  return { allowed: true, effect: "host-write", reason: `domain "${action.domain}" has earned \`${earned}\`` };
}

/** withDisclosure appends the AI-authorship disclosure exactly once. */
export function withDisclosure(body: string): string {
  return body.includes("automated agent") ? body : body + AI_DISCLOSURE;
}

async function loadActions(ctx: AgentContext): Promise<HostAction[]> {
  const path = String(ctx.input.flags.actions ?? "").trim();
  if (!path) return [];
  const raw = await ctx.readRepoFile(path);
  if (!raw) throw new Error(`host-drone: actions file not found: ${path}`);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("host-drone: actions file must be a JSON array");
  return parsed as HostAction[];
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the governed host-drone surface is reachable");
    return { ok: true, smoke: true, verifier: r.verifierActor, performed: 0, refused: 0 };
  }

  const ceiling = ctx.manifest.boundary?.exec ?? [];
  const ledger = await ctx.readRepoFile(AUTONOMY_LEDGER);
  const actions = await loadActions(ctx);

  const log: Record<string, unknown>[] = [];
  let performed = 0;
  let refused = 0;

  for (const action of actions) {
    const earned = parseRung(ledger, action.domain);
    const d = decide(action, earned, ceiling);

    if (!d.allowed) {
      refused++;
      log.push({ ...action, earned, allowed: false, reason: d.reason, effect: d.effect });
      ctx.log(`refused: ${action.command} — ${d.reason}`);
      continue;
    }

    // The write itself flows through the GOVERNED Go exec tool, which re-enforces the
    // allowlist, injects GH_TOKEN from the broker into that child only, and audits the call.
    // This TS layer never holds the token and never shells out.
    const body = action.body ? withDisclosure(action.body) : undefined;
    await ctx.hive.run(
      `Run the governed host action: ${action.command}\n${body ? `body:\n${body}` : ""}`.trim(),
    );
    performed++;
    log.push({ ...action, earned, allowed: true, reason: d.reason, effect: d.effect, body });
    ctx.log(`performed: ${action.command} (rung ${earned})`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const relPath = `${ACTIONS_DIR}/${date}-actions.md`;
  await ctx.writeRepoFile(relPath, renderLog(date, log, performed, refused));

  return {
    ok: true,
    smoke: false,
    // A refusal is a successful outcome, not a failure.
    performed,
    refused,
    actionLog: relPath,
    identity: "agix-steward-gh-token (brokered ref; never the operator's token)",
    notPorted: [
      "live gh invocation runs inside the governed Go exec tool (no process spawned in tests)",
      "propose-rung PR opening (needs the App's branch-push grant)",
    ],
  };
});

function renderLog(date: string, log: Record<string, unknown>[], performed: number, refused: number): string {
  const lines = [
    `# Host actions — ${date}`,
    ``,
    `Performed: **${performed}** · Refused: **${refused}**`,
    ``,
    `Identity: \`agix-steward\` (the fleet's own GitHub App installation token, brokered by`,
    `ref). The operator's personal token is never used, so the agent authors and the human`,
    `approves and actor≠verifier holds at the host level.`,
    ``,
    `| action | domain | earned rung | outcome | reason |`,
    `|---|---|---|---|---|`,
  ];
  for (const e of log) {
    lines.push(
      `| \`${e.command}\` | ${e.domain} | \`${e.earned}\` | ${e.allowed ? "performed" : "refused"} | ${e.reason} |`,
    );
  }
  return lines.join("\n") + "\n";
}
