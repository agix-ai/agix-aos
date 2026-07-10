// End-to-end integration — the REAL TS↔Go seam. When the `agix-core` binary is
// available (AGIX_CORE_BIN or on PATH), these tests drive a fixture agent through
// SpawnEngine, which shells `agix-core agent run … --engine --json`, and assert
// the Go engine returned a genuinely governed result (distinct verifier, $0 on
// the mock provider). They SKIP cleanly when the binary is absent, so the default
// `bun test` stays hermetic.
//
// Build the binary + point the tests at it:
//   (cd core && go build -o /tmp/agix-core ./cmd/agix-core)
//   AGIX_CORE_BIN=/tmp/agix-core bun test fleet/tests/integration.test.ts

import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { SpawnEngine } from "../runtime/engine.ts";
import { runAgent } from "../runtime/runner.ts";
import { MemComb } from "../runtime/comb.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const FIXTURES = join(import.meta.dir, "fixtures");

async function locateBinary(): Promise<string | null> {
  if (Bun.env.AGIX_CORE_BIN) return Bun.env.AGIX_CORE_BIN;
  const which = Bun.spawnSync(["which", "agix-core"]);
  const p = which.stdout.toString().trim();
  return p || null;
}

const bin = await locateBinary();
const describeOrSkip = bin ? describe : describe.skip;

describeOrSkip("real agix-core governed seam", () => {
  test("SpawnEngine drives a governed Go run (distinct verifier, $0 on mock)", async () => {
    const engine = new SpawnEngine({ bin: bin!, dir: FIXTURES, provider: "mock" });
    const r = await engine.run("probe", "integration: is the seam live?");
    expect(r.verified).toBe(true);
    expect(r.verifierActor).toBe("probe/worker/verifier-1");
    expect(r.verifierActor).not.toBe(r.queenActor);
    expect(r.verdict.by).toBe(r.verifierActor);
    expect(r.cost.usd).toBe(0);
  });

  test("runAgent runs the probe agent.ts through the real engine end-to-end", async () => {
    const engine = new SpawnEngine({ bin: bin!, dir: FIXTURES, provider: "mock" });
    const { result } = await runAgent("probe", {
      dir: FIXTURES,
      engine,
      comb: new MemComb(),
      repoRoot: mkdtempSync(join(tmpdir(), "agix-fleet-int-")),
      input: { text: "end to end" },
    });
    expect(result.ok).toBe(true);
    expect(result.verifier).toBe("probe/worker/verifier-1");
  });
});
