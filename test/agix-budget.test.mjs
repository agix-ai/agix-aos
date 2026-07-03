// agix budget primitive — unit tests.
// Runner: node --test test/agix-budget.test.mjs
//
// The budget is enforced structurally by the Model dispatcher
// (checkBudget before every provider call); spend accrues through
// recordModelCall. These tests exercise the runtime surface directly
// plus the Model gate with a stubbed adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalRuntime, BudgetExceededError } from '../lib/agix-runtime.mjs';
import { Model } from '../lib/agix-model.mjs';

test('no budget configured: status reports unlimited, checkBudget never throws', () => {
  const rt = new LocalRuntime({ agentName: 'sensei' });
  rt.recordModelCall({ model: 'm', tokens_in: 1e6, tokens_out: 1e6, cost_usd: 9999 });
  const status = rt.budgetStatus();
  assert.equal(status.configured, false);
  assert.equal(status.exceeded, false);
  assert.doesNotThrow(() => rt.checkBudget());
});

test('cost cap: spend accrues via recordModelCall and trips the gate', () => {
  const rt = new LocalRuntime({ agentName: 'sensei', budget: { max_cost_usd: 1.0 } });
  rt.recordModelCall({ model: 'm', tokens_in: 100, tokens_out: 50, cost_usd: 0.4 });
  assert.equal(rt.budgetStatus().exceeded, false);
  assert.equal(rt.budgetStatus().remaining_usd, 0.6);

  rt.recordModelCall({ model: 'm', tokens_in: 100, tokens_out: 50, cost_usd: 0.6 });
  assert.equal(rt.budgetStatus().exceeded, true);
  assert.throws(() => rt.checkBudget(), BudgetExceededError);
});

test('token cap trips independently of cost', () => {
  const rt = new LocalRuntime({ agentName: 'research', budget: { max_tokens: 1000 } });
  rt.recordModelCall({ model: 'm', tokens_in: 600, tokens_out: 400, cost_usd: 0 });
  assert.throws(() => rt.checkBudget(), /Budget exceeded.*research/);
});

test('budget spend accrues even outside an active run event', () => {
  const rt = new LocalRuntime({ agentName: 'sensei', budget: { max_cost_usd: 1 } });
  // No _beginRunEvent was called — recordModelCall must still count spend.
  rt.recordModelCall({ model: 'm', tokens_in: 10, tokens_out: 10, cost_usd: 0.25 });
  assert.equal(rt.budgetStatus().spent_usd, 0.25);
  assert.equal(rt.budgetStatus().spent_tokens, 20);
});

test('Model.chat gates on the budget before dispatch and records spend after', async () => {
  const rt = new LocalRuntime({ agentName: 'sensei', budget: { max_cost_usd: 0.5 } });
  const model = new Model({ runtime: rt, keys: { anthropic: 'test' } });
  // Stub the adapter so no network/SDK is touched; cost comes from the
  // rate card, so use a model id with a known rate or assert via usage.
  let calls = 0;
  model._adapters.set('anthropic', {
    chat: async () => {
      calls += 1;
      return {
        model_used: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, output_tokens: 100, cached_tokens: 0 },
        stop_reason: 'end_turn',
        latency_ms: 1,
      };
    },
  });

  const resp = await model.chat({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    agent: 'sensei',
  });
  assert.equal(calls, 1);
  assert.ok(resp.cost_usd >= 0);
  // The dispatcher recorded the spend on the runtime.
  assert.equal(rt.budgetStatus().spent_tokens, 200);

  // Exhaust the budget manually, then the next call is refused pre-dispatch.
  rt.recordModelCall({ model: 'm', tokens_in: 0, tokens_out: 0, cost_usd: 10 });
  await assert.rejects(
    () => model.chat({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi again' }],
      agent: 'sensei',
    }),
    BudgetExceededError,
  );
  assert.equal(calls, 1, 'provider adapter must not be reached once over budget');
});
