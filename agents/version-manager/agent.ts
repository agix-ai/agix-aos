// Agix Version Manager — the versioning-semantics gate above the dev loop,
// reborn on Bun.
//
// This is the BEHAVIOR layer. Its governance metadata (identity, trust=proposer →
// worker caste, model tiering worker=haiku / verifier=haiku, the guard-bee
// boundary that writes only wiki/version-manager/ and denies tag/publish/deploy,
// and public=true) lives in the sibling agent.json, read by the Go engine.
//
// The versioning-semantics CORES are deterministic and pure — they run with no
// API key and no network, exactly as in the Node original
// (agents/version-manager/agent.mjs):
//   bumpCorrectness(changeSet)        → PATCH|MINOR|MAJOR from the diff + whether a
//                                       breaking change hides in the declared bump.
//   validateChangelog(text)           → Keep-a-Changelog conformance.
//   checkDeprecationSLA(deps, window) → nothing removed inside its deprecation window.
//   assignScheme(artifact)            → SemVer (contracts) vs CalVer (cadenced).
//   checkArtifactIdentity(rings)      → build-once, promote-many (no rebuild across rings).
// The four gate VERDICTS (V1 bump-correctness, V2 changelog, V3 deprecation-SLA,
// V4 artifact-identity) — including V1's MAJOR / breaking-hidden human co-sign
// routing (→ HOLD) and V3/V4 escalation — are computed deterministically here (the
// actor's proposal).
//
// The ONE unit of intelligence the Node agent had was the OPTIONAL narrative
// TL;DR (runtime.getModel().chat(), the narrator pattern). It maps to a single
// GOVERNED pass (ctx.hive.run): the Go swarm drafts the TL;DR AND certifies it
// through a DISTINCT verifier (actor≠verifier), so the version_bump record the
// agent writes to the Comb is attested, not self-graded. The deterministic
// verdicts stand with or without that narrative.
//
// NOT PORTED (faithful reduction — flagged honestly, mirrors the release-manager port):
//   - The append-only audit-ledger STREAM (lib/agix-audit-ledger.mjs emitted a
//     separate `gate_decision` + `verdict` row per gate AND a domain `version_bump`
//     entry, each with an entry_id, via runtime.getLedger()). That Node substrate is
//     reduced to ONE attested Comb leaf (the version_bump record) certified by the
//     governed run's distinct verifier; the per-gate verdict rows still appear in
//     the report. The Go engine owns the authoritative append-only ledger.
//   - The lib/agix-gate.mjs Gate objects (which enforced actor≠verifier + recorded
//     to the ledger at evaluate()). In the reborn contract the actor≠verifier
//     CERTIFICATION is supplied by the governed run (ctx.hive.run), so this layer
//     re-implements NONE of that — it computes only the deterministic verdict logic.
//   - The cursor `state` output (runtime.writeState('cursor', …)): the reborn
//     AgentContext exposes no state seam. The last-run summary is folded into the
//     dated report + the attested Comb version_bump leaf instead. The manifest
//     still DECLARES the state output as intent.
//   - Non-behavioral telemetry hooks (runtime.recordDecision / recordFileWritten)
//     have no seam in the reborn context and are dropped.
//
// Spec / persona: agents/version-manager/PERSONA.md
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const REPORT_DIR = "wiki/version-manager";

// The change author whose bump this agent verifies (the actor in the gates). Ported
// from the Node manifest's defaults.default_change_author — behavior policy, so it
// lives here beside the code that uses it.
const DEFAULT_CHANGE_AUTHOR = "dev-fleet";

// Deprecation SLA: minimum minor cycles a symbol must be deprecated (with notice)
// before it may be removed. Ported from defaults.deprecation_policy.
const DEPRECATION_POLICY = { minMinorCycles: 1 } as const;

// SemVer bump levels.
const BUMP = { PATCH: "PATCH", MINOR: "MINOR", MAJOR: "MAJOR" } as const;
type Bump = (typeof BUMP)[keyof typeof BUMP];

// The six Keep-a-Changelog categories.
const CHANGELOG_CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;

// Stage-Gate verdicts (LOOP_ENGINEERED_SDLC §2) — richer than pass/fail.
const VERDICT = { GO: "GO", KILL: "KILL", HOLD: "HOLD", RECYCLE: "RECYCLE" } as const;
type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

