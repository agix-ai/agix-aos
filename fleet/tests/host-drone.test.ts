// Host Drone tests — HERMETIC ($0/offline, no Go binary, no key, no network, no gh).
// The drone is the only agent that can write to the code host, so its gates are the most
// safety-critical code in the fleet. Every gate is asserted to FAIL CLOSED:
//   - security actions are never automated
//   - the NEVER list holds even if the manifest were edited
//   - the manifest exec allowlist is a ceiling (deny-by-default)
//   - an unvalidated proposal is refused (actor != verifier: no self-certification)
//   - the earned autonomy rung is the live gate below the ceiling
//   - an unknown/corrupt ledger yields `shadow`, never a wider rung
//   - AI-authorship disclosure is appended exactly once
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runAgent } from "../runtime/runner.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import {
  decide, parseRung, withDisclosure, AI_DISCLOSURE, NEVER,
  type HostAction, type Rung,
} from "../../agents/host-drone/agent.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const tmpRepo = () => mkdtempSync(join(tmpdir(), "agix-host-drone-"));
const comb = () => new MemComb({ roster: ["host-drone/worker/verifier-1"], trustFloor: 0.35 });

// The real ceiling, as declared in agents/host-drone/agent.json.
const CEILING = ["gh issue view", "gh issue list", "gh issue edit", "gh issue comment", "gh pr view", "gh pr list", "gh pr comment", "gh pr diff"];

const labelAction = (over: Partial<HostAction> = {}): HostAction => ({
  domain: "issue-label",
  command: "gh issue edit 1 --add-label bug",
  summary: "label #1 as bug",
  validated: true,
  ...over,
});

describe("decide() — every gate fails closed", () => {
  test("security findings are never automated, at ANY rung", () => {
    const d = decide(labelAction({ security: true }), "act", CEILING);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("routed to a human");
  });

  test("the NEVER list holds even at act, even if it were in the ceiling", () => {
    for (const cmd of ["gh pr merge 1", "gh repo delete", "git push --force", "gh secret set X"]) {
      const d = decide(labelAction({ command: cmd }), "act", [...CEILING, ...NEVER]);
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("permanently denied");
    }
  });

  test("the exec ceiling is deny-by-default (empty ceiling permits nothing)", () => {
    expect(decide(labelAction(), "act", []).allowed).toBe(false);
    // Outside the ceiling, even though it is not on the NEVER list.
    expect(decide(labelAction({ command: "gh gist create" }), "act", CEILING).allowed).toBe(false);
  });

  test("an unvalidated proposal is refused — the drone may not self-certify", () => {
    const d = decide(labelAction({ validated: false }), "act", CEILING);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("no distinct-verifier validation");
  });

  test("the earned rung is the live gate: shadow cannot act, act can", () => {
    const shadow = decide(labelAction(), "shadow", CEILING);
    expect(shadow.allowed).toBe(false);
    expect(shadow.effect).toBe("proposal-file"); // writes a file, touches nothing
    expect(shadow.reason).toContain("has earned `shadow`");

    const propose = decide(labelAction(), "propose", CEILING);
    expect(propose.allowed).toBe(false); // issue-label requires `act`

    const act = decide(labelAction(), "act", CEILING);
    expect(act.allowed).toBe(true);
    expect(act.effect).toBe("host-write");
  });

  test("an unknown domain defaults to requiring `act` (deny-by-default)", () => {
    const d = decide(labelAction({ domain: "some-new-domain" }), "propose", CEILING);
    expect(d.allowed).toBe(false);
  });
});

describe("parseRung() — the Go-written ledger, read safely", () => {
  test("an absent ledger yields shadow", () => {
    expect(parseRung(null, "issue-label")).toBe("shadow");
    expect(parseRung("", "issue-label")).toBe("shadow");
  });

  test("last record per domain wins, and other domains do not leak authority", () => {
    // The Go ledger stores Rung as an int (autonomy.Rung is an int enum).
    const jsonl = [
      JSON.stringify({ domain: "issue-label", rung: 1 }),
      JSON.stringify({ domain: "issue-label", rung: 2 }),
      JSON.stringify({ domain: "pr-comment", rung: 2 }),
    ].join("\n");
    expect(parseRung(jsonl, "issue-label")).toBe("act");
    expect(parseRung(jsonl, "pr-comment")).toBe("act");
    expect(parseRung(jsonl, "release")).toBe("shadow"); // never recorded → shadow
  });

  test("a demotion recorded later wins over an earlier promotion", () => {
    const jsonl = [
      JSON.stringify({ domain: "issue-label", rung: 2 }),
      JSON.stringify({ domain: "issue-label", rung: 0 }),
    ].join("\n");
    expect(parseRung(jsonl, "issue-label")).toBe("shadow");
  });

  test("a corrupt line never widens authority", () => {
    const jsonl = ["{ this is not json", JSON.stringify({ domain: "issue-label", rung: 1 }), "}}}"].join("\n");
    expect(parseRung(jsonl, "issue-label")).toBe("propose");
    expect(parseRung("garbage\ngarbage", "issue-label")).toBe("shadow");
  });

  test("tolerates the string rung form as well as the int form", () => {
    expect(parseRung(JSON.stringify({ domain: "d", rung: "act" }), "d")).toBe("act");
  });
});

