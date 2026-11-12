import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryRepository } from '@newsroom/data';
import { createAuthService, hashPassword, hashSessionToken, verifyPassword } from '../src/auth.js';

async function createHarness() {
  const repository = new InMemoryRepository();
  await repository.migrate();
  const auth = createAuthService({ repository, rounds: 4, now: () => Date.parse('2026-11-10T12:00:00.000Z') });
  return { repository, auth };
}

describe('local auth service', () => {
  let repository;
  let auth;

  beforeEach(async () => {
    ({ repository, auth } = await createHarness());
  });

  it('hashes and verifies bcrypt passwords', async () => {
    const hash = await hashPassword('correct horse battery', { rounds: 4 });
    assert.match(hash, /^\$2[aby]\$/);
    assert.equal(verifyPassword('correct horse battery', hash), true);
    assert.equal(verifyPassword('wrong', hash), false);
    assert.throws(() => hashPassword('short', { rounds: 4 }), /at least 8/);
  });

  it('creates users with roles and authenticates them', async () => {
    const user = await auth.createUser({
      email: 'Editor@Example.local',
      display_name: 'Demo Editor',
      password: 'editor-secret',
      roles: ['editor', 'viewer'],
    });
    assert.equal(user.email, 'editor@example.local');
    assert.deepEqual(user.roles.sort(), ['editor', 'viewer']);
    assert.equal('password_hash' in user, false);

    const authenticated = await auth.authenticate({ user: 'EDITOR@example.local', password: 'editor-secret' });
    assert.equal(authenticated.user.user_id, user.user_id);
    assert.deepEqual(authenticated.roles, ['editor', 'viewer']);

    await assert.rejects(
      () => auth.authenticate({ user: 'editor@example.local', password: 'wrong' }),
      /Invalid credentials/,
    );
    await assert.rejects(() => auth.createUser({ email: 'bad', password: 'password-1' }), /valid email/);
    await assert.rejects(
      () => auth.createUser({ email: 'x@example.local', password: 'password-1', roles: ['owner'] }),
      /unknown role/,
    );
  });

  it('creates repository-backed sessions and only stores the token hash', async () => {
    const user = await auth.createUser({
      email: 'admin@example.local',
      display_name: 'Demo Admin',
      password: 'admin-secret',
      roles: ['admin'],
    });
    const session = await auth.createSession({
      user,
      roles: ['admin'],
      ipAddress: '127.0.0.1',
      userAgent: 'node-test',
    });
    assert.ok(session.session_id);
    assert.equal(session.user.email, 'admin@example.local');

    const rawToken = 'raw-session-token';
    const stored = await repository.createSession({
      userId: user.user_id,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.ok(stored.session_id);
    assert.equal(await repository.getSessionByTokenHash(rawToken), null);

    const verified = await auth.getSession(rawToken);
    assert.equal(verified.user.user_id, user.user_id);
    assert.deepEqual(verified.roles, ['admin']);
    assert.ok(verified.last_seen_at);

    await auth.revokeSession(rawToken);
    assert.equal(await auth.getSession(rawToken), null);
  });

  it('rejects disabled users and supports admin updates', async () => {
    const user = await auth.createUser({
      email: 'viewer@example.local',
      display_name: 'Demo Viewer',
      password: 'viewer-secret',
      roles: ['viewer'],
    });
    await auth.updateUser(user.user_id, { status: 'disabled', roles: ['editor'], display_name: 'New Name' });
    const rows = await auth.listUsers();
    assert.equal(rows[0].display_name, 'New Name');
    assert.equal(rows[0].status, 'disabled');
    assert.deepEqual(rows[0].roles, ['editor']);
    await assert.rejects(
      () => auth.authenticate({ user: 'viewer@example.local', password: 'viewer-secret' }),
      /Invalid credentials/,
    );
    await assert.rejects(() => auth.updateUser('missing', { status: 'active' }), /not found/);
  });
});
