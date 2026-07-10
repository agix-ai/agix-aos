// Sentinel port tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// They load the real reborn agents/sentinel/agent.ts, run it against a MOCKED
// governed engine + in-memory Comb over a throwaway repo, and assert:
//   - the sweep executes GOVERNED (a distinct verifier certifies — actor≠verifier);
//   - the DETERMINISTIC gate catches a planted secret over the bounded read seam
//     (classification + location only — the raw secret is never echoed);
//   - the ADAPTIVE layer's high-confidence novel entity is LEARNED into
//     wiki/sentinel/learned-entities.json as a proposed gate rule (the compounding
//     loop), and a subsequent sweep catches that entity BY RULE in the gate;
//   - the sweep verdict is written as an attested Comb leaf;
//   - on EXPOSURE the sweep pushes a CRITICAL "DO NOT RELEASE" alert through the
//     governed notify seam (an injected DryRunNotifier records it, sends nothing);
//     a CLEAN surface pushes no alert;
//   - generalize mode runs a governed pass and writes a proposal (proposer trust);
//   - smoke short-circuits to a single governed surface check.
//
// The final describe FOLDS IN the legacy eval (agents/sentinel/eval/sentinel.suite.mjs)
// — its adversarial leak classes re-expressed against the reborn agent.ts. The legacy
// suite drove the external bash gate; the reborn splits that verdict into a network-free
// DETERMINISTIC gate (secret shapes, PEM blocks, real/non-placeholder emails, placeholder
// exemption — with NO hardcoded operator IP, since sentinel itself is public=true) and a
// governed ADAPTIVE layer that LEARNS operator-specific classes (person/client/product/
// address) into proposed gate rules. Each legacy class is asserted on the layer that now
// owns it; every real leak still fails closed AND now pushes a recorded critical notify.
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
  return mkdtempSync(join(tmpdir(), "agix-sentinel-"));
}

// A registered-verifier MemComb so writes actually attest (mirrors the Go roster).
function comb(): MemComb {
  return new MemComb({ roster: ["sentinel/worker/verifier-1"], trustFloor: 0.35 });
}

// The mock adaptive answer: a governed pass returns a JSON array of candidates. One
// is high-confidence (learned + becomes a rule), one is low (surfaced, not learned).
const NOVEL_JSON =
  'Here is what I found:\n[' +
  '{"entity":"Northwind Traders","type":"client","confidence":"high","why":"a real client name in a public file"},' +
  '{"entity":"maybe-generic","type":"unknown","confidence":"low","why":"probably a placeholder"}' +
  "]";