describe("withDisclosure() — AI authorship, exactly once", () => {
  test("appends the disclosure", () => {
    expect(withDisclosure("hello")).toContain("automated agent");
  });
  test("is idempotent — never doubles up", () => {
    const once = withDisclosure("hello");
    expect(withDisclosure(once)).toBe(once);
    expect(once.split("automated agent").length - 1).toBe(1);
  });
  test("the disclosure names the agent and invites correction", () => {
    expect(AI_DISCLOSURE).toContain("agix-steward");
    expect(AI_DISCLOSURE).toContain("reply to correct it");
  });
});

describe("host-drone (boundary / drone caste)", () => {
  test("smoke short-circuits to one governed surface check", async () => {
    const engine = new MockEngine();
    const { result } = await runAgent("host-drone", {
      dir: AGENTS, engine, comb: comb(), repoRoot: tmpRepo(), smoke: true,
      input: { mode: "", args: [], text: "", flags: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("host-drone/worker/verifier-1");
  });

  test("with no earned rung, it refuses every action and spawns NO governed run", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    await Bun.write(join(repo, "actions.json"), JSON.stringify([labelAction(), labelAction({ domain: "pr-comment", command: "gh pr comment 2 --body hi" })]));
    const { result } = await runAgent("host-drone", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { actions: "actions.json" } },
    });
    expect(result.performed).toBe(0);
    expect(result.refused).toBe(2);
    // The load-bearing property: nothing reached the host, so nothing was even executed.
    expect(engine.calls.length).toBe(0);
    const log = readFileSync(join(repo, result.actionLog as string), "utf8");
    expect(log).toContain("refused");
    // The action log states the identity boundary explicitly.
    expect(log).toContain("The operator's personal token is never used");
    expect(result.identity).toContain("never the operator's token");
  });

  test("with `act` earned on issue-label, it performs that action and still refuses pr-comment", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    const ledger = join(repo, "governance/tenants/agix/autonomy.jsonl");
    mkdirSync(dirname(ledger), { recursive: true });
    await Bun.write(ledger, JSON.stringify({ domain: "issue-label", rung: 2 }) + "\n");
    await Bun.write(join(repo, "actions.json"), JSON.stringify([
      labelAction(),
      labelAction({ domain: "pr-comment", command: "gh pr comment 2 --body hi", body: "hi" }),
    ]));

    const { result } = await runAgent("host-drone", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { actions: "actions.json" } },
    });
    expect(result.performed).toBe(1); // issue-label earned act
    expect(result.refused).toBe(1);   // pr-comment did not
    expect(engine.calls.length).toBe(1);
    expect(existsSync(join(repo, result.actionLog as string))).toBe(true);
  });

  test("a posted body carries the AI disclosure", async () => {
    const engine = new MockEngine();
    const repo = tmpRepo();
    const ledger = join(repo, "governance/tenants/agix/autonomy.jsonl");
    mkdirSync(dirname(ledger), { recursive: true });
    await Bun.write(ledger, JSON.stringify({ domain: "issue-comment", rung: 2 }) + "\n");
    await Bun.write(join(repo, "actions.json"), JSON.stringify([
      { domain: "issue-comment", command: "gh issue comment 1 --body x", summary: "reply", body: "Thanks for the report.", validated: true },
    ]));
    await runAgent("host-drone", {
      dir: AGENTS, engine, comb: comb(), repoRoot: repo,
      input: { mode: "", args: [], text: "", flags: { actions: "actions.json" } },
    });
    expect(engine.calls[0].task).toContain("automated agent");
  });
});
