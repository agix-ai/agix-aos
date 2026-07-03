// agix-soul.mjs — the instance soul GROWS (AGIX.ONBOARD.1 Phase E.2).
//
// Onboarding (lib/agix-onboard.mjs) SCAFFOLDS a minimal `soul.md` under the config
// dir (identity + North Star + preferences). This module makes it GROW: what the AOS
// learns about the operator over time accretes into the soul as DATED bullets under a
// dedicated `## Learnings (accreted)` section.
//
// Q3 (resolved) = MINIMAL, append-growing: never clobber existing soul content, never
// rewrite, never summarize/compact (compaction is a noted follow-on). Each learning is
// one dated bullet; exact repeats are de-duped so re-running the same observation is a
// no-op. Minimal markdown — no heavy structure to drift.
//
// Two callers:
//   1. The OPERATOR, via the CLI/slash surface (`agix soul show` / `agix soul note "…"`
//      and `/soul` in interactive mode).
//   2. The MENTOR, via `recordLearning(...)` — a stable name the mentor imports so that
//      when it captures a durable preference/approval about the operator, the soul
//      accretes it as a side-effect (best-effort; never crashes the mentor).
//
// The Ideation-Loop auto-retro that would fire accretion automatically is aspirational
// (not auto-firing yet); this module is the SUBSTRATE it will call. See E.2 in the plan.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

// ─── path resolution (matches lib/agix-onboard.mjs exactly) ──────────────────
//
// Resolved against $AGIX_CONFIG_DIR or $HOME at CALL time (not module load) so a test
// can redirect HOME / set AGIX_CONFIG_DIR without import-order games. This MUST mirror
// onboarding's soulPath() so the operator and the mentor read/write the same file.

function configDir() {
  return process.env.AGIX_CONFIG_DIR || resolve(homedir(), '.config/agix');
}

/** Absolute path to the instance soul.md (the same file onboarding scaffolds). */
export function soulPath() {
  return resolve(configDir(), 'soul.md');
}

// The section the accreted learnings live under. Created on first append if absent.
const LEARNINGS_HEADING = '## Learnings (accreted)';

// ─── readSoul ─────────────────────────────────────────────────────────────

/**
 * Return the full soul.md text, or '' if no soul exists yet (never throws).
 * @returns {string}
 */
export function readSoul() {
  const path = soulPath();
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

// ─── appendLearning ─────────────────────────────────────────────────────────

/**
 * Append a DATED bullet to the `## Learnings (accreted)` section of soul.md, creating
 * the section if it does not yet exist. APPEND-ONLY (Q3): existing soul content is never
 * rewritten or clobbered. Exact-duplicate learnings (same bullet text already present
 * anywhere in the file) are de-duped — a repeated observation is a no-op.
 *
 * The bullet shape is `- <YYYY-MM-DD>[ (category)]: <text>`. The date is taken from the
 * runtime's clock when supplied (opts.now), else `new Date()` (allowed here — this is
 * lib code, NOT a workflow script).
 *
 * @param {string} text                         the learning (trimmed; empty → no-op)
 * @param {{category?: string, now?: Date|number}} [opts]
 *   category — optional tag rendered inline (e.g. "preference", "goal")
 *   now      — clock injection for tests (Date or epoch ms)
 * @returns {{appended: boolean, deduped: boolean, createdSection: boolean, bullet: (string|null)}}
 */
export function appendLearning(text, { category = null, now = null } = {}) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return { appended: false, deduped: false, createdSection: false, bullet: null };

  const date = toISODate(now);
  const tag = typeof category === 'string' && category.trim() ? ` (${category.trim()})` : '';
  const bullet = `- ${date}${tag}: ${clean}`;

  const path = soulPath();
  const existing = readSoul();

  // De-dupe: if this exact bullet line is already present, do nothing.
  if (lineExists(existing, bullet)) {
    return { appended: false, deduped: true, createdSection: false, bullet };
  }

  // Ensure the config dir exists (a learning can land before onboarding scaffolds soul.md;
  // we still want it captured rather than dropped).
  mkdirSync(dirname(path), { recursive: true });

  const hasSection = sectionExists(existing, LEARNINGS_HEADING);
  // When the section is missing we add it. We separate from prior content with a blank
  // line; the bullet follows the heading. Append-only — prior content is untouched.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  let chunk = '';
  if (needsLeadingNewline) chunk += '\n';
  if (!hasSection) {
    // A blank line before the heading keeps markdown readable when appending to existing text.
    chunk += `${existing.length > 0 ? '\n' : ''}${LEARNINGS_HEADING}\n\n${bullet}\n`;
  } else {
    chunk += `${bullet}\n`;
  }

  appendFileSync(path, chunk, { mode: 0o600 });
  return { appended: true, deduped: false, createdSection: !hasSection, bullet };
}

// ─── recordLearning (the mentor-callable entry) ──────────────────────────────

/**
 * The stable name the MENTOR imports to accrete a durable learning into the soul.
 * Identical behavior to appendLearning — kept as a distinct, intention-revealing name
 * so the mentor's call site reads as "record what I learned about the operator" and the
 * underlying mechanism can evolve without touching the mentor.
 *
 * Best-effort by contract: callers (the mentor) wrap this so a soul-write failure never
 * crashes the calling agent.
 *
 * @param {string} text
 * @param {{category?: string, now?: Date|number}} [opts]
 * @returns {{appended: boolean, deduped: boolean, createdSection: boolean, bullet: (string|null)}}
 */
export function recordLearning(text, opts = {}) {
  return appendLearning(text, opts);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toISODate(now) {
  let d;
  if (now instanceof Date) d = now;
  else if (typeof now === 'number' && Number.isFinite(now)) d = new Date(now);
  else d = new Date();
  return d.toISOString().slice(0, 10);
}

function lineExists(haystack, line) {
  if (!haystack) return false;
  return haystack.split('\n').some((l) => l.trim() === line.trim());
}

function sectionExists(haystack, heading) {
  if (!haystack) return false;
  return haystack.split('\n').some((l) => l.trim() === heading);
}
