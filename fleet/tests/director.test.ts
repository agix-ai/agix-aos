// Director port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn director agent, runs it against a MOCKED governed engine
// + in-memory Comb, and asserts:
//   - the classify pass runs GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the ported output guardrail keeps only real, well-formed intents (never invents IDs);
//   - each safe verb dispatches correctly (approve drafts a spec under the boundary,
//     defer is a pure-state entry, dive delegates to research via `fire`);
//   - the classification + drafts are attested into the Comb;
//   - smoke short-circuits to a single governed surface check.
//
// Mirrors fleet/tests/runner.test.ts. Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-director-"));
}

// A registered-verifier MemComb so writes actually attest (mirrors the Go roster).
// director's mock verifier is director/worker/verifier-1; a fired research dive
// attests under research/worker/verifier-1.
function comb(): MemComb {
  return new MemComb({
    roster: ["director/worker/verifier-1", "research/worker/verifier-1"],
    trustFloor: 0.35,
  });
}

// A mock governed engine that returns valid classifier JSON for the CLASSIFY pass
// and prose for every drafting pass. The intents cover approve (drafts a spec) and
// defer (pure state). One intent (BADVERB) exercises the output guardrail, and one
// invented ID (2099-01-01.Z9, absent from the brief) must be dropped.
function classifyingEngine(): MockEngine {
  const intentsJson = JSON.stringify({
    intents: [
      { item_id: "2026-07-07.A1", verb: "approve", scope_hints: "use the PRM approach", raw_reply_excerpt: "yes build A1" },
      { item_id: "2026-07-07.B2", verb: "defer", scope_hints: "next sprint", raw_reply_excerpt: "defer B2" },
      { item_id: "2026-07-07.C3", verb: "chainsaw", scope_hints: "", raw_reply_excerpt: "unknown verb" },
      { item_id: "2099-01-01.Z9", verb: "approve", scope_hints: "", raw_reply_excerpt: "invented id" },
    ],
    unresolved: ["what did 'the other thing' refer to?"],
  });
  return new MockEngine((_agent, task) =>
    task.startsWith("CLASSIFY") ? intentsJson : "## Goal\nDraft spec body.\n## Approach\ndo the thing.",
  );
}

// A brief on disk that names two addressable items (A1, B2). Written into the
// agent's read boundary (wiki/research/) so filterValidIntents accepts A1/B2 and
// rejects the invented 2099-01-01.Z9.
async function seedBrief(repo: string, date: string): Promise<string> {
  const rel = `wiki/research/${date}-brief.md`;
  await Bun.write(
    join(repo, rel),
    `# Research Brief ${date}\n\n### ${date}.A1 — AgentPRM\nBuild the PRM.\n\n### ${date}.B2 — Cheap-model swarms\nSurvey.\n`,
  );
  return rel;
}

