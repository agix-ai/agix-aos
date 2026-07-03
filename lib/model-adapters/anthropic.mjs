// Anthropic adapter for the Agix Model protocol. Wraps @anthropic-ai/sdk
// so the rest of the codebase never imports Anthropic directly.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §3.1.

import Anthropic from '@anthropic-ai/sdk';
import { ModelProviderError } from './errors.mjs';

// Short → fully-dated model IDs. The SDK accepts the short form for some
// models but not others; the dated form always works.
const MODEL_ALIAS = {
  'claude-opus-4-7':   'claude-opus-4-7',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5':  'claude-haiku-4-5-20251001',
};

const MAX_CACHE_BREAKPOINTS = 4;

export class AnthropicAdapter {
  constructor({ apiKey } = {}) {
    if (!apiKey) {
      throw new Error('AnthropicAdapter: apiKey is required');
    }
    this.client = new Anthropic({ apiKey });
  }

  // ─── capability descriptor ────────────────────────────────────────
  //
  // What this adapter's models support, so the dispatcher can pick the
  // right structured-output rung + record honest `degraded[]` markers.
  // `structuredOutput: 'native'` — the SDK (>=0.96) accepts
  // `output_config.format` with a `json_schema` so the model is constrained
  // to emit the schema. See translateRequest.
  get capabilities() {
    return {
      toolUse: true,
      streamingToolUse: true,
      structuredOutput: 'native',
      vision: true,
      promptCaching: true,
      reasoning: true,
    };
  }

  // ─── chat ─────────────────────────────────────────────────────────

  async chat(req) {
    const { sdkReq, modelUsed } = translateRequest(req);
    const started = Date.now();
    let resp;
    try {
      resp = await this.client.messages.create(sdkReq);
    } catch (err) {
      throw new ModelProviderError({
        provider: 'anthropic',
        model: modelUsed,
        status: err?.status ?? null,
        message: err?.message || String(err),
        cause: err,
      });
    }
    return translateResponse({
      resp,
      modelUsed,
      latency_ms: Date.now() - started,
    });
  }

  // ─── stream ───────────────────────────────────────────────────────

  async *stream(req) {
    const { sdkReq, modelUsed } = translateRequest(req);
    const started = Date.now();

    let streamObj;
    try {
      streamObj = this.client.messages.stream(sdkReq);
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
      return;
    }

    const toolUses = new Map();        // id → { name, input_acc }
    try {
      for await (const event of streamObj) {
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const id = event.content_block.id;
          toolUses.set(id, { name: event.content_block.name, input_acc: '' });
          yield { type: 'tool_use_start', id, name: event.content_block.name };
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta?.type === 'input_json_delta') {
            // Find the most-recent in-flight tool_use by content block index
            // — the SDK gives us the block index on the parent event.
            const id = [...toolUses.keys()].pop();
            if (id) {
              toolUses.get(id).input_acc += event.delta.partial_json || '';
              yield { type: 'tool_use_delta', id, partial_input: event.delta.partial_json || '' };
            }
          }
        } else if (event.type === 'content_block_stop') {
          const id = [...toolUses.keys()].pop();
          if (id) {
            const acc = toolUses.get(id);
            let parsed = {};
            try { parsed = acc.input_acc ? JSON.parse(acc.input_acc) : {}; } catch { /* leave {} */ }
            yield { type: 'tool_use_stop', id, input: parsed };
          }
        }
      }
      const finalMessage = await streamObj.finalMessage();
      const response = translateResponse({
        resp: finalMessage,
        modelUsed,
        latency_ms: Date.now() - started,
      });
      yield { type: 'message_stop', response };
    } catch (err) {
      yield {
        type: 'error',
        error: { class: 'ModelProviderError', message: err?.message || String(err) },
      };
    }
  }

  // ─── vision ───────────────────────────────────────────────────────
  //
  // Vision is just chat with image content blocks. The Model dispatcher
  // typically routes vision to Gemini per the routing table; this method
  // is here so the adapter remains complete.
  async vision({ images, prompt, model, agent, tenant }) {
    return this.chat({
      model: model || 'claude-sonnet-4-6',
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
}

// ─── request translation ───────────────────────────────────────────

function translateRequest(req) {
  const modelUsed = resolveModelId(req.model);
  const sdkReq = {
    model: modelUsed,
    max_tokens: req.max_tokens ?? 1024,
    messages: req.messages.map(translateMessage),
  };
  if (req.system != null) sdkReq.system = translateSystem(req.system);
  if (req.temperature != null) sdkReq.temperature = req.temperature;
  if (req.stop_sequences) sdkReq.stop_sequences = req.stop_sequences;
  if (req.tools && req.tools.length) sdkReq.tools = req.tools.map(translateTool);
  // Anthropic-specific extended-thinking knob. The protocol doesn't
  // formalize this yet (no analogue on OpenAI/Gemini), but Sensei's
  // strategic reasoning depends on it. Pass-through is safe because the
  // SDK ignores unrecognized shapes and other adapters never see it.
  if (req.thinking != null) sdkReq.thinking = req.thinking;

  // Native structured output: the dispatcher's 'native' rung passes a JSON
  // schema through as `responseSchema`. Anthropic constrains the reply to
  // the schema via `output_config.format` (SDK >=0.96). Gated on the field
  // so ordinary calls are unchanged.
  if (req.responseSchema && typeof req.responseSchema === 'object') {
    sdkReq.output_config = {
      ...(sdkReq.output_config || {}),
      format: { type: 'json_schema', schema: req.responseSchema },
    };
  }

  applyCacheBreakpoints(sdkReq, req.cache_breakpoints);

  return { sdkReq, modelUsed };
}

function resolveModelId(model) {
  if (!model) return MODEL_ALIAS['claude-sonnet-4-6'];
  return MODEL_ALIAS[model] || model;
}

function translateSystem(system) {
  if (typeof system === 'string') return system;
  // Array of content blocks (already protocol-shaped) → SDK shape.
  return system.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return b;
  });
}

