// Smoke-mode model stub. Returns canned responses shaped to the
// protocol so smoke runs verify code paths without burning tokens, and
// still writes a ledger entry per call (cost_usd: 0) so AC-MP-09's
// "smoke runs produce one ledger line per call site" guardrail holds.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §9 AC-MP-09.

import { resolveCapability, resolveModelToProvider } from './routing.mjs';
import { writeLedgerEntry, buildLedgerEntry } from './ledger.mjs';
import { uuidv7 } from './uuid.mjs';

export function makeSmokeModelStub({ runtime } = {}) {
  return {
    smoke: true,

    async chat(req) {
      const { provider, model, capability } = resolveRoute(req);
      const callId = uuidv7();
      const response = {
        content: [{ type: 'text', text: '[smoke-mode canned response]' }],
        stop_reason: 'end_turn',
        model_used: model,
        provider,
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
        cost_usd: 0,
        latency_ms: 0,
        request_id: `smoke-${callId}`,
      };
      await writeLedgerEntry(buildLedgerEntry({
        callId,
        tenant: runtime?.tenantId || 'agix',
        agent: req.agent || runtime?.agentName || null,
        provider,
        model,
        capability,
        stop_reason: 'end_turn',
      })).catch((err) => {
        console.error(`smoke-stub: ledger write failed: ${err.message}`);
      });
      return response;
    },

    async *stream(req) {
      const { provider, model, capability } = resolveRoute(req);
      const callId = uuidv7();
      const text = '[smoke-mode canned stream]';
      yield { type: 'text_delta', text };
      const response = {
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        model_used: model,
        provider,
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
        cost_usd: 0,
        latency_ms: 0,
        request_id: `smoke-${callId}`,
      };
      await writeLedgerEntry(buildLedgerEntry({
        callId,
        tenant: runtime?.tenantId || 'agix',
        agent: req.agent || runtime?.agentName || null,
        provider,
        model,
        capability,
        stop_reason: 'end_turn',
      })).catch(() => {});
      yield { type: 'message_stop', response };
    },

    async vision(req) {
      return this.chat({
        capability: 'vision',
        messages: [],
        agent: req.agent,
        tenant: req.tenant,
      });
    },

    async embed() {
      throw new Error('embed: not implemented in v1 (NotImplementedError)');
    },
  };
}

function resolveRoute(req) {
  if (req.model) {
    return {
      provider: safeResolveProvider(req.model),
      model: req.model,
      capability: req.capability || null,
    };
  }
  const cap = req.capability || 'default-quality';
  const row = resolveCapability(cap);
  return { provider: row.provider, model: row.model, capability: cap };
}

function safeResolveProvider(model) {
  try { return resolveModelToProvider(model); } catch { return 'anthropic'; }
}