describe("director (boundary / drone)", () => {
  test("classifies a reply governed, keeps only real intents, drafts + attests", async () => {
    const engine = classifyingEngine();
    const c = comb();
    const repo = tmpRepo();
    const date = "2026-07-07";
    const brief = await seedBrief(repo, date);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: "YES A1 — use the PRM approach. Defer B2 to next sprint.", flags: { brief, date } },
    });

    // Governed: the classify pass was certified by a DISTINCT verifier.
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("director/worker/verifier-1");
    expect(result.queen).toBe("director/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // Guardrail: 4 raw intents in → 2 valid out (bad verb + invented ID dropped).
    expect(result.intents).toBe(2);
    expect(result.unresolved).toBe(1);

    // The two safe verbs dispatched correctly.
    const executed = result.executed as { verb: string; item_id: string; status: string; artifact: string | null }[];
    const approve = executed.find((e) => e.verb === "approve");
    const defer = executed.find((e) => e.verb === "defer");
    expect(approve?.item_id).toBe("2026-07-07.A1");
    expect(approve?.status).toBe("in-progress");
    expect(defer?.item_id).toBe("2026-07-07.B2");
    expect(defer?.status).toBe("deferred");

    // The spec was written UNDER the boundary (wiki/director/specs/).
    expect(approve?.artifact).toStartWith("wiki/director/specs/");
    const spec = await Bun.file(join(repo, approve!.artifact as string)).text();
    expect(spec).toContain("## Goal");

    // The actions log was written under the boundary.
    const log = await Bun.file(join(repo, result.actionsLog as string)).text();
    expect(log).toContain("APPROVE");
    expect(log).toContain("DEFER");
    expect(log).toContain("No merges to main");

    // Engine ran exactly two governed units: the classify + the approve spec draft
    // (defer is pure state, the dropped intents never ran).
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].task.startsWith("CLASSIFY")).toBe(true);

    // The classification + the spec were attested into the Comb (actor≠verifier).
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(2);
  });

  test("dive delegates to the research agent via the fire capability", async () => {
    // Classifier returns a single DIVE intent (no brief on disk → any well-formed
    // ID is accepted).
    const engine = new MockEngine((_agent, task) =>
      task.startsWith("CLASSIFY")
        ? JSON.stringify({
            intents: [{ item_id: "2026-07-07.D4", verb: "dive", scope_hints: "the auth flow", raw_reply_excerpt: "dive D4" }],
            unresolved: [],
          })
        : "research finding one, two, three",
    );
    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { text: "DIVE D4 — focus on the auth flow" },
    });

    expect(result.ok).toBe(true);
    expect(result.intents).toBe(1);

    // Two governed runs: the classify (director) + the fired dive (research).
    const agents = engine.calls.map((x) => x.agent);
    expect(agents).toContain("director");
    expect(agents).toContain("research");

    const dive = (result.executed as { verb: string; status: string; verifier: string | null }[]).find((e) => e.verb === "dive");
    expect(dive?.status).toBe("in-progress");
    expect(dive?.verifier).toBe("research/worker/verifier-1");
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "ignored under smoke" },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("director/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });

  test("an empty reply is a no-op (no governed run)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { text: "   " },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-reply");
    expect(engine.calls.length).toBe(0);
  });
});

// ── Ported from the legacy eval suite ───────────────────────────────────────
// agents/director/eval/classify-reply.suite.mjs drove classifyReply() +
// filterValidIntents() directly as exported pure functions from
// agents/director/lib/classify.mjs. The reborn agents/director/agent.ts inlines
// the SAME logic (parseClassification + filterValidIntents, ported verbatim —
// see the comment above SUPPORTED_VERBS in agent.ts) but does not re-export it;
// the only export is the default defineAgent(...) entrypoint. Per HARD
// CONSTRAINTS this port edits only this test file (agent.ts is not touched to
// add exports), so every case below runs the ORIGINAL suite's golden
// brief/reply/raw_model_output fixtures (copied verbatim from
// agents/director/eval/classify-reply.cases.json) through the full governed
// runAgent() path, with a MockEngine standing in for the classify pass — the
// exact harness pattern the describe block above already established. This
// is an honest, not a diminished, reproduction: it exercises the guardrail and
// dispatch logic end to end, one layer up from a pure-function unit test.

// Golden briefs, verbatim from classify-reply.cases.json's `briefs` object.
const RESEARCH_BRIEF_2026_06_01 =
  `# Research Brief — 2026-06-01\n\n` +
  `## Section A — Techniques\n\n` +
  `### 2026-06-01.A1 Self-distilled agentic RL\nAgents learn from their own trajectories.\n\n` +
  `### 2026-06-01.A2 Verifier-gated emission\nA scalar verifier suppresses low-signal findings.\n\n` +
  `### 2026-06-01.A3 Memory plugin token reduction\nOpenClaw-style memory cuts tokens 30%.\n\n` +
  `## Section B — Market\n\n` +
  `### 2026-06-01.B1 Employee advocacy TAM\nMarket sizing 2024-2026.\n\n` +
  `### 2026-06-01.B2 Procurement gates\nSOC2/DPA/SSO gate enterprise deals.\n`;

const CURATOR_BRIEF_2026_06_02 =
  `# Curator Review — 2026-06-02\n\n` +
  `## Critical\n\n` +
  `**2026-06-02.C1** Tagline drift on the homepage hero.\n\n` +
  `**2026-06-02.C2** Mission-contradicting lock-in language in pricing copy.\n\n` +
  `## Warn\n\n` +
  `**2026-06-02.W1** Insider jargon "RAG" without a buyer-language gloss.\n`;

