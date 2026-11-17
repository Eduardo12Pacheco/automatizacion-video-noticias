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

  it('rejects passwords longer than 72 UTF-8 bytes on create and reset', async () => {
    const user = await auth.createUser({
      email: 'long@example.local',
      display_name: 'Long Password',
      password: 'a'.repeat(72),
      roles: ['editor'],
    });
    await assert.rejects(
      () => auth.createUser({ email: 'toolong@example.local', password: 'a'.repeat(73), roles: ['editor'] }),
      /at most 72 bytes/,
    );
    await assert.rejects(
      () => auth.createUser({ email: 'bytes@example.local', password: 'ñ'.repeat(37), roles: ['editor'] }),
      /at most 72 bytes/,
    );
    await assert.rejects(
      () => auth.updateUser(user.user_id, { password: 'a'.repeat(73) }),
      /at most 72 bytes/,
    );
    const reset = await auth.updateUser(user.user_id, { password: 'a'.repeat(72) });
    assert.equal(reset.user_id, user.user_id);
  });

  it('revokes every session of a user when the password is reset', async () => {
    const user = await auth.createUser({
      email: 'reset@example.local',
      display_name: 'Reset User',
      password: 'first-secret',
      roles: ['editor'],
    });
    const other = await auth.createUser({
      email: 'other@example.local',
      display_name: 'Other User',
      password: 'other-secret',
      roles: ['editor'],
    });
    const expiresAt = '2099-01-01T00:00:00.000Z';
    for (const token of ['first-token', 'second-token']) {
      await repository.createSession({ userId: user.user_id, tokenHash: hashSessionToken(token), expiresAt });
    }
    await repository.createSession({ userId: other.user_id, tokenHash: hashSessionToken('other-token'), expiresAt });

    await auth.updateUser(user.user_id, { password: 'second-secret' });

    assert.equal(await auth.getSession('first-token'), null);
    assert.equal(await auth.getSession('second-token'), null);
    assert.ok(await auth.getSession('other-token'));
  });

  it('runs a dummy bcrypt comparison for unknown and disabled users', async () => {
    const comparisons = [];
    const service = createAuthService({
      repository,
      rounds: 4,
      verify: (password, hash) => {
        comparisons.push(hash);
        return false;
      },
    });
    await assert.rejects(() => service.authenticate({ user: 'missing@example.local', password: 'whatever' }), /Invalid credentials/);
    await assert.rejects(() => service.authenticate({ user: '', password: 'whatever' }), /Invalid credentials/);
    assert.equal(comparisons.length, 2);
    for (const hash of comparisons) assert.match(hash, /^\$2[aby]\$/);

    const user = await auth.createUser({
      email: 'disabled@example.local',
      display_name: 'Disabled',
      password: 'disabled-secret',
      roles: ['editor'],
    });
    await auth.updateUser(user.user_id, { status: 'disabled' });
    comparisons.length = 0;
    await assert.rejects(() => service.authenticate({ user: 'disabled@example.local', password: 'disabled-secret' }), /Invalid credentials/);
    assert.equal(comparisons.length, 1);
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
