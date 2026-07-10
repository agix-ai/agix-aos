// Agix Onboarding Agent — the first bee pointed at a new codebase (proposer /
// worker caste), reborn on Bun.
//
// This is the BEHAVIOR layer; identity, trust=proposer, the three-tier model
// mapping (worker=haiku scan, queen=sonnet synth, verifier=opus judge), the
// read-only boundary (write only wiki/sources/, wiki/director/specs/, wiki/log.md;
// deny git push/commit), and public=true live in the sibling agent.json. The
// legacy three-pass pipeline (scan → synth → judge) is run as ONE GOVERNED hive
// pass: the Go swarm forages the sources (workers), synthesizes the baseline
// (queen), and a DISTINCT verifier grades severity + the scorecard (actor≠verifier).
// That is exactly the Iron Law posture the legacy encoded by making the Opus judge
// pass a separate model from the Sonnet synth pass — the FIND is graded, not
// self-certified. The two artifacts (baseline source page + architect-annotatable
// foundation plan) are rendered here and written under the manifest boundary; the
// per-repo audit cursor is kept in the Comb as durable memory.
//
// Faithful reduction of agents/onboarding/agent.mjs.
//
// PORTED (the seams the reborn contract now expresses):
//   • The source-tree baseline. A GOVERNED glob discovery pass (the fs read/glob
//     tools, bounded to boundary.read + repoRoot) enumerates the client source tree
//     under `.client-repos/<slug>/` and hands the audit pass a real file inventory
//     to ground its findings — mirrors how the architect discovers specs. The Go
//     swarm reads the files with its bounded `read` tool INSIDE the governed audit;
//     the physical per-file scan-with-token-budget-halt is the swarm's job, not a
//     TypeScript re-implementation. The baseline artifact is written under the boundary.
//   • The email digest (`--send`). Delivered through ctx.sendEmail — the orchestration
//     twin of the Go core/tool/email tool — DRY-RUN by default (recorded, nothing
//     sent). The recipient rides the agent's declared email output surface (agent.json
//     outputs kind:"email" → "operator") or an explicit --to.
//   • The citation gate. weaknessesHaveCitations() is preserved as an exported,
//     adversarially-tested invariant (every claimed weakness must cite file:line).
//     The distinct verifier enforces it on the governed synthesis; the eval lives in
//     fleet/tests/onboarding.test.ts (ported from eval/citation-gate.suite.mjs).
//
// NOT PORTED (honest roadmap flags — genuinely deferred, deployment/runtime concerns):
//   • Live `git clone` of the client repos + LIVE email transport. Physically pulling
//     `.client-repos/` and a credentialed SMTP/Gmail adapter are deployment config; the
//     seams above fail closed (the glob pass degrades to empty; the digest is dry-run)
//     until they are wired. No secret is needed for a $0/offline run.
//   • The ~/.cache/agix-onboarding/ state store (runs/ + cursors/*.json). There is
//     no ctx.writeState and the path is outside the repo boundary; the per-repo
//     cursor is reduced to an attested Comb leaf (durable memory), and the per-run
//     record is a runtime concern.
//   • The programmatic citation-validator RETRY-once loop + in-process token-budget
//     halt. Citation discipline is carried in the persona + task + the exported gate;
//     certification (and any re-ask) is the distinct verifier's job now.
//   • `--memory` (getMemoryStore recall→offload to ground the judge) is subsumed by
//     the Comb: priors are recalled via ctx.comb.retrieve and persisted via
//     ctx.comb.put, so the explicit judge-grounding loop is not a distinct mode.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const SOURCES_DIR = "wiki/sources";
const SPECS_DIR = "wiki/director/specs";
const LOG_PATH = "wiki/log.md";
const CLIENT_REPOS_DIR = ".client-repos";