async function seedBriefAt(repo: string, rel: string, markdown: string): Promise<string> {
  await Bun.write(join(repo, rel), markdown);
  return rel;
}

// A MockEngine whose CLASSIFY response is exactly the given raw model output —
// the ported twin of the legacy suite's ReplayModel (one frozen recorded output
// per case). Every OTHER governed pass (spec/expand/fix drafts, fired dives)
// returns generic drafted prose, same as classifyingEngine() above.
function engineWithClassifyOutput(rawModelOutput: string): MockEngine {
  return new MockEngine((_agent, task) =>
    task.startsWith("CLASSIFY") ? rawModelOutput : "## Goal\nDraft body.\n## Approach\ndo the thing.",
  );
}

type Executed = { verb: string; item_id: string; status: string; artifact: string | null; note: string; verifier: string | null };

describe("director — reply-classification guardrails (ported from classify-reply.suite.mjs)", () => {
  test("drops an invented item ID but keeps the real one — never invent IDs (guardrail-invented-id)", async () => {
    const raw = JSON.stringify({
      intents: [
        { item_id: "2026-06-01.A1", verb: "approve", scope_hints: "", raw_reply_excerpt: "YES 2026-06-01.A1" },
        { item_id: "2026-06-01.Z9", verb: "approve", scope_hints: "", raw_reply_excerpt: "hallucinated" },
      ],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "YES 2026-06-01.A1", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(1);
    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed[0].item_id).toBe("2026-06-01.A1");
    expect(executed.some((e) => e.item_id === "2026-06-01.Z9")).toBe(false);
  });

  test("malformed JSON (unquoted keys) sanitizes to zero intents, never crashes (guardrail-malformed-json)", async () => {
    const engine = engineWithClassifyOutput("Sure! {intents: [{item_id: 2026-06-01.A1, verb: approve}]}");
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "YES 2026-06-01.A1", flags: { brief, date: "2026-06-01" } },
    });

    // The RUN is still governed (ok=true) — it's the SANITIZATION under test.
    expect(result.ok).toBe(true);
    expect(result.intents).toBe(0);
    expect(result.unresolved).toBe(1);
    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed[0].status).toBe("unresolved");
    expect(executed[0].note).toBe("classifier returned malformed JSON");
    expect(engine.calls).toHaveLength(1); // nothing valid ever reached dispatch
  });

  test("no JSON object anywhere in the output → zero intents (guardrail-no-json)", async () => {
    const engine = engineWithClassifyOutput("I'm not sure what you'd like me to do here.");
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "hmm", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(0);
    expect(result.unresolved).toBe(1);
    const executed = result.executed as Executed[];
    expect(executed[0].note).toBe("classifier returned no JSON");
  });

  test("a non-canonical verb is dropped — canonical verbs only (guardrail-unknown-verb)", async () => {
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-01.A1", verb: "build", scope_hints: "", raw_reply_excerpt: "build 2026-06-01.A1" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "build 2026-06-01.A1", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(0);
    expect(result.executed as Executed[]).toHaveLength(0);
    expect(engine.calls).toHaveLength(1); // never dispatched
  });

  test("an unqualified ID without the date prefix is dropped — malformed ID (guardrail-malformed-id)", async () => {
    const raw = JSON.stringify({
      intents: [{ item_id: "A1", verb: "approve", scope_hints: "", raw_reply_excerpt: "YES A1" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "YES A1", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(0);
    expect(result.executed as Executed[]).toHaveLength(0);
  });
});

describe("director — classification fidelity / no-misroute discipline (ported eval cases)", () => {
  test("multiple intents in one reply dispatch independently, each to its own verb (multi-intent)", async () => {
    const raw = JSON.stringify({
      intents: [
        { item_id: "2026-06-01.A1", verb: "approve", scope_hints: "", raw_reply_excerpt: "YES 2026-06-01.A1" },
        { item_id: "2026-06-01.B1", verb: "dive", scope_hints: "", raw_reply_excerpt: "DIVE 2026-06-01.B1" },
        { item_id: "2026-06-01.A3", verb: "skip", scope_hints: "", raw_reply_excerpt: "SKIP 2026-06-01.A3" },
      ],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "YES 2026-06-01.A1, DIVE 2026-06-01.B1, SKIP 2026-06-01.A3", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(3);
    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(3); // no cross-contamination: each item lands exactly once
    expect(executed.find((e) => e.item_id === "2026-06-01.A1")?.verb).toBe("approve");
    expect(executed.find((e) => e.item_id === "2026-06-01.B1")?.verb).toBe("dive");
    expect(executed.find((e) => e.item_id === "2026-06-01.A3")?.verb).toBe("skip");
  });

  test("one verb applied across a whole section dispatches to every item independently (section-command)", async () => {
    const raw = JSON.stringify({
      intents: [
        { item_id: "2026-06-01.A1", verb: "skip", scope_hints: "", raw_reply_excerpt: "SKIP A" },
        { item_id: "2026-06-01.A2", verb: "skip", scope_hints: "", raw_reply_excerpt: "SKIP A" },
        { item_id: "2026-06-01.A3", verb: "skip", scope_hints: "", raw_reply_excerpt: "SKIP A" },
      ],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "SKIP A", flags: { brief, date: "2026-06-01" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(3);
    expect(executed.every((e) => e.verb === "skip" && e.status === "dismissed")).toBe(true);
    expect(engine.calls).toHaveLength(1); // skip is pure state — no drafting fan-out
  });

  test("dispatch executes exactly the classified verb, even a realistic misclassification — no silent reinterpretation (model-error-misclassified-verb)", async () => {
    // The recorded model read "let's look closer" (a DIVE cue) as an approve.
    // Director's job is boundary discipline, not model quality: it dispatches
    // whatever the governed classify pass certified, and never second-guesses it.
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-01.A2", verb: "approve", scope_hints: "", raw_reply_excerpt: "let's look closer at 2026-06-01.A2" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "let's look closer at 2026-06-01.A2 before deciding", flags: { brief, date: "2026-06-01" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed[0].verb).toBe("approve");
    expect(executed[0].status).toBe("in-progress"); // spec-drafted, not delegated as a dive
  });

  test("Director never adds intents beyond what the classifier emitted — no rogue text-scanning fallback (model-error-missed-intent)", async () => {
    // The reply names two items but the recorded classifier only emitted one —
    // Director must act on exactly what came back, never infer the missing one
    // from the raw reply text itself.
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-01.A1", verb: "approve", scope_hints: "", raw_reply_excerpt: "YES 2026-06-01.A1" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "YES 2026-06-01.A1 and dive into 2026-06-01.B2", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(1);
    expect(result.unresolved).toBe(0);
    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed.some((e) => e.item_id === "2026-06-01.B2")).toBe(false);
  });

  test("a reply with no actionable intent executes nothing (no-action)", async () => {
    const raw = JSON.stringify({ intents: [], unresolved: [] });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "thanks, got it — great brief this week", flags: { brief, date: "2026-06-01" } },
    });

    expect(result.intents).toBe(0);
    expect(result.unresolved).toBe(0);
    expect(result.executed as Executed[]).toHaveLength(0);
    const log = await Bun.file(join(repo, result.actionsLog as string)).text();
    expect(log).toContain("_No actions this run._");
  });
});

describe("director — verb dispatch coverage: skip / expand / fix (ported eval cases)", () => {
  test("skip dispatches to a dismissed pure-state entry, no draft, no delegation (skip-single)", async () => {
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-01.A3", verb: "skip", scope_hints: "", raw_reply_excerpt: "SKIP 2026-06-01.A3" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "SKIP 2026-06-01.A3", flags: { brief, date: "2026-06-01" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toEqual([
      { verb: "skip", item_id: "2026-06-01.A3", status: "dismissed", artifact: null, note: "dismissed", verifier: null },
    ]);
    expect(engine.calls).toHaveLength(1); // classify only — skip never drafts

    const log = await Bun.file(join(repo, result.actionsLog as string)).text();
    expect(log).toContain("Dismissed");
  });

  test("expand drafts a deeper-context follow-up under the boundary and attests it (expand-single)", async () => {
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-01.B2", verb: "expand", scope_hints: "", raw_reply_excerpt: "can you explain 2026-06-01.B2 more?" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const c = comb();
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/research/2026-06-01-brief.md", RESEARCH_BRIEF_2026_06_01);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: "can you explain 2026-06-01.B2 more?", flags: { brief, date: "2026-06-01" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed[0].status).toBe("drafted");
    expect(executed[0].artifact).toBe("wiki/director/expansions/2026-06-01-2026-06-01.B2.md");

    const doc = await Bun.file(join(repo, executed[0].artifact as string)).text();
    expect(doc).toContain("# Expand · 2026-06-01.B2 · 2026-06-01");
    expect(doc).toContain("actor≠verifier");

    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(2); // classify leaf + expand leaf
  });

  test("fix drafts a fix-spec keyed off the FINDING's own date, not the run date (curator-fix)", async () => {
    const raw = JSON.stringify({
      intents: [{ item_id: "2026-06-02.C1", verb: "fix", scope_hints: "", raw_reply_excerpt: "FIX 2026-06-02.C1" }],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/curator/reviews/2026-06-02-review.md", CURATOR_BRIEF_2026_06_02);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      // Run date deliberately differs from the finding's own embedded date, to
      // prove the fix artifact path is keyed off the finding ID, not "today".
      input: { text: "FIX 2026-06-02.C1", flags: { brief, date: "2026-07-07", source: "curator" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(1);
    expect(executed[0].artifact).toBe("wiki/director/fixes/2026-06-02-C1-c1.md");

    const doc = await Bun.file(join(repo, executed[0].artifact as string)).text();
    expect(doc).toContain("finding_id: 2026-06-02.C1");
    expect(doc).toContain("verb: fix");
  });

  test("FIX applied to multiple critical findings drafts one independent spec per finding, no cross-contamination (curator-fix-all-critical)", async () => {
    const raw = JSON.stringify({
      intents: [
        { item_id: "2026-06-02.C1", verb: "fix", scope_hints: "", raw_reply_excerpt: "FIX all critical" },
        { item_id: "2026-06-02.C2", verb: "fix", scope_hints: "", raw_reply_excerpt: "FIX all critical" },
      ],
      unresolved: [],
    });
    const engine = engineWithClassifyOutput(raw);
    const repo = tmpRepo();
    const brief = await seedBriefAt(repo, "wiki/curator/reviews/2026-06-02-review.md", CURATOR_BRIEF_2026_06_02);

    const { result } = await runAgent("director", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "FIX all critical", flags: { brief, date: "2026-06-02", source: "curator" } },
    });

    const executed = result.executed as Executed[];
    expect(executed).toHaveLength(2);
    const artifacts = executed.map((e) => e.artifact).sort();
    expect(artifacts).toEqual(["wiki/director/fixes/2026-06-02-C1-c1.md", "wiki/director/fixes/2026-06-02-C2-c2.md"]);
  });
});

// NOT PORTED — the legacy suite's AGGREGATE statistical gates (THRESHOLDS:
// macroF1 >= 0.8, accuracy >= 0.8, guardrailRate == 1.0 over the whole golden
// set, computed by lib/agix-eval/scorers.mjs + harness.mjs's gate()). Those
// measure the REAL classifier's quality across many cases scored together, and
// need either a live model call or a large frozen-replay corpus aggregated by
// that scoring library — neither fits a hermetic $0 bun:test, where every case
// above supplies its OWN mocked classify output (there is no single "real"
// classification run to be macro-F1/accuracy-scored against; every case is
// independently authoritative by construction). The per-case adversarial
// assertions above (guardrail sanitization + no-misroute dispatch fidelity) are
// the hermetic-appropriate reduction of this suite. The aggregate quality gate
// belongs in a live eval run (agents/director/eval/, --live), not a unit test.
test.todo(
  "classify-reply aggregate gates (macro-F1 >= 0.8, accuracy >= 0.8, guardrailRate == 1.0) need a live-model golden-set eval — not reproducible in a hermetic bun:test",
);
