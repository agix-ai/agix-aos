// agix-eval/replay-model — a scripted Model stub for deterministic,
// API-key-free evaluation.
//
// The runtime caches the model on `runtime._model` and hands it out via
// `getModel()`. The harness injects a ReplayModel there so an agent's
// REAL code path runs — parsing, validation, ID-enforcement, finding
// assembly — against fixed, pre-recorded model outputs. This evaluates
// the agent's deterministic layer (its guardrails and post-processing)
// reproducibly, and lets the same suite run live (real model) by
// swapping the injected model out.
//
// It mirrors the surface that lib/model-adapters/smoke.mjs exposes, so
// agents cannot tell it apart from a real Model.

import { resolveCapability, resolveModelToProvider } from '../model-adapters/routing.mjs';

function resolveRoute(req) {
  if (req.model) {
    return { provider: resolveModelToProvider(req.model), model: req.model, capability: req.capability || null };
  }
  const cap = req.capability || 'default-quality';
  const row = resolveCapability(cap);
  return { provider: row.provider, model: row.model, capability: cap };
}

export class ReplayModel {
  /**
   * @param {object} opts
   * @param {string[]} [opts.responses]  FIFO queue of text responses.
   * @param {(req)=>string} [opts.respond]  Function form: derive the
   *        response text from the request (e.g. match on system prompt
   *        or capability). Takes precedence over `responses`.
   */
  constructor({ responses = [], respond = null } = {}) {
    this.replay = true;
    this._queue = [...responses];
    this._respond = respond;
    this.calls = []; // recorded for assertions
  }

  _next(req) {
    if (this._respond) return this._respond(req) ?? '';
    if (this._queue.length) return this._queue.shift();
    return '';
  }

  async chat(req) {
    const { provider, model, capability } = resolveRoute(req);
    const text = this._next(req);
    this.calls.push({ capability, model, system: req.system, agent: req.agent });
    return {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model_used: model,
      provider,
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      cost_usd: 0,
      latency_ms: 0,
      request_id: `replay-${this.calls.length}`,
    };
  }

  async *stream(req) {
    const r = await this.chat(req);
    yield { type: 'text_delta', text: r.content[0].text };
    yield { type: 'message_stop', response: r };
  }

  async vision(req) {
    return this.chat(req);
  }

  async embed() {
    throw new Error('ReplayModel.embed: not supported');
  }
}

/**
 * Build a LocalRuntime-compatible object with a ReplayModel already
 * wired into getModel(). We avoid importing LocalRuntime to keep this a
 * pure test double; agents only touch the surfaces declared here. Pass
 * `repoRoot` so file-reading agents resolve prompts/fixtures correctly.
 */
export function makeReplayRuntime({ repoRoot, responses, respond, agentName = 'eval' } = {}) {
  const model = new ReplayModel({ responses, respond });
  const writes = [];
  return {
    replay: true,
    repoRoot,
    agentName,
    tenantId: 'agix-eval',
    smoke: false,
    _model: model,
    getModel() {
      return model;
    },
    recordModelCall() {},
    async writeRepoFile(relPath, content) {
      writes.push({ relPath, content });
    },
    async writeState() {},
    async readState() {
      return null;
    },
    _writes: writes,
    _replayModel: model,
  };
}
