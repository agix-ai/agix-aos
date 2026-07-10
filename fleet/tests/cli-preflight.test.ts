// The governed-engine pre-flight — the guard that keeps "verification never ran"
// from reading as "verified".
//
// Every agent's governed unit goes through SpawnEngine → `agix-core agent run …
// --engine`, which is where actor≠verifier, the tool loop, and the public gate are
// enforced. Agents catch broadly (by design, so an empty corpus is not a crash), so
// before this guard existed a MISSING engine binary was swallowed by the same catch
// as "found nothing": the run logged a skip, reported `result: ok`, and exited 0.
// A caller could not distinguish a certified run from a run where governance never
// executed. `cli.ts` now refuses up front — loud, once, early, exit 2.
//
// These tests are hermetic: the negative cases POISON the resolution deliberately,
// so they need no binary. The positive case skips cleanly when none is available.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "runtime", "cli.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

/** Run the fleet CLI with an explicit environment; returns exit code + streams.
 *  Spawns Bun by ABSOLUTE path (process.execPath) so a test may blank PATH to prove
 *  the PATH-resolution branch without also hiding the interpreter from itself. */
async function runCli(argv: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...env } as Record<string, string>,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("governed-engine pre-flight", () => {
  test("refuses to run when AGIX_CORE_BIN points at a nonexistent binary", async () => {
    const { stderr, code } = await runCli(["run", "probe", "--dir", FIXTURES, "--provider", "mock"], {
      AGIX_CORE_BIN: "/nonexistent/agix-core",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("governed engine not found");
    expect(stderr).toContain("/nonexistent/agix-core");
  });

  test("refuses to run when no binary resolves on PATH", async () => {
    const { stderr, code } = await runCli(["run", "probe", "--dir", FIXTURES, "--provider", "mock"], {
      AGIX_CORE_BIN: undefined,
      PATH: "/var/empty",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("governed engine not found");
  });

  test("emits a machine-readable error under --json (never a bare ok)", async () => {
    const { stdout, code } = await runCli(
      ["run", "probe", "--dir", FIXTURES, "--provider", "mock", "--json"],
      { AGIX_CORE_BIN: "/nonexistent/agix-core" },
    );
    expect(code).toBe(2);
    const j = JSON.parse(stdout.trim());
    expect(j.error).toContain("governed engine not found");
    // The regression this locks down: a missing engine must never surface as a
    // successful, verifier-less result envelope.
    expect(j.ok).toBeUndefined();
  });

  test("`list` stays usable without an engine (it runs no governed unit)", async () => {
    const { code } = await runCli(["list", "--dir", FIXTURES], { AGIX_CORE_BIN: "/nonexistent/agix-core" });
    expect(code).toBe(0);
  });
});

// Positive control: with a real binary the pre-flight is transparent. Skips when absent
// so the default `bun test` stays hermetic (same posture as integration.test.ts).
const bin = Bun.env.AGIX_CORE_BIN && (await Bun.file(Bun.env.AGIX_CORE_BIN).exists())
  ? Bun.env.AGIX_CORE_BIN
  : Bun.which("agix-core");

const describeOrSkip = bin ? describe : describe.skip;

describeOrSkip("pre-flight is transparent when the engine resolves", () => {
  test("a governed smoke run still succeeds", async () => {
    const { code } = await runCli(["run", "probe", "--dir", FIXTURES, "--provider", "mock", "--smoke"], {
      AGIX_CORE_BIN: bin!,
    });
    expect(code).toBe(0);
  });
});
