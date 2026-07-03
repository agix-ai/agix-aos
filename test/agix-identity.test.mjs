// agix-identity — multi-user identity model + backward-compat unit tests.
// Runner: node --test test/agix-identity.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  _setIdentityForTest, _resetIdentityCache,
  enterpriseId, enterpriseName, declaredRoles, DEFAULT_ROLES,
  loadUsers, primaryUser, resolveUser, rolesForUser, currentActor,
  operatorFirstName, operatorFullName, operatorEmail,
} from '../lib/agix-identity.mjs';

afterEach(() => {
  _resetIdentityCache();
  delete process.env.AGIX_ENTERPRISE_ID;
  delete process.env.AGIX_OPERATOR_EMAIL;
});

test('enterpriseId: env > identity.json > fallback', () => {
  _setIdentityForTest({ enterprise_id: 'acme' });
  assert.equal(enterpriseId(), 'acme');
  process.env.AGIX_ENTERPRISE_ID = 'override';
  assert.equal(enterpriseId(), 'override');
  delete process.env.AGIX_ENTERPRISE_ID;
  _setIdentityForTest({});
  assert.equal(enterpriseId(), 'agix'); // default fallback
  assert.equal(enterpriseName('Agix Inc'), 'Agix Inc');
});

test('declaredRoles: declared set or defaults', () => {
  _setIdentityForTest({ roles: ['admin', 'analyst'] });
  assert.deepEqual(declaredRoles(), ['admin', 'analyst']);
  _setIdentityForTest({});
  assert.deepEqual(declaredRoles(), DEFAULT_ROLES);
});

test('loadUsers: multi-user declared', () => {
  _setIdentityForTest({
    users: [
      { id: 'sam', email: 'Sam@example.com', name: 'Sam Rivera', roles: ['owner'] },
      { email: 'jo@example.com', name: 'Jo Lee', roles: ['operator'] },
    ],
  });
  const users = loadUsers();
  assert.equal(users.length, 2);
  assert.equal(users[0].email, 'sam@example.com'); // normalized lowercase
  assert.equal(users[1].id, 'jo'); // derived from email when absent
  assert.deepEqual(users[1].roles, ['operator']);
  assert.equal(primaryUser().id, 'sam'); // first owner
});

test('loadUsers: synthesizes a single owner from legacy operator fields', () => {
  _setIdentityForTest({ operator_full_name: 'Pat Doe', operator_email: 'pat@example.com' });
  const users = loadUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'pat@example.com');
  assert.deepEqual(users[0].roles, ['owner']);
  assert.equal(primaryUser().name, 'Pat Doe');
});

test('resolveUser + rolesForUser by email', () => {
  _setIdentityForTest({
    users: [
      { id: 'sam', email: 'sam@example.com', name: 'Sam', roles: ['owner'] },
      { id: 'jo', email: 'jo@example.com', name: 'Jo', roles: ['operator', 'reviewer'] },
    ],
  });
  assert.equal(resolveUser({ email: 'JO@example.com' }).id, 'jo');
  assert.deepEqual(rolesForUser('jo@example.com'), ['operator', 'reviewer']);
  assert.deepEqual(rolesForUser('nobody@example.com'), []); // unknown → deny-friendly
});

test('currentActor: resolves the operator into an Actor', () => {
  _setIdentityForTest({
    enterprise_id: 'acme',
    users: [{ id: 'sam', email: 'sam@example.com', name: 'Sam', roles: ['owner'] }],
  });
  process.env.AGIX_OPERATOR_EMAIL = 'sam@example.com';
  const a = currentActor();
  assert.equal(a.kind, 'human');
  assert.equal(a.enterpriseId, 'acme');
  assert.equal(a.userId, 'sam');
  assert.equal(a.actorId, 'ent:acme/user:sam');
  assert.deepEqual(a.roles, ['owner']);
});

test('backward-compat: operator* unchanged when legacy fields present', () => {
  _setIdentityForTest({ operator_first_name: 'Sam', operator_full_name: 'Sam Rivera', operator_email: 'sam@example.com' });
  assert.equal(operatorFirstName(), 'Sam');
  assert.equal(operatorFullName(), 'Sam Rivera');
  assert.equal(operatorEmail(), 'sam@example.com');
});

test('backward-compat: operator* derives from primary user when legacy absent', () => {
  _setIdentityForTest({ users: [{ id: 'jo', email: 'jo@example.com', name: 'Jo Lee', roles: ['owner'] }] });
  assert.equal(operatorFirstName(), 'Jo');
  assert.equal(operatorFullName(), 'Jo Lee');
  assert.equal(operatorEmail(), 'jo@example.com');
});

test('backward-compat: generic fallbacks when not onboarded', () => {
  _setIdentityForTest({});
  assert.equal(operatorFirstName(), 'there');
  assert.equal(operatorFullName(), 'Operator');
  assert.equal(operatorEmail(), 'operator@example.com');
});
