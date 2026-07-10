// Investigator (forensic root-cause debugger, proposer caste) tests — HERMETIC
// ($0/offline, no Go binary, no key, no network). Loads the real reborn
// agents/investigator/agent.ts against a MOCKED governed engine + in-memory Comb.
//
// Source: agents/investigator/eval/failure-extract.suite.mjs. That legacy suite
// unit-tested one exported pure function, extractNamedFailures(text) — parsing
// tester-report `### N. \`name\`` headers and TAP `not ok N - name` lines out of
// a raw failure blob, excluding `# SKIP`, and de-duping by name.
//
// GAP (regression, not edited around): agent.ts has NO extractNamedFailures
// export, and nothing in its default-exported entrypoint calls an equivalent —
// acquireSignal() now hands the RAW tester-report / --text blob straight into
// the governed hive.run() task, unparsed. The failure-NAME extraction behavior
// the legacy suite guarded is gone in the reborn agent. Per instructions this is
// NOT patched into agent.ts from a test file; each legacy case is preserved
// below as a commented `test.todo` so the gap stays visible and auditable.
//
// What IS re-expressed against the reborn surface (black-box via runAgent(),
// since agent.ts exports no pure functions to import directly):
//   - smoke short-circuits to one governed surface check;
//   - a clean "no signal at all" no-op spends nothing (closest honest analog to
//     the legacy "empty-clean" case, which tested "no failures found" rather than
//     "no signal at all" — see the gap note);
//   - signal ACQUISITION: --text wins over an on-disk tester report, and the
//     agent falls back to the latest tester report when --text is empty;
//   - the governed pass writes an attested Comb symptom leaf under actor≠verifier
//     governance and a diagnosis file under the wiki/investigator/ boundary;
//   - root-cause STRUCTURING honesty: "root cause:" text containing "not yet
//     identified" must never be reported as identified (the Iron Law — no cause
//     without evidence — is the sharper analog of the legacy suite's evidence
//     discipline, expressed at the diagnosis layer instead of the extraction
//     layer);
//   - confidence-tier parsing (high/medium/low);
//   - the stable, order-independent SYMPTOM FINGERPRINT recognizes a reordered /
//     renumbered repeat of the same signal as recurring, carries the prior
//     diagnosis into a RE-VERIFICATION pass (never blindly re-served), and
//     dedupes to one Comb leaf — this is the re-expression of the legacy
//     "dedupes" case, moved from failure-NAME dedup to failure-SIGNAL dedup;
//   - the raw signal survives verbatim in the written diagnosis (citation /
//     evidence discipline — the record is the evidence, not a paraphrase of it).
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
  return mkdtempSync(join(tmpdir(), "agix-investigator-"));
}

// A registered-verifier MemComb so writes actually attest (mirrors the Go roster).
function comb(): MemComb {
  return new MemComb({ roster: ["investigator/worker/verifier-1"], trustFloor: 0.35 });
}

// agent.ts's isoDate() defaults to `new Date()` with no override seam (unlike
// research's --date flag), so tests match it against the real current UTC date.
const TODAY = new Date().toISOString().slice(0, 10);

