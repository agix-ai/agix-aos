// CLI-passthrough adapter for the Agix Model protocol.
//
// Routes model calls THROUGH a locally-installed CLI agent — Claude Code
// (`claude -p …`) or OpenAI Codex (`codex exec …`) — using that CLI's
// EXISTING subscription auth. The point: Agix works with NO API key for
// anyone who already has Claude Code or Codex signed in. The API-key
// adapters (anthropic/openai/gemini) remain the preferred path when a key
// IS configured; this is the fallback the Model dispatcher selects when no
// key is present but a CLI is detected.
//
// Tradeoffs (honest):
//   - We shell out per call (spawnSync). Latency is dominated by CLI
//     start-up + the CLI's own context assembly, NOT raw model time.
//   - The CLI does not report API-shaped token usage we can trust, so
//     `usage` is best-effort (0s when unavailable) and `cost_usd` lands
//     at 0 through the rate card (a subscription call is not metered API
//     spend). The ledger still records the call; cost analysis sees the
//     gap rather than a wrong number.
//   - Tool-use / streaming are NOT supported through this path (the CLIs
//     are answer-text oriented in print mode). Callers needing tools must
//     configure an API key.
//
// Spec lineage: AGIX.ONBOARD.1 DL.13.
//
// ─── Compliance ───────────────────────────────────────────────────────
//
// This adapter spawns the USER'S OWN officially-installed `claude` / `codex`
// binary (`spawnSync`) and lets that binary use its own authenticated
// session. It is LOCAL and USER-INITIATED only — the operator runs Agix on
// their own machine against a CLI they themselves installed and signed in.
// It is NEVER a hosted, multi-tenant, or "on behalf of users" service.
//
// It does NOT read, copy, cache, or replay the CLI's OAuth tokens or
// credentials; it never touches the credential store. It does NOT spoof,
// forge, or inject harness/client headers to impersonate the official CLI
// or any first-party app — it simply invokes the real binary and reads its
// stdout. This keeps the passthrough path within Anthropic's Feb-2026 usage
// policy (use your own account, through the official client, on your own
// device). If you need a hosted / programmatic path, configure an API key
// and use the anthropic/openai adapters instead.

import { spawnSync } from 'node:child_process';
import { ModelProviderError } from './errors.mjs';

// kind → display + the CLI binary it shells out to.
const CLI_KINDS = Object.freeze({
  'claude-code': { bin: 'claude', label: 'Claude Code' },
  'codex':       { bin: 'codex',  label: 'OpenAI Codex' },
});

// Default per-call timeout. Shelling out to a CLI that assembles its own
// context can take a while on a cold start; keep generous but bounded.
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── detection ───────────────────────────────────────────────────────

// Returns true iff `bin` resolves on PATH. `bin` is one of our fixed,
// known-safe values ('claude' | 'codex') — never user input — but we still
// pass it as a discrete argv element (no shell-string interpolation).
function binOnPath(bin) {
  // `which <bin>` exits 0 when found. argv-array form → no shell, no
  // injection surface, and no DEP0190 (shell:true + args) warning.
  const w = spawnSync('which', [bin], { encoding: 'utf8' });
  if (w.status === 0 && (w.stdout || '').trim().length > 0) return true;
  // Fallback for shells/PATHs where `which` is absent: probe `command -v`
  // through a shell as a single command string (no args array → no DEP0190).
  const r = spawnSync(`command -v ${bin}`, { shell: true, encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

// First installed CLI agent, preferring Claude Code. Returns the kind
// string ('claude-code' | 'codex') or null when neither is installed.
export function detectCliAgent() {
  if (binOnPath(CLI_KINDS['claude-code'].bin)) return 'claude-code';
  if (binOnPath(CLI_KINDS['codex'].bin)) return 'codex';
  return null;
}

// ─── prompt flattening ───────────────────────────────────────────────

// Render the protocol's system + messages into a single prompt string the
// CLI can consume on argv/stdin. We keep role markers so the model still
// sees turn structure; image blocks are dropped with a marker (CLI print
// mode here is text-only).
export function flattenRequestToPrompt(req) {
  const parts = [];
  if (req.system != null) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : (req.system || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (sysText) parts.push(`[System]\n${sysText}`);
  }
  for (const msg of req.messages || []) {
    const roleLabel = msg.role === 'assistant' ? 'Assistant' : msg.role === 'system' ? 'System' : 'User';
    let text;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else {
      text = (msg.content || []).map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'image') return '[image omitted — CLI passthrough is text-only]';
        if (b.type === 'tool_use') return `[tool_use ${b.name}: ${JSON.stringify(b.input || {})}]`;
        if (b.type === 'tool_result') return `[tool_result: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}]`;
        return '';
      }).filter(Boolean).join('\n');
    }
    if (text) parts.push(`[${roleLabel}]\n${text}`);
  }
  return parts.join('\n\n');
}