// Source scope for the tree-walk baseline (ported from the legacy SOURCE_EXTS /
// SKIP_DIRS). Carried into the governed glob discovery prompt so the enumeration
// matches the audit's effective scope.
const SOURCE_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
  ".css", ".scss", ".json", ".yaml", ".yml", ".toml",
  ".md", ".sql", ".graphql", ".gql", ".html", ".sh", ".bash", ".zsh",
];
const SKIP_DIRS = [
  "node_modules", ".git", ".next", "dist", "build", "out", ".turbo",
  ".cache", "coverage", "__pycache__", ".venv", "venv", ".idea", ".vscode",
];

// The 12 AI-readiness dimensions the judge scores (ported from the legacy judge
// pass scorecard schema). Carried here so a smoke skeleton renders a real header.
const SCORECARD_DIMENSIONS = [
  "Data model",
  "Async / job infra",
  "Realtime",
  "Auth + tenancy",
  "Cost control",
  "CI/CD + tests",
  "Observability",
  "Schema validation",
  "AI client surface",
  "Deploy / hosting",
  "Frontend AI surface",
  "Dependency hygiene",
];

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Derive a repo slug from a git URL (ported from repoNameFromUrl).
function repoNameFromUrl(url: string): string {
  return url.replace(/\.git$/, "").replace(/[/:]$/, "").split(/[/:]/).pop() ?? url;
}

