// Agix Model — model-agnostic dispatcher. Single entry point for every
// model call in the codebase; provider SDKs live behind adapters in
// `lib/model-adapters/`. The runtime hands the singleton out via
// `runtime.getModel()`.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §2.

import { AnthropicAdapter } from './model-adapters/anthropic.mjs';
import { OpenAIAdapter } from './model-adapters/openai.mjs';
import { GeminiAdapter } from './model-adapters/gemini.mjs';
import { CliPassthroughAdapter, detectCliAgent } from './model-adapters/cli-passthrough.mjs';
import { OpenRouterAdapter } from './model-adapters/openrouter.mjs';
import { ROUTING_TABLE, resolveCapability, resolveModelToProvider, CLI_PROVIDERS, stripRoutingPrefix } from './model-adapters/routing.mjs';
import { computeCost } from './model-adapters/rate-card.mjs';
import { writeLedgerEntry, buildLedgerEntry } from './model-adapters/ledger.mjs';
import { uuidv7 } from './model-adapters/uuid.mjs';
import { ModelProviderError, NotImplementedError, StructuredOutputError } from './model-adapters/errors.mjs';

export class Model {
  constructor({ runtime, keys = {}, detectCli = detectCliAgent } = {}) {
    this.runtime = runtime || null;
    this.keys = keys;
    this._adapters = new Map();
    // CLI-passthrough detection seam (overridable in tests). Cached per
    // instance so detection only shells out once.
    this._detectCli = detectCli;
    this._detectedCli = undefined; // undefined = not yet probed
  }

  // Lazily detect (once) which CLI agent is installed for passthrough.
  _cliAgent() {
    if (this._detectedCli === undefined) {
      try { this._detectedCli = this._detectCli ? this._detectCli() : null; }
      catch { this._detectedCli = null; }
    }
    return this._detectedCli;
  }

  // ─── chat ─────────────────────────────────────────────────────────

  async chat(req) {
    // Budget gate: a runtime with a configured budget halts the run
    // before the provider call, not after the spend lands.
    this.runtime?.checkBudget?.();
    const route = this._route(req);
    // `degraded` accumulates honest "we couldn't do exactly what you asked"
    // markers (prompt-cache dropped, structured-output degraded, fallback
    // fired) and rides onto the ledger entry.
    const degraded = [];
    const wantsStructured = req.responseSchema != null || req.structuredOutput === true;
    try {
      return await this._dispatchChat(req, route, degraded, wantsStructured);
    } catch (err) {
      // Opt-in fallback: on a RETRYABLE provider error (5xx / rate / network,
      // never 4xx/auth, never a budget error) try the caller/table fallback
      // model ONCE. Fallback is a caller decision (req.fallbackModel) or an
      // operator decision (a fallbackModel field on the ROUTING_TABLE row) —
      // never a silent protocol default.
      if (!isRetryableProviderError(err)) throw err;
      const fallbackModel = this._resolveFallbackModel(req, route);
      if (!fallbackModel) throw err;
      let fbRoute;
      try { fbRoute = this._fallbackRoute(fallbackModel); }
      catch { throw err; } // can't resolve the fallback → surface the original
      // No pointless self-fallback to the identical provider+model.
      if (fbRoute.provider === route.provider && fbRoute.model === route.model) throw err;
      degraded.push(`fallback:${route.provider}`);
      // The budget still governs the retry.
      this.runtime?.checkBudget?.();
      return await this._dispatchChat(req, fbRoute, degraded, wantsStructured);
    }
  }

  // One dispatch to a resolved route. Splits the plain path from the
  // structured-output ladder, and records the prompt-cache degradation
  // marker when a requested cache can't be honored by the routed provider.
  async _dispatchChat(req, route, degraded, wantsStructured) {
    const adapter = this._getAdapter(route.provider);
    const caps = this._capabilities(adapter);
    if (req.cache_breakpoints && req.cache_breakpoints.length
        && !caps.promptCaching && !degraded.includes('prompt_cache')) {
      degraded.push('prompt_cache');
    }
    if (!wantsStructured) {
      return this._callAdapterChat(req, route, { ...req, model: route.model }, degraded);
    }
    return this._structuredChat(req, route, caps, degraded);
  }