// ─── adapter ─────────────────────────────────────────────────────────

export class CliPassthroughAdapter {
  // kind: 'claude-code' | 'codex'. timeoutMs + a _spawn injection seam for
  // tests (defaults to node:child_process spawnSync).
  constructor({ kind, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawnSync } = {}) {
    if (!kind || !CLI_KINDS[kind]) {
      throw new Error(`CliPassthroughAdapter: unknown kind "${kind}". Use 'claude-code' or 'codex'.`);
    }
    this.kind = kind;
    this.bin = CLI_KINDS[kind].bin;
    this.label = CLI_KINDS[kind].label;
    this.timeoutMs = timeoutMs;
    this._spawn = spawnImpl;
  }

  // ─── capability descriptor ────────────────────────────────────────
  //
  // Print-mode CLI passthrough is answer-text oriented: no tool-use, no
  // token stream, no cacheable prompt knob. Conservative by design — the
  // dispatcher degrades structured output to the prompt ladder and callers
  // needing tools/streaming must configure an API key.
  get capabilities() {
    return {
      toolUse: false,
      streamingToolUse: false,
      structuredOutput: 'prompt',
      vision: false,
      promptCaching: false,
      reasoning: false,
    };
  }

  // ─── chat ───────────────────────────────────────────────────────
  //
  // Returns the SAME response shape the API adapters return so
  // Model.chat() callers + the bench's askModel work unchanged.
  async chat(req) {
    const prompt = flattenRequestToPrompt(req);
    const { args, parse } = this._buildInvocation(req, prompt);
    const started = Date.now();

    const r = this._spawn(this.bin, args, {
      encoding: 'utf8',
      timeout: this.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      // No `shell: true` — args are passed as an array, so a prompt
      // containing shell metacharacters is inert. This is the injection
      // guard the task calls for.
    });

    if (r.error) {
      // ENOENT = binary vanished between detection and call; surface clearly.
      const notFound = r.error.code === 'ENOENT';
      throw new ModelProviderError({
        provider: this.kind,
        model: this.kind,
        status: null,
        message: notFound
          ? `${this.label} CLI not found ("${this.bin}" not on PATH). Install + sign in, or set ${this._apiKeyHint()}.`
          : `${this.label} CLI invocation failed: ${r.error.message}`,
        cause: r.error,
      });
    }
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      const auth = /auth|login|sign[- ]?in|unauthor|credential|not logged/i.test(stderr);
      throw new ModelProviderError({
        provider: this.kind,
        model: this.kind,
        status: r.status,
        message: auth
          ? `${this.label} CLI not authenticated (exit ${r.status}). Run \`${this.bin} login\` / sign in, or set ${this._apiKeyHint()}.${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`
          : `${this.label} CLI exited ${r.status}${stderr ? `: ${stderr.slice(0, 300)}` : ''}.`,
      });
    }

    const stdout = r.stdout || '';
    let parsed;
    try {
      parsed = parse(stdout);
    } catch (err) {
      throw new ModelProviderError({
        provider: this.kind,
        model: this.kind,
        status: r.status,
        message: `${this.label} CLI output could not be parsed: ${err.message}. First 200 chars: ${stdout.slice(0, 200)}`,
        cause: err,
      });
    }

    const text = (parsed.text || '').trim();
    if (!text) {
      throw new ModelProviderError({
        provider: this.kind,
        model: this.kind,
        status: r.status,
        message: `${this.label} CLI returned an empty answer.`,
      });
    }