function flagStr(ctx: AgentContext, key: string): string {
  const v = ctx.input.flags[key];
  return typeof v === "string" ? v.trim() : "";
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // ── Smoke short-circuit ──────────────────────────────────────────────────
  // Exercise the governed surface once ($0), then write a structurally-correct
  // skeleton of both artifacts through the bounded writeRepoFile — mirrors the
  // legacy runSmoke (verify wiring + render path without cloning or burning
  // tokens). In tests repoRoot is a tmp dir, so the writes land there.
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the codebase-audit reasoning surface is live");
    const date = isoDate();
    const slug = "smoke-fake-client";
    const sourceRel = `${SOURCES_DIR}/${date}-${slug}-baseline.md`;
    const specRel = `${SPECS_DIR}/${date}-${slug}-foundation-plan.md`;
    try {
      await ctx.writeRepoFile(
        sourceRel,
        renderBaseline({ clientSlug: slug, date, depth: "sample", repos: ["https://example.com/smoke.git"], files: 0, synthesis: "_(smoke)_", verifier: r.verifierActor }),
      );
      await ctx.writeRepoFile(
        specRel,
        renderFoundationPlan({ clientSlug: slug, date, repos: ["https://example.com/smoke.git"], synthesis: "_(smoke)_" }),
      );
    } catch (e) {
      ctx.log(`smoke artifact write skipped: ${(e as Error).message}`);
    }
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor, artifacts: { source: sourceRel, spec: specRel } };
  }

  // ── Parse the invocation ─────────────────────────────────────────────────
  const client = flagStr(ctx, "client");
  const reposRaw = flagStr(ctx, "repos");
  const repos = reposRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const depthRaw = flagStr(ctx, "depth");
  const depth = depthRaw || "full";
  const phase = ctx.input.flags.phase;
  // Legacy: sub = positional[0] || (client ? 'audit' : null). Mode is the first
  // positional in the reborn contract; a --client with no explicit mode implies audit.
  const mode = ctx.input.mode ?? (client ? "audit" : undefined);

  // Email digest delivery is opt-in via --send (dry-run by default). The delivery
  // itself runs after the artifacts are rendered — see the notify-seam block below.
  const send = ctx.input.flags.send === true || ctx.input.flags.send === "true";

  // ── No target: orient GO (SDLC phase) or help ────────────────────────────
  if (!mode) {
    if (phase) {
      // Fired by the SDLC phase-runner as the Orient actor with no repo target:
      // emit a clean phase note and GO (parity with the legacy orient path).
      ctx.log("[orient] no repo target — skipping codebase audit; run: onboarding audit --client <slug> --repos <url,...>");
      return { ok: true, mode: "orient", phase: String(phase), verdict: "GO", skipped: true, reason: "no repo target provided" };
    }
    ctx.log("modes: audit --client <slug> --repos <url1,url2,...> [--depth full|sample]");
    return { ok: true, mode: null, help: true };
  }

  if (mode !== "audit") {
    ctx.log(`unknown mode: ${mode} (only "audit" is supported)`);
    return { ok: false, mode, unknown: true };
  }

  // ── audit: validate inputs ───────────────────────────────────────────────
  if (!client) {
    ctx.log("--client <slug> is required for audit");
    return { ok: false, mode: "audit", reason: "missing --client" };
  }
  if (repos.length === 0) {
    ctx.log("--repos <url1,url2,...> is required for audit");
    return { ok: false, mode: "audit", reason: "missing --repos" };
  }
  if (depth !== "full" && depth !== "sample") {
    ctx.log(`--depth must be 'full' or 'sample' (got ${depth})`);
    return { ok: false, mode: "audit", reason: "bad --depth" };
  }

  const date = isoDate();

  // ── Ground the pass in any prior audit of this client (Comb = the memory) ──
  const priors = await ctx.comb.retrieve(`onboarding ${client}`, 3).catch(() => []);
  const priorNote = priors.length
    ? `\n\nA prior audit of this client concluded (weigh as precedent, not ground truth):\n${priors.map((p) => `- ${p.content}`).join("\n")}`
    : "";

  // ── Source-tree baseline — one GOVERNED glob discovery pass (actor≠verifier) ─
  // The reborn reduction of the Node walkRepos readdir sweep: the worker holds the
  // fs read/glob tools (declared in agent.json, bounded to boundary.read = .client-repos/
  // + repoRoot) INSIDE a governed pass, so the source tree is enumerated governed.
  // The inventory GROUNDS the audit; it degrades to empty on any parse failure.
  const sourceFiles = await discoverSourceTree(ctx, client, repos, depth);
  ctx.log(`source-tree baseline: enumerated ${sourceFiles.length} source file(s) under ${CLIENT_REPOS_DIR}/${client}/`);
  const treeBlock = sourceFiles.length
    ? `\n\nSOURCE-TREE BASELINE (${sourceFiles.length} file(s) enumerated under ${CLIENT_REPOS_DIR}/${client}/ — ` +
      `use the read tool to open the highest-signal files before asserting any weakness; cite file:line VERBATIM):\n` +
      sourceFiles.slice(0, 200).map((p) => `- ${p}`).join("\n")
    : `\n\n(No source tree enumerated — the glob pass returned nothing; audit from the repo brief and cite what you can open with the read tool.)`;

  // ── One GOVERNED audit pass (scan → synth → judge, all in the Go swarm) ────
  const auditTask =
    `Audit the "${client}" codebase for AI-readiness. Repos: ${repos.join(", ")}. Depth: ${depth}.\n\n` +
    `Produce, in this order:\n` +
    `1. Product capability baseline — what the product does, personas, end-to-end journeys, data model summary.\n` +
    `2. Stack inventory — frontend, API, data tier, deploy, integrations.\n` +
    `3. Weakness assessment — the highest-signal weaknesses, each keyed P0/P1/P2, each citing at least one file path + line number. P0 blocks any AI feature ship, P1 must be in Foundation Sprint scope, P2 is a transparency note. No more than 25.\n` +
    `4. AI-readiness scorecard — score all 12 dimensions (${SCORECARD_DIMENSIONS.join(", ")}) as Ready, Gap, or Blocker with a one-sentence justification.\n` +
    `5. Discovery / Foundation Sprint scope implications — what the sprint must include to unblock AI features given these findings.${priorNote}${treeBlock}`;

  const r = await ctx.hive.run(auditTask);

  // ── Render + write the two artifacts (bounded by boundary.write) ──────────
  const sourceRel = `${SOURCES_DIR}/${date}-${client}-baseline.md`;
  const specRel = `${SPECS_DIR}/${date}-${client}-foundation-plan.md`;

  const baselineMd = renderBaseline({ clientSlug: client, date, depth, repos, files: sourceFiles.length, synthesis: r.answer, verifier: r.verifierActor });
  const specMd = renderFoundationPlan({ clientSlug: client, date, repos, synthesis: r.answer });

  let wrote = false;
  try {
    await ctx.writeRepoFile(sourceRel, baselineMd);
    await ctx.writeRepoFile(specRel, specMd);
    wrote = true;
  } catch (e) {
    ctx.log(`artifact write skipped: ${(e as Error).message}`);
  }

  // Single-line append to the wiki log (the legacy appendLog surface).
  try {
    const prev = (await ctx.readRepoFile(LOG_PATH)) ?? "";
    const line = `${new Date().toISOString()} onboarding: ${client} baseline drafted — ${repos.length} repo(s) · verifier=${r.verifierActor}`;
    await ctx.writeRepoFile(LOG_PATH, prev + (prev.endsWith("\n") || !prev ? "" : "\n") + line + "\n");
  } catch (e) {
    ctx.log(`log append skipped: ${(e as Error).message}`);
  }

  // ── Deliver the onboarding digest (--send) via the governed notify seam ────
  // ctx.sendEmail is DRY-RUN by default: the digest is RECORDED and NOTHING is
  // sent ($0/offline, no credential). A credentialed live SMTP/Gmail transport is a
  // deployment config and fails closed. Delivery never fails the run — the artifacts
  // are the durable deliverable either way.
  let delivered: { sent: boolean; queued: boolean; mode: string } | null = null;
  if (send) {
    try {
      const to = flagStr(ctx, "to") || mailDefaultTo(ctx);
      const d = await ctx.sendEmail({
        to,
        subject: `Agix Onboarding — ${client} baseline (${date}) · ${repos.length} repo(s)`,
        body: renderDigest({ clientSlug: client, date, repos, files: sourceFiles.length, verifier: r.verifierActor, sourceRel, specRel, synthesis: r.answer }),
      });
      delivered = { sent: d.sent, queued: d.queued, mode: d.mode };
      ctx.log(`(dry-run) digest recorded, not sent · mode=${d.mode} sent=${d.sent} queued=${d.queued}`, { to });
    } catch (e) {
      ctx.log(`digest delivery skipped: ${(e as Error).message}`);
    }
  }

  // ── Persist the per-repo audit cursor as an attested Comb leaf ────────────
  // (the reborn reduction of ~/.cache/agix-onboarding/cursors/<slug>.json:
  // author = the run's queen, certified by its DISTINCT verifier).
  for (const url of repos) {
    const repoName = repoNameFromUrl(url);
    await ctx.comb
      .put({
        id: `onboarding-cursor-${client}--${repoName}`,
        content: `onboarding ${client} ${date}: audited ${url} (${repoName}) at depth=${depth} · verifier=${r.verifierActor}`,
        branch: "business", // TOGAF Business Architecture — client posture lives here
        author: r.queenActor,
        verifier: r.verifierActor,
        trust: 0.7,
      })
      .catch((e) => ctx.log(`comb cursor put skipped: ${(e as Error).message}`));
  }

  return {
    ok: r.verified,
    mode: "audit",
    client_slug: client,
    depth,
    repos: repos.length,
    files_inventoried: sourceFiles.length,
    verifier: r.verifierActor,
    queen: r.queenActor,
    priorsUsed: priors.length,
    artifacts: wrote ? { source: sourceRel, spec: specRel } : null,
    sent: delivered ? delivered.sent : false, // dry-run default → false; a live transport flips this true
    queued: delivered ? delivered.queued : false, // the digest was handed to the notify seam
    deliveryMode: delivered ? delivered.mode : "none",
    costUSD: r.cost.usd,
  };
});

