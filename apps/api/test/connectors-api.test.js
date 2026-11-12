import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { InMemoryRepository, FsBlobStorage } from '../../../packages/data/src/index.js';
import { createAdminRouter } from '../src/admin-router.js';
import { createAuthService } from '../src/auth.js';
import { createConnectorRegistry } from '../../../packages/adapters/src/connectors.js';
import { createGatewayServer } from '../src/gateway.js';
import { createJobsRouter } from '../src/jobs-router.js';

const TRUSTED_ORIGIN = 'http://gateway.test';
const FAKE_ORIGIN = 'http://evil.test';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('connectors API', () => {
  let server;
  let base;
  let root;
  let cookies;
  let refreshStarts;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'newsroom-connectors-'));
    const repository = new InMemoryRepository();
    await repository.migrate();
    const authService = createAuthService({ repository, rounds: 4 });
    for (const [role, email] of Object.entries({ admin: 'admin@example.local', editor: 'editor@example.local' })) {
      await authService.createUser({ email, display_name: role, password: `${role}-secret`, roles: [role] });
    }
    const connectors = createConnectorRegistry({
      env: {},
      adapters: {
        llm: {
          constructor: { name: 'OllamaLLMAdapter' },
          baseUrl: 'http://ollama.local:11434',
          model: 'qwen2.5:3b-instruct',
        },
        notification: {
          constructor: { name: 'SmtpNotificationAdapter' },
          host: 'mailpit',
          port: 1025,
          async verify() { return { ok: true, message: 'SMTP greeting OK' }; },
        },
        workflow: {
          constructor: { name: 'N8nWorkflowTrigger' },
          baseUrl: 'https://user:secret@n8n.example.local/path?token=abc#frag',
        },
      },
      blobStorage: new FsBlobStorage({ root }),
      fetchImpl: async (url) => {
        throw new Error(`cannot reach ${url}`);
      },
    });
    refreshStarts = [];
    const jobsRouter = createJobsRouter({
      apiKey: 'machine-secret',
      jobQueue: { enqueue() {} },
      useCases: {
        refreshSearch: {
          async start(input) {
            refreshStarts.push(input);
            return { run_id: 'run-1' };
          },
        },
      },
    });
    server = createGatewayServer({
      allowedOrigins: [TRUSTED_ORIGIN],
      trustedMutationOrigins: [TRUSTED_ORIGIN],
      authService,
      repository,
      adminRouter: createAdminRouter({ authService, connectors }),
      jobsRouter,
      eventRecorder: { record: async () => {}, query: async () => ({ events: [] }) },
      logger: { error() {}, warn() {}, info() {} },
    });
    base = `http://127.0.0.1:${await listen(server)}`;
    cookies = {};
    for (const role of ['admin', 'editor']) {
      const response = await fetch(`${base}/panel/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        body: JSON.stringify({ user: `${role}@example.local`, pass: `${role}-secret` }),
      });
      assert.equal(response.status, 200);
      cookies[role] = response.headers.get('set-cookie').split(';')[0];
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lists every connector for admins without exposing credentials', async () => {
    const response = await fetch(`${base}/panel/connectors`, { headers: { cookie: cookies.admin } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.connectors.length >= 10);
    assert.equal(payload.connectors.find((entry) => entry.id === 'llm').status, 'local');
    assert.equal(JSON.stringify(payload).includes('mailpit:1025'), true);
    assert.equal(JSON.stringify(payload).includes('password'), false);
  });

  it('never returns URL credentials from the list or a test probe', async () => {
    const list = await fetch(`${base}/panel/connectors`, { headers: { cookie: cookies.admin } });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    for (const secret of ['user', 'secret', 'token', 'abc', 'frag']) {
      assert.equal(listBody.includes(secret), false, `connector list leaked ${secret}`);
    }

    const response = await fetch(`${base}/panel/connectors/workflow/test`, {
      method: 'POST',
      headers: { cookie: cookies.admin, origin: TRUSTED_ORIGIN },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const secret of ['user', 'secret', 'token', 'abc', 'frag']) {
      assert.equal(body.includes(secret), false, `connector probe leaked ${secret}`);
    }
  });

  it('reserves the connectors screen for admins', async () => {
    assert.equal((await fetch(`${base}/panel/connectors`)).status, 401);
    assert.equal((await fetch(`${base}/panel/connectors`, { headers: { cookie: cookies.editor } })).status, 403);
  });

  it('runs one connection test through the admin-only mutation route', async () => {
    const anonymous = await fetch(`${base}/panel/connectors/llm/test`, { method: 'POST', headers: { origin: TRUSTED_ORIGIN } });
    assert.equal(anonymous.status, 401);

    const editor = await fetch(`${base}/panel/connectors/llm/test`, {
      method: 'POST',
      headers: { cookie: cookies.editor, origin: TRUSTED_ORIGIN },
    });
    assert.equal(editor.status, 403);

    const badOrigin = await fetch(`${base}/panel/connectors/llm/test`, {
      method: 'POST',
      headers: { cookie: cookies.admin, origin: FAKE_ORIGIN },
    });
    assert.equal(badOrigin.status, 403);

    const response = await fetch(`${base}/panel/connectors/notification/test`, {
      method: 'POST',
      headers: { cookie: cookies.admin, origin: TRUSTED_ORIGIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.ok, true);
    assert.equal(payload.result.message, 'SMTP greeting OK');
  });

  it('rejects unknown connectors with a JSON 404', async () => {
    const response = await fetch(`${base}/panel/connectors/nope/test`, {
      method: 'POST',
      headers: { cookie: cookies.admin, origin: TRUSTED_ORIGIN },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'connector_not_found');
  });

  it('starts discovery for the n8n cron workflow only with the machine token', async () => {
    const anonymous = await fetch(`${base}/jobs/discover`, { method: 'POST' });
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${base}/jobs/discover`, {
      method: 'POST',
      headers: { authorization: 'Bearer machine-secret' },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.run_id, 'run-1');
    assert.deepEqual(refreshStarts, [{ window: '24h' }]);
  });
});
