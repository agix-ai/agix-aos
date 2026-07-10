// Research agent tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn agents/research/agent.ts against a MOCKED governed engine
// + in-memory Comb and asserts:
//   - the brief runs GOVERNED (one pass, a DISTINCT verifier certifies — actor≠verifier);
//   - the six-section brief is written under the boundary (wiki/research/) and
//     recorded as an ATTESTED Comb leaf;
//   - the wiki log is appended (weekly brief only);
//   - a topic DIVE writes a dive-named sub-brief and does NOT touch the wiki log;
//   - an empty registry is a soft no-sources return (no governed spend);
//   - smoke short-circuits to a single governed surface check.
//
// It also PORTS the legacy adversarial eval suite
// (agents/research/eval/brief-structure.suite.mjs) forward, re-expressing its
// deterministic scorers against the reborn agent's real composed brief:
//   - the six-section format contract (structure checklist);
//   - the "≤3 techniques, each with a Why-for-Agix line" IFEval constraints;
//   - citation discipline + no-invented-sources (every URL cited above the source
//     log is logged, all hosts are known sources) — and a negative case proving the
//     checks have teeth against a malformed brief;
// and it covers the newly-ported DRY-RUN email delivery seam (ctx.sendEmail):
//   - requested delivery (--send) queues exactly ONE recorded dry-run email, no live
//     send; --to overrides the declared recipient; the default (no flag) sends nothing.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { DryRunNotifier } from "../runtime/notify.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-research-"));
}

// A registered-verifier MemComb so writes actually attest (mirrors the Go roster).
function comb(): MemComb {
  return new MemComb({ roster: ["research/worker/verifier-1"], trustFloor: 0.35 });
}

// Seed a minimal two-source registry into the tmp repo so the parse + forage-target
// path is exercised for real (the agent reads agents/research/sources.yaml).
async function seedSources(repo: string): Promise<void> {
  const yaml = `sources:
  - name: Anthropic Engineering
    url: https://www.anthropic.com/engineering
    kind: html
    priority: 5
    notes: First-party agent + context-engineering posts.

  - name: arXiv cs.AI agent papers
    url: https://arxiv.org/list/cs.AI/recent
    kind: arxiv-query
    priority: 4
    notes: Keyword filter on agent, trajectory, verifier.
`;
  await Bun.write(join(repo, "agents/research/sources.yaml"), yaml);
}

const DATE = "2026-07-07";

// A production-shaped six-section brief BODY (sections 1-5; the agent appends the
// governed self-grade as §6). Every URL cited in the prose above the source log is
// logged in §5, and every host is a known source — so it passes the ported
// citation-discipline + no-invented-sources scorers. Two techniques, each with a
// Why-for-Agix line (IFEval: ≤3, each with a Why). This is what the governed hive
// "returns"; the agent frames it into the final brief.
const SIX_SECTION_BRIEF = `Weekly field-state brief for the operator. 2 sources scanned; items above the relevance threshold.

## 1. New techniques worth tracking (≤3)

### Self-distilled agentic RL
Agents learn from their own execution trajectories without an external teacher, per [Self-Distilled Agentic RL](https://arxiv.org/abs/2605.15155). The loop closes between trajectory collection and policy improvement.
**Why for Agix:** A working reference for the trajectory-based RL the verifier loop needs.

### Verifier-gated emission
A scalar verifier suppresses low-signal findings before they reach the operator, as [Anthropic Engineering](https://www.anthropic.com/engineering) describes, lifting precision at fixed recall.
**Why for Agix:** Directly applicable to the Director deploy-health emission gate.

## 2. Reframe an Agix assumption (1)

We assumed weekly cadence is enough; the evidence in [Anthropic Engineering](https://www.anthropic.com/engineering) says reply latency, not scan latency, is the bottleneck.

## 3. "If Agix built this" opportunity (1)

An eval-as-a-service layer for downloadable agent packs. No incumbent ships per-agent regression gates; the Agix wedge is the owned second-brain corpus that seeds golden datasets.

## 4. New failure modes or risks

- **Position bias** — LLM judges can flip pairwise verdicts depending on order; run both orders. See [Position bias benchmark](https://github.com/lechmazur/position_bias). Severity: high.

## 5. Source log

1. [Self-Distilled Agentic RL](https://arxiv.org/abs/2605.15155) — trajectory RL without an external teacher.
2. [Anthropic Engineering](https://www.anthropic.com/engineering) — first-party agent + context-engineering posts.
3. [Position bias benchmark](https://github.com/lechmazur/position_bias) — judge order sensitivity.
`;

// A governed engine that returns the well-formed six-section brief for any synthesis
// task (mirrors secretary.test.ts's triagingEngine). Lets the ported eval score the
// agent's REAL composed artifact, not the generic default mock string.
function sixSectionEngine(): MockEngine {
  return new MockEngine(() => SIX_SECTION_BRIEF);
}