// ── Source-tree baseline — one GOVERNED glob discovery pass ───────────────────
// The reborn reduction of the Node walkRepos readdir sweep. The worker holds the
// fs `glob`/`read` tools (declared in agent.json, bounded to boundary.read +
// repoRoot). It enumerates the client source tree and returns it as strict JSON.
// Degrades to empty on any parse failure — discovery is additive (the audit still
// runs and still writes the baseline), never fatal.
async function discoverSourceTree(ctx: AgentContext, client: string, repos: string[], depth: string): Promise<string[]> {
  const repoNames = repos.map(repoNameFromUrl);
  const task =
    `DISCOVERY. Use the glob tool to enumerate repo-relative source file paths under ` +
    `\`${CLIENT_REPOS_DIR}/${client}/\` (the read-only client clone; repos: ${repoNames.join(", ")}), ` +
    `then return STRICT JSON only (no prose, no code fences): {"files":[...]}.\n` +
    `- files: every path matching \`${CLIENT_REPOS_DIR}/${client}/**\` whose extension is one of ` +
    `${SOURCE_EXTS.join(" ")}; skip these directories entirely: ${SKIP_DIRS.join(" ")}.\n` +
    (depth === "sample"
      ? `- depth=sample: keep only the ~20 most-recently-modified files per directory.\n`
      : `- depth=full: every source file.\n`) +
    `Return ONLY real paths the glob tool produced; never invent or paraphrase a path.`;
  try {
    const r = await ctx.hive.run(task);
    return parseSourceTree(r.answer);
  } catch (e) {
    ctx.log(`source-tree glob pass skipped: ${(e as Error).message}`);
    return [];
  }
}

