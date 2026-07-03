// Append-only JSONL ledger for every model call. One line per chat /
// stream / vision call, success or failure. The ledger is the single
// source of truth for "what did Agix spend on models" queries.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §5.

import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const LEDGER_PATH = resolve(homedir(), '.cache/agix-models/ledger.jsonl');
const LEDGER_DIR = dirname(LEDGER_PATH);

const RETENTION_LINES = 100_000;
const RETENTION_MS = 180 * 24 * 3600 * 1000;
const PRUNE_EVERY_N_WRITES = 1000;

let writeCounter = 0;

export function ledgerPath() {
  return LEDGER_PATH;
}

export async function writeLedgerEntry(entry) {
  if (!existsSync(LEDGER_DIR)) {
    await mkdir(LEDGER_DIR, { recursive: true });
  }
  const line = JSON.stringify(entry) + '\n';
  await appendFile(LEDGER_PATH, line);
  writeCounter += 1;
  if (writeCounter % PRUNE_EVERY_N_WRITES === 0) {
    // Best-effort; never block the call path on prune.
    pruneLedger().catch((err) => {
      console.error(`agix-models: ledger prune failed: ${err.message}`);
    });
  }
}

// Lazy rotation. Keep the most-recent RETENTION_LINES lines OR everything
// inside the RETENTION_MS window, whichever set is larger. Runs at most
// once per PRUNE_EVERY_N_WRITES writes.
export async function pruneLedger() {
  if (!existsSync(LEDGER_PATH)) return;
  const stats = await stat(LEDGER_PATH);
  // Cheap fast-path: tiny ledger, nothing to prune.
  if (stats.size < 1_000_000) return;
  const raw = await readFile(LEDGER_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= RETENTION_LINES) return;
  const cutoff = Date.now() - RETENTION_MS;
  const kept = [];
  // Keep the last RETENTION_LINES lines.
  const tail = lines.slice(-RETENTION_LINES);
  for (const l of tail) kept.push(l);
  // Plus any earlier line still inside the retention window.
  for (const l of lines.slice(0, -RETENTION_LINES)) {
    try {
      const ts = JSON.parse(l).ts;
      if (ts && Date.parse(ts) >= cutoff) kept.push(l);
    } catch { /* drop unparseable line */ }
  }
  await writeFile(LEDGER_PATH, kept.join('\n') + '\n');
}

// Build a ledger entry shape from the canonical inputs. Adapters call
// this so the schema lives in one place.
export function buildLedgerEntry({
  callId,
  ts,
  tenant,
  agent,
  provider,
  model,
  capability,
  input_tokens = 0,
  cached_tokens = 0,
  output_tokens = 0,
  cost_usd = 0,
  latency_ms = 0,
  stop_reason = null,
  tools_used = [],
  degraded = [],
  error = null,
} = {}) {
  return {
    schema_version: '1',
    ts: ts || new Date().toISOString(),
    call_id: callId,
    tenant: tenant || 'agix',
    agent: agent || null,
    provider,
    model,
    capability: capability || null,
    input_tokens,
    cached_tokens,
    output_tokens,
    cost_usd: Math.round(cost_usd * 1_000_000) / 1_000_000,
    latency_ms,
    stop_reason,
    tools_used: Array.isArray(tools_used) ? tools_used : [],
    // Honest "couldn't do exactly what you asked" markers for this call:
    //   'prompt_cache'      — a requested cache was dropped (provider lacks it)
    //   'structured:prompt' — structured output fell to the prompt rung
    //   'fallback:<from>'   — a fallback fired after <from> failed
    degraded: Array.isArray(degraded) ? [...degraded] : [],
    error,
  };
}
