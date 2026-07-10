// Architect port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn architect (agents/architect/agent.ts) and runs it against a
// MOCKED governed engine + in-memory Comb, asserting:
//   - it executes GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - it re-renders ONLY the ARCHITECT marker section of a spec (marker-replace),
//     preserving the operator's hand edits, and is idempotent across re-runs;
//   - a well-formed brief item survives the defensive filter and is rendered;
//   - it feeds the Comb an attested annotation leaf;
//   - smoke short-circuits to a single governed surface check;
//   - with NO spec named it AUTO-DISCOVERS specs via a governed glob pass, and
//     an empty repo is a clean no-op after that one discovery pass;
//   - an architecture conflict is verified against the globbed architecture index
//     (no longer force-dropped) and rendered.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { filterScanResult } from "../../agents/architect/agent.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");
const MARKER_BEGIN = "<!-- ARCHITECT:BEGIN -->";
const MARKER_END = "<!-- ARCHITECT:END -->";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-architect-"));
}

// A registered-verifier MemComb so the annotation leaf actually attests.
function comb(): MemComb {
  return new MemComb({ roster: ["architect/worker/verifier-1"], trustFloor: 0.35 });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Seed one shared spec + one recent brief in a fresh repo. Returns the paths.
async function seedRepo(root: string, specBody: string): Promise<{ specRel: string; briefRel: string; date: string }> {
  const date = today();
  const specRel = "wiki/director/specs/reborn-runtime.md";
  const briefRel = `wiki/research/${date}-brief.md`;
  await Bun.write(join(root, specRel), specBody);
  await Bun.write(
    join(root, briefRel),
    `# Research brief ${date}\n\n## ${date}.A1 — cheap-model distillation beats routing\n\nEvidence the hive should cite.\n`,
  );
  return { specRel, briefRel, date };
}

// A governed engine whose answer is a strict-JSON scan that references the seeded
// brief item — so it survives the defensive filter and gets rendered. The governed
// glob DISCOVERY pass (task starts with "DISCOVERY.") gets an empty result, so a
// named-spec run falls back to the named spec + the date-window brief probe.
function scanEngine(date: string, briefRel: string): MockEngine {
  const scan = JSON.stringify({
    applies: [
      { item_id: `${date}.A1`, brief_path: briefRel, relevance: "AC-02 evidence base", note: "materially changes the cited evidence." },
    ],
    duplicates: [],
    roadmap_impact: [],
    architecture_conflicts: [],
  });
  return new MockEngine((_agent, task) =>
    task.startsWith("DISCOVERY") ? JSON.stringify({ specs: [], briefs: [], arch: [] }) : scan,
  );
}

// A governed engine that answers the DISCOVERY glob pass with the given paths and
// every scan pass with the given scan JSON — so a NO-spec-named run auto-discovers.
function discoverEngine(discovery: { specs?: string[]; briefs?: string[]; arch?: string[] }, scan: object): MockEngine {
  return new MockEngine((_agent, task) =>
    task.startsWith("DISCOVERY")
      ? JSON.stringify({ specs: discovery.specs ?? [], briefs: discovery.briefs ?? [], arch: discovery.arch ?? [] })
      : JSON.stringify(scan),
  );
}

describe("architect (CTO cross-reference / worker)", () => {
  test("runs a governed scan, writes ONLY the marker section, feeds an attested leaf", async () => {
    const repo = tmpRepo();
    const handEdit = "# Reborn runtime spec\n\n## Problem\n\nOperator's hand-written body — must survive.\n";
    const { specRel, briefRel, date } = await seedRepo(repo, handEdit);
    const engine = scanEngine(date, briefRel);
    const c = comb();

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { mode: specRel, args: [], text: specRel, flags: { date } },
    });

    // governed + actor≠verifier
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("architect/worker/verifier-1");
    expect(result.verifier).not.toBe("architect/queen/root");
    // two governed passes: the glob DISCOVERY pass, then one scan pass for the spec.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].task.startsWith("DISCOVERY")).toBe(true);
    expect(engine.calls[0].agent).toBe("architect");
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(1);

    // the spec now carries the marker block, the operator's body is preserved
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).toContain(MARKER_BEGIN);
    expect(written).toContain(MARKER_END);
    expect(written).toContain("## Related new findings");
    expect(written).toContain("Applies to this spec:");
    expect(written).toContain(`${date}.A1`);
    expect(written).toContain("Operator's hand-written body — must survive."); // hand edit intact

    // the annotation was recorded, attested by the DISTINCT verifier
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("re-running replaces the marker section, never duplicates it (idempotent)", async () => {
    const repo = tmpRepo();
    const { specRel, briefRel, date } = await seedRepo(repo, "# Spec\n\n## Problem\n\nBody.\n");
    const engine = scanEngine(date, briefRel);

    const opts = {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { mode: specRel, args: [], text: specRel, flags: { date } },
    };
    await runAgent("architect", opts);
    await runAgent("architect", { ...opts, comb: comb() });

    const written = await Bun.file(join(repo, specRel)).text();
    const begins = written.split(MARKER_BEGIN).length - 1;
    const ends = written.split(MARKER_END).length - 1;
    expect(begins).toBe(1); // exactly one marker block after two runs
    expect(ends).toBe(1);
  });

  test("smoke short-circuits to a single governed surface check — no spec write", async () => {
    const repo = tmpRepo();
    const { specRel, briefRel, date } = await seedRepo(repo, "# Spec\n\n## Problem\n\nBody.\n");
    const engine = scanEngine(date, briefRel);

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      smoke: true,
      input: { mode: specRel, args: [], text: specRel, flags: { date } },
    });

    expect(result.smoke).toBe(true);
    expect(result.verifier).toBe("architect/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
    // the spec was NOT annotated in smoke mode
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).not.toContain(MARKER_BEGIN);
  });

  test("no spec named → AUTO-DISCOVERS specs via the governed glob pass, then scans them", async () => {
    const repo = tmpRepo();
    const { specRel, briefRel, date } = await seedRepo(repo, "# Reborn spec\n\n## Problem\n\nBody.\n");
    // The discovery pass returns the seeded (un-named) spec + brief; the scan pass
    // references the brief item so it renders.
    const engine = discoverEngine(
      { specs: [specRel], briefs: [briefRel] },
      { applies: [{ item_id: `${date}.A1`, brief_path: briefRel, relevance: "evidence", note: "applies." }], duplicates: [], roadmap_impact: [], architecture_conflicts: [] },
    );

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [], text: "", flags: { date } }, // NO spec named
    });

    expect(result.ok).toBe(true);
    expect(result.specs).toBe(1); // discovered, not named
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(1);
    // call 0 is the glob DISCOVERY pass; call 1 is the scan of the discovered spec.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0].task.startsWith("DISCOVERY")).toBe(true);
    // the discovered spec was annotated.
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).toContain(MARKER_BEGIN);
    expect(written).toContain(`${date}.A1`);
  });

  test("empty repo → clean no-op after the single governed discovery pass", async () => {
    const engine = discoverEngine({ specs: [], briefs: [], arch: [] }, {});
    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { args: [], text: "", flags: {} }, // no spec named, nothing to discover
    });
    expect(result.ok).toBe(true);
    expect(result.specs).toBe(0);
    expect(engine.calls.length).toBe(1); // exactly the one glob discovery pass, then stop
    expect(engine.calls[0].task.startsWith("DISCOVERY")).toBe(true);
  });

  test("--no-discover with no spec named → clean no-op, ZERO governed passes", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { args: [], text: "", flags: { "no-discover": true } },
    });
    expect(result.ok).toBe(true);
    expect(result.specs).toBe(0);
    expect(engine.calls.length).toBe(0); // discovery suppressed → never ran a governed unit
  });

  test("an architecture conflict is verified against the globbed arch index and rendered", async () => {
    const repo = tmpRepo();
    const { specRel, briefRel, date } = await seedRepo(repo, "# Spec\n\n## Problem\n\nBody.\n");
    const archPath = "architecture/03-ai-ml/agent-architecture/AGENT_RUNTIME.md";
    // Discovery surfaces the arch doc; the scan cites it as a conflict. Without the
    // globbed index this would be force-dropped — now it is verified and rendered.
    const engine = discoverEngine(
      { specs: [], briefs: [], arch: [archPath] },
      {
        applies: [],
        duplicates: [],
        roadmap_impact: [],
        architecture_conflicts: [{ architecture_path: archPath, kind: "supersedes", section: "Runtime", note: "this spec supersedes it." }],
      },
    );

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { mode: specRel, args: [], text: specRel, flags: { date } }, // named spec
    });

    expect(result.architecture_conflicts).toBe(1);
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).toContain("Architecture conflicts:");
    expect(written).toContain(archPath);
    // a scan citing an arch path NOT in the globbed index is dropped (no invented paths).
    expect(briefRel).toBeTruthy(); // (seed sanity)
  });

  test("dry-run scans but does not write the spec", async () => {
    const repo = tmpRepo();
    const { specRel, briefRel, date } = await seedRepo(repo, "# Spec\n\n## Problem\n\nBody.\n");
    const engine = scanEngine(date, briefRel);

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { mode: specRel, args: [], text: specRel, flags: { date, "dry-run": true } },
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(engine.calls.length).toBe(2); // the discovery pass + the scan pass (it DID scan)
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).not.toContain(MARKER_BEGIN); // but did NOT write
  });
});

