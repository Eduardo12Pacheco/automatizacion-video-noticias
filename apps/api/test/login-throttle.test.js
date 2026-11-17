import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createGatewayServer } from '../src/gateway.js';

const TRUSTED_ORIGIN = 'http://127.0.0.1:8080';
const servers = [];

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const rejectAllCredentials = { authenticate: async () => { throw new Error('invalid credentials'); } };

async function createGateway(options = {}) {
  const server = createGatewayServer({
    allowedOrigins: [TRUSTED_ORIGIN],
    trustedMutationOrigins: [TRUSTED_ORIGIN],
    authService: rejectAllCredentials,
    logger: { error() {}, warn() {}, info() {} },
    ...options,
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

function login(baseUrl, { user = 'victim', pass = 'wrong-password', forwardedFor } = {}) {
  const headers = { origin: TRUSTED_ORIGIN, 'content-type': 'application/json' };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user, pass }),
  });
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('login throttle eviction safety', () => {
  it('keeps an active lock when random usernames flood the bounded store', async () => {
    const now = () => Date.parse('2026-11-17T12:00:00.000Z');
    const baseUrl = await createGateway({
      // No auth service: every credential is invalid, which is all this test needs.
      maxLoginAttempts: 64,
      loginAttemptTtlMs: 15 * 60 * 1000,
      // Keep the per-IP bucket out of the way so the per-user lock is what is measured.
      loginIpFailureLimit: 1_000_000,
      now,
    });

    assert.equal((await login(baseUrl)).status, 401);
    assert.equal((await login(baseUrl)).status, 429, 'the victim starts locked');

    for (let index = 0; index < 1_000; index += 1) {
      const response = await login(baseUrl, { user: `flood-${index}@example.local` });
      assert.ok([401, 429].includes(response.status), `flood attempt ${index}: ${response.status}`);
    }

    const victim = await login(baseUrl);
    assert.equal(victim.status, 429, 'the victim lock must survive the flood');
    assert.equal((await victim.json()).code, 'too_many_attempts');
  });

  it('rejects new attempts once the store is full of live locks', async () => {
    const baseUrl = await createGateway({
      maxLoginAttempts: 2,
      loginAttemptTtlMs: 15 * 60 * 1000,
      loginIpFailureLimit: 1_000_000,
    });

    assert.equal((await login(baseUrl, { user: 'first@example.local' })).status, 401);
    assert.equal((await login(baseUrl, { user: 'second@example.local' })).status, 401);
    assert.equal((await login(baseUrl, { user: 'third@example.local' })).status, 429);
  });

  it('adds a per-IP failed-login bucket on top of the per-user lock', async () => {
    const baseUrl = await createGateway({
      maxLoginAttempts: 1_000,
      loginAttemptTtlMs: 15 * 60 * 1000,
      loginIpFailureLimit: 3,
      loginIpLockMs: 60_000,
    });

    for (const user of ['one@example.local', 'two@example.local', 'three@example.local']) {
      assert.equal((await login(baseUrl, { user })).status, 401);
    }
    const blocked = await login(baseUrl, { user: 'a-brand-new-user@example.local' });
    assert.equal(blocked.status, 429, 'the IP bucket blocks new usernames too');
    assert.equal((await blocked.json()).code, 'too_many_attempts');
  });
});