  // The fallback model for this call: an explicit per-call `req.fallbackModel`
  // wins; otherwise an optional `fallbackModel` on the routed capability's
  // ROUTING_TABLE row (unset by default). Returns null when none is declared.
  _resolveFallbackModel(req, route) {
    if (req.fallbackModel) return req.fallbackModel;
    const cap = route.capability;
    if (cap && ROUTING_TABLE[cap] && ROUTING_TABLE[cap].fallbackModel) {
      return ROUTING_TABLE[cap].fallbackModel;
    }
    return null;
  }

  // Resolve a fallback model id into a full route (provider + stripped model),
  // honoring the same CLI-passthrough precedence as the primary route.
  _fallbackRoute(fallbackModel) {
    const provider = resolveModelToProvider(fallbackModel);
    return this._applyCliFallback({
      provider,
      model: stripRoutingPrefix(fallbackModel, provider),
      capability: null,
    });
  }

  // Structured-output degradation ladder. Based on the routed adapter's
  // `structuredOutput` capability:
  //   'native'    → pass the JSON schema through provider-native structured
  //                 output; parse the reply (throw on failure).
  //   'json_mode' → request the provider's JSON mode; parse the reply.
  //   'prompt'    → inject a "return exactly one JSON value, no prose"
  //                 instruction, parse (strip fences + extract the outermost
  //                 balanced JSON); on failure, re-ask ONCE with a repair
  //                 instruction; still failing → StructuredOutputError.
  // Every rung yields a valid object on `response.structured` or throws a
  // typed error — never silent prose.
  async _structuredChat(req, route, caps, degraded) {
    const mode = caps.structuredOutput || 'prompt';
    const jsonSchema = toJsonSchema(req.responseSchema);

    if (mode === 'native' || mode === 'json_mode') {
      const adapterReq = { ...req, model: route.model };
      if (mode === 'native' && jsonSchema) adapterReq.responseSchema = jsonSchema;
      else adapterReq.jsonMode = true;
      const resp = await this._callAdapterChat(req, route, adapterReq, degraded);
      const parsed = extractJson(structuredText(resp));
      if (parsed.ok) { resp.structured = parsed.value; return resp; }
      throw new StructuredOutputError({ provider: route.provider, model: resp.model_used || route.model, text: structuredText(resp) });
    }

    // 'prompt' rung — the universal fallback that works against any model.
    // Strip the native directives so a schema-unaware adapter (local, CLI)
    // never receives a response_format/output_config it can't honor; the
    // schema shapes the injected instruction instead.
    if (!degraded.includes('structured:prompt')) degraded.push('structured:prompt');
    const { responseSchema: _rs, structuredOutput: _so, jsonMode: _jm, ...bare } = req;
    const instructed = { ...bare, system: appendSystem(req.system, jsonInstruction(jsonSchema)) };
    const resp = await this._callAdapterChat(req, route, { ...instructed, model: route.model }, degraded);
    const first = extractJson(structuredText(resp));
    if (first.ok) { resp.structured = first.value; return resp; }

    // Re-ask ONCE: show the model its bad output + a repair instruction.
    const repairReq = { ...instructed, messages: repairMessages(instructed.messages, structuredText(resp)) };
    const resp2 = await this._callAdapterChat(req, route, { ...repairReq, model: route.model }, degraded);
    const second = extractJson(structuredText(resp2));
    if (second.ok) { resp2.structured = second.value; return resp2; }

    throw new StructuredOutputError({ provider: route.provider, model: resp2.model_used || route.model, text: structuredText(resp2) });
  }

