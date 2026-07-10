// context-warden tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// They load the real reborn context-warden agent (agents/context-warden/agent.ts),
// run it against a MOCKED governed engine + in-memory Comb, and assert:
//   - a DEGRADED context runs the cost-gated TRAILING check as a GOVERNED pass
//     (a distinct verifier certifies — actor≠verifier) and grows attested memory;
//   - a GREEN (healthy) context short-circuits BEFORE any governed pass — the
//     cost-discipline core truth: a healthy audit spends zero $ and zero bees;
//   - the deterministic LEADING signals detect the degradation conditions
//     (over-length, superseded/contradictory facts) with no model at all;
//   - smoke short-circuits to a single governed surface check.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { DryRunNotifier } from "../runtime/notify.ts";
import { analyzeContext } from "../../agents/context-warden/agent.ts";

const REPO = join(import.meta.dir, "..", "..");
const AGENTS = join(REPO, "agents");

// The real, refreshable effective-length table (the accuracy-relevant denominator).
// The detection-eval ports below score against it, exactly as the legacy .mjs suites did.
const EFF_TABLE = JSON.parse(readFileSync(join(AGENTS, "context-warden/effective-length.json"), "utf8"));

// A silent DryRunNotifier (no stderr breadcrumb) whose `.notifications[]` a test reads
// back to assert what the warden WOULD have alerted — recorded, never sent ($0/offline).
function notifier(): DryRunNotifier {
  return new DryRunNotifier(() => {});
}

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "agix-warden-"));
}

// A registered-verifier MemComb so a governed audit's leaf actually attests
// (mirrors the Go roster). The MockEngine certifies as <agent>/worker/verifier-1.
function comb(): MemComb {
  return new MemComb({ roster: ["context-warden/worker/verifier-1"], trustFloor: 0.35 });
}

// Non-repetitive, punctuation-free filler so an occupancy-only case does not also
// trip the repetition / duplication / contradiction flags. Each token is unique.
const bigVaried = (n: number): string =>
  Array.from({ length: n }, (_, i) => `para${i} alpha${i} beta${i} gamma${i} delta${i} epsilon${i} zeta${i} eta${i}`).join(" ");

// A short, LOW-occupancy but POISONED context: a fact that is later overridden. The
// always-on override-marker screen must flag it (the case the cost-gated LLM check
// used to miss). Uses the effective-length DEFAULT table (model unknown → default).
const POISONED = "Cluster Orion region is us-west-3. UPDATE: Orion migrated to eu-central-1, which supersedes the earlier value.";

