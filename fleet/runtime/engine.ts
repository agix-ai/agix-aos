// The TS↔Go boundary. An EngineDriver is the ONE seam through which a TypeScript
// agent invokes intelligence, and it is ALWAYS a governed run: the Go engine
// (core/swarm via hivekit) decomposes the task, fans out worker bees, synthesizes,
// and certifies the answer through a DISTINCT verifier (actor≠verifier). This
// runtime NEVER re-implements the tool-use loop or the swarm in TypeScript — that
// governance lives in Go, and the driver only shells into it.
//
//   - SpawnEngine  — production: spawns `agix-core agent run <name> --engine --json`
//                    (the declarative governed hive; --engine means "do not
//                    re-enter Bun", so the Go→Bun→Go hop is non-recursive).
//   - MockEngine   — a $0/offline deterministic governed result for `bun test`, so
//                    the runner is testable with no binary, no key, no network.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

/** Options for one governed run. Tiering/boundary/public come from the target
 *  agent's manifest (read by the Go engine), so callers rarely set more than the
 *  provider — the manifest is the single source of truth. */
export interface HiveRunOptions {
  provider?: string;
  publicOnly?: boolean;
  /** Working dir the agent manifests live under (default "agents"). */
  dir?: string;
  /** The sidecar tree the Go fs/metric/exec tools are scoped to. Defaults to the
   *  engine's constructor repoRoot; a per-call value overrides it. */
  repoRoot?: string;
}

export interface Verdict {
  approved: boolean;
  /** The certifying actor — ALWAYS the distinct verifier, never the queen. */
  by: string;
  notes: string;
}

export interface GovernedCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  bees: number;
}

/** GovernedResult is the frozen outcome of one governed run — the TS mirror of the
 *  Go runJSON seam contract. The two governance facts a reviewer checks are
 *  first-class: verifierActor (≠ queenActor) and the graded verdict. */
export interface GovernedResult {
  agent: string;
  verified: boolean;
  verdict: Verdict;
  answer: string;
  queenActor: string;
  verifierActor: string;
  tools: string[];
  unresolvedTools: string[];
  boundary: { ref: string; allowed: boolean; source: string }[];
  cost: GovernedCost;
  subtasks: { id: string; title: string }[];
  degraded: string[];
}

export interface EngineDriver {
  /** Run `agent` against `task` as a governed hive and return its certified
   *  result. Implementations MUST return a distinct verifier (actor≠verifier);
   *  the runner asserts it as a governance tripwire. */
  run(agent: string, task: string, opts?: HiveRunOptions): Promise<GovernedResult>;
}

/** The raw JSON shape `agix-core agent run --json` emits (snake_case). */
interface EngineJSON {
  agent: string;
  caste: string;
  trust: string;
  verified: boolean;
  verdict: { approved: boolean; by: string; notes: string };
  answer: string;
  queen_actor: string;
  verifier_actor: string;
  tools: string[] | null;
  unresolved_tools: string[] | null;
  boundary: { ref: string; allowed: boolean; source: string }[] | null;
  cost: { usd: number; input_tokens: number; output_tokens: number; bees: number };
  subtasks: { id: string; title: string }[] | null;
  degraded: string[] | null;
  error?: string;
}

function fromEngineJSON(j: EngineJSON): GovernedResult {
  return {
    agent: j.agent,
    verified: j.verified,
    verdict: j.verdict,
    answer: j.answer,
    queenActor: j.queen_actor,
    verifierActor: j.verifier_actor,
    tools: j.tools ?? [],
    unresolvedTools: j.unresolved_tools ?? [],
    boundary: j.boundary ?? [],
    cost: {
      usd: j.cost.usd,
      inputTokens: j.cost.input_tokens,
      outputTokens: j.cost.output_tokens,
      bees: j.cost.bees,
    },
    subtasks: j.subtasks ?? [],
    degraded: j.degraded ?? [],
  };
}

/** SpawnEngine drives the governed hive by shelling out to the Go `agix-core`
 *  binary. Governance (the tool-use loop, the swarm, actor≠verifier, the guard-bee
 *  boundary, the public gate, model-key resolution) is applied entirely by the Go
 *  engine from the agent's manifest — this class only spawns and parses. */
