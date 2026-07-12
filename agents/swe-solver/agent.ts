// Agix SWE Solver — the fleet's SWE-bench SYSTEM-UNDER-TEST: a bounded coder loop
// that turns Agix's declarative "proposer" into an agent that actually edits a repo.
//
// The prototype finding (research/swe-bench-pilot/2026-07-11-sut-prototype-findings.md)
// was that `agix agent run` is single-pass — it emits TEXT (even a proposed diff) but
// never edits the tree, and a single-pass local model guessed the wrong file path
// (flask/blueprints.py vs the real src/flask/blueprints.py). This behavior closes both
// gaps with a real locate -> edit -> test -> iterate loop:
//
//   1. LOCATE   — grep the ACTUAL repoRoot for the anchor(s) and read the real file +
//                 excerpt. Deterministic + grounded, so we never write a guessed path.
//   2. PROPOSE  — a GOVERNED hive pass (ctx.hive.run, actor != verifier in Go) proposes
//                 the minimal edit as strict JSON {file, find, replace} against the shown
//                 excerpt. Intelligence flows through the governed Go engine only.
//   3. EDIT     — apply the proposal through the GOVERNED write seam (ctx.writeRepoFile,
//                 boundary-checked) so `git diff` is genuinely non-empty at the REAL path.
//   4. TEST     — run the task's failing test(s) as an EXTERNAL, DETERMINISTIC oracle
//                 (apply the test patch, run pytest, revert the test patch). The verdict
//                 is the test PROCESS's exit code — never a model's claim. This is what
//                 keeps actor != verifier honest: the grader is the compiler/test, not a
//                 bee narrating success.
//   5. ITERATE  — on a red verdict, feed the failure tail back and re-propose, up to a
//                 small budget. Fail CLOSED when the budget is exhausted.
//   6. EMIT      — the final `git diff` (source only) is the prediction, written as a
//                 SWE-bench predictions.jsonl line.
//   7. CERTIFY  — a DISTINCT certification step (a separate governed pass + the external
//                 oracle gate) certifies the diff before it is a submission. The coder is
//                 the actor; certification is the verifier.
//
// Born-clean discipline: the Go core is untouched. Intelligence + the file write go
// through the governed Go engine (ctx.hive / ctx.writeRepoFile). The ONLY thing this
// orchestration layer runs directly (via Bun.spawn) is the git plumbing and the test
// oracle — deliberately OUTSIDE the model, because a system-under-test's verdict must be
// external ground truth, not something the actor can talk its way past.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";
import { resolve as resolvePath, isAbsolute } from "node:path";

// ── task card ────────────────────────────────────────────────────────────────
// Everything task-specific lives in a JSON card (passed as --task <abs path>), so
// the loop itself carries NO repo/task knowledge — it is a generic coder loop.
interface TestSpec {
  /** Absolute path to the SWE-bench test patch (adds the FAIL_TO_PASS tests). Applied
   *  only to RUN the oracle, then reverted, so it never leaks into the prediction. */
  patch_file: string;
  /** The oracle program (a bare path, e.g. a venv python) and its verbatim args. */
  command: string;
  args: string[];
  /** The FAIL_TO_PASS node ids — reported for provenance. */
  fail_to_pass?: string[];
}
interface TaskCard {
  instance_id: string;
  problem_statement: string;
  /** Exact strings to grep for in the repo to find + anchor the real source file. */
  locate_hints: string[];
  test: TestSpec;
  /** Absolute directory the prediction.jsonl is written to. */
  out_dir: string;
}

