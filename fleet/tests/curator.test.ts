// Curator port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real agents/curator/agent.ts against a MOCKED governed engine + an
// in-memory Comb, and asserts:
//   - the nuanced brand review runs GOVERNED (a distinct verifier certifies —
//     actor≠verifier);
//   - the free deterministic palette pre-scan flags an off-palette hex ($0, no
//     model);
//   - the legacy voice/marketing LLM findings (now the ONE governed pass) are
//     parsed back and merged into the report;
//   - the review is written under the write boundary (wiki/curator/) and a
//     review-summary leaf is attested in the Comb;
//   - smoke short-circuits to a single governed surface check;
//   - a commit with no marketing surface costs zero governed runs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

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
  return mkdtempSync(join(tmpdir(), "agix-curator-"));
}

// A registered-verifier MemComb so the review-summary leaf actually attests.
function comb(): MemComb {
  return new MemComb({ roster: ["curator/worker/verifier-1"], trustFloor: 0.35 });
}

// The governed pass returns structured findings as JSON — the reborn twin of the
// legacy voice.mjs/marketing.mjs `{ "findings": [...] }` contract.
const GOVERNED_JSON =
  '{"findings":[{"rule":"voice.tagline-drift","severity":"critical",' +
  '"file":"apps/website/src/app/globals.css","quote":"Scale your empire",' +
  '"detail":"Locked tagline paraphrased away."}]}';

describe("curator (marketing/brand guardrail — proposer / worker)", () => {
  test("runs a governed review, flags an off-palette hex, writes the report, attests a leaf", async () => {
    const repo = tmpRepo();
    // A brand rubric whose approved palette lists two hexes.
    await Bun.write(join(repo, "rubric.yaml"), "palette:\n  approved_hex:\n    - \"#14213D\"\n    - \"#B08840\"\n");
    // A marketing-surface file: one approved hex, one off-palette hex.
    const surface = "apps/website/src/app/globals.css";
    await Bun.write(join(repo, surface), ":root {\n  --ink: #14213D;\n  --bad: #123456;\n}\n");

    const engine = new MockEngine(() => GOVERNED_JSON);
    const c = comb();
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { args: [surface], flags: { rubric: "rubric.yaml" } },
    });

    // governed: a distinct verifier certified the review (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("curator/worker/verifier-1");
    expect(result.verifier).not.toBe("curator/queen/root");
    // exactly one governed unit of work ran, at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("curator");

    // the free deterministic scan caught the off-palette hex (#123456), not the
    // approved one (#14213D).
    expect(result.staticFindings).toBe(1);
    // the governed JSON finding was parsed back and merged.
    expect(result.governedFindings).toBe(1);
    expect(result.critical).toBeGreaterThanOrEqual(1);
    expect(result.filesReviewed).toBe(1);

    // the review landed under the write boundary and names both findings.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(result.report).toContain("wiki/curator/reviews/");
    expect(doc).toContain("palette.off-palette-hex");
    expect(doc).toContain("#123456");
    expect(doc).toContain("voice.tagline-drift");
    expect(doc).not.toContain("#14213D"); // approved hex is not flagged

    // a review-summary leaf was recorded AND attested (distinct verifier + trust).
    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("promotes an off-palette hex in a token file to critical", async () => {
    const repo = tmpRepo();
    await Bun.write(join(repo, "rubric.yaml"), "approved_hex: [\"#14213D\"]\n");
    const tokenFile = "packages/ui/tokens/colors.css";
    await Bun.write(join(repo, tokenFile), ":root { --x: #abcdef; }\n");

    const engine = new MockEngine(() => '{"findings":[]}');
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [tokenFile], flags: { rubric: "rubric.yaml" } },
    });
    expect(result.ok).toBe(true);
    expect(result.staticFindings).toBe(1);
    expect(result.critical).toBe(1); // token-file violation → critical
  });

  test("smoke short-circuits to a single governed surface check (no review written)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { args: [] },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("curator/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
    expect(result.report).toBeUndefined();
  });

  test("a commit with no marketing surface costs zero governed runs", async () => {
    const repo = tmpRepo();
    const engine = new MockEngine();
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      // a backend-only path, outside the surface globs.
      input: { args: ["core/agentspec/spec.go"] },
    });
    expect(result.ok).toBe(true);
    expect(result.filesReviewed).toBe(0);
    expect(result.findings).toBe(0);
    // never ran a governed unit — no model cost on a backend-only commit.
    expect(engine.calls.length).toBe(0);
    // still wrote a zero-finding audit report.
    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("No marketing-surface files changed");
  });
});

