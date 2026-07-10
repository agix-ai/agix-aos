// AgentContext is what an agent.ts receives — the faithful reduction of the Node
// `runtime` seam, but every intelligence call now flows through the GOVERNED Go
// engine instead of a raw model call. An agent orchestrates in TypeScript (which
// governed tasks to run, in what sequence, how to shape input + output) and
// delegates all governed execution to Go via ctx.hive, and all durable memory to
// the Comb via ctx.comb. The agent never sees a model key and never runs a
// tool-use loop — that governance stays in Go.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import type { EngineDriver, GovernedResult, HiveRunOptions } from "./engine.ts";
import type { Comb } from "./comb.ts";
import type { Notifier, EmailMessage, NotifyMessage, DeliveryResult } from "./notify.ts";
import { type TurnIO, NullIO } from "./session.ts";
import { type Manifest, resolveCaste } from "./manifest.ts";
import { join, resolve as resolvePath } from "node:path";

/** The parsed invocation an agent runs against. `mode` is the first positional
 *  (e.g. mentor's brief|plan|goals); `text` is the free-form remainder (e.g. the
 *  investigator's failure signal); `args`/`flags` carry the rest. */
export interface AgentInput {
  mode?: string;
  args: string[];
  text: string;
  flags: Record<string, string | boolean>;
}

/** An agent's return value. `ok` is the run verdict; everything else is
 *  agent-specific provenance the CLI prints. */
export interface AgentResult {
  ok: boolean;
  [k: string]: unknown;
}

/** Hive is the governed-execution seam. Every run() is a full governed swarm in
 *  Go (queen decompose → workers forage → synthesize → DISTINCT verifier). This
 *  wrapper enforces the actor≠verifier invariant on every result as a tripwire:
 *  the TS layer refuses to accept a result that is not governed. */
export interface Hive {
  /** Run ONE governed unit of work for THIS agent (its manifest supplies the
   *  tiering, boundary, and persona in Go). Throws if the returned result is not
   *  actor≠verifier governed. */
  run(task: string, opts?: HiveRunOptions): Promise<GovernedResult>;
}

/** AgentContext — the surface an agent.ts programs against. */
export interface AgentContext {
  /** The loaded manifest (governance metadata). */
  readonly manifest: Manifest;
  /** The resolved governing caste (queen|worker|drone). */
  readonly caste: ReturnType<typeof resolveCaste>;
  /** The parsed invocation. */
  readonly input: AgentInput;
  /** True in $0/offline smoke mode — exercise the surfaces, do no real work. */
  readonly smoke: boolean;
  /** Governed execution → Go. The ONE way to invoke intelligence. */
  readonly hive: Hive;
  /** Durable, provenance-gated memory → the Comb. */
  readonly comb: Comb;
  /** Structured log line (to stderr, so stdout stays clean for --json). */
  log(msg: string, fields?: Record<string, unknown>): void;

  /** Delegate a governed unit of work to ANOTHER agent (the `fire` capability).
   *  The target runs its declarative governed hive; the caller's agent.ts is
   *  responsible for its own allowlist policy before calling this. Requires the
   *  manifest to declare the "fire" tool. */
  fire(agent: string, task: string, opts?: HiveRunOptions): Promise<GovernedResult>;

  /** Read a repo file relative to the repo root, or null if absent. */
  readRepoFile(rel: string): Promise<string | null>;
  /** Write a repo file relative to the repo root. Advisory-bounded by the
   *  manifest's boundary.write globs (the enforcement seam is authoritative in
   *  Go); a write outside the boundary throws. */
  writeRepoFile(rel: string, content: string): Promise<void>;

  /** Deliver an email through the governed notify seam. Requires the manifest to
   *  declare an email/notify capability. DRY-RUN by default (recorded, not sent);
   *  credentialed live delivery is a deployment config and fails closed. */
  sendEmail(msg: EmailMessage): Promise<DeliveryResult>;
  /** Deliver a generic notification (an alert on a channel) through the same seam.
   *  Requires the manifest to declare an email/notify capability. */
  notify(msg: NotifyMessage): Promise<DeliveryResult>;

  /** The interactive turn-loop seam (conversational modes). In a non-interactive
   *  run this is NullIO (no turns), so single-shot modes are unaffected. Agents run
   *  a governed conversation over it via `converse` (see session.ts). */
  readonly io: TurnIO;
}

