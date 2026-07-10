// The reborn agent MANIFEST — the declarative governance metadata that BOTH the
// Go engine (core/agentspec.Spec) and this Bun runtime read from one file,
// agents/<name>/agent.json. It is the single source of truth for an agent's
// identity, trust boundary, model tiering, declared tools, and the public /
// proprietary distribution bit. Behavior does NOT live here — it lives in the
// sibling agent.ts. Keeping the manifest as JSON (not TOML/YAML) is deliberate:
// the zero-dependency Go core parses it with encoding/json and Bun imports it
// natively, so neither runtime grows a parser dependency to read the contract it
// governs.
//
// This mirrors core/agentspec.Spec field-for-field (same JSON keys) so a manifest
// authored once is read identically by `agix-core agent run` and by this runner.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

/** Advisory, auditable trust levels (mirrors the Go agentspec + Node soul doctrine). */
export type Trust = "conductor" | "proposer" | "boundary";

/** The governing caste taxonomy: queen (conductor), worker (proposer), drone (boundary). */
export type Caste = "queen" | "worker" | "drone";

/** Per-role model tiering, ported from a Node manifest's `defaults` block. */
export interface ModelTiers {
  /** Decompose + synthesize model. Empty routes by capability tier. */
  queen?: string;
  /** Per-worker models, assigned round-robin across the workers. */
  worker?: string[];
  /** The DISTINCT grader model (actor≠verifier). */
  verifier?: string;
  /** Worker-bee count; 0/undefined → runner default. */
  workers?: number;
}

/** The guard-bee trust boundary. `secrets` is the least-privilege allowlist of
 *  logical secret refs this agent's role may resolve; read/write/deny are advisory
 *  fs/op limits ported from the Node policy.yaml. Enforcement is authoritative in
 *  Go (core/fleet + core/secrets); this runtime honors write/deny advisorily. */
export interface Boundary {
  secrets?: string[];
  read?: string[];
  write?: string[];
  deny?: string[];
}

export interface ConfigVar {
  name: string;
  required?: boolean;
}

export interface Output {
  kind: "file" | "email" | "state";
  path?: string;
}

/** Manifest is the declarative agent contract — the TS mirror of
 *  core/agentspec.Spec. Parsed from agents/<name>/agent.json. */
export interface Manifest {
  name: string;
  display_name?: string;
  description?: string;

  tier?: "basic" | "pro" | "enterprise";
  /** Ships in the open AOS pack. The genericization seam — a property of the
   *  agent, not the build script. A public-only runner refuses public=false. */
  public: boolean;

  role: string;
  caste?: Caste;
  trust?: Trust;

  /** The base persona/prompt (the "how"). Optional in the reborn contract: the
   *  behavior lives in agent.ts, but a manifest may carry a base persona that the
   *  Go governed hive folds into every task envelope. Required by the Go loader,
   *  so keep it non-empty for parity. */
  instructions: string;

  tools?: string[];
  models?: ModelTiers;
  boundary?: Boundary;

  config?: ConfigVar[];
  schedule?: string[];
  outputs?: Output[];
}

/** Resolve the governing caste. Explicit caste wins; else trust seeds it
 *  (conductor→queen, proposer→worker, boundary→drone); else worker (the safe
 *  least-authority default). Mirrors agentspec.Spec.ResolveCaste. */
export function resolveCaste(m: Manifest): Caste {
  const c = (m.caste ?? "").trim().toLowerCase();
  if (c === "queen" || c === "worker" || c === "drone") return c;
  switch ((m.trust ?? "").trim().toLowerCase()) {
    case "conductor":
      return "queen";
    case "boundary":
    case "drone":
      return "drone";
    case "proposer":
      return "worker";
    default:
      return "worker";
  }
}

const VALID_CASTES = new Set<Caste>(["queen", "worker", "drone"]);
const VALID_TRUST = new Set<string>(["conductor", "proposer", "boundary"]);

/** Validate a manifest with the SAME strictness as the Go loader
 *  (agentspec.Spec.Validate), so a hand-authored manifest fails at load time in
 *  either runtime, not mid-run. Throws on the first problem. */
export function validateManifest(m: Manifest): Manifest {
  if (!m.name || !m.name.trim()) throw new Error("manifest: name is required");
  if (/[ \t/\\]/.test(m.name)) throw new Error(`manifest: ${m.name}: name must be a slug (no spaces or slashes)`);
  if (!m.role || !m.role.trim()) throw new Error(`manifest: ${m.name}: role is required`);
  if (!m.instructions || !m.instructions.trim())
    throw new Error(`manifest: ${m.name}: instructions are required (a declarative agent must carry its behavior/persona)`);
  if (!VALID_CASTES.has(resolveCaste(m)))
    throw new Error(`manifest: ${m.name}: caste does not resolve to queen|worker|drone`);
  const t = (m.trust ?? "").trim().toLowerCase();
  if (t && !VALID_TRUST.has(t))
    throw new Error(`manifest: ${m.name}: trust ${m.trust} is not one of conductor|proposer|boundary`);
  const seen = new Set<string>();
  for (const raw of m.tools ?? []) {
    const n = (raw ?? "").trim();
    if (!n) throw new Error(`manifest: ${m.name}: empty tool name`);
    if (seen.has(n)) throw new Error(`manifest: ${m.name}: duplicate tool ${n}`);
    seen.add(n);
  }
  for (const c of m.config ?? []) {
    if (!c.name || !c.name.trim()) throw new Error(`manifest: ${m.name}: config entry with an empty name`);
  }
  if (typeof m.public !== "boolean") throw new Error(`manifest: ${m.name}: public must be a boolean`);
  return m;
}

/** Load + validate the manifest at an absolute path. Uses Bun's file API — no
 *  Node fs, no YAML/TOML parser. */
export async function loadManifest(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`manifest: not found: ${path}`);
  let parsed: Manifest;
  try {
    parsed = (await file.json()) as Manifest;
  } catch (e) {
    throw new Error(`manifest: parse ${path}: ${(e as Error).message}`);
  }
  return validateManifest(parsed);
}
