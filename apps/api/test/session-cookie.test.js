import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createGatewayServer } from '../src/gateway.js';
import { requestUsesHttps } from '../src/gateway-auth.js';
import { serializePanelSessionCookie } from '../src/sessions.js';

const ORIGIN = 'http://127.0.0.1:8080';
const servers = [];

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const authService = {
  authenticate: async ({ user, password }) => {
    if (user !== 'admin@example.local' || password !== 'admin-secret') throw new Error('invalid credentials');
    return { user: { user_id: 'u1', email: 'admin@example.local', display_name: 'Admin' }, roles: ['admin'] };
  },
};

async function createGateway(options = {}) {
  const server = createGatewayServer({
    allowedOrigins: [ORIGIN],
    trustedMutationOrigins: [ORIGIN],
    authService,
    logger: { error() {}, warn() {}, info() {} },
    ...options,
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

function login(baseUrl, headers = {}) {
  return fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ user: 'admin@example.local', pass: 'admin-secret' }),
  });
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('session cookie security', () => {
  it('marks the cookie Secure only when HTTPS is proven', () => {
    assert.doesNotMatch(serializePanelSessionCookie('t', { maxAgeSeconds: 60 }), /; Secure/);
    assert.match(serializePanelSessionCookie('t', { maxAgeSeconds: 60, secure: true }), /; Secure/);
    assert.match(serializePanelSessionCookie('t', { maxAgeSeconds: 60, crossSite: true }), /SameSite=None; Secure/);
  });

  it('trusts X-Forwarded-Proto only from the panel proxy', () => {
    const direct = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } };
    assert.equal(requestUsesHttps(direct, { trustedProxyCidrs: [] }), false);
    assert.equal(requestUsesHttps(direct, { trustedProxyCidrs: ['127.0.0.1/32'] }), true);
    assert.equal(
      requestUsesHttps({ socket: { remoteAddress: '198.51.100.7' }, headers: { 'x-forwarded-proto': 'https' } },
        { trustedProxyCidrs: ['127.0.0.1/32'] }),
      false,
    );
  });

  it('sets Secure on the login cookie when the trusted proxy reports HTTPS', async () => {
    const baseUrl = await createGateway({ trustedProxyCidrs: ['127.0.0.1/32'] });

    const plain = await login(baseUrl);
    assert.equal(plain.status, 200);
    assert.doesNotMatch(plain.headers.get('set-cookie'), /; Secure/);

    const secure = await login(baseUrl, { 'x-forwarded-proto': 'https' });
    assert.equal(secure.status, 200);
    assert.match(secure.headers.get('set-cookie'), /; Secure/);
  });
});