function translateMessage(msg) {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: msg.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image') {
        return {
          type: 'image',
          source: { type: 'base64', media_type: b.mime, data: b.data },
        };
      }
      if (b.type === 'tool_use') {
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      }
      if (b.type === 'tool_result') {
        return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content };
      }
      return b;
    }),
  };
}

function translateTool(t) {
  return { name: t.name, description: t.description, input_schema: t.input_schema };
}

function applyCacheBreakpoints(sdkReq, breakpoints) {
  if (!breakpoints || breakpoints.length === 0) return;
  let bps = breakpoints;
  if (bps.length > MAX_CACHE_BREAKPOINTS) {
    console.warn(`anthropic-adapter: ${bps.length} cache breakpoints provided, Anthropic max is ${MAX_CACHE_BREAKPOINTS} — clamping.`);
    bps = bps.slice(0, MAX_CACHE_BREAKPOINTS);
  }
  for (const bp of bps) {
    if (bp.scope === 'system') {
      // Normalize string system to a one-block array first.
      if (typeof sdkReq.system === 'string') {
        sdkReq.system = [{ type: 'text', text: sdkReq.system }];
      }
      if (Array.isArray(sdkReq.system) && sdkReq.system.length) {
        const last = sdkReq.system[sdkReq.system.length - 1];
        last.cache_control = { type: 'ephemeral' };
      }
    } else if (bp.scope === 'messages') {
      const i = typeof bp.index === 'number' ? bp.index : sdkReq.messages.length - 1;
      const msg = sdkReq.messages[i];
      if (!msg) continue;
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
      }
      if (Array.isArray(msg.content) && msg.content.length) {
        const lastBlock = msg.content[msg.content.length - 1];
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }
}

// ─── response translation ──────────────────────────────────────────

function translateResponse({ resp, modelUsed, latency_ms }) {
  const content = (resp.content || []).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') {
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    }
    return b;
  });
  const usage = resp.usage || {};
  const input_tokens = usage.input_tokens ?? 0;
  // Anthropic surfaces `cache_read_input_tokens` for prompt-cache hits
  // and `cache_creation_input_tokens` for the first write. Treat both as
  // "input tokens" for the input_tokens total; only the cache reads
  // count as `cached_tokens` for the discount math.
  const cached_tokens = usage.cache_read_input_tokens ?? 0;
  const output_tokens = usage.output_tokens ?? 0;
  return {
    content,
    stop_reason: normalizeStopReason(resp.stop_reason),
    model_used: canonicalizeModel(modelUsed),
    provider: 'anthropic',
    usage: {
      input_tokens: input_tokens + (usage.cache_creation_input_tokens ?? 0),
      output_tokens,
      cached_tokens,
    },
    latency_ms,
    request_id: resp.id || null,
    _raw_stop_reason: resp.stop_reason,
  };
}

function normalizeStopReason(stop) {
  if (stop === 'end_turn') return 'end_turn';
  if (stop === 'max_tokens') return 'max_tokens';
  if (stop === 'tool_use') return 'tool_use';
  if (stop === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

// Strip the date suffix so callers see the protocol's canonical short form.
function canonicalizeModel(modelId) {
  return String(modelId || '').replace(/-\d{8}$/, '');
}
