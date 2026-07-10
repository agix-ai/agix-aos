// Agix Investigator — the forensic root-cause debugger (worker / proposer caste),
// reborn on Bun.
//
// This is the BEHAVIOR layer; identity, trust=proposer, model tiering
// (worker=sonnet, verifier=haiku), the boundary (write only wiki/investigator/,
// deny git push/commit), and public=true live in the sibling agent.json. The
// four-phase reasoning (investigate → analyze → hypothesize → root cause) is run
// as a GOVERNED hive pass — a distinct verifier certifies the diagnosis
// (actor≠verifier), which is exactly the Iron Law posture: the FIND is checked,
// never rubber-stamped. Symptom fingerprints are cached in the Comb, but the cache
// is not ground truth: a cache hit re-verifies against the live signal.
//
// Faithful reduction of agents/investigator/agent.mjs. The deterministic
// skeleton + the tester-report auto-discovery are reduced to: signal acquisition
// (from --text or a tester report), one governed four-phase pass, a written
// diagnosis, and the re-verifying Comb symptom cache.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { defineAgent, type AgentContext, type AgentResult } from "../../fleet/runtime/sdk.ts";

const DIAGNOSES_DIR = "wiki/investigator/diagnoses";
const TESTER_REPORTS_DIR = "wiki/tester/reports";

function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// A stable, order-independent fingerprint of a failure signal — the symptom key
// the Comb cache is keyed on (mirrors the Node per-symptom fingerprint tracker).
function fingerprint(signal: string): string {
  const norm = signal
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return "sym-" + h.toString(36);
}

export default defineAgent(async (ctx: AgentContext): Promise<AgentResult> => {
  if (ctx.smoke) {
    const r = await ctx.hive.run("smoke: confirm the diagnosis reasoning surface is live");
    ctx.log("smoke short-circuit · governed surface verified", { verifier: r.verifierActor });
    return { ok: true, smoke: true, verifier: r.verifierActor };
  }

  // ── 1. Acquire the failure signal ────────────────────────────────────────
  const signal = await acquireSignal(ctx);
  if (!signal) {
    ctx.log("no failure signal (pass one as text or drop a tester report)");
    return { ok: false, reason: "no-signal" };
  }
  const fp = fingerprint(signal);

  // ── 2. Consult the symptom cache — but the cache is NOT ground truth ──────
  const cached = await ctx.comb.retrieve(fp, 1).catch(() => []);
  const recurring = cached.length > 0;
  if (recurring) {
    ctx.log("symptom seen before — re-verifying the cached cause against the live signal", { fingerprint: fp });
  }

  // ── 3. One GOVERNED four-phase root-cause pass ───────────────────────────
  const priorNote = recurring ? `\n\nA prior pass on this symptom concluded:\n${cached[0].content}\nRe-verify it against the CURRENT signal; do not blindly re-serve it.` : "";
  const r = await ctx.hive.run(
    `Diagnose this failure signal through the four phases (investigate, analyze, hypothesize, root cause). ` +
      `State confidence honestly and propose a fix DIRECTION only, never a patch.\n\n` +
      `SIGNAL:\n${signal}${priorNote}`,
  );

  const rootCauseIdentified = /root cause[:\s]/i.test(r.answer) && !/not (yet )?identified|unidentified/i.test(r.answer);
  const confidence = /confidence[:\s]+high/i.test(r.answer) ? "high" : /confidence[:\s]+medium/i.test(r.answer) ? "medium" : "low";

  // ── 4. Write the diagnosis (bounded by boundary.write = wiki/investigator/) ─
  const diagnosisPath = `${DIAGNOSES_DIR}/${isoDate()}.md`;
  const doc =
    `# Diagnosis · ${isoDate()}\n\n` +
    `- fingerprint: ${fp}${recurring ? " (recurring — cache re-verified)" : ""}\n` +
    `- verifier: ${r.verifierActor} (actor≠verifier)\n` +
    `- root cause identified: ${rootCauseIdentified}\n` +
    `- confidence: ${confidence}\n\n` +
    `## Signal\n\n${signal}\n\n## Diagnosis\n\n${r.answer}\n`;
  try {
    await ctx.writeRepoFile(diagnosisPath, doc);
  } catch (e) {
    ctx.log(`diagnosis write skipped: ${(e as Error).message}`);
  }

  // ── 5. Refresh the symptom cache (attested by the run's distinct verifier) ─
  await ctx.comb
    .put({
      id: fp,
      content: `${fp} ${isoDate()}: ${rootCauseIdentified ? "root cause found" : "cause not yet identified"} (conf ${confidence}) — ${r.answer.slice(0, 300)}`,
      branch: "software", // TOGAF Software Architecture — defects live here
      author: r.queenActor,
      verifier: r.verifierActor,
      trust: confidence === "high" ? 0.9 : confidence === "medium" ? 0.6 : 0.4,
    })
    .catch((e) => ctx.log(`comb put skipped: ${(e as Error).message}`));

  return {
    ok: r.verified,
    diagnosed: true,
    root_cause_identified: rootCauseIdentified,
    confidence,
    recurring,
    verifier: r.verifierActor,
    diagnosis: diagnosisPath,
    costUSD: r.cost.usd,
  };
});

// acquireSignal takes the signal from the invocation text, else the latest tester
// report, else nothing. (The Node agent also had a canned smoke signal; here
// smoke short-circuits earlier.)
async function acquireSignal(ctx: AgentContext): Promise<string> {
  const text = ctx.input.text.trim();
  if (text) return text;

  const latest = await latestTesterReport(ctx);
  if (latest) {
    ctx.log(`no --text signal; using latest tester report`, { report: latest.path });
    return latest.body.slice(0, 4000);
  }
  return "";
}

async function latestTesterReport(ctx: AgentContext): Promise<{ path: string; body: string } | null> {
  // The runtime does not expose a directory glob to a worker (boundary posture),
  // so probe today's + a couple recent conventional report names. A real fleet
  // would wire a read tool through the Go catalog; this is the honest reduction.
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const rel = `${TESTER_REPORTS_DIR}/${isoDate(d)}.md`;
    const body = await ctx.readRepoFile(rel);
    if (body) return { path: rel, body };
  }
  return null;
}
