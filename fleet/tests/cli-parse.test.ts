// parseArgv — the CLI front-door parser. Regression net for a silent
// wrong-verdict bug: the old parser only let `--dir`/`--provider` take a
// space-separated value, so `--input session.txt` set `input=true` and leaked
// the path into the positionals. Value-bearing flags now consume the next token;
// only the small BOOLEAN_FLAGS set stays switch-only.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { parseArgv, BOOLEAN_FLAGS, runFlags } from "../runtime/cli.ts";

describe("parseArgv", () => {
  test("value flags take the following token (space form) — the bug", () => {
    const p = parseArgv(["run", "context-warden", "--input", "session.txt"]);
    expect(p.cmd).toBe("run");
    expect(p.positionals).toEqual(["context-warden"]);
    // Previously: input=true and "session.txt" leaked into positionals.
    expect(p.flags.input).toBe("session.txt");
  });

  test("the `=` form still works and is unchanged", () => {
    const p = parseArgv(["run", "investigator", "--results=bench/go.json"]);
    expect(p.flags.results).toBe("bench/go.json");
  });

  test("space and `=` forms agree for a value flag", () => {
    const a = parseArgv(["run", "x", "--threshold", "99"]).flags.threshold;
    const b = parseArgv(["run", "x", "--threshold=99"]).flags.threshold;
    expect(a).toBe("99");
    expect(b).toBe("99");
  });

  test("boolean flags never consume the next token", () => {
    const p = parseArgv(["run", "architect", "--smoke", "--json"]);
    expect(p.flags.smoke).toBe(true);
    expect(p.flags.json).toBe(true);
    expect(p.positionals).toEqual(["architect"]);
  });

  test("a boolean flag before a positional leaves the positional intact", () => {
    const p = parseArgv(["run", "research", "--send", "chat"]);
    expect(p.flags.send).toBe(true); // `send` is in BOOLEAN_FLAGS
    expect(p.positionals).toEqual(["research", "chat"]);
  });

  test("a value flag whose value would start with -- is treated as a switch", () => {
    const p = parseArgv(["run", "research", "--send", "--to=a@b.c"]);
    expect(p.flags.send).toBe(true);
    expect(p.flags.to).toBe("a@b.c");
  });

  test("dir/provider still parse (no longer special-cased, but still value flags)", () => {
    const p = parseArgv(["run", "architect", "--dir", "agents", "--provider", "mock"]);
    expect(p.flags.dir).toBe("agents");
    expect(p.flags.provider).toBe("mock");
  });

  test("trailing value flag with no value is a boolean", () => {
    const p = parseArgv(["run", "x", "--input"]);
    expect(p.flags.input).toBe(true);
  });

  test("BOOLEAN_FLAGS covers the framework switches", () => {
    for (const f of ["smoke", "json", "interactive", "public-only", "engine"]) {
      expect(BOOLEAN_FLAGS.has(f)).toBe(true);
    }
  });
});

// R4 — the `run` command must THREAD --repoRoot into runAgent. The regression: the
// flag parsed into flags.repoRoot but cmdRun never read it, so runAgent defaulted to
// CWD and a governed write/refactor targeted the current dir, not the sidecar. These
// lock the flag→option mapping (runFlags) that cmdRun now uses.
describe("runFlags — the run command's flag→runAgent wiring", () => {
  test("--repoRoot is threaded through (space form) — the R4 bug", () => {
    const rf = runFlags(parseArgv(["run", "refactor-surgeon", "--repoRoot", "sidecars/pay"]));
    // Previously: repoRoot was dropped entirely → undefined → runAgent used CWD.
    expect(rf.repoRoot).toBe("sidecars/pay");
  });

  test("--repoRoot= form is threaded too", () => {
    const rf = runFlags(parseArgv(["run", "smell-scout", "--repoRoot=sidecars/pay", "--dir", "agents"]));
    expect(rf.repoRoot).toBe("sidecars/pay");
    expect(rf.dir).toBe("agents");
  });

  test("no --repoRoot → undefined (runAgent defaults to CWD)", () => {
    const rf = runFlags(parseArgv(["run", "tester"]));
    expect(rf.repoRoot).toBeUndefined();
    expect(rf.provider).toBe("mock");
  });

  test("a bare --repoRoot (no value) THROWS — fail closed, never silently drop the scope", () => {
    // parseArgv turns a trailing bare flag into `repoRoot: true`; runFlags must refuse
    // it rather than treat it as unset (which would fall back to CWD — the R4 hazard).
    expect(() => runFlags(parseArgv(["run", "refactor-surgeon", "--repoRoot"]))).toThrow(/repoRoot/);
  });

  test("other run flags still map (dir/provider/json/public-only/smoke)", () => {
    const rf = runFlags(parseArgv(["run", "x", "--dir", "agents", "--provider", "anthropic", "--json", "--public-only", "--smoke"]));
    expect(rf).toMatchObject({ dir: "agents", provider: "anthropic", jsonOut: true, publicOnly: true, smoke: true });
  });
});
