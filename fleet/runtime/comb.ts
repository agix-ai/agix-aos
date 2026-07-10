// The Comb memory seam. Comb is the hive's durable, provenance-gated knowledge
// graph (Go core/kmstore, served by services/comb-mcp and driven by the
// `agix-core km` CLI). A TS agent grows and reads governed knowledge through this
// interface — reads are attested-only by default (the provenance-first posture),
// writes carry author + a DISTINCT verifier + a trust score. The attestation gate
// and anti-poison shield live in Go; this client never reimplements them.
//
//   - CliComb  — production: shells `agix-core km …` against the shared store
//                (~/.agix/km.db, the same store the Comb MCP serves).
//   - MemComb  — an in-memory store for `bun test` (attestation modeled by the
//                same actor≠verifier + trust-floor rule the Go gate enforces).
//
// A third impl, McpComb (JSON-RPC to `comb-mcp -stdio`), is the networked fleet
// seam; it satisfies this same interface. Left as a documented extension.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

export interface Provenance {
  author?: string;
  /** A DISTINCT, registered actor that vouches (empty → un-attested). */
  verifier?: string;
  /** Verifier confidence 0..1; must clear the store's trust floor to attest. */
  trust?: number;
}

export interface CombNote extends Provenance {
  content: string;
  id?: string;
  branch?: string;
  ratified?: boolean;
}

export interface CombPutResult {
  id: string;
  added: boolean;
  attested: boolean;
  quarantined: boolean;
  reason?: string;
}

export interface CombLeaf {
  id: string;
  content: string;
  branch?: string;
  attested: boolean;
}

export interface CombStats {
  leaves: number;
  attested: number;
  ratified: number;
  edges: number;
  quarantined: number;
  trustFloor: number;
}

export interface Comb {
  put(note: CombNote): Promise<CombPutResult>;
  link(src: string, type: string, dst: string, prov?: Provenance): Promise<void>;
  retrieve(query: string, k?: number, attestedOnly?: boolean): Promise<CombLeaf[]>;
  traverse(seed: string, type: string, hops?: number): Promise<CombLeaf[]>;
  stats(): Promise<CombStats>;
}

/** CliComb drives the Go provenance-gated store via `agix-core km`. It parses the
 *  CLI's deterministic, documented output. The attestation roster is seeded out of
 *  band in Go (AGIX_KM_VERIFIERS), so a bare --verifier cannot forge attestation —
 *  this client cannot bypass that gate. */
export class CliComb implements Comb {
  private readonly bin: string;
  private readonly db?: string;

  constructor(opts: { bin?: string; db?: string } = {}) {
    this.bin = opts.bin ?? Bun.env.AGIX_CORE_BIN ?? "agix-core";
    this.db = opts.db ?? Bun.env.COMB_MCP_STORE ?? undefined;
  }

  private async km(sub: string, args: string[]): Promise<string> {
    const argv = ["km", sub, ...args];
    if (this.db) argv.push("--db", this.db);
    const proc = Bun.spawn([this.bin, ...argv], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // km returns 3 for a shielded (quarantined) write — not a hard failure.
    if (code !== 0 && code !== 3) throw new Error(`comb: km ${sub} failed (exit ${code}): ${err.trim()}`);
    return out;
  }

  async put(note: CombNote): Promise<CombPutResult> {
    const args = ["--content", note.content];
    if (note.id) args.push("--id", note.id);
    if (note.branch) args.push("--branch", note.branch);
    if (note.author) args.push("--author", note.author);
    if (note.verifier) args.push("--verifier", note.verifier);
    if (typeof note.trust === "number") args.push("--trust", String(note.trust));
    if (note.ratified) args.push("--ratified");
    const out = await this.km("put", args);
    const m = out.match(/id=(\S+)\s+added=(\w+)\s+attested=(\w+)\s+quarantined=(\w+)/);
    if (!m) throw new Error(`comb: unparseable km put output: ${out}`);
    return { id: m[1], added: m[2] === "true", attested: m[3] === "true", quarantined: m[4] === "true" };
  }

  async link(src: string, type: string, dst: string, prov: Provenance = {}): Promise<void> {
    const args = ["--src", src, "--type", type, "--dst", dst];
    if (prov.author) args.push("--author", prov.author);
    if (prov.verifier) args.push("--verifier", prov.verifier);
    if (typeof prov.trust === "number") args.push("--trust", String(prov.trust));
    await this.km("link", args);
  }

  async retrieve(query: string, k = 5, attestedOnly = true): Promise<CombLeaf[]> {
    const args = ["--query", query, "--k", String(k)];
    if (attestedOnly) args.push("--attested-only");
    const out = await this.km("retrieve", args);
    return parseLeafLines(out);
  }

  async traverse(seed: string, type: string, hops = 1): Promise<CombLeaf[]> {
    const out = await this.km("traverse", ["--seed", seed, "--type", type, "--hops", String(hops), "--attested-only"]);
    return parseLeafLines(out);
  }

  async stats(): Promise<CombStats> {
    const out = await this.km("stats", []);
    const m = out.match(
      /leaves=(\d+)\s+attested=(\d+)\s+ratified=(\d+)\s+tombstoned=\d+\s+edges=(\d+)\s+quarantined=(\d+)\s+trust_floor=([\d.]+)/,
    );
    if (!m) throw new Error(`comb: unparseable km stats output: ${out}`);
    return {
      leaves: +m[1],
      attested: +m[2],
      ratified: +m[3],
      edges: +m[4],
      quarantined: +m[5],
      trustFloor: +m[6],
    };
  }
}

// km retrieve/traverse print numbered lines like:
//   1. <id>  branch=<b> attested=<bool>  "<content>"
function parseLeafLines(out: string): CombLeaf[] {
  const leaves: CombLeaf[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+(\S+)\s+(?:branch=(\S+)\s+)?attested=(\w+)\s+"(.*)"\s*$/);
    if (m) leaves.push({ id: m[1], branch: m[2] === "-" ? undefined : m[2], attested: m[3] === "true", content: m[4] });
  }
  return leaves;
}