describe("investigator (root-cause debugger, proposer)", () => {
  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "" },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("investigator/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });

  test("no --text signal and no tester report on disk is a clean no-op — no governed spend", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(), // empty repo: no wiki/tester/reports/*.md
      input: { text: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-signal");
    expect(engine.calls.length).toBe(0);
  });

  test("falls back to reading the latest tester report when no --text signal is given", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    const reportBody = "### 1. `auth login redirect`\nRedirect loop after SSO callback.\n\nnot ok 2 - vault decrypt path\n";
    await Bun.write(join(repo, `wiki/tester/reports/${TODAY}.md`), reportBody);

    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "" },
      log: (msg, fields) => logs.push({ msg, fields }),
    });

    expect(result.ok).toBe(true);
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].task).toContain("auth login redirect");
    expect(logs.some((l) => l.msg.includes("no --text signal; using latest tester report"))).toBe(true);
  });

  test("an explicit --text signal takes precedence over an on-disk tester report", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    await Bun.write(join(repo, `wiki/tester/reports/${TODAY}.md`), "not ok 9 - unrelated report failure");

    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "not ok 2 - vault decrypt path" },
    });

    expect(result.ok).toBe(true);
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].task).toContain("vault decrypt path");
    expect(engine.calls[0].task).not.toContain("unrelated report failure");
  });

  test("writes a governed diagnosis under wiki/investigator/ and attests the Comb symptom leaf (actor≠verifier)", async () => {
    const engine = new MockEngine(
      () => "investigate: ...\nanalyze: ...\nhypothesize: ...\nroot cause: vault credentials expired before decrypt.\nconfidence: high",
    );
    const c = comb();
    const repo = tmpRepo();

    const { result } = await runAgent("investigator", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: "not ok 2 - vault decrypt path" },
    });

    expect(result.ok).toBe(true);
    expect(result.diagnosed).toBe(true);
    expect(result.root_cause_identified).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.verifier).toBe("investigator/worker/verifier-1");
    expect(result.diagnosis).toBe(`wiki/investigator/diagnoses/${TODAY}.md`);

    const doc = await Bun.file(join(repo, result.diagnosis as string)).text();
    expect(doc).toContain("verifier: investigator/worker/verifier-1 (actor≠verifier)");
    expect(doc).toContain("root cause identified: true");
    expect(doc).toContain("confidence: high");
    // the raw signal survives verbatim — the written record IS the evidence,
    // never just the model's paraphrase of it (citation/evidence discipline).
    expect(doc).toContain("## Signal\n\nnot ok 2 - vault decrypt path");

    const stats = await c.stats();
    expect(stats.leaves).toBeGreaterThanOrEqual(1);
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test(
    "root-cause honesty: 'not yet identified' is never reported as identified even though the literal " +
      "phrase 'root cause:' is present (Iron Law: no cause without evidence)",
    async () => {
      const engine = new MockEngine(
        () => "root cause: not yet identified — missing evidence: no stack trace in the signal.\nconfidence: low",
      );
      const { result } = await runAgent("investigator", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { text: "something failed" },
      });
      expect(result.root_cause_identified).toBe(false);
      expect(result.confidence).toBe("low");
    },
  );

  test("confidence tiers parse high / medium / low (default low) from the governed answer", async () => {
    const cases: [string, string][] = [
      ["root cause: X. confidence: high", "high"],
      ["root cause: X. confidence: medium", "medium"],
      ["root cause: X. confidence: unspecified", "low"],
    ];
    for (const [answer, expected] of cases) {
      const engine = new MockEngine(() => answer);
      const { result } = await runAgent("investigator", {
        dir: AGENTS,
        engine,
        comb: comb(),
        repoRoot: tmpRepo(),
        input: { text: "some failure signal" },
      });
      expect(result.confidence).toBe(expected);
    }
  });

  test(
    "stable, order-independent symptom fingerprint recognizes a reordered/renumbered repeat as recurring, " +
      "re-verifies instead of blindly re-serving the cache, and dedupes to ONE Comb leaf " +
      "(re-expression of the legacy 'dedupes' case at the signal-fingerprint level)",
    async () => {
      const engine = new MockEngine(() => "root cause: vault credentials expired. confidence: high");
      const c = comb();
      const repo = tmpRepo();

      const run1 = await runAgent("investigator", {
        dir: AGENTS,
        engine,
        comb: c,
        repoRoot: repo,
        input: { text: "not ok 3 - vault decrypt path" },
      });
      expect(run1.result.ok).toBe(true);
      expect(run1.result.recurring).toBe(false);
      const doc1 = await Bun.file(join(repo, run1.result.diagnosis as string)).text();
      const fp1 = doc1.match(/- fingerprint: (sym-\S+)/)?.[1];
      expect(fp1).toBeTruthy();

      // Same tokens, reshuffled order + a different failure number — the
      // fingerprint lowercases, strips digits, and sorts tokens, so this MUST
      // hash identical to run1's signal.
      const run2 = await runAgent("investigator", {
        dir: AGENTS,
        engine,
        comb: c,
        repoRoot: repo,
        input: { text: "path vault ok 7 not decrypt" },
      });
      expect(run2.result.ok).toBe(true);
      expect(run2.result.recurring).toBe(true);
      // engine.calls[1] is run2's single governed pass; it must carry the prior
      // cached diagnosis forward for RE-VERIFICATION, not a blind re-serve.
      expect(engine.calls.length).toBe(2);
      expect(engine.calls[1].task).toContain("A prior pass on this symptom concluded");
      expect(engine.calls[1].task).toContain("Re-verify it against the CURRENT signal; do not blindly re-serve it.");

      const doc2 = await Bun.file(join(repo, run2.result.diagnosis as string)).text();
      const fp2 = doc2.match(/- fingerprint: (sym-\S+)/)?.[1];
      expect(fp2).toBe(fp1);
      expect(doc2).toContain("(recurring — cache re-verified)");

      // one symptom, one Comb leaf — dedup, not duplication.
      const stats = await c.stats();
      expect(stats.leaves).toBe(1);
    },
  );
});

// ── Ported adversarial assertions from the legacy eval suite ──────────────────
// Each case below unit-tested `extractNamedFailures(text)` directly (agent.mjs).
// The reborn agent.ts has NO such export and calls no equivalent internally —
// acquireSignal() forwards the raw blob unparsed into the governed task. This is
// a genuine coverage gap versus the legacy behavior, not a test-authoring choice;
// it is left as `test.todo` rather than silently dropped or faked as passing.
describe("ported from legacy failure-extract.suite.mjs (GAP: extractNamedFailures has no reborn surface)", () => {
  test.todo(
    "tester-report-header: extractNamedFailures('### 1. `auth login redirect`\\nsome detail') " +
      "should include 'auth login redirect' (gap: no extractNamedFailures export in agent.ts)",
  );
  test.todo(
    "tap-not-ok: extractNamedFailures('not ok 2 - vault decrypt path') should include 'vault decrypt path' " +
      "(gap: no extractNamedFailures export in agent.ts)",
  );
  test.todo(
    "both-formats: extractNamedFailures('### 1. `a`\\nnot ok 2 - b') should include both 'a' and 'b' " +
      "(gap: no extractNamedFailures export in agent.ts)",
  );
  test.todo(
    "skip-excluded: extractNamedFailures('not ok 3 - flaky # SKIP') should exclude the SKIP-tagged failure " +
      "(gap: no extractNamedFailures export in agent.ts)",
  );
  test.todo(
    "dedupes: extractNamedFailures('not ok 1 - same\\nnot ok 2 - same') should collapse to one 'same' entry " +
      "(gap: no extractNamedFailures export; re-expressed at the signal-fingerprint level above, which IS a " +
      "real, passing test on the reborn agent)",
  );
  test.todo(
    "empty-clean: extractNamedFailures('all good\\nok 1 - fine') should return zero failures " +
      "(gap: no extractNamedFailures export; closest honest analog — 'no signal at all is a clean no-op' — " +
      "is a real, passing test above, but it is not the same claim: it never exercises a signal that CONTAINS " +
      "text but no recognizable failure)",
  );
});