// ── Input shapes ────────────────────────────────────────────────────────────
interface ChangeSet {
  declared?: string | null;
  breaking?: boolean;
  removed?: string[];
  changedSignatures?: string[];
  added?: string[] | boolean;
  deprecated?: string[];
  fixed?: string[] | boolean;
  changed?: string[] | boolean;
}
interface Artifact {
  name?: string;
  kind?: string;
  publicApi?: boolean;
}
interface Deprecation {
  id?: string;
  deprecatedInVersion?: string;
  removedInVersion?: string | null;
  notice?: boolean;
}
interface VersionInput {
  releaseId?: string;
  changeSet: ChangeSet;
  artifact: Artifact;
  changelogText: string;
  deprecations: Deprecation[];
  rings: Record<string, string>;
}

// ── Pure core 1: bump-correctness (SemVer) ──────────────────────────────────
// Given a change descriptor, decide the SemVer bump the changes actually warrant,
// and whether the DECLARED bump hides a breaking change. The anti-"MAJOR
// mislabeled as MINOR" control (V1's evidence).
interface BumpAnalysis {
  correct: Bump;
  declared: Bump | null;
  agrees: boolean;
  breaking: boolean;
  breakingHidden: boolean;
  reasons: string[];
}
export function bumpCorrectness(changeSet: ChangeSet = {}): BumpAnalysis {
  const removed = asList(changeSet.removed);
  const changedSig = asList(changeSet.changedSignatures);
  const added = asList(changeSet.added);
  const deprecated = asList(changeSet.deprecated);
  const fixed = asList(changeSet.fixed);
  const changed = asList(changeSet.changed);

  const breaking = Boolean(changeSet.breaking) || removed.length > 0 || changedSig.length > 0;
  const hasAddition = truthy(changeSet.added) || added.length > 0 || deprecated.length > 0;
  const hasFixOrChange = truthy(changeSet.fixed) || truthy(changeSet.changed) || fixed.length > 0 || changed.length > 0;

  let correct: Bump;
  const reasons: string[] = [];
  if (breaking) {
    correct = BUMP.MAJOR;
    if (removed.length) reasons.push(`removed public surface: ${removed.join(", ")}`);
    if (changedSig.length) reasons.push(`incompatible signature change: ${changedSig.join(", ")}`);
    if (changeSet.breaking && !removed.length && !changedSig.length) reasons.push("flagged backward-incompatible");
  } else if (hasAddition) {
    correct = BUMP.MINOR;
    if (added.length) reasons.push(`added: ${added.join(", ")}`);
    if (deprecated.length) reasons.push(`deprecated (still present): ${deprecated.join(", ")}`);
    if (truthy(changeSet.added) && !added.length) reasons.push("added new backward-compatible surface");
  } else if (hasFixOrChange) {
    correct = BUMP.PATCH;
    reasons.push("bug fixes / backward-compatible changes only");
  } else {
    correct = BUMP.PATCH;
    reasons.push("no user-visible change — no-op patch");
  }

  const declared = normalizeLevel(changeSet.declared);
  const agrees = declared == null ? true : declared === correct;
  // The headline failure mode: a breaking change riding in a PATCH/MINOR label.
  const breakingHidden = correct === BUMP.MAJOR && declared != null && declared !== BUMP.MAJOR;

  return { correct, declared, agrees, breaking, breakingHidden, reasons };
}