  // Single adapter.chat call with cost + ledger + budget accounting. Used
  // by both the plain path and each rung of the structured ladder. Writes
  // the ledger on success AND failure.
  async _callAdapterChat(req, route, adapterReq, degraded) {
    const adapter = this._getAdapter(route.provider);
    const callId = uuidv7();
    const started = Date.now();
    let response;
    try {
      response = await adapter.chat(adapterReq);
    } catch (err) {
      await this._writeLedger({
        callId,
        provider: route.provider,
        model: route.model,
        capability: route.capability,
        agent: req.agent,
        tenant: req.tenant,
        latency_ms: Date.now() - started,
        error: err,
        toolsUsed: collectToolNames(req.tools),
        degraded,
      });
      throw err;
    }
    response.cost_usd = computeCost({
      provider: route.provider,
      model: response.model_used,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cached_tokens: response.usage.cached_tokens,
    });
    await this._writeLedger({
      callId,
      provider: route.provider,
      model: response.model_used,
      capability: route.capability,
      agent: req.agent,
      tenant: req.tenant,
      input_tokens: response.usage.input_tokens,
      cached_tokens: response.usage.cached_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: response.cost_usd,
      latency_ms: response.latency_ms,
      stop_reason: response.stop_reason,
      toolsUsed: collectToolUsesFromResponse(response),
      degraded,
    });
    // Structural run-event + budget accounting. Agents routed through
    // the Model dispatcher no longer need to call recordModelCall
    // themselves (the legacy getAnthropicClient path still does).
    this.runtime?.recordModelCall?.({
      model: response.model_used,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      cost_usd: response.cost_usd,
    });
    return response;
  }

  // ─── stream ───────────────────────────────────────────────────────

  async *stream(req) {
    this.runtime?.checkBudget?.();
    const route = this._route(req);
    const adapter = this._getAdapter(route.provider);
    const adapterReq = { ...req, model: route.model };
    const callId = uuidv7();
    const started = Date.now();
    let finalResponse = null;
    let errored = null;
    try {
      for await (const ev of adapter.stream(adapterReq)) {
        if (ev.type === 'message_stop') {
          finalResponse = ev.response;
          finalResponse.cost_usd = computeCost({
            provider: route.provider,
            model: finalResponse.model_used,
            input_tokens: finalResponse.usage.input_tokens,
            output_tokens: finalResponse.usage.output_tokens,
            cached_tokens: finalResponse.usage.cached_tokens,
          });
          ev.response = finalResponse;
        }
        if (ev.type === 'error') errored = ev.error;
        yield ev;
      }
    } finally {
      await this._writeLedger({
        callId,
        provider: route.provider,
        model: finalResponse?.model_used || route.model,
        capability: route.capability,
        agent: req.agent,
        tenant: req.tenant,
        input_tokens: finalResponse?.usage?.input_tokens ?? 0,
        cached_tokens: finalResponse?.usage?.cached_tokens ?? 0,
        output_tokens: finalResponse?.usage?.output_tokens ?? 0,
        cost_usd: finalResponse?.cost_usd ?? 0,
        latency_ms: finalResponse?.latency_ms ?? (Date.now() - started),
        stop_reason: finalResponse?.stop_reason ?? null,
        toolsUsed: finalResponse ? collectToolUsesFromResponse(finalResponse) : [],
        error: errored ? new ModelProviderError({ provider: route.provider, model: route.model, message: errored.message }) : null,
      });
      if (finalResponse) {
        this.runtime?.recordModelCall?.({
          model: finalResponse.model_used,
          tokens_in: finalResponse.usage?.input_tokens ?? 0,
          tokens_out: finalResponse.usage?.output_tokens ?? 0,
          cost_usd: finalResponse.cost_usd ?? 0,
        });
      }
    }
  }

  // ─── vision ───────────────────────────────────────────────────────