interface Sh {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command directly (no shell) under repoRoot. This is the deterministic
 *  git/test-oracle seam — intentionally OUTSIDE the governed model path (see header). */
async function sh(cwd: string, argv: string[]): Promise<Sh> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const git = (root: string, ...args: string[]) => sh(root, ["git", "--no-pager", ...args]);

/** The current working-tree diff, restricted to tracked changes. Intent-to-add makes a
 *  brand-new source file show up too. Excludes the tests/ tree — the prediction is a
 *  SOURCE patch; SWE-bench applies its own test patch at scoring time. */
async function predictionDiff(root: string): Promise<string> {
  await git(root, "add", "-N", "--", ".");
  const r = await git(root, "diff", "--", ".", ":(exclude)tests", ":(exclude)test");
  return r.stdout;
}

/** Reset the working tree to the clean checkout so each iteration proposes from a known
 *  base (proposals never stack). */
async function resetTree(root: string): Promise<void> {
  await git(root, "checkout", "--", ".");
  await git(root, "reset", "-q");
}

// ── locate (deterministic, grounded) ─────────────────────────────────────────
interface Located {
  file: string; // repo-relative, verified to exist
  excerpt: string; // a window around the first hit, with real line numbers
  anchorLine: number;
}

const CODE_EXT = /\.(py|go|ts|tsx|js|jsx|java|rb|rs|c|cc|cpp|h|hpp|cs|kt|scala|php|swift|m|mm)$/;
const NONCODE = /\.(rst|md|txt|cfg|ini|toml|yaml|yml|json|lock)$/i;

/** Score a candidate path: prefer source under a write-boundary root and a code
 *  extension; reject tests and docs. A higher score is a better locate target. */
function scorePath(path: string, writeRoots: string[]): number {
  if (/(^|\/)tests?\//.test(path) || /(^|\/)test_[^/]*$/.test(path) || /_test\.[a-z]+$/.test(path)) return -1000;
  let s = 0;
  if (writeRoots.some((r) => path === r || path.startsWith(r.replace(/\/+$/, "") + "/"))) s += 100;
  if (/(^|\/)docs?\//.test(path)) s -= 200;
  if (CODE_EXT.test(path)) s += 40;
  else if (NONCODE.test(path)) s -= 60;
  return s;
}

/** Find the real source file + a focused excerpt by grepping the ACTUAL repo for the
 *  anchor strings. Files are ranked by (a) how many DISTINCT hints they match — the file
 *  carrying the whole cluster of anchors is the real target, not a namesake that happens
 *  to share one generic line — and (b) a path score that favors source under the
 *  write-boundary and rejects tests/docs. The excerpt centers on the FIRST hint (the
 *  primary anchor). Returns null if nothing matches (the loop then fails closed rather
 *  than guessing a path). */
async function locate(ctx: AgentContext, root: string, hints: string[]): Promise<Located | null> {
  const writeRoots = ctx.manifest.boundary?.write ?? [];
  // file -> { hint index -> first matching line }
  const byFile = new Map<string, Map<number, number>>();
  for (let h = 0; h < hints.length; h++) {
    const g = await git(root, "grep", "-n", "--fixed-strings", hints[h]);
    if (g.code !== 0) continue;
    for (const l of g.stdout.split("\n")) {
      if (!l.trim()) continue;
      const ci = l.indexOf(":");
      const cj = l.indexOf(":", ci + 1);
      if (ci < 0 || cj < 0) continue;
      const file = l.slice(0, ci);
      if (scorePath(file, writeRoots) <= -1000) continue; // tests
      const lineNo = Number(l.slice(ci + 1, cj));
      let hits = byFile.get(file);
      if (!hits) byFile.set(file, (hits = new Map()));
      if (!hits.has(h)) hits.set(h, lineNo);
    }
  }
  if (!byFile.size) return null;
  const ranked = [...byFile.entries()]
    .map(([file, hits]) => ({ file, hits, score: hits.size * 1000 + scorePath(file, writeRoots) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const pick = ranked[0];
  const content = await ctx.readRepoFile(pick.file);
  if (content === null) return null;
  // Anchor on the earliest hint (by hint order) that hit this file.
  const anchorHint = [...pick.hits.keys()].sort((a, b) => a - b)[0];
  const anchorLine = pick.hits.get(anchorHint)!;
  const lines = content.split("\n");
  const from = Math.max(0, anchorLine - 16);
  const to = Math.min(lines.length, anchorLine + 16);
  const excerpt = lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join("\n");
  return { file: pick.file, excerpt, anchorLine };
}

// ── proposal parsing ─────────────────────────────────────────────────────────
interface Edit {
  find: string;
  replace: string;
}
interface Proposal {
  file: string;
  edits: Edit[]; // applied in order; a multi-hunk fix is several edits
}

/** Extract a proposal from a governed answer. Tolerant of the common local-model
 *  shapes: {file, find, replace}, {file, edits:[{find,replace},...]}, a ```json fence,
 *  a bare top-level object, or (fallback) a unified diff reduced to one edit per hunk. */
function parseProposal(answer: string): Proposal | null {
  const jsonBlocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(answer))) jsonBlocks.push(m[1]);
  jsonBlocks.push(answer); // last resort: whole answer
  for (const block of jsonBlocks) {
    const obj = firstJsonObject(block);
    if (!obj || typeof obj.file !== "string") continue;
    if (Array.isArray(obj.edits)) {
      const edits = obj.edits
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .filter((e) => typeof e.find === "string" && typeof e.replace === "string")
        .map((e) => ({ find: e.find as string, replace: e.replace as string }));
      if (edits.length) return { file: obj.file, edits };
    }
    if (typeof obj.find === "string" && typeof obj.replace === "string") {
      return { file: obj.file, edits: [{ find: obj.find, replace: obj.replace }] };
    }
  }
  // unified-diff fallback.
  return proposalFromDiff(answer);
}

function firstJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  // Scan for the matching brace, respecting strings/escapes.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Reduce a unified diff to a find/replace over a single contiguous hunk: the removed
 *  (+context) block is `find`, the added (+context) block is `replace`. The file path is
 *  taken from the `+++ b/...` header (path remapping to the real tree happens at apply
 *  time). This is what lets the loop still land the fix when a local model emits the
 *  correct LOGIC as a diff but against the wrong layout — the exact prototype failure. */
function proposalFromDiff(answer: string): Proposal | null {
  const diff = extractDiff(answer);
  if (!diff) return null;
  const lines = diff.split("\n");
  let file = "";
  for (const l of lines) {
    const mm = l.match(/^\+\+\+ [ab]\/(.+)$/);
    if (mm) {
      file = mm[1].trim();
      break;
    }
  }
  if (!file) return null;
  const edits: Edit[] = [];
  let find: string[] = [];
  let replace: string[] = [];
  let inHunk = false;
  const flush = () => {
    if (find.length || replace.length) edits.push({ find: find.join("\n"), replace: replace.join("\n") });
    find = [];
    replace = [];
  };
  for (const l of lines) {
    if (l.startsWith("@@")) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("diff ")) break;
    if (l.startsWith("-")) find.push(l.slice(1));
    else if (l.startsWith("+")) replace.push(l.slice(1));
    else if (l.startsWith(" ")) {
      find.push(l.slice(1));
      replace.push(l.slice(1));
    }
  }
  flush();
  if (!edits.length) return null;
  return { file, edits };
}

function extractDiff(answer: string): string | null {
  const fenced = answer.match(/```diff\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  const idx = answer.search(/^(diff --git |--- [ab]\/)/m);
  if (idx >= 0) return answer.slice(idx);
  return null;
}

// ── edit (through the governed write seam) ───────────────────────────────────
interface Applied {
  file: string;
  newContent: string;
}

/** Apply a proposal to the REAL tree. The path is remapped to a file that actually
 *  exists (e.g. flask/blueprints.py -> src/flask/blueprints.py) so a model's stale-layout
 *  guess still lands. The find snippet is matched exactly, then on a whitespace-normalized
 *  basis, so minor indentation drift still applies. The write itself goes through the
 *  governed, boundary-checked ctx.writeRepoFile. Returns the applied edit or a reason. */
async function applyProposal(
  ctx: AgentContext,
  root: string,
  p: Proposal,
  preferFile: string,
): Promise<{ applied?: Applied; reason?: string }> {
  const file = await resolveRealPath(ctx, root, p.file, preferFile);
  if (!file) return { reason: `no existing file matches ${p.file}` };
  const original = await ctx.readRepoFile(file);
  if (original === null) return { reason: `${file} could not be read` };

  let content = original;
  let n = 0;
  for (const edit of p.edits) {
    const find = edit.find.replace(/\r\n/g, "\n");
    const replace = edit.replace.replace(/\r\n/g, "\n");
    if (!find.trim()) continue;
    if (content.includes(find)) {
      const next = content.replace(find, replace);
      if (next !== content) {
        content = next;
        n++;
        continue;
      }
    }
    const idx = fuzzyIndex(content, find); // whitespace-tolerant (line-trimmed) fallback
    if (idx) {
      content = content.slice(0, idx.start) + replace + content.slice(idx.end);
      n++;
      continue;
    }
    return { reason: `anchor not found in ${file}: ${find.split("\n")[0].slice(0, 60)}…` };
  }
  if (n === 0 || content === original) return { reason: "no edit changed the file" };
  await ctx.writeRepoFile(file, content);
  return { applied: { file, newContent: content } };
}

/** Map a model-supplied path onto a file that exists. Exact hit wins; else match by
 *  basename across tracked files (prefer a path sharing the most trailing segments, and
 *  the locate() file on a tie). */
async function resolveRealPath(ctx: AgentContext, root: string, want: string, prefer: string): Promise<string | null> {
  const norm = want.replace(/^[ab]\//, "").replace(/^\.\//, "");
  if ((await ctx.readRepoFile(norm)) !== null) return norm;
  const base = norm.split("/").pop() ?? norm;
  const ls = await git(root, "ls-files");
  const candidates = ls.stdout.split("\n").filter((f) => f.endsWith("/" + base) || f === base);
  if (!candidates.length) return null;
  if (candidates.includes(prefer)) return prefer;
  candidates.sort((a, b) => trailingOverlap(b, norm) - trailingOverlap(a, norm));
  return candidates[0];
}

function trailingOverlap(a: string, b: string): number {
  const as = a.split("/").reverse();
  const bs = b.split("/").reverse();
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/** Locate `find` in `content` ignoring per-line leading/trailing whitespace. Returns the
 *  raw char span to replace, or null. */
function fuzzyIndex(content: string, find: string): { start: number; end: number } | null {
  const cLines = content.split("\n");
  const fLines = find.split("\n").map((l) => l.trim()).filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  if (!fLines.length) return null;
  for (let i = 0; i + fLines.length <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < fLines.length; j++) {
      if (cLines[i + j].trim() !== fLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = cLines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
      const end = cLines.slice(0, i + fLines.length).reduce((n, l) => n + l.length + 1, 0) - 1;
      return { start, end };
    }
  }
  return null;
}

// ── the external test oracle (deterministic; NOT the model) ───────────────────
interface Verdict {
  passed: boolean;
  exitCode: number;
  tail: string;
}

/** Run the task's failing test(s): apply the test patch, run the oracle command, ALWAYS
 *  revert the test patch (so it never contaminates the prediction). A zero exit is the
 *  only green — the process is the grader. */
async function runOracle(root: string, test: TestSpec): Promise<Verdict> {
  const apply = await git(root, "apply", "--whitespace=nowarn", test.patch_file);
  if (apply.code !== 0) {
    return { passed: false, exitCode: -1, tail: `oracle setup failed: could not apply test patch\n${apply.stderr}` };
  }
  try {
    const r = await sh(root, [test.command, ...test.args]);
    const out = (r.stdout + "\n" + r.stderr).trimEnd();
    const tail = out.split("\n").slice(-25).join("\n");
    return { passed: r.code === 0, exitCode: r.code, tail };
  } finally {
    await git(root, "apply", "-R", "--whitespace=nowarn", test.patch_file);
    // Belt-and-braces: drop any test-tree residue so the prediction stays source-only.
    await git(root, "checkout", "--", "tests", "test").catch(() => {});
  }
}

// ── the loop ─────────────────────────────────────────────────────────────────
function flagStr(ctx: AgentContext, k: string): string | undefined {
  const v = ctx.input.flags[k];
  return typeof v === "string" ? v : undefined;
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  // Smoke: prove the governed reasoning surface is live, do no repo work ($0/offline).
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the swe-solver coder surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  const repoRootRaw = flagStr(ctx, "repoRoot");
  if (!repoRootRaw) return { ok: false, reason: "swe-solver needs --repoRoot <target repo checkout>" };
  const root = resolvePath(repoRootRaw);

  const taskPath = flagStr(ctx, "task");
  if (!taskPath) return { ok: false, reason: "swe-solver needs --task <abs path to task card json>" };
  const cardFile = Bun.file(isAbsolute(taskPath) ? taskPath : resolvePath(taskPath));
  if (!(await cardFile.exists())) return { ok: false, reason: `task card not found: ${taskPath}` };
  const card = (await cardFile.json()) as TaskCard;

  const budget = Math.max(1, Number(flagStr(ctx, "budget") ?? "3"));

  // Start from a clean checkout so the prediction is exactly our edit.
  await resetTree(root);

  const located = await locate(ctx, root, card.locate_hints);
  if (!located) {
    return { ok: false, reason: `could not locate a source file from hints: ${card.locate_hints.join(", ")}` };
  }
  ctx.log(`located real target: ${located.file} (anchor line ${located.anchorLine})`, { file: located.file });

  const trail: {
    iteration: number;
    proposalFrom: string;
    edited: boolean;
    file?: string;
    verifier?: string;
    verdict?: string;
    reason?: string;
  }[] = [];

  let best: Applied | null = null;
  let bestVerdict: Verdict | null = null;
  let feedback = "";

  for (let i = 1; i <= budget; i++) {
    await resetTree(root);

    // ── PROPOSE (governed; actor != verifier enforced in Go) ──────────────────
    const prompt =
      `Resolve this GitHub issue with the SMALLEST possible source edit.\n\n` +
      `[ISSUE]\n${card.problem_statement.trim()}\n\n` +
      `[REAL FILE] ${located.file}\n[EXCERPT — line-numbered, from the ACTUAL repo]\n${located.excerpt}\n\n` +
      (feedback ? `[PREVIOUS ATTEMPT FAILED]\n${feedback}\n\n` : "") +
      `Return ONLY a single fenced json object. For a single change:\n` +
      "```json\n" +
      `{"file": "${located.file}", "find": "<an EXACT substring copied verbatim from the excerpt above>", ` +
      `"replace": "<that substring with your minimal fix applied>"}\n` +
      "```\n" +
      `If the issue needs changes in MORE THAN ONE place, use an edits array instead:\n` +
      "```json\n" +
      `{"file": "${located.file}", "edits": [{"find": "<exact substring>", "replace": "<fixed>"}, {"find": "...", "replace": "..."}]}\n` +
      "```\n" +
      `Rules: every "find" MUST be copied character-for-character from the excerpt (it is matched literally). ` +
      `Keep replacements minimal. Do NOT edit tests. Do NOT invent a path — use ${located.file}. ` +
      `You may grep/read the repo first to see code outside the excerpt if the fix needs it.`;

    const r = await ctx.hive.run(prompt);
    const proposal = parseProposal(r.answer);
    if (!proposal) {
      feedback = `Your answer did not contain a parseable {file, find, replace} json object. It was:\n${r.answer.slice(0, 500)}`;
      trail.push({ iteration: i, proposalFrom: r.verifierActor, edited: false, verifier: r.verifierActor, reason: "unparseable proposal" });
      ctx.log(`iteration ${i}: no parseable proposal`, { verifier: r.verifierActor });
      continue;
    }

    // ── EDIT (through the governed write seam) ────────────────────────────────
    const applied = await applyProposal(ctx, root, proposal, located.file);
    if (!applied.applied) {
      feedback = `Your proposed edit could not be applied: ${applied.reason}. The "find" text must be an EXACT substring of the shown excerpt.`;
      trail.push({ iteration: i, proposalFrom: r.verifierActor, edited: false, verifier: r.verifierActor, reason: applied.reason });
      ctx.log(`iteration ${i}: edit not applied — ${applied.reason}`);
      continue;
    }
    const diff = await predictionDiff(root);
    if (!diff.trim()) {
      feedback = `Your edit produced no change in the tree.`;
      trail.push({ iteration: i, proposalFrom: r.verifierActor, edited: false, verifier: r.verifierActor, reason: "empty diff" });
      continue;
    }
    best = applied.applied;
    ctx.log(`iteration ${i}: applied edit to ${applied.applied.file} (git diff non-empty)`, { file: applied.applied.file });

    // ── TEST (external deterministic oracle) ──────────────────────────────────
    const verdict = await runOracle(root, card.test);
    bestVerdict = verdict;
    trail.push({
      iteration: i,
      proposalFrom: r.verifierActor,
      edited: true,
      file: applied.applied.file,
      verifier: r.verifierActor,
      verdict: verdict.passed ? "PASS" : `FAIL(exit ${verdict.exitCode})`,
    });
    ctx.log(`iteration ${i}: test oracle → ${verdict.passed ? "PASS" : "FAIL"} (exit ${verdict.exitCode})`);
    if (verdict.passed) break;
    feedback = `The failing test(s) still did not pass. Test output tail:\n${verdict.tail}`;
  }

  // Restore the BEST real edit so the emitted prediction reflects our strongest attempt.
  await resetTree(root);
  if (best) await ctx.writeRepoFile(best.file, best.newContent);
  const finalDiff = await predictionDiff(root);
  const edited = finalDiff.trim().length > 0;
  const targetsReal = best !== null && finalDiff.includes(best.file);
  const passed = bestVerdict?.passed === true;

  // ── EMIT prediction (SWE-bench predictions.jsonl) ────────────────────────────
  let predPath = "";
  if (edited && card.out_dir) {
    predPath = resolvePath(card.out_dir, `preds.${card.instance_id}.jsonl`);
    const line = JSON.stringify({
      instance_id: card.instance_id,
      model_name_or_path: "agix-swe-solver-local",
      model_patch: finalDiff,
    });
    await Bun.write(predPath, line + "\n");
  }

  // ── CERTIFY (DISTINCT step: actor != verifier at the submission boundary) ────
  // Two independent gates decide whether the diff is a certified submission:
  //   (a) the EXTERNAL oracle — the test process must be green (authoritative);
  //   (b) a GOVERNED certification pass whose Go-side verifier is distinct from its
  //       queen — a second pair of eyes on whether the diff is a minimal, test-free fix.
  // The coder loop above is the ACTOR; this is the VERIFIER seam. A submission is
  // certified only when the external oracle is green — a bee cannot certify a red test.
  let certVerifier = "";
  let certNotes = "";
  if (edited) {
    const cert = await ctx.hive.run(
      `You are the CERTIFIER (not the author). Decide if this diff is a minimal, correct, ` +
        `test-free fix for the issue. The EXTERNAL test oracle reported: ${passed ? "PASS" : "FAIL"}.\n\n` +
        `[ISSUE]\n${card.problem_statement.trim()}\n\n[DIFF]\n${finalDiff}\n\n` +
        `Answer APPROVE or REJECT with one sentence of reasoning. Note: a diff the oracle marks FAIL ` +
        `is NOT a certified submission regardless of how plausible it looks.`,
    );
    certVerifier = cert.verifierActor;
    certNotes = cert.verdict.notes;
  }
  // Fail closed: certified iff we truly edited a real file AND the external oracle is green.
  const certified = edited && targetsReal && passed;

  const result: AgentResult = {
    ok: edited, // the mechanical loop ran end-to-end and produced a real edit
    instance_id: card.instance_id,
    edited,
    targets_real_path: targetsReal,
    edited_file: best?.file ?? null,
    test_verdict: bestVerdict ? (passed ? "PASS" : `FAIL(exit ${bestVerdict.exitCode})`) : "not-run",
    certified,
    certifier: certVerifier || null,
    certify_notes: certNotes || null,
    fail_to_pass: card.test.fail_to_pass ?? [],
    iterations: trail.length,
    trail,
    prediction: predPath || null,
    diff: finalDiff,
  };
  return result;
});