describe("context-warden (session-health advisor / proposer / worker)", () => {
  test("a degraded (over-length) context runs the cost-gated governed trailing check", async () => {
    const engine = new MockEngine(() => "No internal contradiction found in the sampled window; occupancy is the risk.");
    const c = comb();
    const repo = tmpRepo();
    const notify = notifier();
    const { result } = await runAgent("context-warden", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier: notify,
      repoRoot: repo,
      // model unknown → the DEFAULT effective-length band (8000): occupancy ≥ 0.8 → compact.
      input: { text: bigVaried(500), flags: { model: "unknown-model" } },
    });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe("compact");
    expect(result.flags as string[]).toContain("over-effective-length");
    expect(result.trailingChecked).toBe(true);

    // Parity win: the compact tier is the degradation_risk_high condition, so the warden
    // pushed EXACTLY ONE alert through the governed notify seam — recorded (dry-run),
    // never sent. Its level is critical and its body carries the SIGNALS (tier +
    // occupancy% + flags), never raw session content.
    expect(result.notified).toBe(true);
    expect(notify.notifications.length).toBe(1);
    expect(notify.notifications[0].level).toBe("critical");
    expect(notify.notifications[0].title).toContain("degradation risk HIGH");
    expect(notify.notifications[0].body).toContain("compact");
    expect(notify.notifications[0].body).toContain("over-effective-length");
    // The warden is a PROPOSER: autonomous session-mutation is an explicit roadmap flag.
    expect(result.roadmap as string[]).toContain("autonomous-session-mutation");

    // It ran EXACTLY ONE governed unit (the cost-gated trailing check), certified by
    // a DISTINCT verifier (actor≠verifier).
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("context-warden");
    expect(result.verifier).toBe("context-warden/worker/verifier-1");
    expect(result.verifier).not.toBe("context-warden/queen/root");

    // The audit report was written UNDER the boundary (wiki/context-warden/) and
    // carries the governed trailing section.
    const doc = await Bun.file(join(repo, result.reportPath as string)).text();
    expect(doc).toContain("Context Warden audit");
    expect(doc).toContain("Trailing check");

    // The audit was recorded as an ATTESTED Comb leaf (distinct verifier vouched).
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("the always-on override-marker screen flags a poisoned low-occupancy context", async () => {
    const engine = new MockEngine(() => "Contradiction: Orion region us-west-3 is later superseded by eu-central-1. Verify which is current.");
    const notify = notifier();
    const { result } = await runAgent("context-warden", {
      dir: AGENTS,
      engine,
      comb: comb(),
      notifier: notify,
      repoRoot: tmpRepo(),
      input: { text: POISONED, flags: { model: "unknown-model" } },
    });

    // LOW occupancy, but the deterministic screen still catches the override markers →
    // amber → the cost-gated governed contradiction check fires.
    expect(result.ok).toBe(true);
    expect(result.tier).toBe("amber");
    expect(result.flags as string[]).toContain("contradiction-suspected");
    expect(result.trailingChecked).toBe(true);
    expect(result.verifier).toBe("context-warden/worker/verifier-1");
    expect(engine.calls.length).toBe(1);

    // AMBER is a soft warning, NOT degradation_risk_high: it is RETURNED + logged, but
    // pushes NO notify alert (only the compact tier crosses the alert threshold).
    expect(result.notified).toBe(false);
    expect(notify.notifications.length).toBe(0);
  });

  test("a green (healthy) context short-circuits before any governed pass (cost discipline)", async () => {
    const engine = new MockEngine();
    const c = comb();
    const notify = notifier();
    const { result } = await runAgent("context-warden", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier: notify,
      repoRoot: tmpRepo(),
      input: { text: "The build is green and the plan is on track. Ship the smallest reversible change.", flags: { model: "unknown-model" } },
    });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe("green");
    expect(result.flags as string[]).toHaveLength(0);
    expect(result.trailingChecked).toBe(false);
    // The cost-discipline guarantee: a healthy audit runs ZERO governed passes …
    expect(engine.calls.length).toBe(0);
    expect(result.verifier).toBeNull();
    expect(result.costUSD).toBe(0);
    // … and therefore grows NO attested memory (no verifier vouched).
    const stats = await c.stats();
    expect(stats.attested).toBe(0);
    // The zero-notify guarantee: a healthy audit alerts NOTHING (silent short-circuit).
    expect(result.notified).toBe(false);
    expect(notify.notifications.length).toBe(0);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("context-warden", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "" },
    });
    expect(result.smoke).toBe(true);
    expect(result.verifier).toBe("context-warden/worker/verifier-1");
    expect(engine.calls.length).toBe(1);
  });
});

