// agix-authz-gate — LocalRuntime.authorize() enforcement gate unit tests.
// Exercises the Hanko PDP wired into the runtime against the REAL repo
// AGENT_POLICY.yaml (agix enterprise: owner=allow-all, viewer=read-only,
// operator=scoped). Runner: node --test test/agix-authz-gate.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { LocalRuntime, PermissionDeniedError } from '../lib/agix-runtime.mjs';
import { _setIdentityForTest, _resetIdentityCache } from '../lib/agix-identity.mjs';
import { _resetPolicyCache } from '../lib/agix-policy.mjs';

function asOperator(email, roles) {
  _setIdentityForTest({ users: [{ id: email.split('@')[0], email, name: email, roles }] });
  process.env.AGIX_OPERATOR_EMAIL = email;
}

afterEach(() => {
  _resetIdentityCache();
  _resetPolicyCache();
  delete process.env.AGIX_AUTHZ;
  delete process.env.AGIX_OPERATOR_EMAIL;
});

test('smoke runs bypass the gate', () => {
  process.env.AGIX_AUTHZ = 'enforce';
  asOperator('v@example.com', ['viewer']); // would be denied if enforced
  const rt = new LocalRuntime({ agentName: 'tester', smoke: true });
  assert.equal(rt.authorize('run', { agent: 'director' }).bypass, 'smoke');
});

test('mode=off is a no-op', () => {
  process.env.AGIX_AUTHZ = 'off';
  asOperator('v@example.com', ['viewer']);
  const rt = new LocalRuntime({ agentName: 'tester' });
  assert.equal(rt.authorize('run', { agent: 'director' }).bypass, 'off');
});

test('unresolved actor (no identity) bypasses — can\'t enforce against nobody', () => {
  process.env.AGIX_AUTHZ = 'enforce';
  _setIdentityForTest({}); // no users, no operator
  const rt = new LocalRuntime({ agentName: 'tester' });
  assert.equal(rt.authorize('run', { agent: 'director' }).bypass, 'no-identity');
});

test('advisory (default): a denied action is reported but NOT blocked', () => {
  asOperator('v@example.com', ['viewer']); // viewer: read-only
  const rt = new LocalRuntime({ agentName: 'tester' });
  const d = rt.authorize('run', { agent: 'director' }); // not 'read' → denied
  assert.equal(d.allowed, false); // advisory returns the decision, does not throw
});

test('enforce: a denied action throws PermissionDeniedError', () => {
  process.env.AGIX_AUTHZ = 'enforce';
  asOperator('v@example.com', ['viewer']);
  const rt = new LocalRuntime({ agentName: 'tester' });
  assert.throws(() => rt.authorize('run', { agent: 'director' }), PermissionDeniedError);
  // viewer CAN read
  assert.equal(rt.authorize('read', { agent: 'director' }).allowed, true);
});

test('enforce: the owner (repo policy binding) may do anything', () => {
  process.env.AGIX_AUTHZ = 'enforce';
  asOperator('owner@example.com', ['owner']); // bound to owner in repo AGENT_POLICY.yaml
  const rt = new LocalRuntime({ agentName: 'tester' });
  assert.equal(rt.authorize('run', { agent: 'director' }).allowed, true);
  assert.equal(rt.authorize('apphosting.rollout.create', { agent: 'director' }).allowed, true);
});

test('enforce: a require_approval action blocks until approval', () => {
  process.env.AGIX_AUTHZ = 'enforce';
  asOperator('op@example.com', ['operator']); // operator: director scoped + requires_approval on rollout
  const rt = new LocalRuntime({ agentName: 'tester' });
  assert.equal(rt.authorize('gh.run.rerun', { agent: 'director' }).allowed, true); // plain allow
  assert.throws(
    () => rt.authorize('apphosting.rollout.create', { agent: 'director' }),
    /requires human approval/,
  );
});