export interface BuildContextArgs {
  manifest: Manifest;
  input: AgentInput;
  engine: EngineDriver;
  comb: Comb;
  notifier: Notifier;
  io?: TurnIO;
  dir: string;
  provider: string;
  publicOnly: boolean;
  smoke: boolean;
  repoRoot: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** The capability aliases that authorize the ctx.sendEmail / ctx.notify seam — the
 *  TS mirror of the Go email tool's aliases. An agent must declare at least one to
 *  deliver (mirrors how `fire` is gated on the "fire" tool). */
const NOTIFY_ALIASES = new Set(["email", "notify", "mail", "send", "alert"]);

function declaresNotify(m: Manifest): boolean {
  return (m.tools ?? []).some((t) => NOTIFY_ALIASES.has((t ?? "").trim().toLowerCase()));
}

/** Assert the governance invariant on a result: a distinct verifier certified the
 *  answer. This is the TS twin of hivekit's actor≠verifier tripwire — even though
 *  the run executes in Go, the runtime refuses to hand an ungoverned result back
 *  to an agent. */
export function assertGoverned(r: GovernedResult): GovernedResult {
  if (!r.verifierActor || r.verifierActor === r.queenActor) {
    throw new Error(`governance: actor≠verifier violated — queen=${r.queenActor} verifier=${r.verifierActor}`);
  }
  if (r.verdict.by !== r.verifierActor) {
    throw new Error(`governance: verdict.by=${r.verdict.by} is not the distinct verifier ${r.verifierActor}`);
  }
  return r;
}

function matchesGlob(rel: string, globs: string[]): boolean {
  // Advisory prefix/segment match (mirrors the Node v0.2 advisory posture): a
  // glob "wiki/" or "wiki/**" allows any path under wiki/.
  const norm = rel.replace(/^\.?\//, "");
  return globs.some((g) => {
    const base = g.replace(/\*+$/, "").replace(/\/$/, "");
    return base === "" || norm === base || norm.startsWith(base + "/");
  });
}

export function buildContext(a: BuildContextArgs): AgentContext {
  const log =
    a.log ??
    ((msg: string, fields?: Record<string, unknown>) => {
      const suffix = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
      process.stderr.write(`[${a.manifest.name}] ${msg}${suffix}\n`);
    });

  const hive: Hive = {
    async run(task, opts) {
      const r = await a.engine.run(a.manifest.name, task, {
        provider: a.provider,
        publicOnly: a.publicOnly,
        dir: a.dir,
        ...opts,
      });
      return assertGoverned(r);
    },
  };

  const writeGlobs = a.manifest.boundary?.write ?? [];

  return {
    manifest: a.manifest,
    caste: resolveCaste(a.manifest),
    input: a.input,
    smoke: a.smoke,
    hive,
    comb: a.comb,
    log,
    async fire(agent, task, opts) {
      if (!(a.manifest.tools ?? []).includes("fire")) {
        throw new Error(`fire: ${a.manifest.name} does not declare the "fire" tool`);
      }
      const r = await a.engine.run(agent, task, {
        provider: a.provider,
        publicOnly: a.publicOnly,
        dir: a.dir,
        ...opts,
      });
      return assertGoverned(r);
    },
    async readRepoFile(rel) {
      const f = Bun.file(join(a.repoRoot, rel));
      return (await f.exists()) ? f.text() : null;
    },
    async writeRepoFile(rel, content) {
      if (writeGlobs.length && !matchesGlob(rel, writeGlobs)) {
        throw new Error(`boundary: ${a.manifest.name} may not write ${rel} (allowed: ${writeGlobs.join(", ")})`);
      }
      const abs = resolvePath(a.repoRoot, rel);
      await Bun.write(abs, content);
    },
    async sendEmail(msg) {
      if (!declaresNotify(a.manifest)) {
        throw new Error(`sendEmail: ${a.manifest.name} does not declare an email/notify capability (add "email" or "notify" to its tools)`);
      }
      return a.notifier.sendEmail(msg);
    },
    async notify(msg) {
      if (!declaresNotify(a.manifest)) {
        throw new Error(`notify: ${a.manifest.name} does not declare an email/notify capability (add "notify" or "email" to its tools)`);
      }
      return a.notifier.notify(msg);
    },
    io: a.io ?? new NullIO(),
  };
}