// ─── Ported eval suite #1 — detection accuracy ──────────────────────────────────
// Re-expresses agents/context-warden/eval/context-warden.suite.mjs (the legacy
// `analyzeContext({text,modelId,table,thresholds})` object-arg core) against the
// reborn EXPORTED analyzeContext(text, turns, modelId, table). Same adversarial
// cases, same model (claude-sonnet-4-6, effective 6000 → amber ≥3000 tok / compact
// ≥4800 tok), scored against the real refreshable table — plants known context
// conditions and asserts the deterministic LEADING signals detect them with the
// right tier/flags, with false-positive guards.
describe("context-warden detection eval (ported context-warden.suite.mjs)", () => {
  const MODEL = "claude-sonnet-4-6";
  const a = (text: string) => analyzeContext(text, null, MODEL, EFF_TABLE);
  // Non-repetitive filler so occupancy-only cases don't also trip repetition/dup flags.
  const varied = (n: number): string =>
    Array.from({ length: n }, (_, i) => `Sentence ${i}: a distinct point about topic_${i} with words alpha${i} beta${i} gamma${i} delta${i}.`).join(" ");

  test("clean-short → green, no flags", () => {
    const r = a(varied(15));
    expect(r.tier).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  test("approaching-eff-length → amber, approaching-effective-length", () => {
    const r = a(varied(190));
    expect(r.tier).toBe("amber");
    expect(r.flags).toContain("approaching-effective-length");
  });

  test("over-eff-length → compact, over-effective-length", () => {
    const r = a(varied(360));
    expect(r.tier).toBe("compact");
    expect(r.flags).toContain("over-effective-length");
  });

  test("repetition-loop is detected (losing the thread)", () => {
    expect(a("the cat sat on the mat ".repeat(40)).flags).toContain("repetition-loop");
  });

  test("distractor-duplication is detected", () => {
    const dup = Array(20).fill("A duplicated distractor line that appears many times in this context window.").join("\n");
    expect(a(dup).flags).toContain("distractor-duplication");
  });

  test("empty → green (boundary)", () => {
    const r = a("");
    expect(r.tier).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  test("long-clean-no-overflag → green (false-positive guard: ~2.4k varied tok must NOT flag)", () => {
    const r = a(varied(100));
    expect(r.tier).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  test("mixed over+distractor → compact with both flags", () => {
    const mixed = Array(400).fill("Identical distractor line padding an over-long context window here now.").join("\n");
    const r = a(mixed);
    expect(r.tier).toBe("compact");
    expect(r.flags).toContain("over-effective-length");
    expect(r.flags).toContain("distractor-duplication");
  });

  test("contradiction-low-occupancy → amber, contradiction-suspected (the case the LLM check used to miss)", () => {
    const r = a("Cluster Orion region is us-west-3. UPDATE: Orion migrated to eu-central-1, which supersedes the earlier value.");
    expect(r.tier).toBe("amber");
    expect(r.flags).toContain("contradiction-suspected");
  });

  test("no-false-contradiction → green (clean varied text raises no contradiction flag)", () => {
    const r = a(varied(20));
    expect(r.tier).toBe("green");
    expect(r.flags).not.toContain("contradiction-suspected");
    expect(r.flags).toHaveLength(0);
  });
});

// ─── Ported eval suite #2 — warm-context compaction DECISION ────────────────────
// Re-expresses agents/context-warden/eval/warm-context.suite.mjs. That suite tests
// lib/agix-warm-context.mjs::wardenStep, whose compaction DECISION is exactly
//   shouldCompact = tier === "compact" || flags.includes("contradiction-suspected")
// — a pure function of the reborn analyzeContext. We re-express that detection half
// here against the reborn agent. NOTE (honest scope): wardenStep's COMPACTION-STRATEGY
// assertions (kept[]/pin-recent/relevance-aware/lost-in-the-middle) exercise a context
// ACTUATOR that mutates the retained item set — that is the autonomous-session-mutation
// seam this port deliberately leaves on the ROADMAP (a proposer never actuates), so
// those are intentionally NOT re-expressed here.
describe("warm-context compaction decision (ported warm-context.suite.mjs — detection half only)", () => {
  const MODEL = "claude-sonnet-4-6";
  // The exact wardenStep decision, over the reborn analyzeContext.
  const shouldCompact = (items: string[]): boolean => {
    const r = analyzeContext(items.join("\n"), null, MODEL, EFF_TABLE);
    return r.tier === "compact" || r.flags.includes("contradiction-suspected");
  };
  const longLine = (i: number): string =>
    `Task ${i}: a detailed result paragraph with distinct words alpha${i} beta${i} gamma${i} delta${i} epsilon${i} zeta${i} eta${i} theta${i} iota${i} kappa${i} lambda${i}.`;

  test("clean-no-compact: a couple of tidy notes do NOT trip compaction", () => {
    expect(shouldCompact(["short clean note", "another tidy note"])).toBe(false);
  });

  test("contradiction-compacts: a superseded/migrated fact trips compaction", () => {
    expect(shouldCompact(["region is us-west-3", "UPDATE: migrated to eu-central-1 which supersedes the above"])).toBe(true);
  });

  test("contradiction-low-occupancy: an override marker trips compaction even at low occupancy", () => {
    const items = ["x", "the value was changed to Y, no longer the old one"];
    expect(shouldCompact(items)).toBe(true);
    expect(analyzeContext(items.join("\n"), null, MODEL, EFF_TABLE).occupancyPct).toBeLessThan(0.5);
  });

  test("overlength-compacts: a large accumulated context trips compaction", () => {
    expect(shouldCompact(Array.from({ length: 200 }, (_, i) => longLine(i)))).toBe(true);
  });

  test("empty-no-compact: no items → no compaction", () => {
    expect(shouldCompact([])).toBe(false);
  });
});
