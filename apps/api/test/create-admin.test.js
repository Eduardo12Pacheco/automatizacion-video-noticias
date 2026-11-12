import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryRepository } from '@newsroom/data';

import { ensureAdminUser, validateBootstrapInput } from '../src/create-admin.js';
import { verifyPassword } from '../src/auth.js';
import { main, parseArgs } from '../scripts/create-admin.js';

function repositoryWithRoles() {
  const repository = new InMemoryRepository();
  repository.seedRoles?.(['admin', 'editor', 'viewer']);
  return repository;
}

test('ensureAdminUser creates an active admin with a hashed password', async () => {
  const repository = repositoryWithRoles();
  const result = await ensureAdminUser({
    repository,
    email: 'Admin@Example.local',
    displayName: 'Ada Admin',
    password: 'correct horse battery',
  });

  assert.equal(result.created, true);
  assert.equal(result.user.email, 'admin@example.local');
  assert.equal(result.user.display_name, 'Ada Admin');
  assert.deepEqual(result.user.roles, ['admin']);
  assert.equal(result.user.status, 'active');
  assert.equal(result.user.password_hash, undefined);

  const stored = await repository.getUserByEmail('admin@example.local');
  assert.notEqual(stored.password_hash, 'correct horse battery');
  assert.equal(verifyPassword('correct horse battery', stored.password_hash), true);
});

test('ensureAdminUser is idempotent and keeps the existing password', async () => {
  const repository = repositoryWithRoles();
  const first = await ensureAdminUser({
    repository,
    email: 'admin@example.local',
    password: 'first password value',
  });
  const second = await ensureAdminUser({
    repository,
    email: 'admin@example.local',
    password: 'a completely different password',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.existing, true);
  assert.equal(second.password_changed, false);
  assert.equal((await repository.listUsers()).length, 1);

  const stored = await repository.getUserByEmail('admin@example.local');
  assert.equal(verifyPassword('first password value', stored.password_hash), true);
  assert.equal(verifyPassword('a completely different password', stored.password_hash), false);
});

test('ensureAdminUser promotes an existing non-admin account without resetting it', async () => {
  const repository = repositoryWithRoles();
  const auth = await import('../src/auth.js');
  const service = auth.createAuthService({ repository });
  const editor = await service.createUser({
    email: 'editor@example.local',
    password: 'editor password',
    roles: ['editor'],
  });

  const result = await ensureAdminUser({
    repository,
    email: 'editor@example.local',
    password: 'ignored password value',
  });

  assert.equal(result.created, false);
  assert.equal(result.roles_changed, true);
  assert.deepEqual(result.user.roles, ['admin', 'editor']);
  const stored = await repository.getUserByEmail('editor@example.local');
  assert.equal(verifyPassword('editor password', stored.password_hash), true);
});

test('ensureAdminUser can reset a password only when explicitly requested', async () => {
  const repository = repositoryWithRoles();
  await ensureAdminUser({
    repository,
    email: 'admin@example.local',
    password: 'original password',
  });
  const result = await ensureAdminUser({
    repository,
    email: 'admin@example.local',
    password: 'replacement password',
    resetPassword: true,
  });

  assert.equal(result.password_changed, true);
  const stored = await repository.getUserByEmail('admin@example.local');
  assert.equal(verifyPassword('replacement password', stored.password_hash), true);
});

test('validateBootstrapInput rejects missing email and short passwords', () => {
  assert.throws(() => validateBootstrapInput({ email: '', password: 'long enough password' }), /email/i);
  assert.throws(() => validateBootstrapInput({ email: 'not-an-email', password: 'long enough password' }), /email/i);
  assert.throws(() => validateBootstrapInput({ email: 'admin@example.local', password: 'short' }), /8 characters/i);
  assert.doesNotThrow(() => validateBootstrapInput({ email: 'admin@example.local', password: '12345678' }));
});

test('the create-admin CLI parses flags and creates an admin without printing secrets', async () => {
  const repository = repositoryWithRoles();
  const options = parseArgs([
    '--email', 'cli@example.local',
    '--display-name', 'CLI Admin',
    '--password-stdin',
  ]);
  assert.equal(options.email, 'cli@example.local');
  assert.equal(options.passwordStdin, true);

  const previousPassword = process.env.NEWSROOM_ADMIN_PASSWORD;
  process.env.NEWSROOM_ADMIN_PASSWORD = 'cli password value';
  const output = [];
  const stdout = { write: (chunk) => { output.push(String(chunk)); return true; } };
  try {
    const code = await main(
      ['--email', 'cli@example.local', '--display-name', 'CLI Admin'],
      { repositoryFactory: () => repository, stdout },
    );
    assert.equal(code, 0);
  } finally {
    if (previousPassword === undefined) delete process.env.NEWSROOM_ADMIN_PASSWORD;
    else process.env.NEWSROOM_ADMIN_PASSWORD = previousPassword;
  }

  const encoded = JSON.parse(output.join(''));
  assert.equal(encoded.ok, true);
  assert.equal(encoded.created, true);
  assert.equal(encoded.user.email, 'cli@example.local');
  assert.deepEqual(encoded.user.roles, ['admin']);
  assert.equal(output.join('').includes('cli password value'), false);
});

test('the create-admin CLI rejects a missing password', async () => {
  const repository = repositoryWithRoles();
  const previous = process.env.NEWSROOM_ADMIN_PASSWORD;
  delete process.env.NEWSROOM_ADMIN_PASSWORD;
  try {
    await assert.rejects(
      main(['--email', 'cli@example.local'], { repositoryFactory: () => repository }),
      /password is required/,
    );
  } finally {
    if (previous !== undefined) process.env.NEWSROOM_ADMIN_PASSWORD = previous;
  }
});