describe("sentinel — sweep (proposer / worker, narrator pattern)", () => {
  test("governed sweep + deterministic gate catches a planted secret, learns a novel entity", async () => {
    const engine = new MockEngine(() => NOVEL_JSON);
    const c = comb();
    const repo = tmpRepo();
    const notifier = new DryRunNotifier(() => {});

    // Plant a public-surface file with a secret the DETERMINISTIC gate must catch
    // and a client name the ADAPTIVE layer flags (the mock supplies the finding).
    const surface = "packaging/release-notes.md";
    await Bun.write(
      join(repo, surface),
      "# Release\nContact: founder@northwind-traders.com\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\nBuilt with Northwind Traders.\n", // # public-clean: ok synthetic release fixture (fake client Northwind + AWS doc example key + fake email; exercises the sentinel gate)
    );

    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier,
      repoRoot: repo,
      input: { text: surface, args: [surface], flags: { target: surface } },
    });

    // Governed: a DISTINCT verifier certified the sweep (actor≠verifier).
    expect(result.ok).toBe(true);
    expect(result.swept).toBe(true);
    expect(result.verifier).toBe("sentinel/worker/verifier-1");
    expect(result.verifier).not.toBe("sentinel/queen/root");
    // exactly one governed unit of work ran, at $0.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0].agent).toBe("sentinel");

    // Deterministic gate caught the planted secret + email → exposure.
    expect(result.exposure).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.gate_hits as number).toBeGreaterThanOrEqual(2);
    expect(result.gate_categories as string[]).toContain("aws-access-key");

    // The report never echoes the raw secret (classification + location only).
    const report = await Bun.file(join(repo, result.report as string)).text();
    expect(report).not.toContain("AKIAIOSFODNN7EXAMPLE"); // # public-clean: ok references the synthetic AWS doc example key from the fixture above
    expect(report).toContain("aws-access-key");

    // EXPOSURE pushed a CRITICAL "DO NOT RELEASE" alert through the governed notify
    // seam. The DryRunNotifier RECORDED it and sent nothing (dry-run/queued default).
    // The alert names the COUNT + severity but never echoes the raw secret value.
    expect(result.notified).toBe(true);
    expect(notifier.notifications.length).toBe(1);
    expect(notifier.notifications[0].level).toBe("critical");
    expect(notifier.notifications[0].channel).toBe("release");
    expect(notifier.notifications[0].title).toContain("DO NOT RELEASE");
    expect(notifier.notifications[0].body).toContain("DO NOT RELEASE");
    expect(notifier.notifications[0].body).not.toContain("AKIAIOSFODNN7EXAMPLE"); // # public-clean: ok references the synthetic AWS doc example key from the fixture above
    expect(notifier.emails.length).toBe(0); // notify, not email

    // The high-confidence novel entity was LEARNED into a proposed gate rule; the
    // low-confidence one was not.
    expect(result.novel_candidates).toBe(2);
    expect(result.novel_high).toBe(1);
    expect(result.learned).toBe(1);
    const learned = JSON.parse(await Bun.file(join(repo, "wiki/sentinel/learned-entities.json")).text());
    expect(learned.entities.map((e: { entity: string }) => e.entity)).toContain("Northwind Traders");
    expect(learned.entities.find((e: { entity: string }) => e.entity === "Northwind Traders").proposed_gate_rule).toContain(
      "Northwind",
    );

    // The sweep verdict was written as an attested Comb leaf (actor≠verifier).
    const stats = await c.stats();
    expect(stats.attested).toBeGreaterThanOrEqual(1);
  });

  test("the compounding loop: a learned entity is caught BY RULE on the next sweep", async () => {
    const engine = new MockEngine(() => NOVEL_JSON);
    const c = comb();
    const repo = tmpRepo();
    const surface = "packaging/release-notes.md";

    // First sweep learns "Northwind Traders" → writes learned-entities.json.
    await Bun.write(join(repo, surface), "# Release\nBuilt with Northwind Traders.\n");
    await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { text: surface, args: [surface], flags: { target: surface } },
    });

    // Second sweep: the adaptive layer returns NOTHING new, but the entity is now a
    // LEARNED rule, so the DETERMINISTIC gate must catch it by pattern.
    const engine2 = new MockEngine(() => "[]");
    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine: engine2,
      comb: c,
      repoRoot: repo,
      input: { text: surface, args: [surface], flags: { target: surface } },
    });
    expect(result.novel_high).toBe(0);
    expect(result.exposure).toBe(true); // caught by the learned rule, not the LLM
    expect(result.gate_categories as string[]).toContain("learned:client");
  });

  test("a clean surface yields no exposure, no alert, and no governance downgrade", async () => {
    const engine = new MockEngine(() => "[]");
    const c = comb();
    const repo = tmpRepo();
    const notifier = new DryRunNotifier(() => {});
    const surface = "README.md";
    await Bun.write(join(repo, surface), "# Agix\nA generic open-source agent OS. Contact hello@example.com.\n");

    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: c,
      notifier,
      repoRoot: repo,
      input: { text: surface, args: [surface], flags: { target: surface } },
    });
    expect(result.ok).toBe(true);
    expect(result.exposure).toBe(false); // example.com is an allowlisted placeholder
    expect(result.clean).toBe(true);
    expect(result.learned).toBe(0);
    expect(result.verifier).toBe("sentinel/worker/verifier-1");
    // A clean surface pushes NO alert (the seam only fires on a DO NOT RELEASE verdict).
    expect(result.notified).toBe(false);
    expect(notifier.notifications.length).toBe(0);
  });
});

describe("sentinel — generalize + smoke", () => {
  test("generalize mode runs a governed pass and writes a proposal (proposer trust)", async () => {
    const engine = new MockEngine(() => "Redaction map: replace the client name with <client>. Make the domain configurable.");
    const c = comb();
    const repo = tmpRepo();
    // A minimal agent surface to generalize (read via the bounded read seam).
    await Bun.write(join(repo, "agents/acme-bot/agent.json"), '{"name":"acme-bot","note":"inspired by Acme Corp"}\n');

    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: c,
      repoRoot: repo,
      input: { mode: "generalize", args: ["acme-bot"], text: "generalize acme-bot", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("generalize");
    expect(result.generalized).toBe("acme-bot");
    expect(result.verifier).toBe("sentinel/worker/verifier-1");
    expect(engine.calls.length).toBe(1);

    const proposal = await Bun.file(join(repo, result.proposal as string)).text();
    expect(proposal).toContain("generalization proposal: acme-bot");
    expect(proposal).toContain("nothing was edited"); // proposer trust — never edits source
  });

  test("generalize of a missing agent fails cleanly without a governed run", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      input: { mode: "generalize", args: ["does-not-exist"], text: "generalize does-not-exist", flags: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("agent-not-found");
    expect(engine.calls.length).toBe(0);
  });

  test("smoke short-circuits to a single governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("sentinel", {
      dir: AGENTS,
      engine,
      comb: comb(),
      repoRoot: tmpRepo(),
      smoke: true,
      input: { text: "", args: [], flags: {} },
    });
    expect(result.smoke).toBe(true);
    expect(result.ok).toBe(true);
    expect(engine.calls.length).toBe(1);
  });
});

// ── Eval port: legacy agents/sentinel/eval/sentinel.suite.mjs, re-expressed ──────
// One high-confidence novel entity the governed adaptive layer would surface.
type Novel = { entity: string; type?: string; confidence?: "high" | "med" | "low"; why?: string };