    return {
      content: [{ type: 'text', text }],
      stop_reason: parsed.stop_reason || 'end_turn',
      model_used: parsed.model_used || this.kind,
      provider: this.kind,
      usage: {
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
        cached_tokens: parsed.usage?.cached_tokens ?? 0,
      },
      latency_ms: Date.now() - started,
      request_id: parsed.request_id || null,
      via_cli: this.kind,
    };
  }

  // ─── stream ─────────────────────────────────────────────────────
  //
  // Print-mode CLI passthrough is not a token stream. Provide a one-shot
  // adapter-shaped generator so callers using Model.stream() still get a
  // single text_delta + message_stop rather than crashing.
  async *stream(req) {
    let response;
    try {
      response = await this.chat(req);
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
      return;
    }
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) yield { type: 'text_delta', text };
    yield { type: 'message_stop', response };
  }

  // ─── invocation builders ────────────────────────────────────────

  _buildInvocation(req, prompt) {
    if (this.kind === 'claude-code') return this._claudeInvocation(req, prompt);
    return this._codexInvocation(req, prompt);
  }

  // claude -p "<prompt>" --output-format json [--model <m>]
  //
  // JSON shape (Claude Code print mode):
  //   { type:'result', subtype:'success', is_error, result:'<answer>',
  //     stop_reason, usage:{input_tokens, cache_creation_input_tokens,
  //     cache_read_input_tokens, output_tokens}, modelUsage:{ '<id>':{…} } }
  _claudeInvocation(req, prompt) {
    const args = ['-p', prompt, '--output-format', 'json'];
    // Map a protocol/Anthropic model id to a Claude Code alias when present.
    const alias = mapClaudeModelAlias(req.model);
    if (alias) args.push('--model', alias);
    const parse = (stdout) => {
      const json = JSON.parse(stdout);
      if (json.is_error || json.subtype === 'error') {
        throw new Error(json.result || json.error || 'Claude Code reported is_error');
      }
      const u = json.usage || {};
      // Prefer the concrete model id from modelUsage (the assistant model
      // that actually produced the answer is the largest by output tokens);
      // fall back to whatever the caller asked for.
      const modelUsed = pickClaudeModelUsed(json.modelUsage) || req.model || 'claude-code';
      return {
        text: json.result || '',
        stop_reason: normalizeStop(json.stop_reason),
        model_used: modelUsed,
        request_id: json.session_id || null,
        usage: {
          input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output_tokens: u.output_tokens ?? 0,
          cached_tokens: u.cache_read_input_tokens ?? 0,
        },
      };
    };
    return { args, parse };
  }

  // codex exec "<prompt>" [-m <model>] --skip-git-repo-check --color never
  //
  // codex exec prints the agent's final message to stdout in plain text
  // (with `--color never` it's clean). We don't use `--json` (JSONL event
  // stream) for the simple answer path — plain stdout IS the answer.
  _codexInvocation(req, prompt) {
    const args = ['exec', prompt, '--skip-git-repo-check', '--color', 'never'];
    if (req.model && !/^claude-/i.test(req.model)) args.push('-m', req.model);
    const parse = (stdout) => ({
      text: extractCodexAnswer(stdout),
      stop_reason: 'end_turn',
      model_used: req.model || 'codex',
      request_id: null,
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
    });
    return { args, parse };
  }

  _apiKeyHint() {
    return this.kind === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  }
}

// ─── helpers ───────────────────────────────────────────────────────

function normalizeStop(stop) {
  if (stop === 'end_turn' || stop === 'max_tokens' || stop === 'tool_use' || stop === 'stop_sequence') return stop;
  if (stop === 'length') return 'max_tokens';
  return 'end_turn';
}

// Claude Code accepts aliases ('opus'|'sonnet'|'haiku'|'fable') or full
// model names. Map a few protocol short-forms to aliases; pass full names
// through; return null to let the CLI use its configured default.
function mapClaudeModelAlias(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  // A full claude-* id the CLI may accept directly; otherwise let default win.
  if (m.startsWith('claude-')) return model;
  return null;
}

// Choose the model id that produced the answer from Claude Code's
// modelUsage map — the assistant model has the most output tokens.
function pickClaudeModelUsed(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let best = null;
  let bestOut = -1;
  for (const [id, u] of Object.entries(modelUsage)) {
    const out = u?.outputTokens ?? 0;
    if (out > bestOut) { bestOut = out; best = id; }
  }
  // Strip Claude Code's `[1m]` context-window suffix + date suffix so the
  // ledger sees a canonical-ish id.
  return best ? String(best).replace(/\[\d+m\]$/, '').replace(/-\d{8}$/, '') : null;
}

// codex exec (plain text mode) prints session banners + the final message.
// Be tolerant: take everything; trim leading banner lines that codex emits
// before the answer when they're clearly metadata (lines like
// "[timestamp] ..."), but default to the full stdout so we never drop the
// real answer. Fragile-by-nature — codex's plain output format is not a
// stable contract; the JSON path (anthropic/openai key) is preferred when
// a key exists.
function extractCodexAnswer(stdout) {
  const raw = String(stdout || '');
  const lines = raw.split('\n');
  // Drop obvious codex metadata/banner lines (bracketed timestamps,
  // "workdir:", "model:", "provider:", "tokens used:" footers).
  const kept = lines.filter((l) => {
    const t = l.trim();
    if (!t) return true; // keep blank lines for paragraph structure
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;       // [2026-... ] event lines
    if (/^(workdir|model|provider|approval|sandbox|reasoning effort|tokens used)\s*:/i.test(t)) return false;
    if (/^-{3,}$/.test(t)) return false;                      // separator rules
    return true;
  });
  const out = kept.join('\n').trim();
  return out || raw.trim();
}
