import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createGatewayServer } from '../src/gateway.js';

const ORIGIN = 'http://127.0.0.1:8080';
let server;
let base;
let calls;

function session(roles) {
  return {
    user: { user_id: `user-${roles[0]}`, email: `${roles[0]}@example.local`, display_name: roles[0] },
    roles,
    session_id: `session-${roles[0]}`,
    expires_at: Date.now() + 60_000,
  };
}

before(async () => {
  calls = [];
  const dataRouter = {
    matches: (pathname) => pathname.startsWith('/panel/video-projects/'),
    handle: async ({ pathname }) => {
      calls.push(`data:${pathname}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
    },
  };
  const localRouter = {
    matches: (pathname) => pathname.startsWith('/webhook/'),
    handle: async ({ pathname }) => {
      calls.push(`local:${pathname}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
    },
  };
  server = createGatewayServer({
    allowedOrigins: [ORIGIN],
    trustedMutationOrigins: [ORIGIN],
    dataRouter,
    localRouter,
    panelSessions: {
      'editor-token': session(['editor']),
      'viewer-token': session(['viewer']),
    },
    logger: { error() {}, warn() {}, info() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function cookie(role) {
  return `approval-panel-session-v1=${role}-token`;
}

function mutate(pathname, role) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(role ? { cookie: cookie(role) } : {}),
    },
    body: '{}',
  });
}

describe('role/CSRF gate fails closed for uncovered mutations', () => {
  for (const [label, pathname] of [
    ['data', '/panel/video-projects/draft-1/uncovered-action'],
    ['local', '/webhook/uncovered/v9'],
  ]) {
    it(`rejects an unknown ${label} mutation for anonymous, viewer and editor`, async () => {
      assert.equal((await mutate(pathname)).status, 401, 'anonymous');
      assert.equal((await mutate(pathname, 'viewer')).status, 403, 'viewer');
      const editor = await mutate(pathname, 'editor');
      assert.equal(editor.status, 403, 'editor');
      assert.equal((await editor.json()).code, 'mutation_not_covered');
      assert.equal(calls.some((entry) => entry.includes('uncovered')), false, 'router must not run');
    });
  }

  it('still lets the router answer reads', async () => {
    const response = await fetch(`${base}/webhook/known/v9`, { headers: { cookie: cookie('editor') } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), 'local:/webhook/known/v9');
  });
});