// ── Ported adversarial assertions from the legacy eval suite ──────────────────
// Source: agents/architect/eval/relevance-scan.suite.mjs + its gold corpus
// agents/architect/eval/relevance-scan.cases.json. That suite drove the real
// scanSpec() -> filterScanResult() path against recorded model output and scored
// the result by precision/recall/F1, gating a corpus-level guardrail-sanitization
// rate. Reborn has no corpus-eval harness (see the test.todo at the bottom), so
// each case's PER-CASE adversarial intent is re-expressed directly against the
// reborn agent's exported pure functions (filterScanResult) or, where the guarded
// code is not exported (parseScan is private), against the public runAgent()
// surface that exercises it internally.
const BRIEF_A = { date: "2026-06-01", path: "wiki/research/2026-06-01-brief.md", markdown: "# Brief 2026-06-01\n\n### 2026-06-01.A1 Self-distilled agentic RL\nAgents learn from their own trajectories.\n\n### 2026-06-01.A2 Verifier-gated emission\nA scalar verifier suppresses low-signal findings before emission.\n\n### 2026-06-01.A3 Second-brain memory plugin\nOpenClaw-style memory cuts tokens 30%." };
const BRIEF_B = { date: "2026-05-25", path: "wiki/research/2026-05-25-brief.md", markdown: "# Brief 2026-05-25\n\n### 2026-05-25.B1 Process reward models\nA verifier scores intermediate steps to gate outputs.\n\n### 2026-05-25.B2 Employee advocacy market\nMarket sizing 2024-2026." };
const GOLD_BRIEFS = [BRIEF_A, BRIEF_B];

