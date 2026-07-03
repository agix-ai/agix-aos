// agix-policy — Policy Binding loader + decision (Hanko PDP seed) unit tests.
// Runner: node --test test/agix-policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPolicy, _resetPolicyCache,
  rolesForUserInPolicy, grantsForAgent, decide, checkAuthority,
} from '../lib/agix-policy.mjs';

const POLICY = {
  version: 1,
  default_decision: 'deny',
  enterprises: {
    acme: {
      roles: {
        owner: { agents: { '*': { allow: ['*'] } } },
        operator: {
          agents: {
            director: {
              allow: ['gh.run.rerun', 'apphosting.rollout.create'],
              require_approval: ['apphosting.rollout.create'],
              deny: ['prod.database.drop'],
            },
            '*': { allow: ['read'] },
          },
        },
        viewer: { agents: { '*': { allow: ['read'] } } },
      },
      users: {
        'sam@example.com': { roles: ['owner'] },
        'jo@example.com': { roles: ['operator'] },
      },
    },
  },
};

const d = (roles, agent, action, userEmail = null) =>
  decide(POLICY, { enterpriseId: 'acme', roles, userEmail, agent, action });

test('rolesForUserInPolicy: email-keyed, case-insensitive', () => {
  assert.deepEqual(rolesForUserInPolicy(POLICY, 'acme', 'JO@example.com'), ['operator']);
  assert.deepEqual(rolesForUserInPolicy(POLICY, 'acme', 'nobody@example.com'), []);
});

test('owner wildcard allows any agent/action', () => {
  const r = d(['owner'], 'director', 'anything.at.all');
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test('operator: scoped allow, deny-by-default outside scope', () => {
  assert.equal(d(['operator'], 'director', 'gh.run.rerun').allowed, true);
  assert.equal(d(['operator'], 'director', 'read').allowed, true); // via '*' agent allow
  assert.equal(d(['operator'], 'director', 'some.random.action').allowed, false);
});

test('require_approval is surfaced on an allowed action', () => {
  const r = d(['operator'], 'director', 'apphosting.rollout.create');
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

test('deny wins over allow (even owner allow-all)', () => {
  assert.equal(d(['operator'], 'director', 'prod.database.drop').allowed, false);
  // owner grants '*' but operator denies it → deny wins
  assert.equal(d(['owner', 'operator'], 'director', 'prod.database.drop').allowed, false);
});

test('viewer is read-only; unknown enterprise denies', () => {
  assert.equal(d(['viewer'], 'director', 'read').allowed, true);
  assert.equal(d(['viewer'], 'director', 'gh.run.rerun').allowed, false);
  assert.equal(
    decide(POLICY, { enterpriseId: 'nope', roles: ['owner'], agent: 'director', action: 'x' }).allowed,
    false,
  );
});

test('grantsForAgent merges role + per-user overrides', () => {
  const policy = {
    enterprises: {
      acme: {
        roles: { viewer: { agents: { '*': { allow: ['read'] } } } },
        users: { 'jo@example.com': { agents: { director: { allow: ['gh.run.rerun'] } } } },
      },
    },
  };
  const g = grantsForAgent(policy, { enterpriseId: 'acme', roles: ['viewer'], userEmail: 'jo@example.com', agent: 'director' });
  assert.ok(g.allow.has('read'));        // from role
  assert.ok(g.allow.has('gh.run.rerun')); // from per-user override
});

test('checkAuthority: roles resolved from the policy user binding', () => {
  const r = checkAuthority({ enterpriseId: 'acme', email: 'jo@example.com' }, 'director', 'gh.run.rerun', { policy: POLICY });
  assert.equal(r.allowed, true);
  // sam is owner → anything
  assert.equal(checkAuthority({ enterpriseId: 'acme', email: 'sam@example.com' }, 'tester', 'x', { policy: POLICY }).allowed, true);
});

test('checkAuthority: falls back to the actor roles when no policy binding', () => {
  const r = checkAuthority({ enterpriseId: 'acme', email: 'stranger@example.com', roles: ['viewer'] }, 'director', 'read', { policy: POLICY });
  assert.equal(r.allowed, true);
  assert.equal(checkAuthority({ enterpriseId: 'acme', email: 'stranger@example.com', roles: ['viewer'] }, 'director', 'gh.run.rerun', { policy: POLICY }).allowed, false);
});

test('loadPolicy: the repo AGENT_POLICY.yaml parses and the owner role works', () => {
  _resetPolicyCache();
  const policy = loadPolicy(); // resolves the repo file
  assert.ok(policy.enterprises && policy.enterprises.agix, 'agix enterprise present');
  // The repo file binds the operator to owner → can do anything.
  const r = checkAuthority({ enterpriseId: 'agix', email: 'owner@example.com' }, 'director', 'gh.run.rerun', { policy });
  assert.equal(r.allowed, true);
});