// Drive ONE sweep over a single planted fixture file, with an injected DryRunNotifier
// the assertions read back. `novel` seeds the governed adaptive layer's JSON answer
// (empty → the deterministic gate alone decides the verdict).
async function sweepText(text: string, novel: Novel[] = []) {
  const engine = new MockEngine(() => JSON.stringify(novel));
  const notifier = new DryRunNotifier(() => {});
  const repo = tmpRepo();
  const surface = "packaging/fixture.md";
  await Bun.write(join(repo, surface), text);
  const { result } = await runAgent("sentinel", {
    dir: AGENTS,
    engine,
    comb: comb(),
    notifier,
    repoRoot: repo,
    input: { text: surface, args: [surface], flags: { target: surface } },
  });
  return { result, notifier, repo };
}

// The legacy DETERMINISTIC classes — the network-free gate the reborn keeps in TS.
// (Legacy ids preserved; the anthropic-key shape is caught by the generic provider-key
// pattern, since a public tool must not hardcode a vendor-specific secret rule either.)
const GATE_CASES: { id: string; text: string; leak: boolean; cat?: string }[] = [
  { id: "clean-passes", text: "A generic agent helps the operator with a task. No real entities. example.com only.", leak: false },
  { id: "catches-secret", text: "key = sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", leak: true, cat: "provider-api-key" },
  // Regression: a leaked PEM private key must fail closed (legacy grep parsed the leading
  // dashes as flags and let it pass "Safe to release").
  { id: "catches-pem-key", text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", leak: true, cat: "private-key" }, // # public-clean: ok synthetic PEM fixture (exercises the private-key gate)
  { id: "catches-email", text: "reach me at someone@acme.example", leak: true, cat: "email" },
  { id: "catches-broad-email", text: "reach the buyer at buyer@acme.example", leak: true, cat: "email" }, // #11 client email on any domain
  { id: "allowlist-no-self-exempt", text: "key = sk-test-AAAAAAAAAAAAAAAAAAAA   public-clean: ok", leak: true, cat: "provider-api-key" }, // #10 bare phrase must NOT exempt
  { id: "placeholder-email-ok", text: "configure your address like user@example.com", leak: false }, // broad-email must not false-positive on placeholders
];

describe("sentinel — public-clean gate (eval port: deterministic leak classes)", () => {
  for (const c of GATE_CASES) {
    test(c.id, async () => {
      const { result, notifier, repo } = await sweepText(c.text);
      if (c.leak) {
        expect(result.exposure).toBe(true);
        expect(result.clean).toBe(false);
        if (c.cat) expect(result.gate_categories as string[]).toContain(c.cat);
        // Every real leak ALSO pushes a recorded CRITICAL alert (dry-run/queued).
        expect(result.notified).toBe(true);
        expect(notifier.notifications.length).toBe(1);
        expect(notifier.notifications[0].level).toBe("critical");
        // Redaction discipline: the raw secret value is never echoed in the report.
        const report = await Bun.file(join(repo, result.report as string)).text();
        expect(report).not.toContain("sk-test-");
      } else {
        expect(result.exposure).toBe(false);
        expect(result.clean).toBe(true);
        // Clean content pushes NO alert.
        expect(result.notified).toBe(false);
        expect(notifier.notifications.length).toBe(0);
      }
    });
  }
});

// The legacy OPERATOR-IP classes. The reborn does NOT hardcode operator identity in its
// (public) deterministic gate — it LEARNS these via the governed adaptive layer, so each
// high-confidence novel entity becomes a proposed gate rule the NEXT sweep catches by
// pattern. Re-expressed here on that layer (the mock supplies the high-confidence find).
const ADAPTIVE_CASES: { id: string; entity: string; type: string; text: string }[] = [
  { id: "catches-person", entity: "Jane Doe", type: "person", text: "this was built by Jane Doe" },
  { id: "catches-client", entity: "Globex", type: "client", text: "inspired by the Globex engagement" },
  { id: "catches-product", entity: "Contoso", type: "product", text: "mirrors the Contoso cso archetype" },
  { id: "catches-address", entity: "123 Example St", type: "address", text: "office at 123 Example St, Springfield" },
  { id: "catches-spaced-product", entity: "Contoso Cloud", type: "product", text: "this mirrors the Contoso Cloud design canvas" }, // #12 spaced variant
];

describe("sentinel — adaptive+learned classes (eval port: operator-IP leak classes)", () => {
  for (const c of ADAPTIVE_CASES) {
    test(c.id, async () => {
      const novel: Novel[] = [{ entity: c.entity, type: c.type, confidence: "high", why: "operator-specific IP a public tool must not ship" }];
      const { result, notifier } = await sweepText(c.text, novel);
      // The deterministic gate is clean on these (no secret/email); the governed adaptive
      // layer flags the entity, it is LEARNED into a proposed rule, and the verdict is EXPOSURE.
      expect(result.exposure).toBe(true);
      expect(result.novel_high).toBe(1);
      expect(result.learned).toBe(1);
      // Exposure → recorded CRITICAL alert (dry-run/queued).
      expect(result.notified).toBe(true);
      expect(notifier.notifications.length).toBe(1);
      expect(notifier.notifications[0].level).toBe("critical");
    });
  }
});