describe("architect — defensive filter (ported from legacy relevance-scan eval)", () => {
  // legacy case: verifier-spec-applies-and-dup — a well-formed apply AND a
  // well-formed duplicate (both fields sourced from loaded briefs) must survive
  // the filter intact; the guardrail's job is provenance, not judgment.
  test("well-formed apply + well-formed duplicate both survive (verifier-spec-applies-and-dup)", () => {
    const scan = {
      applies: [
        { item_id: "2026-06-01.A2", brief_path: BRIEF_A.path, relevance: "directly the technique this spec implements", note: "" },
      ],
      duplicates: [
        { item_id: "2026-06-01.A2", brief_path: BRIEF_A.path, duplicate_of: "2026-05-25.B1", duplicate_brief_path: BRIEF_B.path, note: "PRM is the same idea" },
      ],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    expect(filtered.applies.length).toBe(1);
    expect(filtered.applies[0].item_id).toBe("2026-06-01.A2");
    expect(filtered.duplicates.length).toBe(1);
    expect(filtered.duplicates[0].duplicate_of).toBe("2026-05-25.B1");
  });

  // legacy case: guardrail-malformed-item-id — an un-qualified item_id ("A2", no
  // YYYY-MM-DD prefix) must be dropped; the well-formed sibling is kept.
  test("guardrail: un-qualified item_id (no date prefix) is dropped, valid one kept", () => {
    const scan = {
      applies: [
        { item_id: "2026-06-01.A1", brief_path: BRIEF_A.path, relevance: "x", note: "" },
        { item_id: "A2", brief_path: BRIEF_A.path, relevance: "x", note: "" },
      ],
      duplicates: [],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    expect(filtered.applies.length).toBe(1);
    expect(filtered.applies[0].item_id).toBe("2026-06-01.A1");
  });

  // legacy case: guardrail-invented-brief-path — an item attributed to a
  // brief_path that was never loaded must be dropped (no invented sources).
  test("guardrail: item attributed to a brief_path never loaded is dropped", () => {
    const scan = {
      applies: [{ item_id: "2026-06-01.A1", brief_path: "wiki/research/2099-01-01-brief.md", relevance: "x", note: "" }],
      duplicates: [],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    expect(filtered.applies.length).toBe(0);
  });

  // Same guardrail intent as the two cases above, extended to the duplicate
  // fields — filterScanResult applies the identical wellFormedItemId + real-path
  // checks to duplicate_of / duplicate_brief_path, so a malformed or invented
  // duplicate reference must be dropped exactly like a malformed/invented apply.
  // Not a distinct legacy case (the gold corpus only exercised applies for these
  // two guardrails), but the same adversarial intent applied to the sibling field
  // the reborn filter guards identically.
  test("guardrail: duplicate with un-qualified duplicate_of (no date prefix) is dropped", () => {
    const scan = {
      applies: [],
      duplicates: [
        { item_id: "2026-06-01.A2", brief_path: BRIEF_A.path, duplicate_of: "B1", duplicate_brief_path: BRIEF_B.path, note: "" },
      ],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    expect(filtered.duplicates.length).toBe(0);
  });

  test("guardrail: duplicate attributed to an invented duplicate_brief_path is dropped", () => {
    const scan = {
      applies: [],
      duplicates: [
        { item_id: "2026-06-01.A2", brief_path: BRIEF_A.path, duplicate_of: "2026-05-25.B1", duplicate_brief_path: "wiki/research/2099-01-01-brief.md", note: "" },
      ],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    expect(filtered.duplicates.length).toBe(0);
  });

  // legacy case: model-error-overapply-and-miss — a recorded model over-applies
  // a loosely-related item (false positive vs. gold) and misses another (false
  // negative). Both A1 and A2 are well-formed and sourced from a loaded brief, so
  // BOTH legitimately survive filterScanResult: the guardrail's job is provenance
  // and shape, not semantic correctness/relevance judgment. That is the honest
  // reborn behavior — see the test.todo below for what is NOT ported.
  test("over-applied but well-formed items are NOT caught by the structural filter (model-error-overapply-and-miss)", () => {
    const scan = {
      applies: [
        { item_id: "2026-06-01.A1", brief_path: BRIEF_A.path, relevance: "the core technique", note: "" },
        { item_id: "2026-06-01.A2", brief_path: BRIEF_A.path, relevance: "loosely related", note: "" },
      ],
      duplicates: [],
      roadmap_impact: [],
      architecture_conflicts: [],
    };
    const filtered = filterScanResult(scan, GOLD_BRIEFS, null, new Set());
    // gold for this case is {A1, A3} — A2 is a false positive and A3 (missed) is
    // a false negative. filterScanResult does not and should not catch either:
    // it passed both well-formed, real-provenance items through unchanged.
    expect(filtered.applies.length).toBe(2);
    expect(filtered.applies.map((a) => a.item_id)).toEqual(["2026-06-01.A1", "2026-06-01.A2"]);
  });

  // legacy case: guardrail-malformed-json — malformed JSON yields empty
  // annotations, never a crash. The reborn JSON-extraction step (parseScan) that
  // guards this is an unexported internal of agents/architect/agent.ts (unlike
  // filterScanResult, parseDiscovery, stripMarkerSection, applyMarkerBlock,
  // renderMarkerBlock, it carries no `export`), so it cannot be unit-tested
  // directly without editing agent.ts (out of scope — HARD CONSTRAINT: agent.ts
  // is read-only for this port). It IS still exercised for real on every governed
  // scan pass (agent.ts line ~142: `parseScan(r.answer)`), so the same adversarial
  // input is driven end-to-end through the public runAgent() surface instead.
  test("guardrail: a malformed-JSON governed answer degrades to zero annotations, never throws (end-to-end — parseScan is not exported)", async () => {
    const repo = tmpRepo();
    const { specRel, date } = await seedRepo(repo, "# Spec\n\n## Problem\n\nBody.\n");
    const engine = new MockEngine((_agent, task) =>
      task.startsWith("DISCOVERY") ? JSON.stringify({ specs: [], briefs: [], arch: [] }) : "Here you go: {applies: [oops not json",
    );

    const { result } = await runAgent("architect", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { mode: specRel, args: [], text: specRel, flags: { date } },
    });

    expect(result.ok).toBe(true); // no crash / no throw propagated
    expect(result.applied).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.roadmap_impact).toBe(0);
    expect(result.architecture_conflicts).toBe(0);
    const written = await Bun.file(join(repo, specRel)).text();
    expect(written).toContain(MARKER_BEGIN);
    expect(written).toContain("_No related findings since last scan._");
  });

  // GAP (honest regression finding, not ported): the legacy suite's aggregate()
  // computed a CORPUS-level precision/recall/F1 over every quality case plus a
  // guardrail-sanitization rate, and gated the run on THRESHOLDS = { f1: 0.7,
  // precision: 0.7, recall: 0.6 } (agents/architect/eval/relevance-scan.suite.mjs
  // lines 28, 83-112), backed by lib/agix-eval/{scorers,stats,harness}.mjs
  // (setCorrectness / proportionCI / gate) and a live-model replay path
  // (ReplayModel / ctx.live). Fleet's hermetic bun-test harness
  // (fleet/runtime/{runner,engine,comb}.ts) has no equivalent corpus-eval /
  // gold-scoring / live-replay surface — only per-case structural guardrails on
  // filterScanResult are portable here. Re-introducing the F1/precision/recall
  // gate would require a new fleet-side eval harness, which is out of scope for
  // this port (HARD CONSTRAINT: edit only fleet/tests/architect.test.ts).
  test.todo(
    "corpus-level annotation F1 >= 0.7 / precision >= 0.7 / guardrail-sanitization rate == 1.0 over the full gold case set — no corpus-eval/gold-scoring harness exists in fleet/tests (legacy: lib/agix-eval/{scorers,stats,harness}.mjs + relevance-scan.cases.json)",
  );
});
