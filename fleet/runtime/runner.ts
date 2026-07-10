// The Bun runner/loader — the heart of the reborn TS fleet. It loads an agent's
// manifest (agent.json) + behavior (agent.ts), enforces the public/proprietary
// gate, wires the governed-engine + Comb seams into a context, and invokes the
// agent's entrypoint. It adds NO new governance: actor≠verifier, the tool-use
// loop, the guard-bee boundary, and model-key resolution all live in Go; this
// runner only authors the context and asserts (via ctx.hive) that every result
// the engine hands back is governed.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { type Manifest, loadManifest, resolveCaste } from "./manifest.ts";
import { type EngineDriver, SpawnEngine } from "./engine.ts";
import { type Comb, CliComb } from "./comb.ts";
import { type Notifier, DryRunNotifier } from "./notify.ts";
import type { TurnIO } from "./session.ts";
import { type AgentContext, type AgentInput, type AgentResult, buildContext } from "./context.ts";
import type { AgentEntry } from "./sdk.ts";
import { join, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";

export interface LoadedAgent {
  manifest: Manifest;
  entry: AgentEntry;
  manifestPath: string;
  behaviorPath: string;
}

/** Load + validate a reborn agent: its manifest (agents/<name>/agent.json) and
 *  its behavior (agents/<name>/agent.ts, default export). */
export async function loadAgent(name: string, opts: { dir?: string } = {}): Promise<LoadedAgent> {
  const dir = opts.dir ?? "agents";
  const manifestPath = resolvePath(join(dir, name, "agent.json"));
  const behaviorPath = resolvePath(join(dir, name, "agent.ts"));

  const manifest = await loadManifest(manifestPath);
  if (manifest.name !== name) {
    throw new Error(`runner: ${manifestPath} declares name ${manifest.name}, expected ${name}`);
  }

  if (!(await Bun.file(behaviorPath).exists())) {
    throw new Error(`runner: ${name} has no agent.ts behavior at ${behaviorPath} (an un-ported or declarative-only agent)`);
  }
  const mod = (await import(behaviorPath)) as { default?: AgentEntry };
  if (typeof mod.default !== "function") {
    throw new Error(`runner: ${behaviorPath} must default-export an agent entrypoint (use defineAgent)`);
  }
  return { manifest, entry: mod.default, manifestPath, behaviorPath };
}

export interface RunAgentOptions {
  dir?: string;
  provider?: string;
  publicOnly?: boolean;
  smoke?: boolean;
  input?: Partial<AgentInput>;
  repoRoot?: string;
  /** Dependency-injected seams — production defaults are SpawnEngine + CliComb +
   *  DryRunNotifier; tests inject MockEngine + MemComb (+ a DryRunNotifier they read
   *  back, + a ScriptedIO for conversational modes) for a $0/offline hermetic run. */
  engine?: EngineDriver;
  comb?: Comb;
  /** Delivery seam (ctx.sendEmail / ctx.notify); default DryRunNotifier (records,
   *  sends nothing). */
  notifier?: Notifier;
  /** Interactive turn-loop seam (ctx.io); default NullIO (no turns → single-shot). */
  io?: TurnIO;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface RunAgentOutcome {
  manifest: Manifest;
  result: AgentResult;
}

/** Resolve the tool-workspace root. Unset → the current working directory (the
 *  documented default). A supplied root is resolved to an absolute path and asserted
 *  to be an existing directory; anything else THROWS rather than degrading to CWD —
 *  the fail-closed guard for the `--repoRoot` live-run safety seam. */
export function resolveRepoRoot(repoRoot?: string): string {
  if (repoRoot === undefined) return process.cwd();
  const abs = resolvePath(repoRoot);
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(abs);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    throw new Error(
      `runner: --repoRoot ${repoRoot} does not resolve to a directory (${abs}); ` +
        `refusing to fall back to CWD — a governed write/refactor would target the wrong tree`,
    );
  }
  return abs;
}

/** Run a reborn agent end-to-end: load, gate, wire context, invoke behavior. */
export async function runAgent(name: string, opts: RunAgentOptions = {}): Promise<RunAgentOutcome> {
  const dir = opts.dir ?? "agents";
  const provider = opts.provider ?? "mock";
  const publicOnly = opts.publicOnly ?? false;
  const smoke = opts.smoke ?? false;
  // repoRoot scopes every built-in fs/exec/metric tool (and ctx.read/writeRepoFile).
  // An UNSET repoRoot defaults to CWD — but a SUPPLIED one that does not resolve to a
  // directory must fail LOUD, never silently fall back to CWD: a governed write or
  // refactor scoped to the wrong tree is a live-run safety hazard (the surgeon would
  // edit the current dir instead of the sidecar's repo/). Fail closed.
  const repoRoot = resolveRepoRoot(opts.repoRoot);

  const { manifest, entry } = await loadAgent(name, { dir });

  // The public/proprietary gate (fast pre-check; Go re-enforces it authoritatively
  // on every governed unit). Honors the genericization seam either way.
  if (publicOnly && !manifest.public) {
    throw new Error(`runner: ${name} is proprietary (public=false); this runner is public-only`);
  }

  const engine = opts.engine ?? new SpawnEngine({ dir, provider, publicOnly, repoRoot });
  const comb = opts.comb ?? new CliComb();
  const notifier = opts.notifier ?? new DryRunNotifier();

  const input: AgentInput = {
    mode: opts.input?.mode,
    args: opts.input?.args ?? [],
    text: opts.input?.text ?? "",
    flags: opts.input?.flags ?? {},
  };

  const ctx: AgentContext = buildContext({
    manifest,
    input,
    engine,
    comb,
    notifier,
    io: opts.io,
    dir,
    provider,
    publicOnly,
    smoke,
    repoRoot,
    log: opts.log,
  });

  const result = await entry(ctx);
  return { manifest, result };
}

export { resolveCaste };
