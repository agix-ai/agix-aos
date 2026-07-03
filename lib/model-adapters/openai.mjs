// OpenAI adapter for the Agix Model protocol. Uses raw fetch (no SDK)
// per spec §3.2 — keeps the dependency surface minimal and mirrors the
// existing /demos route style.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §3.2.

import { ModelProviderError } from './errors.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

let cacheWarningEmitted = false;

export class OpenAIAdapter {
  // `baseURL` lets this same OpenAI-compatible adapter target a local
  // endpoint (e.g. ollama at http://127.0.0.1:11434/v1) OR a hosted
  // OpenAI-compatible gateway (OpenRouter / Groq / Mistral). When a baseURL
  // points at a truly-local server the apiKey is optional — local servers
  // ignore the bearer token.
  //
  //   provider — response/ledger label ('openai' | 'local' | 'groq' | …).
  //   headers  — extra request headers merged into every call (e.g. the
  //              OpenRouter HTTP-Referer / X-Title attribution headers).
  //   local    — explicit override that decouples "is a local endpoint"
  //              from "has a baseURL"; hosted gateways pass a baseURL but
  //              set local:false so an API key is required + capabilities
  //              report the hosted profile. Defaults to Boolean(baseURL) so
  //              the existing ollama lane is unchanged.
  constructor({ apiKey, baseURL, provider, headers, local } = {}) {
    this.baseURL = (baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint = `${this.baseURL}/chat/completions`;
    this.local = local != null ? Boolean(local) : Boolean(baseURL);
    // Label the lane honestly in responses (the ledger already records this).
    this.providerLabel = provider || (this.local ? 'local' : 'openai');
    this.extraHeaders = headers || {};
    if (!apiKey && !this.local) {
      throw new Error('OpenAIAdapter: apiKey is required');
    }
    this.apiKey = apiKey || 'local-no-auth';
  }

  // ─── capability descriptor ────────────────────────────────────────
  //
  // The same OpenAI-compatible adapter serves both the hosted OpenAI API
  // and a LOCAL endpoint (ollama et al) via `baseURL`. Local servers vary
  // widely and can't be assumed to support streaming tool-use, native
  // json_schema, or vision — so the local lane declares conservatively and
  // the dispatcher degrades to the prompt ladder for structured output.
  get capabilities() {
    if (this.local) {
      return {
        toolUse: true,
        streamingToolUse: false,
        structuredOutput: 'prompt',
        vision: false,
        promptCaching: false,
        reasoning: false,
      };
    }
    return {
      toolUse: true,
      streamingToolUse: true,
      structuredOutput: 'native',
      vision: true,
      promptCaching: false,
      reasoning: true,
    };
  }

  async chat(req) {
    if (req.cache_breakpoints && req.cache_breakpoints.length && !cacheWarningEmitted) {
      console.warn('openai-adapter: cache_breakpoints ignored — OpenAI has no public cache_control knob. Consider routing to Anthropic for cacheable prompts.');
      cacheWarningEmitted = true;
    }
    const body = buildBody(req);
    const started = Date.now();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new ModelProviderError({
        provider: this.providerLabel,
        model: body.model,
        status: res.status,
        message: `${this.providerLabel} ${res.status}: ${text.slice(0, 300)}`,
      });
    }
    const json = await res.json();
    return translateResponse({
      json,
      model: body.model,
      latency_ms: Date.now() - started,
      provider: this.providerLabel,
    });
  }

