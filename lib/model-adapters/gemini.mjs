// Gemini adapter for the Agix Model protocol. Uses Google AI Studio
// (@google/generative-ai), not Vertex AI — operator's choice per spec
// §3.3 for lower friction (one API key, no per-project enablement).
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §3.3.

import { ModelProviderError } from './errors.mjs';

let cacheWarningEmitted = false;

// Lazy-load the SDK so installs that never call Gemini don't fail at
// import time if the dep is missing.
let _genAiCtor = null;
async function loadGenAI() {
  if (_genAiCtor) return _genAiCtor;
  const mod = await import('@google/generative-ai');
  _genAiCtor = mod.GoogleGenerativeAI || mod.default?.GoogleGenerativeAI;
  if (!_genAiCtor) {
    throw new Error('@google/generative-ai: GoogleGenerativeAI export not found');
  }
  return _genAiCtor;
}

export class GeminiAdapter {
  constructor({ apiKey } = {}) {
    if (!apiKey) {
      throw new Error('GeminiAdapter: apiKey is required');
    }
    this.apiKey = apiKey;
  }

  // ─── capability descriptor ────────────────────────────────────────
  //
  // Gemini supports native structured output via
  // `responseMimeType: 'application/json'` + `responseSchema` (see
  // buildGenerationConfig). Tool-use is supported but the adapter surfaces
  // function calls only on the final aggregate, so streamingToolUse is
  // false. Prompt caching is implicit (no explicit knob) → false here.
  get capabilities() {
    return {
      toolUse: true,
      streamingToolUse: false,
      structuredOutput: 'native',
      vision: true,
      promptCaching: false,
      reasoning: true,
    };
  }

  async _client(model) {
    const Ctor = await loadGenAI();
    if (!this._gen) this._gen = new Ctor(this.apiKey);
    return this._gen.getGenerativeModel({ model });
  }

  async chat(req) {
    maybeWarnCache(req);
    const modelId = req.model || 'gemini-2.5-flash';
    const { contents, systemInstruction, tools } = translateRequest(req);
    const client = await this._client(modelId);

    const started = Date.now();
    let result;
    try {
      result = await client.generateContent({
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
        generationConfig: buildGenerationConfig(req),
      });
    } catch (err) {
      throw new ModelProviderError({
        provider: 'gemini',
        model: modelId,
        status: err?.status ?? null,
        message: err?.message || String(err),
        cause: err,
      });
    }
    return translateResponse({
      result,
      model: modelId,
      latency_ms: Date.now() - started,
    });
  }

  async *stream(req) {
    maybeWarnCache(req);
    const modelId = req.model || 'gemini-2.5-flash';
    const { contents, systemInstruction, tools } = translateRequest(req);
    const client = await this._client(modelId);
    const started = Date.now();

    let streamResult;
    try {
      streamResult = await client.generateContentStream({
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
        generationConfig: buildGenerationConfig(req),
      });
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
      return;
    }

    let aggregated = '';
    try {
      for await (const chunk of streamResult.stream) {
        const text = typeof chunk.text === 'function' ? chunk.text() : '';
        if (text) {
          aggregated += text;
          yield { type: 'text_delta', text };
        }
        // Function calls arrive on chunks too in some cases; we wait for
        // the final aggregate response below to translate them so the
        // protocol's tool_use ids stay stable.
      }
      const final = await streamResult.response;
      const response = translateResponse({
        result: { response: final },
        model: modelId,
        latency_ms: Date.now() - started,
      });
      // Replace text in content with the streamed aggregate if the final
      // payload elided it (Gemini sometimes returns only function calls).
      if (aggregated && !response.content.some((b) => b.type === 'text')) {
        response.content.unshift({ type: 'text', text: aggregated });
      }
      yield { type: 'message_stop', response };
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
    }
  }

  async vision({ images, prompt, model, agent, tenant }) {
    return this.chat({
      model: model || 'gemini-2.5-flash',
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

function maybeWarnCache(req) {
  if (req.cache_breakpoints && req.cache_breakpoints.length && !cacheWarningEmitted) {
    console.warn('gemini-adapter: cache_breakpoints ignored — Gemini uses implicit context caching. Explicit CachedContent deferred to v2.');
    cacheWarningEmitted = true;
  }
}

function buildGenerationConfig(req) {
  const cfg = {};
  if (req.max_tokens != null) cfg.maxOutputTokens = req.max_tokens;
  if (req.temperature != null) cfg.temperature = req.temperature;
  if (req.stop_sequences) cfg.stopSequences = req.stop_sequences;
  // Structured output. 'native' rung → responseMimeType + responseSchema;
  // 'json_mode' rung → JSON mime type only. Gated so ordinary calls are
  // unchanged.
  if (req.responseSchema && typeof req.responseSchema === 'object') {
    cfg.responseMimeType = 'application/json';
    cfg.responseSchema = req.responseSchema;
  } else if (req.jsonMode) {
    cfg.responseMimeType = 'application/json';
  }
  return cfg;
}

// ─── request translation ───────────────────────────────────────────

function translateRequest(req) {
  const systemInstruction = req.system != null ? translateSystem(req.system) : null;
  const contents = req.messages.map(translateMessage);
  const tools = req.tools && req.tools.length
    ? [{ functionDeclarations: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })) }]
    : null;
  return { contents, systemInstruction, tools };
}

function translateSystem(system) {
  if (typeof system === 'string') return { role: 'system', parts: [{ text: system }] };
  return {
    role: 'system',
    parts: system.filter((b) => b.type === 'text').map((b) => ({ text: b.text })),
  };
}

function translateMessage(msg) {
  // Gemini uses 'user' and 'model' roles (not 'assistant').
  const role = msg.role === 'assistant' ? 'model' : 'user';
  if (typeof msg.content === 'string') {
    return { role, parts: [{ text: msg.content }] };
  }
  const parts = msg.content.map((b) => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'image') return { inlineData: { mimeType: b.mime, data: b.data } };
    if (b.type === 'tool_use') {
      return { functionCall: { name: b.name, args: b.input || {} } };
    }
    if (b.type === 'tool_result') {
      // Gemini tool results require functionResponse parts on a user turn.
      return {
        functionResponse: {
          name: b.tool_use_id,   // best-effort; ideally caller maps id→name
          response: { content: b.content },
        },
      };
    }
    return null;
  }).filter(Boolean);
  return { role, parts };
}

// ─── response translation ──────────────────────────────────────────

function translateResponse({ result, model, latency_ms }) {
  const response = result.response || result;
  const candidates = response.candidates || [];
  const cand = candidates[0] || {};
  const parts = cand.content?.parts || [];
  const content = [];
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text) {
      content.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: `gemini_${Math.random().toString(36).slice(2, 12)}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  const usage = response.usageMetadata || {};
  return {
    content,
    stop_reason: normalizeStopReason(cand.finishReason),
    model_used: model,
    provider: 'gemini',
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
      cached_tokens: usage.cachedContentTokenCount ?? 0,
    },
    latency_ms,
    request_id: null,
  };
}

function normalizeStopReason(reason) {
  if (reason === 'STOP') return 'end_turn';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'TOOL_CALL' || reason === 'FUNCTION_CALL') return 'tool_use';
  if (reason === 'STOP_SEQUENCE') return 'stop_sequence';
  return 'end_turn';
}