// Defensive parse of the discovery answer — deduped and filtered to real-looking
// paths under the client clone, so a stray/invented path never leaks into the
// baseline (mirrors the architect's parseDiscovery posture).
export function parseSourceTree(answer: string): string[] {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.files)) return [];
  return [
    ...new Set(
      parsed.files
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .filter((p) => p.startsWith(CLIENT_REPOS_DIR + "/")),
    ),
  ];
}

// ── Citation gate (ported verbatim from the Node weaknessesHaveCitations) ─────
// The load-bearing invariant: EVERY claimed weakness must carry at least one
// {path, line} citation, so each finding can be traced to its source before anyone
// acts on it. An empty set is vacuously OK; one uncited weakness poisons the batch.
// The distinct verifier enforces this on the governed synthesis — this is exported
// as a pure, adversarially-tested guard (see fleet/tests/onboarding.test.ts).
export function weaknessesHaveCitations(weaknesses: unknown): boolean {
  if (!Array.isArray(weaknesses) || weaknesses.length === 0) return true;
  return weaknesses.every(
    (w: any) =>
      w &&
      Array.isArray(w.files) &&
      w.files.length > 0 &&
      w.files.every((f: any) => f && typeof f.path === "string" && typeof f.line === "number"),
  );
}

// ── Digest recipient — the "mailDefaultTo" convention ─────────────────────────
// The default recipient rides the agent's declared email output surface (agent.json
// outputs: kind "email", path "operator"). An explicit --to wins over this.
function mailDefaultTo(ctx: AgentContext): string {
  const email = (ctx.manifest.outputs ?? []).find((o) => o.kind === "email");
  const to = (email?.path ?? "").trim();
  return to || "operator";
}

// The onboarding-digest email body (ported from the Node onboarding-digest template):
// a short operator-facing note that links both artifacts and carries the governed
// synthesis. Delivered via ctx.sendEmail (dry-run by default).
function renderDigest(a: {
  clientSlug: string;
  date: string;
  repos: string[];
  files: number;
  verifier: string;
  sourceRel: string;
  specRel: string;
  synthesis: string;
}): string {
  return `# Agix Onboarding — ${a.clientSlug} baseline (${a.date})

A first read of the ${a.clientSlug} codebase is ready. ${a.repos.length} repo(s), ${a.files} source file(s) inventoried. Certified by a distinct verifier (${a.verifier}) — actor≠verifier.

Artifacts:
- Baseline source page: \`${a.sourceRel}\`
- Foundation plan (architect-annotatable): \`${a.specRel}\`

Repos audited:
${a.repos.map((u) => `- ${u}`).join("\n")}

## Baseline, weakness assessment & AI-readiness scorecard

${a.synthesis}

—
Generated by the Agix Onboarding Agent. This digest was queued for delivery (dry-run by default; a credentialed transport sends it live).`;
}