/** Build the `agix-core agent run` argv for one governed unit. Extracted as a pure
 *  function so the argv contract is unit-testable without spawning a binary. The
 *  `--repoRoot` forward is LIVE-RUN SAFETY: without it the Go fs/metric/exec tools
 *  scope to the engine's CWD (the hive repo) instead of the sidecar target, so the
 *  surgeon would edit the wrong tree — a silent-wrong-target hazard. `--repoRoot`
 *  is a value flag placed before the task positional. */
export function agentRunArgv(o: {
  agent: string;
  dir: string;
  provider: string;
  publicOnly: boolean;
  repoRoot?: string;
  task: string;
}): string[] {
  const argv = ["agent", "run", o.agent, "--dir", o.dir, "--provider", o.provider, "--engine", "--json"];
  if (o.publicOnly) argv.push("--public-only");
  if (o.repoRoot) argv.push("--repoRoot", o.repoRoot);
  if (o.task.trim()) argv.push(o.task);
  return argv;
}

export class SpawnEngine implements EngineDriver {
  private readonly bin: string;
  private readonly dir: string;
  private readonly provider: string;
  private readonly publicOnly: boolean;
  private readonly repoRoot?: string;

  constructor(opts: { bin?: string; dir?: string; provider?: string; publicOnly?: boolean; repoRoot?: string } = {}) {
    // Binary resolution: AGIX_CORE_BIN wins, else `agix-core` on PATH.
    this.bin = opts.bin ?? Bun.env.AGIX_CORE_BIN ?? "agix-core";
    this.dir = opts.dir ?? "agents";
    this.provider = opts.provider ?? "mock";
    this.publicOnly = opts.publicOnly ?? false;
    // The sidecar tree the Go tools are scoped to. Threaded through to
    // `agix-core agent run --repoRoot` so fs/metric/exec tools hit the target,
    // not the hive's CWD.
    this.repoRoot = opts.repoRoot;
  }

  async run(agent: string, task: string, opts: HiveRunOptions = {}): Promise<GovernedResult> {
    const dir = opts.dir ?? this.dir;
    const provider = opts.provider ?? this.provider;
    const publicOnly = opts.publicOnly ?? this.publicOnly;

    // --engine forces the declarative governed path in Go (never delegate back
    // to Bun); --json makes the seam machine-readable. --repoRoot scopes the Go
    // fs/metric/exec tools to the sidecar target (the live-run safety seam).
    const argv = agentRunArgv({ agent, dir, provider, publicOnly, repoRoot: opts.repoRoot ?? this.repoRoot, task });

    const proc = Bun.spawn([this.bin, ...argv], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(`engine: ${this.bin} agent run ${agent} produced no JSON (exit ${code}): ${stderr.trim()}`);
    }
    let j: EngineJSON;
    try {
      j = JSON.parse(trimmed.split("\n").pop() as string) as EngineJSON;
    } catch (e) {
      throw new Error(`engine: could not parse governed result for ${agent}: ${(e as Error).message}\n${trimmed}`);
    }
    if (j.error) throw new Error(`engine: governed run for ${agent} failed: ${j.error}`);
    return fromEngineJSON(j);
  }
}

/** MockEngine returns a deterministic, $0 governed result and records every call,
 *  so `bun test` can assert BOTH the governed contract (verifier≠queen, verified,
 *  $0) and the agent's orchestration (which governed units it ran, in order) with
 *  no Go binary, no API key, and no network. It is legitimate offline test
 *  infrastructure — the TS twin of core/provider/mock. */
export class MockEngine implements EngineDriver {
  readonly calls: { agent: string; task: string; opts: HiveRunOptions }[] = [];

  constructor(private readonly answer: (agent: string, task: string) => string = (a, t) => `mock governed answer [${a}]: ${t.slice(0, 120)}`) {}

  async run(agent: string, task: string, opts: HiveRunOptions = {}): Promise<GovernedResult> {
    this.calls.push({ agent, task, opts });
    return {
      agent,
      verified: true,
      verdict: { approved: true, by: `${agent}/worker/verifier-1`, notes: "mock governed: distinct verifier certified" },
      answer: this.answer(agent, task),
      queenActor: `${agent}/queen/root`,
      verifierActor: `${agent}/worker/verifier-1`,
      tools: [],
      unresolvedTools: [],
      boundary: [],
      cost: { usd: 0, inputTokens: 12, outputTokens: 6, bees: 4 },
      subtasks: [{ id: "st-1", title: "slice 1" }],
      degraded: [],
    };
  }
}
