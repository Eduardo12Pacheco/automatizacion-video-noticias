import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryRepository } from '@newsroom/data';
import { createAdminRouter } from '../src/admin-router.js';
import { createAuthService } from '../src/auth.js';

function jsonBody(body) {
  return async () => Buffer.from(JSON.stringify(body));
}

async function createHarness() {
  const repository = new InMemoryRepository();
  await repository.migrate();
  const authService = createAuthService({ repository, rounds: 4 });
  const router = createAdminRouter({ authService });
  return { repository, authService, router };
}

describe('admin router', () => {
  let router;

  beforeEach(async () => {
    ({ router } = await createHarness());
  });

  it('creates, lists, updates and disables users', async () => {
    const created = await router.handle({
      method: 'POST',
      pathname: '/panel/admin/users',
      readBody: jsonBody({
        email: 'editor@example.local',
        display_name: 'Demo Editor',
        password: 'editor-secret',
        roles: ['editor'],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'editor@example.local');
    assert.equal('password_hash' in created.body.user, false);

    const listed = await router.handle({ method: 'GET', pathname: '/panel/admin/users' });
    assert.equal(listed.body.users.length, 1);

    const updated = await router.handle({
      method: 'PATCH',
      pathname: `/panel/admin/users/${created.body.user.user_id}`,
      readBody: jsonBody({ status: 'disabled', roles: ['viewer'], display_name: 'Renamed' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.status, 'disabled');
    assert.deepEqual(updated.body.user.roles, ['viewer']);
    assert.equal(updated.body.user.display_name, 'Renamed');

    const roles = await router.handle({ method: 'GET', pathname: '/panel/admin/roles' });
    assert.deepEqual(roles.body.roles.map((row) => row.role).sort(), ['admin', 'editor', 'viewer']);
  });

  it('maps validation, not-found and method errors', async () => {
    const badPassword = await router.handle({
      method: 'POST',
      pathname: '/panel/admin/users',
      readBody: jsonBody({ email: 'x@example.local', password: 'short', roles: ['viewer'] }),
    });
    assert.equal(badPassword.status, 400);

    const missing = await router.handle({
      method: 'PATCH',
      pathname: '/panel/admin/users/missing',
      readBody: jsonBody({ status: 'active' }),
    });
    assert.equal(missing.status, 404);

    const wrongMethod = await router.handle({ method: 'POST', pathname: '/panel/admin/users/abc' });
    assert.equal(wrongMethod.status, 405);

    const invalidJson = await router.handle({
      method: 'POST',
      pathname: '/panel/admin/users',
      readBody: async () => Buffer.from('{not-json'),
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error, 'invalid_json');
  });
});
