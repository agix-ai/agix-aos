// Manifest contract tests — the TS loader/validator must agree with the Go loader
// (core/agentspec.Spec.Validate) so one agent.json is read identically by both
// runtimes. $0/offline, no binary needed.

import { test, expect, describe } from "bun:test";
import { validateManifest, resolveCaste, loadManifest, type Manifest } from "../runtime/manifest.ts";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

function base(over: Partial<Manifest> = {}): Manifest {
  return {
    name: "probe",
    role: "worker",
    public: true,
    instructions: "do the thing",
    ...over,
  };
}

describe("manifest validation (mirrors agentspec.Spec.Validate)", () => {
  test("accepts a minimal well-formed manifest", () => {
    expect(() => validateManifest(base())).not.toThrow();
  });

  test("rejects a name with spaces or slashes", () => {
    expect(() => validateManifest(base({ name: "a b" }))).toThrow(/slug/);
    expect(() => validateManifest(base({ name: "a/b" }))).toThrow(/slug/);
  });

  test("requires role + instructions", () => {
    expect(() => validateManifest(base({ role: "" }))).toThrow(/role is required/);
    expect(() => validateManifest(base({ instructions: "" }))).toThrow(/instructions are required/);
  });

  test("rejects duplicate + empty tools", () => {
    expect(() => validateManifest(base({ tools: ["read", "read"] }))).toThrow(/duplicate/);
    expect(() => validateManifest(base({ tools: [""] }))).toThrow(/empty tool/);
  });

  test("rejects an invalid trust level", () => {
    expect(() => validateManifest(base({ trust: "overlord" as never }))).toThrow(/trust/);
  });
});

describe("caste resolution (mirrors agentspec.Spec.ResolveCaste)", () => {
  test("explicit caste wins", () => {
    expect(resolveCaste(base({ caste: "drone" }))).toBe("drone");
  });
  test("trust seeds the caste", () => {
    expect(resolveCaste(base({ trust: "conductor" }))).toBe("queen");
    expect(resolveCaste(base({ trust: "proposer" }))).toBe("worker");
    expect(resolveCaste(base({ trust: "boundary" }))).toBe("drone");
  });
  test("defaults to worker (least authority)", () => {
    expect(resolveCaste(base())).toBe("worker");
  });
});

describe("the two shipped reference manifests parse + carry their claimed identity", () => {
  test("mentor is a public conductor→queen", async () => {
    const m = await loadManifest(join(REPO, "agents", "mentor", "agent.json"));
    expect(m.public).toBe(true);
    expect(m.trust).toBe("conductor");
    expect(resolveCaste(m)).toBe("queen");
    expect(m.tools ?? []).toContain("fire");
  });

  test("investigator is a public proposer→worker that denies git", async () => {
    const m = await loadManifest(join(REPO, "agents", "investigator", "agent.json"));
    expect(m.public).toBe(true);
    expect(m.trust).toBe("proposer");
    expect(resolveCaste(m)).toBe("worker");
    expect(m.boundary?.deny ?? []).toContain("git push");
  });
});