// ── Ported brief-structure eval — the deterministic scorers from
// agents/research/eval/brief-structure.suite.mjs, re-expressed here as plain
// assertions over the reborn agent's composed brief. ─────────────────────────────
const REQUIRED_SECTIONS = [
  /##\s*1\.\s*New techniques/i,
  /##\s*2\.\s*Reframe/i,
  /##\s*3\.\s*.{0,4}If Agix built this/i,
  /##\s*4\.\s*New failure modes/i,
  /##\s*5\.\s*Source log/i,
  /##\s*6\.\s*Self-grade/i,
];
const KNOWN_SOURCE_HOSTS = ["arxiv.org", "anthropic.com", "github.com", "ar5iv", "openai.com", "berkeley.edu", "aisi"];

function hasAllSections(text: string): boolean {
  return REQUIRED_SECTIONS.every((re) => re.test(text));
}

// Count "### " technique headings + "**Why for Agix:**" lines inside §1 (between
// "## 1." and "## 2."). Ported verbatim from the suite's section1TechniqueCount.
function section1TechniqueCount(text: string): { count: number; why: number } {
  const m = text.match(/##\s*1\.[\s\S]*?(?=\n##\s*2\.|$)/);
  if (!m) return { count: 0, why: 0 };
  const block = m[0];
  return {
    count: (block.match(/\n###\s+/g) || []).length,
    why: (block.match(/\*\*Why for Agix:\*\*/g) || []).length,
  };
}

function distinctUrls(text: string): string[] {
  const urls = [...text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]);
  return [...new Set(urls)];
}

function isKnownHost(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return false;
  }
  return KNOWN_SOURCE_HOSTS.some((h) => host.includes(h));
}

describe("research (scout / worker)", () => {
  test("brief mode runs ONE governed synthesis, writes the brief + wiki log, attests the Comb leaf", async () => {
    const engine = new MockEngine();
    const c = comb();
    const repo = tmpRepo();
    await seedSources(repo);

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { flags: { date: DATE } },
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("brief");
    // governed: a DISTINCT verifier certified (actor≠verifier).
    expect(result.verifier).toBe("research/worker/verifier-1");
    expect(result.queen).toBe("research/queen/root");
    expect(result.verifier).not.toBe(result.queen);
    expect(result.sourcesScanned).toBe(2);
    // email is NOT ported — the agent must not claim to have emailed.
    expect(result.emailed).toBe(false);
    // exactly one governed unit of work ran (the scan→synth→verify collapse), at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("research");

    // the brief landed under the boundary (wiki/research/) with the six-section
    // frontmatter + the governed self-grade.
    expect(result.brief).toBe(`wiki/research/${DATE}-brief.md`);
    const doc = await Bun.file(join(repo, result.brief as string)).text();
    expect(doc).toContain("type: research-brief");
    expect(doc).toContain(`verified_by: research/worker/verifier-1`);
    expect(doc).toContain("## 6. Self-grade");
    expect(doc).toContain("actor≠verifier");

    // the wiki log was appended.
    const log = await Bun.file(join(repo, "wiki/log.md")).text();
    expect(log).toContain(`## ${DATE} — Research Agent: brief published`);

    // the brief was recorded as an ATTESTED Comb leaf.
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("dive mode writes a topic-named sub-brief and does NOT touch the wiki log", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    await seedSources(repo);

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { flags: { date: DATE, topic: "trajectory RL" } },
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dive");
    expect(result.topic).toBe("trajectory RL");
    expect(result.verifier).toBe("research/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
    // the task carried the topic focus into the governed pass.
    expect(engine.calls[0].task).toContain("trajectory RL");

    // dive filename carries the topic slug; the doc declares research-dive.
    expect(result.brief).toBe(`wiki/research/${DATE}-dive-trajectory-rl.md`);
    const doc = await Bun.file(join(repo, result.brief as string)).text();
    expect(doc).toContain("type: research-dive");
    expect(doc).toContain("dive_topic: trajectory RL");

    // a dive is Director-owned notification territory: no wiki-log entry.
    const log = Bun.file(join(repo, "wiki/log.md"));
    expect(await log.exists()).toBe(false);
  });

  test("an empty registry is a soft no-sources return — no governed spend", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo(); // no sources.yaml seeded

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { flags: { date: DATE } },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-sources");
    // it never spent a governed unit.
    expect(engine.calls.length).toBe(0);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { flags: { date: DATE } },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("research/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });
});

describe("research — ported brief-structure eval (adversarial scorers)", () => {
  test("the composed brief satisfies the 6-section format + IFEval + citation discipline", async () => {
    const engine = sixSectionEngine();
    const repo = tmpRepo();
    await seedSources(repo);

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { flags: { date: DATE } },
    });
    const doc = await Bun.file(join(repo, result.brief as string)).text();

    // (1) Six-section format contract — all six required sections present, in shape.
    expect(hasAllSections(doc)).toBe(true);

    // (2) IFEval: at most 3 techniques in §1, each with a bold Why-for-Agix line.
    const { count, why } = section1TechniqueCount(doc);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
    expect(why).toBeGreaterThanOrEqual(count);

    // (3) Citation discipline: ≥3 distinct markdown-link citations, all to KNOWN
    //     source hosts — never a constructed/guessed host.
    const cited = distinctUrls(doc);
    expect(cited.length).toBeGreaterThanOrEqual(3);
    for (const u of cited) expect(isKnownHost(u)).toBe(true);

    // (4) No invented sources: every URL cited in the prose ABOVE the source log
    //     has exactly its entry in the §5 source log (nothing cited is unlogged).
    const idx = doc.search(/##\s*5\.\s*Source log/i);
    const aboveLog = distinctUrls(doc.slice(0, idx));
    const logged = new Set(distinctUrls(doc.slice(idx)));
    for (const u of aboveLog) expect(logged.has(u)).toBe(true);

    // The governed self-grade IS §6 (actor≠verifier) — the reborn critic pass.
    expect(doc).toContain("## 6. Self-grade");
    expect(doc).toContain("actor≠verifier");
  });

  test("the ported scorers have teeth: a malformed brief FAILS structure + IFEval", () => {
    // Missing §3/§4/§6, four techniques, zero Why lines — the exact malformed shape
    // the legacy suite's unit tests proved the scorers reject.
    const malformed = [
      "## 1. New techniques worth tracking",
      "### A\ngist a",
      "### B\ngist b",
      "### C\ngist c",
      "### D\ngist d",
      "## 2. Reframe an Agix assumption\n\nsomething",
      "## 5. Source log\n\n- nothing here",
    ].join("\n\n");

    expect(hasAllSections(malformed)).toBe(false); // §3/§4/§6 absent
    const { count, why } = section1TechniqueCount(malformed);
    expect(count).toBeGreaterThan(3); // 4 techniques → violates ≤3
    expect(why).toBe(0); // no Why-for-Agix lines
  });
});

describe("research — dry-run email delivery (ctx.sendEmail seam)", () => {
  test("requested delivery (--send) queues EXACTLY ONE recorded dry-run email, no live send", async () => {
    const engine = sixSectionEngine();
    const repo = tmpRepo();
    await seedSources(repo);
    const notifier = new DryRunNotifier(() => {}); // silent; we read .emails back

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: repo,
      input: { flags: { date: DATE, send: true } },
    });

    // Delivered via the notify seam, DRY-RUN: recorded/queued, nothing actually sent.
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("brief");
    expect(result.emailed).toBe(true);
    expect(result.emailMode).toBe("dry-run");

    // Exactly ONE recorded email, and NO live send (the DryRunNotifier never sends).
    expect(notifier.emails.length).toBe(1);
    expect(notifier.emails[0].to).toBe("operator"); // the declared email output surface
    expect(notifier.emails[0].subject).toContain(`Agix Research Brief — ${DATE}`);
    expect(notifier.emails[0].body).toContain("## 1. New techniques");
    expect(notifier.emails[0].body).toContain("## 6. Self-grade");

    // Delivery adds NO governed unit — still exactly one hive pass ($0).
    expect(engine.calls.length).toBe(1);
  });

  test("--to overrides the declared recipient", async () => {
    const engine = sixSectionEngine();
    const repo = tmpRepo();
    await seedSources(repo);
    const notifier = new DryRunNotifier(() => {});

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: repo,
      input: { flags: { date: DATE, send: true, to: "founder@example.com" } },
    });

    expect(result.emailed).toBe(true);
    expect(result.emailTo).toBe("founder@example.com");
    expect(notifier.emails.length).toBe(1);
    expect(notifier.emails[0].to).toBe("founder@example.com");
  });

  test("the default (no delivery flag) sends NOTHING", async () => {
    const engine = sixSectionEngine();
    const repo = tmpRepo();
    await seedSources(repo);
    const notifier = new DryRunNotifier(() => {});

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: repo,
      input: { flags: { date: DATE } }, // no --send
    });

    expect(result.emailed).toBe(false);
    expect(result.emailMode).toBe("none");
    expect(notifier.emails.length).toBe(0);
  });

  test("a dive never emails, even with --send (Director's notification territory)", async () => {
    const engine = sixSectionEngine();
    const repo = tmpRepo();
    await seedSources(repo);
    const notifier = new DryRunNotifier(() => {});

    const { result } = await runAgent("research", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier,
      repoRoot: repo,
      input: { flags: { date: DATE, topic: "trajectory RL", send: true } },
    });

    expect(result.mode).toBe("dive");
    expect(result.emailed).toBe(false);
    expect(notifier.emails.length).toBe(0);
  });
});