// ── Pure core 2: changelog conformance (Keep a Changelog) ───────────────────
interface ChangelogResult {
  valid: boolean;
  hasUnreleased: boolean;
  hasVersioned: boolean;
  categories: string[];
  invalidCategories: string[];
  issues: string[];
}
export function validateChangelog(text = ""): ChangelogResult {
  const src = String(text || "");
  const issues: string[] = [];
  const versions: string[] = []; // section headers: ## [x.y.z] or ## [Unreleased]
  const categories: string[] = []; // ### Added / Changed / ...
  const invalidCategories: string[] = [];

  for (const line of src.split("\n")) {
    const vh = line.match(/^##\s+\[([^\]]+)\]/);
    if (vh) {
      versions.push(vh[1].trim());
      continue;
    }
    const ch = line.match(/^###\s+(.+?)\s*$/);
    if (ch) {
      const cat = ch[1].trim();
      if ((CHANGELOG_CATEGORIES as readonly string[]).includes(cat)) categories.push(cat);
      else invalidCategories.push(cat);
    }
  }

  const hasUnreleased = versions.some((v) => /^unreleased$/i.test(v));
  const hasVersioned = versions.some((v) => /^\d+\.\d+\.\d+/.test(v) || /^\d{4}[.-]\d{2}/.test(v));

  if (!hasUnreleased && !hasVersioned) issues.push('no "## [Unreleased]" or "## [x.y.z]" section');
  if (categories.length === 0) issues.push(`no recognized category (${CHANGELOG_CATEGORIES.join("/")})`);
  if (invalidCategories.length) issues.push(`non-standard categories: ${invalidCategories.join(", ")}`);

  const valid = (hasUnreleased || hasVersioned) && categories.length > 0 && invalidCategories.length === 0;
  return { valid, hasUnreleased, hasVersioned, categories: unique(categories), invalidCategories: unique(invalidCategories), issues };
}

// ── Pure core 3: deprecation SLA ────────────────────────────────────────────
// A removal is compliant only if the symbol was deprecated for ≥ the policy window
// (in minor cycles) AND carried a notice. Anything removed inside its window is a
// backward-compat break the V3 gate escalates.
interface SlaViolation {
  id: string;
  reason: string;
  cycles: number | null;
}
interface SlaResult {
  compliant: boolean;
  violations: SlaViolation[];
  checked: number;
  minMinorCycles: number;
}
export function checkDeprecationSLA(deprecations: Deprecation[] = [], policyWindow: { minMinorCycles?: number } = {}): SlaResult {
  const minCycles = Number.isFinite(policyWindow?.minMinorCycles) ? (policyWindow.minMinorCycles as number) : 1;
  const violations: SlaViolation[] = [];
  let checked = 0;
  for (const d of deprecations || []) {
    if (!d || d.removedInVersion == null) continue; // not removed yet → nothing to enforce
    checked += 1;
    const cycles = minorCycleDistance(d.deprecatedInVersion, d.removedInVersion);
    const hasNotice = d.notice !== false; // default: assume a notice unless explicitly absent
    if (cycles == null) {
      violations.push({ id: d.id ?? "(unknown)", reason: `unparseable versions (${d.deprecatedInVersion} → ${d.removedInVersion})`, cycles: null });
    } else if (cycles < minCycles) {
      violations.push({ id: d.id ?? "(unknown)", reason: `removed after ${cycles} minor cycle(s); policy requires ≥ ${minCycles}`, cycles });
    } else if (!hasNotice) {
      violations.push({ id: d.id ?? "(unknown)", reason: "removed without a deprecation notice", cycles });
    }
  }
  return { compliant: violations.length === 0, violations, checked, minMinorCycles: minCycles };
}

// ── Pure core 4: versioning scheme per artifact ─────────────────────────────
// SemVer for contract-bearing artifacts (a consumer codes against them); CalVer
// for cadenced products (shipped on a calendar, no external API contract).
interface SchemeResult {
  scheme: "SemVer" | "CalVer";
  reason: string;
}
export function assignScheme(artifact: Artifact = {}): SchemeResult {
  const kind = String(artifact.kind || "").toLowerCase();
  const semverKinds = new Set(["library", "lib", "sdk", "api", "cli", "package", "protocol", "schema"]);
  const calverKinds = new Set(["service", "app", "application", "product", "website", "site", "platform", "firmware"]);
  if (semverKinds.has(kind)) return { scheme: "SemVer", reason: `${kind || "contract"} carries a public API/compat contract` };
  if (calverKinds.has(kind)) return { scheme: "CalVer", reason: `${kind} ships on a cadence with no external API contract` };
  // Default: a thing with a declared public API is SemVer; otherwise CalVer.
  return artifact.publicApi
    ? { scheme: "SemVer", reason: "declares a public API contract" }
    : { scheme: "CalVer", reason: "no public API contract — cadenced release" };
}

// ── Pure core 5: build-once, promote-many artifact identity ─────────────────
// The same signed artifact must be promoted across rings (dev→canary→prod); a
// differing digest means a rebuild happened — never allowed. `rings` maps a ring
// name → artifact digest.
interface IdentityResult {
  identical: boolean;
  rings: string[];
  digests: Record<string, string>;
  mismatched?: string[];
  reason: string;
}
export function checkArtifactIdentity(rings: Record<string, string> = {}): IdentityResult {
  const entries = Object.entries(rings || {}).filter(([, v]) => v != null && v !== "");
  if (entries.length < 2) {
    return {
      identical: true,
      rings: entries.map(([r]) => r),
      digests: Object.fromEntries(entries),
      reason: entries.length ? "single ring — nothing to compare" : "no ring digests supplied",
    };
  }
  const first = entries[0][1];
  const identical = entries.every(([, v]) => v === first);
  const mismatched = entries.filter(([, v]) => v !== first).map(([r]) => r);
  return {
    identical,
    rings: entries.map(([r]) => r),
    digests: Object.fromEntries(entries),
    mismatched,
    reason: identical ? "same signed artifact across every ring" : `rebuild detected — digest differs on: ${mismatched.join(", ")}`,
  };
}

// ── Deterministic gate verdicts (V1–V4) ─────────────────────────────────────
//
// The Node agent ran these through lib/agix-gate.mjs Gate objects (actor=the
// change author, verifier=version-manager). In the reborn contract the actor≠
// verifier CERTIFICATION is supplied by the governed run (ctx.hive.run), so this
// layer computes only the deterministic verdict logic (the actor's proposal). V1's
// human co-sign routing is preserved: a MAJOR / breaking-hidden bump is HOLD; a
// mislabeled non-breaking bump is RECYCLE. V3/V4 violations are HOLD.
interface GateResult {
  gate: string;
  verdict: Verdict;
  reason: string;
  routedToHuman: boolean;
}
function evaluateGates(a: {
  bump: BumpAnalysis;
  changelog: ChangelogResult;
  sla: SlaResult;
  identity: IdentityResult;
}): { V1: GateResult; V2: GateResult; V3: GateResult; V4: GateResult } {
  // V1 — bump-correctness.
  let v1: GateResult;
  if (a.bump.breakingHidden) {
    v1 = {
      gate: "V1-bump-correctness",
      verdict: VERDICT.HOLD,
      reason: `breaking change declared as ${a.bump.declared} — a MAJOR is masquerading as ${a.bump.declared}; human co-sign required`,
      routedToHuman: true,
    };
  } else if (a.bump.correct === BUMP.MAJOR) {
    v1 = { gate: "V1-bump-correctness", verdict: VERDICT.HOLD, reason: "MAJOR / breaking-change bump — human co-sign required", routedToHuman: true };
  } else if (a.bump.agrees) {
    v1 = { gate: "V1-bump-correctness", verdict: VERDICT.GO, reason: `bump ${a.bump.correct} matches the changes`, routedToHuman: false };
  } else {
    v1 = {
      gate: "V1-bump-correctness",
      verdict: VERDICT.RECYCLE,
      reason: `declared ${a.bump.declared} but the diff warrants ${a.bump.correct} — relabel and resubmit`,
      routedToHuman: false,
    };
  }

  // V2 — changelog. Conformant → GO; otherwise RECYCLE.
  const v2: GateResult = a.changelog.valid
    ? { gate: "V2-changelog", verdict: VERDICT.GO, reason: "changelog is Keep-a-Changelog conformant", routedToHuman: false }
    : { gate: "V2-changelog", verdict: VERDICT.RECYCLE, reason: `changelog not conformant: ${(a.changelog.issues.length ? a.changelog.issues : ["missing"]).join("; ")}`, routedToHuman: false };

  // V3 — deprecation-SLA. Compliant → GO; a removal inside its window → HOLD.
  const v3: GateResult = a.sla.compliant
    ? { gate: "V3-deprecation-sla", verdict: VERDICT.GO, reason: `${a.sla.checked} removal(s) all honored the deprecation window`, routedToHuman: false }
    : { gate: "V3-deprecation-sla", verdict: VERDICT.HOLD, reason: `deprecation-SLA violation: ${a.sla.violations.map((v) => `${v.id} (${v.reason})`).join("; ")}`, routedToHuman: true };

  // V4 — artifact-identity. Identical digest across rings → GO; a rebuild → HOLD.
  const v4: GateResult = a.identity.identical
    ? { gate: "V4-artifact-identity", verdict: VERDICT.GO, reason: a.identity.reason, routedToHuman: false }
    : { gate: "V4-artifact-identity", verdict: VERDICT.HOLD, reason: `artifact-identity violation: ${a.identity.reason}`, routedToHuman: true };

  return { V1: v1, V2: v2, V3: v3, V4: v4 };
}

// ── The agent run ───────────────────────────────────────────────────────────
export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  const date = isoDate();

  // Smoke short-circuit: exercise the governed surface once ($0), no report, no
  // Comb write. Mirrors the reborn smoke contract ("exercise the surfaces").
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the version-semantics narration surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  // ── 1. Resolve the change input (a --changeSetJson flag / JSON text, else canned) ─
  const input = resolveInput(ctx);
  const actor = DEFAULT_CHANGE_AUTHOR;

  // ── 2. Deterministic cores (pure, no key, no network) ─────────────────────
  const bump = bumpCorrectness(input.changeSet);
  const scheme = assignScheme(input.artifact);
  const changelog = validateChangelog(input.changelogText);
  const sla = checkDeprecationSLA(input.deprecations, DEPRECATION_POLICY);
  const identity = checkArtifactIdentity(input.rings);

  // ── 3. Deterministic gate verdicts + overall + escalations ────────────────
  const gates = evaluateGates({ bump, changelog, sla, identity });
  const gateList = [gates.V1, gates.V2, gates.V3, gates.V4];
  const overall = worstVerdict(gateList.map((g) => g.verdict));
  const escalated = gateList.filter((g) => g.verdict === VERDICT.HOLD).map((g) => g.gate);

  // ── 4. ONE governed pass: narrate the version verdict AND certify (actor≠verifier) ─
  // This is the Node runtime.getModel().chat() narrator, now GOVERNED. The distinct
  // verifier it returns is what attests the version_bump record below.
  const summary = [
    `Overall version verdict: ${overall}.`,
    `Correct SemVer bump: ${bump.correct}${bump.declared ? ` (declared ${bump.declared})` : ""}.`,
    `Scheme: ${scheme.scheme}.`,
    escalated.length ? `Escalated gates: ${escalated.join(", ")}.` : "No human escalations.",
  ].join("\n");
  const r = await ctx.hive.run(
    `You are a release versioning steward. In at most three sentences, state the bump and whether a human ` +
      `co-sign is required and why. Use ONLY the data given, never invent a figure. No em dashes.\n\nDATA:\n${summary}`,
  );
  const narrative = r.answer?.trim() ? r.answer.trim() : cannedNarrative(overall, bump);

  ctx.log(
    `Gates · ${gateList.map((g) => `${g.gate.split("-")[0]}=${g.verdict}`).join(" ")} · overall=${overall}` +
      (escalated.length ? ` · escalate: ${escalated.join(", ")}` : ""),
    { verifier: r.verifierActor },
  );

  // ── 5. Write the dated report (bounded by boundary.write = wiki/version-manager/) ─
  const relPath = `${REPORT_DIR}/${date}.md`;
  const report = composeReport({
    date, bump, scheme, changelog, sla, identity, gates: gateList, overall, escalated, narrative, verifier: r.verifierActor, actor,
  });
  try {
    await ctx.writeRepoFile(relPath, report);
  } catch (e) {
    ctx.log(`report write skipped: ${(e as Error).message}`);
  }

  // ── 6. The version_bump record — an attested Comb leaf certified by the distinct
  //       verifier (the reduction of the Node append-only `version_bump` ledger entry) ─
  const releaseId = safeId(input.releaseId || `ver-${date.replace(/-/g, "")}`);
  await ctx.comb
    .put({
      id: `version-bump-${releaseId}`,
      content:
        `version_bump ${date}: overall=${overall} correct_bump=${bump.correct} ` +
        `declared_bump=${bump.declared ?? "none"} agrees=${bump.agrees} breaking_hidden=${bump.breakingHidden} ` +
        `scheme=${scheme.scheme} changelog_valid=${changelog.valid} deprecation_compliant=${sla.compliant} ` +
        `artifact_identical=${identity.identical} change_author=${actor}` +
        `${escalated.length ? ` escalate=${escalated.join(",")}` : ""} — ${narrative.slice(0, 300)}`,
      branch: "software", // TOGAF Software Architecture — release/versioning gate lives here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: overall === VERDICT.GO ? 0.9 : 0.6,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    overall,
    bump: bump.correct,
    declared: bump.declared ?? null,
    scheme: scheme.scheme,
    breaking_hidden: bump.breakingHidden,
    changelog_valid: changelog.valid,
    deprecation_compliant: sla.compliant,
    artifact_identical: identity.identical,
    escalations: escalated,
    gate_verdicts: Object.fromEntries(gateList.map((g) => [g.gate, g.verdict])),
    verifier: r.verifierActor,
    queen: r.queenActor,
    report: relPath,
    costUSD: r.cost.usd,
  };
});

// ── input resolution ────────────────────────────────────────────────────────
function resolveInput(ctx: AgentContext): VersionInput {
  const flag = ctx.input.flags.changeSetJson;
  const fromFlag = typeof flag === "string" && flag.trim() ? flag.trim() : "";
  const text = ctx.input.text?.trim() ?? "";
  const fromText = text.startsWith("{") ? text : "";
  const raw = fromFlag || fromText;
  if (raw) {
    try {
      return { ...cannedInput(), ...(JSON.parse(raw) as Partial<VersionInput>) } as VersionInput;
    } catch {
      /* fall through to canned */
    }
  }
  return cannedInput();
}

// A canned sample release (a clean MINOR) so smoke/default is a faithful,
// no-network demonstration of the full path.
function cannedInput(): VersionInput {
  return {
    releaseId: "ver-sample",
    changeSet: { declared: "MINOR", added: ["search_brain endpoint"], fixed: ["canary probe timeout"] },
    artifact: { name: "agix-cli", kind: "cli", publicApi: true },
    changelogText: ["# Changelog", "", "## [Unreleased]", "### Added", "- search_brain endpoint", "### Fixed", "- canary probe timeout", ""].join("\n"),
    deprecations: [{ id: "legacy_health_path", deprecatedInVersion: "0.1.0", removedInVersion: "0.3.0", notice: true }],
    rings: { dev: "sha256:abc", canary: "sha256:abc", prod: "sha256:abc" },
  };
}

function cannedNarrative(overall: Verdict, bump: BumpAnalysis): string {
  const cosign = bump.breakingHidden || bump.correct === BUMP.MAJOR;
  return (
    `Overall version posture is ${overall}. The diff warrants a ${bump.correct} bump${bump.declared ? ` (declared ${bump.declared})` : ""}, ` +
    `${cosign ? "so a human co-sign is required." : "which clears without escalation."} ` +
    `Deterministic gate verdicts are the source of truth; this narrative rides on top.`
  );
}

// ── report ───────────────────────────────────────────────────────────────────
function composeReport(a: {
  date: string;
  bump: BumpAnalysis;
  scheme: SchemeResult;
  changelog: ChangelogResult;
  sla: SlaResult;
  identity: IdentityResult;
  gates: GateResult[];
  overall: Verdict;
  escalated: string[];
  narrative: string;
  verifier: string;
  actor: string;
}): string {
  const icon: Record<string, string> = { GO: "✅", RECYCLE: "🔁", HOLD: "⏸️", KILL: "🔴" };
  const L: string[] = [];
  L.push("---");
  L.push(`date: ${a.date}`);
  L.push("agent: version-manager");
  L.push(`overall: ${a.overall}`);
  L.push(`bump: ${a.bump.correct}`);
  L.push(`declared: ${a.bump.declared ?? "none"}`);
  L.push(`scheme: ${a.scheme.scheme}`);
  L.push(`escalations: ${a.escalated.length}`);
  L.push(`verifier: ${a.verifier}`);
  L.push("---");
  L.push("");
  L.push(`# Version Semantics — ${icon[a.overall] || ""} ${a.overall} · ${a.date}`);
  L.push("");
  L.push(`> verifier: \`${a.verifier}\` (actor≠verifier — the governed run certified this version_bump record)`);
  L.push("");
  L.push("## TL;DR");
  L.push("");
  L.push(`> ${String(a.narrative).replace(/\n+/g, "\n> ")}`);
  L.push("");
  L.push("_(Narrative summary — governed pass, certified by a distinct verifier. The deterministic gate table below is the source of truth.)_");
  L.push("");
  L.push("## Bump correctness (V1)");
  L.push("");
  L.push(`- Correct bump: **${a.bump.correct}**${a.bump.declared ? ` · declared: ${a.bump.declared} · agree: ${a.bump.agrees ? "yes" : "NO"}` : ""}`);
  if (a.bump.breakingHidden) L.push(`- ⏸️ **Breaking change hidden in a ${a.bump.declared}** — routed to a human co-sign.`);
  for (const reason of a.bump.reasons) L.push(`  - ${reason}`);
  L.push("");
  L.push("## Gate verdicts");
  L.push("");
  L.push("| Gate | Verdict | Reason |");
  L.push("|---|---|---|");
  for (const g of a.gates) {
    L.push(`| \`${g.gate}\` | ${icon[g.verdict] || ""} ${g.verdict} | ${escapeCell(g.reason || "")} |`);
  }
  L.push("");
  L.push("## Semantics");
  L.push("");
  L.push(`- Scheme: **${a.scheme.scheme}** — ${a.scheme.reason}`);
  L.push(`- Changelog: ${a.changelog.valid ? "✅ conformant" : `🔁 ${a.changelog.issues.join("; ")}`}`);
  L.push(`- Deprecation SLA: ${a.sla.compliant ? `✅ ${a.sla.checked} removal(s) honored` : `⏸️ ${a.sla.violations.map((v) => v.id).join(", ")}`}`);
  L.push(`- Artifact identity: ${a.identity.identical ? "✅ build-once/promote-many" : `⏸️ ${a.identity.reason}`}`);
  L.push("");
  if (a.escalated.length) {
    L.push("## ⏸️ Escalations to human");
    L.push("");
    for (const g of a.gates) {
      if (g.verdict === VERDICT.HOLD) L.push(`- **\`${g.gate}\`** — ${g.reason}${g.routedToHuman ? " _(human co-sign)_" : ""}`);
    }
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push(
    `_Emitted by the Agix **version-manager** (proposer trust; verifier of the change author \`${a.actor}\`). ` +
      "Any MAJOR / breaking bump, deprecation-SLA breach, or artifact rebuild routes to a human co-sign. The " +
      "version_bump record is an attested Comb leaf. See `agents/version-manager/PERSONA.md`._",
  );
  L.push("");
  return L.join("\n") + "\n";
}

// ── helpers ───────────────────────────────────────────────────────────────────
function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => x != null && x !== "").map((x) => String(x)) : [];
}
function truthy(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length > 0);
}
function normalizeLevel(v: unknown): Bump | null {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  return ([BUMP.PATCH, BUMP.MINOR, BUMP.MAJOR] as string[]).includes(s) ? (s as Bump) : null;
}
function parseSemver(v: string | undefined): { major: number; minor: number; patch: number } | null {
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}
// Distance in minor cycles between two versions. A major increment counts as (at
// least) a full cycle so a same-major minor gap is the common case.
function minorCycleDistance(from: string | undefined, to: string | undefined | null): number | null {
  const a = parseSemver(from);
  const b = parseSemver(to ?? undefined);
  if (!a || !b) return null;
  if (b.major > a.major) return (b.major - a.major) * 1000 + (b.minor - a.minor);
  if (b.major < a.major) return 0;
  return b.minor - a.minor;
}
function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
const VERDICT_RANK: Record<string, number> = { GO: 0, RECYCLE: 1, HOLD: 2, KILL: 3 };
function worstVerdict(verdicts: Verdict[]): Verdict {
  let worst: Verdict = VERDICT.GO;
  for (const v of verdicts) if ((VERDICT_RANK[v] ?? 0) > (VERDICT_RANK[worst] ?? 0)) worst = v;
  return worst;
}
function safeId(v: string): string {
  return String(v).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128) || "ver-unknown";
}
function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
