// SpawnEngine argv contract — the LIVE-RUN SAFETY seam. `--repoRoot` must reach
// `agix-core agent run` so the Go fs/metric/exec tools scope to the sidecar target,
// not the engine's CWD (the hive repo). Its omission is a silent-wrong-target
// hazard: the surgeon would edit the wrong tree. HERMETIC (no binary, no network).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { agentRunArgv } from "../runtime/engine.ts";

describe("agentRunArgv — the Bun→Go governed-run contract", () => {
  test("forwards --repoRoot before the task positional when set", () => {
    const argv = agentRunArgv({
      agent: "smell-scout",
      dir: "agents",
      provider: "anthropic",
      publicOnly: false,
      repoRoot: "sidecars/acme",
      task: "scan repo/ for structural smells",
    });
    // the value flag is present, paired, and precedes the free-form task.
    const i = argv.indexOf("--repoRoot");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("sidecars/acme");
    expect(i + 1).toBeLessThan(argv.indexOf("scan repo/ for structural smells"));
    // the governed path is forced and machine-readable.
    expect(argv).toContain("--engine");
    expect(argv).toContain("--json");
  });

  test("omits --repoRoot entirely when unset (defaults to engine CWD by design)", () => {
    const argv = agentRunArgv({
      agent: "mentor", dir: "agents", provider: "mock", publicOnly: false, task: "brief",
    });
    expect(argv).not.toContain("--repoRoot");
  });

  test("--public-only is threaded when the runner is public-only", () => {
    const argv = agentRunArgv({
      agent: "onboarding", dir: "agents", provider: "mock", publicOnly: true, repoRoot: "x", task: "",
    });
    expect(argv).toContain("--public-only");
    // an empty task adds no trailing positional.
    expect(argv[argv.length - 1]).not.toBe("");
  });
});
