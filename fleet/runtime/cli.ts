#!/usr/bin/env bun
// The Bun CLI — the front door for running a reborn TS agent's BEHAVIOR. It is
// what `agix-core agent run <name>` delegates to when an agent carries an
// agent.ts, and what an author runs directly:
//
//   bun fleet/runtime/cli.ts run <name> [mode] [args…] [--dir agents]
//       [--provider mock|anthropic|openai] [--smoke] [--public-only] [--json]
//   bun fleet/runtime/cli.ts list [--dir agents]
//
// It wires the PRODUCTION seams — SpawnEngine (governed runs via `agix-core`) and
// CliComb (durable memory via `agix-core km`) — then invokes the agent. Each
// governed unit the agent runs calls back into `agix-core agent run … --engine`,
// so governance stays in Go while orchestration runs here in TypeScript.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { runAgent } from "./runner.ts";
import { loadManifest } from "./manifest.ts";
import { StdinIO } from "./session.ts";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Parsed {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

// The switches that take NO value — everything else that is followed by a
// non-`--` token consumes it as that flag's value. This inversion (small, stable
// boolean set vs. an open-ended, ever-growing value set) fixes a silent
// wrong-verdict bug: the old code only let `--dir`/`--provider` take a
// space-separated value, so `--input session.txt` set `input=true` and leaked
// `session.txt` into the positionals. A context-warden then audited the literal
// string "session.txt" and reported HEALTHY on a degraded session; head-of-the-lab
// read `--results file` as no results and shipped a HOLD instead of a GO. The
// `--flag=value` form always worked and is unchanged; a genuinely-boolean flag
// missing from this set only misbehaves if followed by a bare positional (rare,
// and a visible error — never a silent wrong verdict). Keep in sync with the
// booleans agents read via `=== true`.
export const BOOLEAN_FLAGS = new Set([
  "smoke", "json", "interactive", "public-only", "engine",
  "send", "dry-run", "dryRun", "no-discover", "noDiscover",
  "verify-deploy", "force", "reset", "generalize",
]);

export function parseArgv(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (
        i + 1 < rest.length &&
        !rest[i + 1].startsWith("--") &&
        !BOOLEAN_FLAGS.has(a.slice(2))
      ) {
        flags[a.slice(2)] = rest[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd: cmd ?? "", positionals, flags };
}

/** The options the `run` command threads into runAgent. Kept as a named shape so
 *  the flag→run wiring is a single, testable mapping — the seam a whole class of
 *  "flag silently dropped" bugs lives in. */
export interface RunFlags {
  dir: string;
  provider: string;
  jsonOut: boolean;
  publicOnly: boolean;
  smoke: boolean;
  /** The sidecar tree the built-in fs/exec/metric tools are scoped to. undefined =
   *  not supplied (runAgent defaults to CWD); a string is honored and existence-
   *  checked downstream. */
  repoRoot?: string;
}

/** Map parsed CLI flags to the run command's runAgent options. Exported so the
 *  wiring — especially `--repoRoot`, a LIVE-RUN SAFETY seam whose omission silently
 *  scopes a governed write/refactor to CWD instead of the sidecar `repo/` — is
 *  unit-testable without spawning the governed engine. Fail closed: a `--repoRoot`
 *  given with no value throws rather than being silently treated as unset (which
 *  would fall back to CWD — the exact hazard this flag exists to prevent). */
export function runFlags(p: Parsed): RunFlags {
  const repoRootRaw = p.flags.repoRoot;
  if (repoRootRaw === true) {
    throw new Error(`--repoRoot needs a directory value (got a bare flag; refusing to fall back to CWD)`);
  }
  return {
    dir: (p.flags.dir as string) ?? "agents",
    provider: (p.flags.provider as string) ?? "mock",
    jsonOut: p.flags.json === true,
    publicOnly: p.flags["public-only"] === true,
    smoke: p.flags.smoke === true,
    repoRoot: typeof repoRootRaw === "string" ? repoRootRaw : undefined,
  };
}

function usage(): void {
  process.stderr.write(
    `agix fleet — run a reborn TypeScript agent on Bun\n\n` +
      `usage:\n` +
      `  bun fleet/runtime/cli.ts run <name> [mode] [args…] [--dir agents]\n` +
      `      [--provider mock|anthropic|openai] [--smoke] [--public-only] [--json] [--interactive]\n` +
      `  bun fleet/runtime/cli.ts list [--dir agents]\n\n` +
      `Conversational modes (mentor chat|session, secretary ask) run an interactive,\n` +
      `history-maintaining turn-loop on a terminal (or with --interactive); each turn is\n` +
      `a governed hive pass. Single-shot modes are unchanged.\n`,
  );
}

async function cmdList(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    process.stderr.write(`list: cannot read ${dir}\n`);
    return 1;
  }
  const rows: string[] = [];
  for (const name of entries.sort()) {
    const manifestPath = join(dir, name, "agent.json");
    if (!(await Bun.file(manifestPath).exists())) continue;
    const hasTS = await Bun.file(join(dir, name, "agent.ts")).exists();
    try {
      const m = await loadManifest(manifestPath);
      const dist = m.public ? "public" : "proprietary";
      const behavior = hasTS ? "ts" : "declarative";
      rows.push(`${name.padEnd(14)} ${(m.trust ?? "-").padEnd(9)} ${m.tier ?? "basic"}/${dist}  behavior=${behavior}`);
    } catch (e) {
      rows.push(`${name.padEnd(14)} INVALID: ${(e as Error).message}`);
    }
  }
  if (rows.length === 0) {
    process.stdout.write(`no reborn agents found under ${dir}\n`);
    return 0;
  }
  process.stdout.write(rows.join("\n") + "\n");
  return 0;
}

/** Resolve the governed engine binary the same way SpawnEngine and CliComb do:
 *  AGIX_CORE_BIN wins, else `agix-core` on PATH. A path-ish value is checked on
 *  disk; a bare name is looked up on PATH. */
function resolveEngineBin(): { bin: string; found: boolean } {
  // `||` (not `??`) so an empty AGIX_CORE_BIN="" — a common shell footgun — is
  // treated as unset and falls back to the PATH lookup, rather than probing "".
  const bin = Bun.env.AGIX_CORE_BIN || "agix-core";
  const found = bin.includes("/") ? existsSync(bin) : Bun.which(bin) !== null;
  return { bin, found };
}

/** Pre-flight the governed engine BEFORE any agent runs.
 *
 *  Every agent's governed unit goes through SpawnEngine → `agix-core agent run
 *  … --engine`, which is where actor≠verifier, the tool loop, and the public gate
 *  are enforced. If the binary is absent, SpawnEngine throws *inside* each governed
 *  call — and agents catch broadly (by design, to tolerate an empty corpus), so an
 *  "engine missing" fault is swallowed identically to "found nothing" and the run
 *  still reports `result: ok`, exit 0. Refusing here is what keeps "verification
 *  never ran" from ever reading as "verified". Fail loud, fail once, fail early. */
function preflightEngine(): string | null {
  const { bin, found } = resolveEngineBin();
  if (found) return null;
  return (
    `governed engine not found: ${Bun.env.AGIX_CORE_BIN ? `AGIX_CORE_BIN=${bin} does not exist` : `\`${bin}\` is not on PATH`}\n` +
    `  Agent runs are governed by the Go engine (actor≠verifier, tool loop, public gate).\n` +
    `  Refusing to run: without it, governed stages degrade to silent no-ops that still report ok.\n` +
    `  Fix: cd core && go build -o "$PWD/../.agix-bin/agix-core" ./cmd/agix-core\n` +
    `       then export AGIX_CORE_BIN="$PWD/.agix-bin/agix-core"  (or put agix-core on PATH)`
  );
}

async function cmdRun(p: Parsed): Promise<number> {
  const name = p.positionals[0];
  if (!name) {
    process.stderr.write(`run: need an agent name\n`);
    usage();
    return 2;
  }

  const engineFault = preflightEngine();
  if (engineFault) {
    if (p.flags.json === true) process.stdout.write(JSON.stringify({ error: engineFault }) + "\n");
    else process.stderr.write(`run: ${engineFault}\n`);
    return 2;
  }

  let rf: RunFlags;
  try {
    rf = runFlags(p);
  } catch (e) {
    const msg = (e as Error).message;
    if (p.flags.json === true) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
    else process.stderr.write(`run: ${msg}\n`);
    return 2;
  }
  const { dir, provider, jsonOut, publicOnly, smoke, repoRoot } = rf;

  const modeArgs = p.positionals.slice(1);
  const input = {
    mode: modeArgs[0],
    args: modeArgs.slice(1),
    text: modeArgs.join(" "),
    flags: p.flags,
  };

  // Interactive turn-loop seam: on a real terminal (or with --interactive) attach a
  // stdin REPL so a conversational mode (mentor chat/session, secretary ask) can take
  // turns. It is created LAZILY (see StdinIO), so a single-shot mode that never asks
  // for a turn never touches stdin — the non-interactive path is byte-for-byte
  // unchanged. Piped/non-TTY runs get the NullIO default (no turns).
  const interactive = process.stdin.isTTY === true || p.flags.interactive === true;
  const io = interactive ? new StdinIO() : undefined;

  try {
    const { manifest, result } = await runAgent(name, { dir, provider, publicOnly, smoke, input, io, repoRoot });
    if (jsonOut) {
      process.stdout.write(JSON.stringify({ agent: manifest.name, ...result }) + "\n");
    } else {
      process.stdout.write(
        `agent:  ${manifest.name} (${manifest.display_name ?? manifest.name})  behavior=ts\n` +
          `result: ${result.ok ? "ok" : "incomplete"}\n` +
          Object.entries(result)
            .filter(([k]) => k !== "ok")
            .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("\n") +
          "\n",
      );
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    if (jsonOut) process.stdout.write(JSON.stringify({ error: (e as Error).message }) + "\n");
    else process.stderr.write(`run: ${(e as Error).message}\n`);
    return 1;
  } finally {
    io?.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseArgv(Bun.argv.slice(2));
  switch (parsed.cmd) {
    case "run":
      return cmdRun(parsed);
    case "list":
      return cmdList((parsed.flags.dir as string) ?? "agents");
    case "":
    case "help":
    case "-h":
    case "--help":
      usage();
      return parsed.cmd === "" ? 2 : 0;
    default:
      process.stderr.write(`unknown command: ${parsed.cmd}\n`);
      usage();
      return 2;
  }
}

// Run only as the direct entrypoint (`bun cli.ts …`, incl. the Go→bun delegate),
// never when imported for unit tests. `import.meta.main` is true exactly then.
if (import.meta.main) {
  process.exit(await main());
}