  async *stream(req) {
    if (req.cache_breakpoints && req.cache_breakpoints.length && !cacheWarningEmitted) {
      console.warn('openai-adapter: cache_breakpoints ignored — OpenAI has no public cache_control knob.');
      cacheWarningEmitted = true;
    }
    const body = { ...buildBody(req), stream: true };
    const started = Date.now();

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await safeText(res);
      yield { type: 'error', error: { class: 'ModelProviderError', message: `OpenAI ${res.status}: ${text.slice(0, 300)}` } };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let accumulatedText = '';
    const toolCallsAcc = new Map();   // index → { id, name, args_acc }
    let stopReason = null;
    let usage = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.content) {
            accumulatedText += delta.content;
            yield { type: 'text_delta', text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args_acc: '' });
                yield { type: 'tool_use_start', id: tc.id || `call_${idx}`, name: tc.function?.name || '' };
              }
              const acc = toolCallsAcc.get(idx);
              if (tc.function?.arguments) {
                acc.args_acc += tc.function.arguments;
                yield { type: 'tool_use_delta', id: acc.id, partial_input: tc.function.arguments };
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
            }
          }
          if (choice.finish_reason) stopReason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
      }

      // Emit tool_use_stop events for any in-flight calls.
      const content = [];
      if (accumulatedText) content.push({ type: 'text', text: accumulatedText });
      for (const acc of toolCallsAcc.values()) {
        let parsed = {};
        try { parsed = acc.args_acc ? JSON.parse(acc.args_acc) : {}; } catch { /* leave {} */ }
        yield { type: 'tool_use_stop', id: acc.id, input: parsed };
        content.push({ type: 'tool_use', id: acc.id, name: acc.name, input: parsed });
      }

      const response = {
        content,
        stop_reason: normalizeStopReason(stopReason),
        model_used: body.model,
        provider: this.providerLabel,
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
          cached_tokens: 0,
        },
        latency_ms: Date.now() - started,
        request_id: null,
      };
      yield { type: 'message_stop', response };
    } catch (err) {
      yield { type: 'error', error: { class: 'ModelProviderError', message: err?.message || String(err) } };
    }
  }

  async vision({ images, prompt, model, agent, tenant }) {
    return this.chat({
      model: model || 'gpt-4.1-mini',
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

// ─── request shape ─────────────────────────────────────────────────

function buildBody(req) {
  const messages = [];
  if (req.system != null) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    messages.push({ role: 'system', content: sysText });
  }
  for (const m of req.messages) messages.push(translateMessage(m));

  const body = {
    model: req.model || 'gpt-4.1-mini',
    messages,
  };
  if (req.max_tokens != null) body.max_tokens = req.max_tokens;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.stop_sequences) body.stop = req.stop_sequences;
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  // Structured output. The dispatcher's 'native' rung passes a JSON schema
  // as `responseSchema` → json_schema response_format; `jsonMode` (the
  // 'json_mode' rung) → the looser json_object mode. Gated on the fields so
  // ordinary calls are unchanged.
  if (req.responseSchema && typeof req.responseSchema === 'object') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'agix_response', schema: req.responseSchema },
    };
  } else if (req.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

function translateMessage(msg) {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  // OpenAI uses tool calls in `message.tool_calls`, not inside content.
  // For assistant turns with tool_use blocks, we emit that path.
  if (msg.role === 'assistant' && msg.content.some((b) => b.type === 'tool_use')) {
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
    }));
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls,
    };
  }
  // tool_result blocks become role:'tool' messages, one per result.
  if (msg.content.some((b) => b.type === 'tool_result')) {
    // OpenAI requires one message per tool result — return the FIRST
    // here and rely on the caller having split them. For now, just merge.
    const results = msg.content.filter((b) => b.type === 'tool_result');
    return {
      role: 'tool',
      tool_call_id: results[0].tool_use_id,
      content: results.map((r) => r.content).join('\n'),
    };
  }
  // Mixed user content: text + images.
  const parts = msg.content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${b.mime};base64,${b.data}` },
      };
    }
    return null;
  }).filter(Boolean);
  return { role: msg.role, content: parts };
}

// ─── response shape ────────────────────────────────────────────────

function translateResponse({ json, model, latency_ms, provider = 'openai' }) {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* {} */ }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }
  const usage = json.usage || {};
  return {
    content,
    stop_reason: normalizeStopReason(choice.finish_reason),
    model_used: model,
    provider,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cached_tokens: 0,
    },
    latency_ms,
    request_id: json.id || null,
  };
}

function normalizeStopReason(reason) {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'function_call') return 'tool_use';
  return 'end_turn';
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