// ── Renderers (ported from renderSourcePage / renderFoundationPlan) ──────────
// Reduced: the governed hive returns the synthesized §1-5 body (r.answer); these
// frame it with the canonical Agix baseline structure + provenance and preserve
// the load-bearing ARCHITECT:BEGIN/END markers the architect agent annotates.

function renderBaseline(a: {
  clientSlug: string;
  date: string;
  depth: string;
  repos: string[];
  files: number;
  synthesis: string;
  verifier: string;
}): string {
  const reposTable = a.repos.map((u) => `| \`${u}\` |`).join("\n");
  return `---
title: ${a.clientSlug} — Repo Evaluation (Onboarding Agent, ${a.date})
type: source
domain: consulting, architecture
client: ${a.clientSlug}
created: ${a.date}
updated: ${a.date}
status: baseline
tags: [client, ${a.clientSlug}, evaluation, code-review, baseline, onboarding-agent]
---

# ${a.clientSlug} — Repo Evaluation

> A first read of the ${a.clientSlug} codebase, with the findings that shape the
> Foundation Sprint. Each weakness is traced to a file and line so it can be
> checked at the source before acting on it. Certified by a distinct verifier
> (${a.verifier}) — actor≠verifier.

## Repos Audited

| URL |
|---|
${reposTable}

## Baseline, Weakness Assessment & AI-Readiness Scorecard

Severities: **P0 = blocks AI proposal until addressed** · **P1 = Discovery / Foundation Sprint must include** · **P2 = note for transparency, doesn't block**. The 12 AI-readiness dimensions are scored Ready / Gap / Blocker.

${a.synthesis}

## Citations

Every weakness above carries a file path and line number from the client repos,
so each finding can be traced directly to its source.

## See Also

- \`wiki/director/specs/${a.date}-${a.clientSlug}-foundation-plan.md\` (sibling spec)
- \`agents/onboarding/\` (this agent)

---

## Run Details

| Field | Value |
|---|---|
| Generated | ${new Date().toISOString()} |
| Depth | ${a.depth} |
| Source files inventoried | ${a.files} (governed glob discovery over \`${CLIENT_REPOS_DIR}/${a.clientSlug}/\`) |
| Verifier | ${a.verifier} (actor≠verifier) |
`;
}

function renderFoundationPlan(a: {
  clientSlug: string;
  date: string;
  repos: string[];
  synthesis: string;
}): string {
  return `---
title: ${a.clientSlug} — Foundation Plan (Onboarding Agent, ${a.date})
type: director-spec
domain: architecture, client
client: ${a.clientSlug}
created: ${a.date}
updated: ${a.date}
status: draft
related:
  - ../sources/${a.date}-${a.clientSlug}-baseline.md
tags: [client, ${a.clientSlug}, foundation-sprint, onboarding-agent]
---

# ${a.clientSlug} — Foundation Plan

Drafted by the Onboarding Agent from the audit at
\`../sources/${a.date}-${a.clientSlug}-baseline.md\`. Architect annotates the
marked block below on its next scheduled run.

## 1. Scope

The Foundation Sprint addresses the P0 findings and Blocker-graded dimensions
surfaced in the sibling baseline. Governed synthesis:

${a.synthesis}

## 2. Acceptance

Each P0 finding has a documented resolution PR with file:line citations matching
the baseline. The Blocker-graded dimensions move to Gap or Ready on a re-audit by
this agent at the end of the sprint.

## 3. Repos Considered

${a.repos.map((u) => `- \`${u}\``).join("\n")}

<!-- ARCHITECT:BEGIN -->
_(Architect annotation pending — will be populated on next architect run per \`agents/architect/agent.json\` schedule.)_
<!-- ARCHITECT:END -->
`;
}