// Ported from agents/curator/eval/voice.suite.mjs + eval/voice.cases.json — the
// legacy critic eval for the four voice rules (voice.no-insider-jargon,
// voice.mission-alignment, voice.tone-calibration, voice.tagline-drift). The
// reborn agent.ts collapses those four separate per-rule LLM calls (see its NOT
// PORTED note) into ONE governed ctx.hive.run() pass whose JSON is parsed back by
// parseGovernedFindings(); these tests drive that real parse+merge+report path
// with a MockEngine standing in for the governed hive, per-case, matching the
// prose/expected shape of each gold case in voice.cases.json. HERMETIC ($0/offline).
describe("curator voice discipline (ported from eval/voice.suite.mjs)", () => {
  test("flags insider AI jargon used without a buyer-language gloss (voice.no-insider-jargon, warn) — case: jargon-violation", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <p>Our platform uses RAG to surface answers from your knowledge base in milliseconds.</p>;\n}\n",
    );
    const findingsJSON =
      '{"findings":[{"rule":"voice.no-insider-jargon","severity":"warn",' +
      '"file":"apps/website/src/app/page.tsx",' +
      '"quote":"Our platform uses RAG to surface answers from your knowledge base in milliseconds.",' +
      '"detail":"Insider term \\"RAG\\" without a buyer-language gloss in proximity."}]}';
    const engine = new MockEngine(() => findingsJSON);
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    expect(result.staticFindings).toBe(0); // no off-palette hex in copy-only prose
    expect(result.governedFindings).toBe(1);
    expect(result.warn).toBe(1);
    expect(result.critical).toBe(0);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("voice.no-insider-jargon");
    expect(doc).toContain("Our platform uses RAG to surface answers from your knowledge base in milliseconds.");
  });

  test("flags mission/vendor lock-in language as critical (voice.mission-alignment) — case: mission-lock-in", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <p>With Agix managed hosting you will always need us to keep your agents running smoothly.</p>;\n}\n",
    );
    const findingsJSON =
      '{"findings":[{"rule":"voice.mission-alignment","severity":"critical",' +
      '"file":"apps/website/src/app/page.tsx",' +
      '"quote":"you will always need us to keep your agents running smoothly",' +
      '"detail":"Implies vendor lock-in; contradicts the foundation-you-own-and-grow framing."}]}';
    const engine = new MockEngine(() => findingsJSON);
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    expect(result.governedFindings).toBe(1);
    expect(result.critical).toBe(1);
    expect(result.warn).toBe(0);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("voice.mission-alignment");
    expect(doc).toContain("you will always need us to keep your agents running smoothly");
  });

  test("flags a paraphrased/replaced tagline as critical (voice.tagline-drift) — case: tagline-drift", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <h1>Agix: build AI that just works, out of the box.</h1>;\n}\n",
    );
    const findingsJSON =
      '{"findings":[{"rule":"voice.tagline-drift","severity":"critical",' +
      '"file":"apps/website/src/app/page.tsx",' +
      '"quote":"build AI that just works",' +
      '"detail":"Locked tagline paraphrased away — replaces \\"Scale your AI organically\\" with a different tagline."}]}';
    const engine = new MockEngine(() => findingsJSON);
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    expect(result.governedFindings).toBe(1);
    expect(result.critical).toBe(1);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("voice.tagline-drift");
    expect(doc).toContain("build AI that just works");
  });

  test("flags off-brand, generic-SaaS tone as a warn (voice.tone-calibration) — case: mixed-with-fp-and-fn (tone leg)", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <p>We are the synergy partner for your journey.</p>;\n}\n",
    );
    const findingsJSON =
      '{"findings":[{"rule":"voice.tone-calibration","severity":"warn",' +
      '"file":"apps/website/src/app/page.tsx",' +
      '"quote":"We are the synergy partner for your journey.",' +
      '"detail":"Generic-SaaS hype; off-brand for a restrained, architect-led voice."}]}';
    const engine = new MockEngine(() => findingsJSON);
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    expect(result.governedFindings).toBe(1);
    expect(result.warn).toBe(1);
    expect(result.critical).toBe(0);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("voice.tone-calibration");
    expect(doc).toContain("We are the synergy partner for your journey.");
  });

  test("on-mission, jargon-free copy produces zero governed findings — case: clean-copy", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <p>Agix installs the AI foundation you own and grow. Start with a Discovery sprint and keep everything we build together.</p>;\n}\n",
    );
    const engine = new MockEngine(() => '{"findings":[]}');
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    expect(result.filesReviewed).toBe(1);
    expect(result.findings).toBe(0);
    expect(result.critical).toBe(0);
    expect(result.warn).toBe(0);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("No findings. Clean run.");
  });

  test("merges multiple simultaneous voice findings from one governed pass — case: mixed-with-fp-and-fn (findings shape only, no scoring)", async () => {
    const repo = tmpRepo();
    const surface = "apps/website/src/app/page.tsx";
    await Bun.write(
      join(repo, surface),
      "export default function Page() {\n  return <p>Leverage our cutting-edge RAG pipeline. We are the synergy partner for your journey.</p>;\n}\n",
    );
    const findingsJSON =
      '{"findings":[' +
      '{"rule":"voice.no-insider-jargon","severity":"warn","file":"apps/website/src/app/page.tsx",' +
      '"quote":"Leverage our cutting-edge RAG pipeline.","detail":"Insider term \\"RAG\\" without a buyer-language gloss in proximity."},' +
      '{"rule":"voice.tone-calibration","severity":"warn","file":"apps/website/src/app/page.tsx",' +
      '"quote":"We are the synergy partner for your journey.","detail":"Generic-SaaS hype."}' +
      "]}";
    const engine = new MockEngine(() => findingsJSON);
    const { result } = await runAgent("curator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { args: [surface] },
    });

    expect(result.ok).toBe(true);
    // one governed hive.run() call assembles BOTH findings — the reborn collapses
    // the legacy's four separate per-rule LLM calls into a single pass.
    expect(engine.calls.length).toBe(1);
    expect(result.governedFindings).toBe(2);
    expect(result.warn).toBe(2);
    expect(result.critical).toBe(0);

    const doc = await Bun.file(join(repo, result.report as string)).text();
    expect(doc).toContain("voice.no-insider-jargon");
    expect(doc).toContain("voice.tone-calibration");
  });

  // GAP (honest regression, not fixed — the task's hard constraint forbids
  // editing agent.ts, and this port may only touch this test file):
  //
  // The legacy eval/voice.suite.mjs's actual bar is QUANTITATIVE, not just "did a
  // rule fire". It drives runVoiceChecks() with a per-rule ReplayModel
  // (jargon/mission/tone/tagline each answer independently, dispatched by prompt
  // substring via ruleForPrompt()), scores the flagged findings against a
  // per-case GOLD set with setCorrectness() (precision/recall/F1 — the standard
  // critic-eval metric), and gates the corpus-level precision (>=0.7), recall
  // (>=0.6), and F1 (>=0.7) via lib/agix-eval/harness.mjs's gate(). The
  // "mixed-with-fp-and-fn" gold case exists specifically to exercise that scoring
  // path: its recorded model both raises a tone false-positive AND misses a
  // mission/ownership false-negative on purpose.
  //
  // agent.ts has no equivalent seam. The four rule-level LLM calls were collapsed
  // into ONE ctx.hive.run() pass by design (see agent.ts's "NOT PORTED" note), and
  // parseGovernedFindings() only merges whatever JSON that single pass returns —
  // there is no gold-set comparison, no per-rule ReplayModel dispatch point, and
  // no precision/recall/F1 gate anywhere in the reborn agent or fleet runtime.
  // Reproducing this honestly would require either exporting an internal scorer
  // from agent.ts (out of scope for this port) or standing up a new eval-harness
  // file (also out of scope — edit ONLY fleet/tests/curator.test.ts). Recorded
  // here as a known regression for a future eval-harness bee.
  test.todo(
    "gates corpus-level precision/recall/F1 of flagged findings against a gold set (legacy eval/voice.suite.mjs — no scoring seam exists in the reborn single-pass governed review)",
  );
});