  async vision({ images, prompt, model, agent, tenant }) {
    return this.chat({
      capability: model ? undefined : 'vision',
      model,
      messages: [{
        role: 'user',
        content: [
          ...images.map((img) => ({ type: 'image', mime: img.mime, data: img.data })),
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 1024,
      agent,
      tenant,
    });
  }

  // ─── embed (v2) ───────────────────────────────────────────────────

  async embed() {
    throw new NotImplementedError('Model.embed is a v2 surface — not implemented yet.');
  }

  // ─── internals ────────────────────────────────────────────────────

  _route(req) {
    if (req.model) {
      const provider = resolveModelToProvider(req.model);
      return this._applyCliFallback({
        provider,
        // Strip a routing prefix (openrouter/ groq/ mistral/) so the adapter
        // receives the gateway's own model id.
        model: stripRoutingPrefix(req.model, provider),
        capability: req.capability || null,
      });
    }
    // Local-first lane: when a local model endpoint + model name are both
    // configured (AGIX_LOCAL_MODEL_URL + AGIX_LOCAL_MODEL), capability routes
    // resolve to the local model — the privacy-spine "prefer local" default.
    // Gated entirely on env, so routing is unchanged when unset.
    const localModel = localFirstModel();
    if (localModel) {
      return { provider: 'local', model: localModel, capability: req.capability || 'default-quality' };
    }
    const cap = req.capability || 'default-quality';
    const row = resolveCapability(cap);
    return this._applyCliFallback({ provider: row.provider, model: row.model, capability: cap });
  }

  // CLI-passthrough fallback. Precedence (the key behavior of DL.13):
  //   1. explicit AGIX_PROVIDER  — honored as-is, no rewrite
  //   2. configured API key      — keep the API-key path
  //   3. detected CLI agent      — rewrite to claude-code / codex passthrough
  //   4. (else) leave the route   — _getAdapter throws the clear "key missing"
  //
  // Only api-key providers (anthropic/openai/gemini) are candidates for
  // rewrite; an explicit claude-code/codex route is already passthrough.
  _applyCliFallback(route) {
    const { provider } = route;
    // Local lane + CLI-passthrough routes are never rewritten to a CLI.
    if (provider === 'local' || CLI_PROVIDERS[provider]) return route;
    // (1) Operator pinned a provider explicitly — respect it, never rewrite.
    if (this._explicitProvider()) return route;
    // (2) The API key for this provider IS configured — use it.
    if (this.keys[provider]) return route;
    // (3) No key, but a CLI agent is installed — route through passthrough.
    //     anthropic → claude-code; openai → codex. Gemini has no CLI path,
    //     but if claude-code is present we still prefer a working answer
    //     over a hard "key missing" failure when nothing was pinned.
    const cli = this._cliAgent();
    if (cli) {
      // Map the original provider to its natural CLI when available; else
      // fall back to whichever CLI is installed.
      let target = cli;
      if (provider === 'anthropic') target = (cli === 'claude-code') ? 'claude-code' : cli;
      else if (provider === 'openai') target = (cli === 'codex') ? 'codex' : cli;
      return {
        provider: target,
        // Pass the originally-requested model through so the CLI adapter can
        // map it to an alias (claude) or -m (codex) when it makes sense.
        model: route.model,
        capability: route.capability,
        via_cli_fallback: true,
        fallback_from: provider,
      };
    }
    // (4) No key, no CLI — leave the route so _getAdapter throws clearly.
    return route;
  }

  // True when the operator pinned a provider via AGIX_PROVIDER. An explicit
  // pin is honored as-is (no CLI rewrite) per the precedence contract.
  _explicitProvider() {
    const p = (process.env.AGIX_PROVIDER || '').trim().toLowerCase();
    return p ? p : null;
  }

  // Capability descriptor for the routed adapter. Falls back to the
  // conservative default when an adapter (or a test stub) doesn't declare
  // one, so callers/ladders never crash on a missing descriptor.
  _capabilities(adapter) {
    return (adapter && adapter.capabilities) || DEFAULT_CAPABILITIES;
  }

  _getAdapter(provider) {
    if (this._adapters.has(provider)) return this._adapters.get(provider);
    let adapter;
    if (provider === 'anthropic') {
      if (!this.keys.anthropic) {
        throw new Error('Model: ANTHROPIC_API_KEY missing. Add ~/.config/agix/anthropic.env or set process.env.ANTHROPIC_API_KEY.');
      }
      adapter = new AnthropicAdapter({ apiKey: this.keys.anthropic });
    } else if (provider === 'openai') {
      if (!this.keys.openai) {
        throw new Error('Model: OPENAI_API_KEY missing. Add ~/.config/agix/openai.env or set process.env.OPENAI_API_KEY.');
      }
      adapter = new OpenAIAdapter({ apiKey: this.keys.openai });
    } else if (provider === 'gemini') {
      if (!this.keys.gemini) {
        throw new Error('Model: GEMINI_API_KEY missing. Add ~/.config/agix/gemini.env or set process.env.GEMINI_API_KEY.');
      }
      adapter = new GeminiAdapter({ apiKey: this.keys.gemini });
    } else if (provider === 'openrouter') {
      if (!this.keys.openrouter) {
        throw new Error('Model: OPENROUTER_API_KEY missing. Add ~/.config/agix/openrouter.env or set process.env.OPENROUTER_API_KEY.');
      }
      adapter = new OpenRouterAdapter({ apiKey: this.keys.openrouter });
    } else if (provider === 'groq') {
      if (!this.keys.groq) {
        throw new Error('Model: GROQ_API_KEY missing. Add ~/.config/agix/groq.env or set process.env.GROQ_API_KEY.');
      }
      // Groq is OpenAI-compatible — reuse the OpenAI adapter against Groq's
      // hosted endpoint (a key IS required, so local:false).
      adapter = new OpenAIAdapter({ apiKey: this.keys.groq, baseURL: 'https://api.groq.com/openai/v1', provider: 'groq', local: false });
    } else if (provider === 'mistral') {
      if (!this.keys.mistral) {
        throw new Error('Model: MISTRAL_API_KEY missing. Add ~/.config/agix/mistral.env or set process.env.MISTRAL_API_KEY.');
      }
      // Mistral is OpenAI-compatible — reuse the OpenAI adapter path.
      adapter = new OpenAIAdapter({ apiKey: this.keys.mistral, baseURL: 'https://api.mistral.ai/v1', provider: 'mistral', local: false });
    } else if (provider === 'local') {
      const baseURL = (process.env.AGIX_LOCAL_MODEL_URL || '').trim();
      if (!baseURL) {
        throw new Error('Model: AGIX_LOCAL_MODEL_URL not set — cannot route to the local model lane.');
      }
      // Reuse the OpenAI-compatible adapter against the local endpoint; no
      // API key required (ollama ignores the bearer token).
      adapter = new OpenAIAdapter({ baseURL, apiKey: this.keys.openai || null });
    } else if (CLI_PROVIDERS[provider]) {
      // CLI-passthrough: no API key needed — uses the installed CLI's
      // subscription auth. kind === provider ('claude-code' | 'codex').
      adapter = new CliPassthroughAdapter({ kind: CLI_PROVIDERS[provider] });
    } else {
      throw new Error(`Model: unknown provider "${provider}"`);
    }
    this._adapters.set(provider, adapter);
    return adapter;
  }

  async _writeLedger({
    callId, provider, model, capability,
    agent, tenant,
    input_tokens = 0, cached_tokens = 0, output_tokens = 0,
    cost_usd = 0, latency_ms = 0, stop_reason = null,
    toolsUsed = [], error = null, degraded = [],
  }) {
    const entry = buildLedgerEntry({
      callId,
      tenant: tenant || this.runtime?.tenantId || 'agix',
      agent: agent || this.runtime?.agentName || null,
      provider,
      model,
      capability,
      input_tokens,
      cached_tokens,
      output_tokens,
      cost_usd: error ? 0 : cost_usd,
      latency_ms,
      stop_reason,
      tools_used: toolsUsed,
      degraded: Array.isArray(degraded) ? degraded : [],
      error: error
        ? { class: error.constructor?.name || 'Error', message: String(error.message || error).slice(0, 500) }
        : null,
    });
    try {
      await writeLedgerEntry(entry);
    } catch (err) {
      console.error(`agix-model: ledger write failed: ${err.message}`);
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

// Conservative capability descriptor used when a routed adapter doesn't
// declare one (older adapters, test stubs). Assumes the least — no native
// structured output, no prompt caching — so the dispatcher degrades safely.
export const DEFAULT_CAPABILITIES = Object.freeze({
  toolUse: false,
  streamingToolUse: false,
  structuredOutput: 'prompt',
  vision: false,
  promptCaching: false,
  reasoning: false,
});

// Local-first model: the configured local model name when BOTH the endpoint
// and model env vars are set, else null. Gates the privacy-spine "prefer
// local" routing without mutating the static capability table.
function localFirstModel() {
  const url = (process.env.AGIX_LOCAL_MODEL_URL || '').trim();
  const model = (process.env.AGIX_LOCAL_MODEL || '').trim();
  return url && model ? model : null;
}

function collectToolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => t?.name).filter(Boolean);
}

function collectToolUsesFromResponse(response) {
  return (response.content || [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => b.name)
    .filter(Boolean);
}

// Whether a thrown error should trigger the opt-in fallback: only
// provider-transport failures qualify — 5xx, rate limits (429), or a
// network/transport error (no status). Explicitly NOT: 4xx auth/bad-request
// (retrying won't help), budget errors (the run is intentionally halted),
// or StructuredOutputError (a parse failure, not a provider outage).
function isRetryableProviderError(err) {
  if (!err) return false;
  if (err.name === 'StructuredOutputError') return false;
  if (err.name === 'BudgetExceededError' || /budget/i.test(err.name || '')) return false;
  if (err.name !== 'ModelProviderError') return false;
  const status = err.status;
  if (status == null) return true;   // network / transport / spawn failure
  if (status === 429) return true;   // rate limited
  if (status >= 500) return true;    // provider server error
  return false;                      // 4xx auth / bad request → not retryable
}

// ─── structured-output helpers ───────────────────────────────────────

// Join the text content blocks of a response into one string.
function structuredText(response) {
  return (response?.content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Normalize a caller-supplied `responseSchema` to a plain JSON Schema for
// the provider-native path. Accepts a JSON Schema object directly; a
// zod-like object (has `.parse`/`._def`) can't be converted without a heavy
// dep, so we return null and let the caller fall to the prompt rung (the
// schema still shapes the prompt instruction generically).
function toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof schema.parse === 'function' || schema._def) return null; // zod-like
  if (schema.type || schema.properties || schema.$schema || schema.oneOf || schema.anyOf) return schema;
  return null;
}

// The prompt-rung instruction. Appended to the system prompt so it works
// across every provider without assuming a JSON knob.
function jsonInstruction(jsonSchema) {
  let instr = 'You must reply with exactly one JSON value and nothing else. '
    + 'No prose, no explanation, no markdown code fences — output only the raw JSON value.';
  if (jsonSchema) instr += `\nThe JSON must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
  return instr;
}

// Append an instruction to the protocol `system` field, tolerating all
// three shapes (absent | string | content-block array).
function appendSystem(system, extra) {
  if (system == null) return extra;
  if (typeof system === 'string') return `${system}\n\n${extra}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: extra }];
  return system;
}

// Build the re-ask turn set: original turns + the model's bad reply +
// a repair instruction. Keeps user/assistant alternation intact.
function repairMessages(messages, badText) {
  return [
    ...(messages || []),
    { role: 'assistant', content: badText || '(no output)' },
    { role: 'user', content: 'That reply was not valid JSON. Reply again with ONLY one valid JSON value — no prose, no explanation, no code fences.' },
  ];
}

// Coerce model text into a JSON value. Strips code fences, tries a direct
// parse, then extracts the outermost balanced object/array. Returns
// { ok, value }.
function extractJson(text) {
  if (!text || typeof text !== 'string') return { ok: false };
  const unfenced = stripCodeFences(text).trim();
  const direct = tryParse(unfenced);
  if (direct.ok) return direct;
  const balanced = extractBalanced(unfenced);
  if (balanced != null) {
    const parsed = tryParse(balanced);
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}

function tryParse(s) {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch { return { ok: false }; }
}

// If the text contains a ```json …``` (or plain ```…```) fence, return its
// inner body; otherwise return the text unchanged.
function stripCodeFences(text) {
  const m = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}

// Extract the outermost balanced { … } or [ … ], respecting string
// literals + escapes so braces inside strings don't miscount.
function extractBalanced(s) {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export { ROUTING_TABLE };
