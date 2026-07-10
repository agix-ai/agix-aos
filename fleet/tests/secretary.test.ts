// Secretary port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Loads the real reborn secretary agent, runs it against a MOCKED governed engine
// + in-memory Comb, and asserts:
//   - the triage pass runs GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the output guardrail: an out-of-taxonomy category collapses to noise;
//   - the classify → summarize → draft arc dispatches correctly (client+reply gets
//     both a summary and a draft; internal gets a summary; newsletter/noise get
//     neither and are counted as archivable);
//   - the digest is written UNDER the manifest boundary (wiki/secretary/) and the
//     triage + digest are attested into the Comb;
//   - email delivery is ported via the notify seam: the digest is queued (dry-run),
//     recorded, and nothing is actually sent (result.sent stays false);
//   - smoke short-circuits to a single governed surface check;
//   - an empty inbox and a no-JSON triage degrade gracefully.
//
// Mirrors fleet/tests/runner.test.ts. Copyright 2026 Agix AI LLC. Apache-2.0.

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
  return mkdtempSync(join(tmpdir(), "agix-secretary-"));
}

// A registered-verifier MemComb so the triage + digest leaves actually attest
// (mirrors the Go roster). The MockEngine certifies with secretary/worker/verifier-1.
function comb(): MemComb {
  return new MemComb({ roster: ["secretary/worker/verifier-1"], trustFloor: 0.35 });
}

// A mock governed engine that returns valid triage JSON for the TRIAGE pass and
// prose for the SUMMARIZE + DRAFT passes. The four threads exercise: a client
// thread that needs a reply (→ summary + draft), an internal thread (→ summary
// only), a newsletter (→ neither), and one with an out-of-taxonomy category
// ("telepathy") + bogus priority ("urgent") that the guardrail must collapse to noise.
function triagingEngine(): MockEngine {
  const triageJson = JSON.stringify({
    threads: [
      { id: "t1", subject: "Kickoff for the Acme engagement", from: "cto@example.com", category: "client", requires_response: true, priority: "high", reason: "proposes a start date" },
      { id: "t2", subject: "Bun 1.3 release notes", from: "news@example.org", category: "agix-internal", requires_response: false, priority: "normal", reason: "tooling update" },
      { id: "t3", subject: "50% off managed hosting this week", from: "deals@host.io", category: "newsletter", requires_response: false, priority: "low", reason: "marketing blast" },
      { id: "t4", subject: "mystery", from: "weird@example.net", category: "telepathy", requires_response: false, priority: "urgent", reason: "unknown category" },
    ],
  });
  return new MockEngine((_agent, task) => {
    if (task.startsWith("TRIAGE")) return triageJson;
    if (task.startsWith("DRAFT")) return "Monday works for the kickoff. I will send repo access today. — the operator";
    if (task.startsWith("SUMMARIZE")) return "The sender wants to lock a start date for the engagement.";
    return "ok";
  });
}

describe("secretary (boundary / drone)", () => {
  test("triages a governed inbox, classifies, summarizes + drafts, writes + attests the digest", async () => {
    const engine = triagingEngine();
    const c = comb();
    const repo = tmpRepo();
    const notifier = new DryRunNotifier(() => {}); // silent; we read .emails back
    const flags = { date: "2026-07-07", slot: "morning" };

    const { result } = await runAgent("secretary", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier,
      repoRoot: repo,
      input: { text: "From: cto@example.com\nSubject: Kickoff...\n(4 threads pasted)", flags },
    });

    // Governed: the triage pass was certified by a DISTINCT verifier.
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("secretary/worker/verifier-1");
    expect(result.queen).toBe("secretary/queen/root");
    expect(result.verifier).not.toBe(result.queen);

    // All four threads triaged; the guardrail folded the bogus category into noise.
    expect(result.threadCount).toBe(4);
    expect(result.needsAttention).toBe(1); // the client thread (requires_response + high)
    expect(result.fyi).toBe(1); // the internal thread
    expect(result.archivable).toBe(2); // newsletter + the coerced-to-noise "telepathy" thread
    expect(result.summarized).toBe(2); // client + internal
    expect(result.drafted).toBe(1); // only the client thread needs a reply

    // Email delivery is PORTED but dry-run by default: the digest was handed to the
    // notify seam (queued) and recorded, but nothing was actually sent.
    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.deliveryMode).toBe("dry-run");
    expect(notifier.emails.length).toBe(1);
    expect(notifier.emails[0].to).toBe("operator");
    expect(notifier.emails[0].body).toContain("Kickoff for the Acme engagement");
    expect(notifier.emails[0].subject).toContain("Digest 2026-07-07 (morning)");

    // Engine ran exactly four governed units: triage + (t1 summary + t1 draft) + t2 summary.
    expect(engine.calls.length).toBe(4);
    expect(engine.calls[0].task.startsWith("TRIAGE")).toBe(true);
    const tasks = engine.calls.map((x) => x.task);
    expect(tasks.some((t) => t.startsWith("DRAFT"))).toBe(true);
    expect(tasks.filter((t) => t.startsWith("SUMMARIZE")).length).toBe(2);
    expect(engine.calls.every((x) => x.agent === "secretary")).toBe(true);

    // The digest was written UNDER the boundary (wiki/secretary/digests/).
    expect(result.digest).toBe("wiki/secretary/digests/2026-07-07-morning.md");
    const digest = await Bun.file(join(repo, result.digest as string)).text();
    expect(digest).toContain("Needs your attention");
    expect(digest).toContain("Kickoff for the Acme engagement");
    expect(digest).toContain("Suggested reply draft");
    expect(digest).toContain("Digest queued for delivery");

    // The triage + digest were attested into the Comb (actor≠verifier). The cursor
    // is a third attested leaf.
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(2);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("secretary", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "ignored under smoke" },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("secretary/worker/verifier-1");
    expect(result.sent).toBe(false);
    // exactly one governed unit ran (the cursor read is a $0 Comb call, not a hive run).
    expect(engine.calls.length).toBe(1);
  });

  test("an empty inbox is a no-op (no governed run)", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("secretary", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { text: "   " },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-inbox");
    expect(engine.calls.length).toBe(0);
  });

  test("a triage that returns no JSON degrades to zero threads (no crash, still governed)", async () => {
    const engine = new MockEngine(() => "sorry, I could not parse the inbox");
    const repo = tmpRepo();
    const { result } = await runAgent("secretary", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: repo,
      input: { text: "an inbox the classifier fails on", flags: { date: "2026-07-07", slot: "afternoon" } },
    });
    // The triage pass still ran governed; no threads → no summarize/draft passes.
    expect(result.ok).toBe(true);
    expect(result.threadCount).toBe(0);
    expect(engine.calls.length).toBe(1);
    // The (empty) digest is still written under the boundary.
    const digest = await Bun.file(join(repo, result.digest as string)).text();
    expect(digest).toContain("0 threads triaged");
  });
});