/** MemComb is an in-memory Comb for tests. It models the SAME governance the Go
 *  gate enforces: a leaf is attested only when a verifier DISTINCT from the author,
 *  present on the roster, vouches with trust ≥ the floor; retrieve(attestedOnly)
 *  refuses un-attested knowledge. Retrieval is a substring match (a stand-in for
 *  the cosine-similar embedding search), which is enough to prove agent wiring. */
export class MemComb implements Comb {
  private leaves = new Map<string, { note: CombNote; attested: boolean }>();
  private edges: { src: string; type: string; dst: string; attested: boolean }[] = [];
  private roster: Set<string>;
  private floor: number;

  constructor(opts: { roster?: string[]; trustFloor?: number } = {}) {
    this.roster = new Set(opts.roster ?? []);
    this.floor = opts.trustFloor ?? 0.35;
  }

  registerVerifier(...actors: string[]): void {
    for (const a of actors) this.roster.add(a);
  }

  private attests(note: CombNote): boolean {
    return (
      !!note.verifier &&
      note.verifier !== note.author &&
      this.roster.has(note.verifier) &&
      (note.trust ?? 0) >= this.floor
    );
  }

  async put(note: CombNote): Promise<CombPutResult> {
    const id = note.id ?? `leaf-${hash(note.content)}`;
    const attested = this.attests(note);
    const prior = this.leaves.get(id);
    // Idempotent refresh only ever RAISES attestation (mirrors kmstore).
    this.leaves.set(id, { note: { ...note, id }, attested: attested || (prior?.attested ?? false) });
    return { id, added: !prior, attested: this.leaves.get(id)!.attested, quarantined: false };
  }

  async link(src: string, type: string, dst: string, prov: Provenance = {}): Promise<void> {
    this.edges.push({
      src,
      type,
      dst,
      attested: !!prov.verifier && prov.verifier !== prov.author && this.roster.has(prov.verifier) && (prov.trust ?? 0) >= this.floor,
    });
  }

  async retrieve(query: string, k = 5, attestedOnly = true): Promise<CombLeaf[]> {
    const q = query.toLowerCase();
    const hits: CombLeaf[] = [];
    for (const [id, { note, attested }] of this.leaves) {
      if (attestedOnly && !attested) continue;
      if (note.content.toLowerCase().includes(q) || q.includes(id.toLowerCase())) {
        hits.push({ id, content: note.content, branch: note.branch, attested });
      }
    }
    return hits.slice(0, k);
  }

  async traverse(seed: string, type: string, hops = 1): Promise<CombLeaf[]> {
    const reached: CombLeaf[] = [];
    let frontier = [seed];
    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const e of this.edges) {
        if (e.attested && e.type === type && frontier.includes(e.src)) {
          const leaf = this.leaves.get(e.dst);
          if (leaf?.attested) {
            reached.push({ id: e.dst, content: leaf.note.content, branch: leaf.note.branch, attested: true });
            next.push(e.dst);
          }
        }
      }
      frontier = next;
    }
    return reached;
  }

  async stats(): Promise<CombStats> {
    let attested = 0;
    let ratified = 0;
    for (const { note, attested: a } of this.leaves.values()) {
      if (a) attested++;
      if (note.ratified) ratified++;
    }
    return {
      leaves: this.leaves.size,
      attested,
      ratified,
      edges: this.edges.length,
      quarantined: 0,
      trustFloor: this.floor,
    };
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
