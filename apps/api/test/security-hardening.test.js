import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { InMemoryRepository, FsBlobStorage } from '../../../packages/data/src/index.js';
import { createAdminRouter } from '../src/admin-router.js';
import { createAuthService } from '../src/auth.js';
import { createDataRouter } from '../src/data-router.js';
import { createGatewayServer, readPanelUsersFromEnv, startGateway } from '../src/gateway.js';
import { createLocalRouter } from '../src/local-router.js';
import { PANEL_MUTATION_ROUTES } from '../src/route-table.js';

const TRUSTED_ORIGIN = 'http://gateway.test';
const FAKE_ORIGIN = 'http://evil.test';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function bodyFor(route) {
  switch (route.id) {
    case 'local-decision':
      return { cluster_id: 'cluster-1', action: 'approve' };
    case 'local-search-refresh':
      return { window: '24h' };
    case 'local-save-draft':
      return { draft_id: 'draft-script-1', id_noticia: 'news-1', guion_editado: 'texto' };
    case 'local-publish':
      return { id_noticia: 'news-1', draft_id: 'draft-script-1' };
    case 'local-publish-status':
      return { job_id: 'publish-job-1' };
    case 'local-download-document':
      return { id_noticia: 'news-1' };
    case 'local-manual-create':
      return { id_noticia: 'news-1' };
    case 'admin-create-user':
      return { email: 'created@example.local', password: 'created-secret', roles: ['viewer'] };
    case 'admin-update-user':
      return { display_name: 'Renamed User' };
    case 'admin-test-connector':
      return {};
    case 'data-editor-state':
      return { editorState: { timeline: [] } };
    case 'data-selections':
      return { selectedImageIds: ['candidate-1'] };
    case 'data-audio':
      return { voiceAudio: {}, backgroundAudio: {} };
    case 'data-custom-images':
      return { customCandidates: [] };
    case 'data-disable':
      return {};
    default:
      return {};
  }
}

function jsonHeaders({ cookie, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  return headers;
}

describe('security hardening (S12)', () => {
  let server;
  let base;
  let root;
  let repository;
  let authService;
  let cookies;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'newsroom-t12-'));
    repository = new InMemoryRepository();
    await repository.migrate();
    await repository.upsertVideoProject({
      draft_id: 'draft-1',
      id_noticia: 'news-1',
      tema_principal: 'Demo topic',
      segments: [],
      status: 'ready',
    });
    await repository.saveScriptDraft({
      draftId: 'draft-script-1',
      idNoticia: 'news-1',
      guionEditado: 'texto',
    });

    authService = createAuthService({ repository, rounds: 4 });
    const users = {};
    for (const [role, email] of Object.entries({
      admin: 'admin@example.local',
      editor: 'editor@example.local',
      viewer: 'viewer@example.local',
    })) {
      users[role] = await authService.createUser({
        email,
        display_name: role,
        password: `${role}-secret`,
        roles: [role],
      });
    }

    const useCases = {
      decideApproval: { execute: async () => ({ ok: true, enqueued: false }) },
      draftScript: { execute: async () => ({ ok: true }) },
      refreshSearch: { start: async () => ({ run_id: 'run-1' }), processRun: async () => ({}) },
      publishScript: { start: async () => ({ job_id: 'publish-job-1' }), process: async () => ({}) },
      manualCreateVideoProject: { start: async () => ({ job_id: 'manual-job-1' }), process: async () => ({}) },
      exportDocument: {
        execute: async () => ({
          filename: 'guion.docx',
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: Buffer.from('doc'),
        }),
      },
    };

    server = createGatewayServer({
      allowedOrigins: [TRUSTED_ORIGIN],
      trustedMutationOrigins: [TRUSTED_ORIGIN],
      authService,
      repository,
      dataRouter: createDataRouter({
        repository,
        blobStorage: new FsBlobStorage({ root }),
      }),
      localRouter: createLocalRouter({ repository, useCases }),
      adminRouter: createAdminRouter({
        authService,
        connectors: { list: () => [], test: async (id) => ({ id, ok: true, status: 'local', message: 'ok' }) },
      }),
      eventRecorder: {
        record: async () => {},
        query: async () => ({ events: [], next_cursor: null, retention: { max_events: 10, max_age_days: 1 } }),
      },
      logger: { error() {}, warn() {}, info() {} },
    });
    base = `http://127.0.0.1:${await listen(server)}`;

    cookies = {};
    for (const role of ['admin', 'editor', 'viewer']) {
      const response = await fetch(`${base}/panel/login`, {
        method: 'POST',
        headers: jsonHeaders({ origin: TRUSTED_ORIGIN }),
        body: JSON.stringify({ user: `${role}@example.local`, pass: `${role}-secret` }),
      });
      assert.equal(response.status, 200, `${role} login`);
      cookies[role] = response.headers.get('set-cookie').split(';')[0];
    }
    cookies.editorId = users.editor.user_id;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (root) await rm(root, { recursive: true, force: true });
  });

  function routeRequest(route, { cookie, origin } = {}) {
    const headers = jsonHeaders({ cookie, origin });
    let body = JSON.stringify(bodyFor(route));
    if (route.id === 'data-upload') {
      headers['content-type'] = 'audio/mp4';
      body = Buffer.from('voice');
    }
    const pathname = route.id === 'admin-update-user'
      ? `/panel/admin/users/${encodeURIComponent(cookies.editorId)}`
      : route.examplePath;
    return fetch(`${base}${pathname}`, {
      method: route.methods[0],
      headers,
      body,
    });
  }

  it('enumerates every registered panel mutation exactly once', () => {
    const ids = PANEL_MUTATION_ROUTES.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of [
      'local-decision',
      'local-search-refresh',
      'local-save-draft',
      'local-publish',
      'local-publish-status',
      'local-download-document',
      'local-manual-create',
      'admin-create-user',
      'admin-update-user',
      'admin-test-connector',
      'data-editor-state',
      'data-selections',
      'data-audio',
      'data-custom-images',
      'data-disable',
      'data-upload',
    ]) {
      assert.ok(ids.includes(id), `missing mutation route ${id}`);
    }
  });

  it('enforces one role and CSRF policy across every mutating route', async () => {
    for (const route of PANEL_MUTATION_ROUTES) {
      const allowedCookie = route.role === 'admin' ? cookies.admin : cookies.editor;

      const unauthenticated = await routeRequest(route);
      assert.equal(unauthenticated.status, 401, `${route.id} without a session`);

      const viewer = await routeRequest(route, { cookie: cookies.viewer, origin: TRUSTED_ORIGIN });
      assert.equal(viewer.status, 403, `${route.id} as viewer`);

      const badOrigin = await routeRequest(route, { cookie: allowedCookie, origin: FAKE_ORIGIN });
      assert.equal(badOrigin.status, 403, `${route.id} from an untrusted origin`);

      const allowed = await routeRequest(route, { cookie: allowedCookie, origin: TRUSTED_ORIGIN });
      assert.ok(allowed.status < 400, `${route.id} as ${route.role} returned ${allowed.status}`);
    }
  });

  it('registers PUT editor-state as an editor-only mutation instead of a read', () => {
    const editorState = PANEL_MUTATION_ROUTES.find((route) => route.id === 'data-editor-state');
    assert.ok(editorState);
    assert.ok(editorState.methods.includes('PUT'));
    assert.equal(editorState.role, 'editor');
  });

  it('reserves audit events and presence read models for admins', async () => {
    for (const pathname of ['/panel/read-models/gateway/events', '/panel/read-models/gateway/presence']) {
      const anonymous = await fetch(`${base}${pathname}`);
      assert.equal(anonymous.status, 401, `${pathname} anonymous`);

      for (const role of ['editor', 'viewer']) {
        const response = await fetch(`${base}${pathname}`, { headers: { cookie: cookies[role] } });
        assert.equal(response.status, 403, `${pathname} as ${role}`);
      }

      const admin = await fetch(`${base}${pathname}`, { headers: { cookie: cookies.admin } });
      assert.equal(admin.status, 200, `${pathname} as admin`);
    }
  });
});

describe('login throttling behind the bundled proxy (S12)', () => {
  let server;
  let base;

  before(async () => {
    server = createGatewayServer({
      panelAuth: { user: 'admin', pass: 'admin-secret' },
      allowedOrigins: [TRUSTED_ORIGIN],
      trustedMutationOrigins: [TRUSTED_ORIGIN],
      trustedProxyCidrs: ['127.0.0.1/32'],
      logger: { error() {}, warn() {}, info() {} },
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function badLogin({ user = 'admin', forwardedFor } = {}) {
    const headers = jsonHeaders({ origin: TRUSTED_ORIGIN });
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
    return fetch(`${base}/panel/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user, pass: 'wrong' }),
    });
  }

  it('keys the lockout on username and forwarded client IP', async () => {
    assert.equal((await badLogin({ forwardedFor: '203.0.113.10' })).status, 401);
    assert.equal((await badLogin({ forwardedFor: '203.0.113.10' })).status, 429);

    assert.equal(
      (await badLogin({ forwardedFor: '203.0.113.11' })).status,
      401,
      'a different client must have its own bucket',
    );
    assert.equal(
      (await badLogin({ user: 'other', forwardedFor: '203.0.113.10' })).status,
      401,
      'a different username must have its own bucket',
    );
  });
});

describe('login throttling without a trusted proxy (S12)', () => {
  let server;
  let base;

  before(async () => {
    server = createGatewayServer({
      panelAuth: { user: 'admin', pass: 'admin-secret' },
      allowedOrigins: [TRUSTED_ORIGIN],
      trustedMutationOrigins: [TRUSTED_ORIGIN],
      trustedProxyCidrs: ['10.0.0.0/8'],
      logger: { error() {}, warn() {}, info() {} },
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted peer', async () => {
    const login = (forwardedFor) => fetch(`${base}/panel/login`, {
      method: 'POST',
      headers: { ...jsonHeaders({ origin: TRUSTED_ORIGIN }), 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ user: 'admin', pass: 'wrong' }),
    });

    assert.equal((await login('203.0.113.20')).status, 401);
    assert.equal((await login('203.0.113.21')).status, 429);
  });
});

describe('legacy env credentials (S12)', () => {
  it('are never read as panel users', () => {
    assert.deepEqual(readPanelUsersFromEnv({
      API_GATEWAY_PANEL_USER: 'legacy',
      API_GATEWAY_PANEL_PASS: 'legacy-secret',
    }), []);
  });

  it('cannot authenticate a disabled database user through startGateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newsroom-t12-env-'));
    const saved = { ...process.env };
    let server;
    try {
      Object.assign(process.env, {
        API_GATEWAY_PANEL_USER: 'disabled@example.local',
        API_GATEWAY_PANEL_PASS: 'allowed-secret',
        API_GATEWAY_ALLOWED_ORIGINS: TRUSTED_ORIGIN,
        API_GATEWAY_TRUSTED_MUTATION_ORIGINS: TRUSTED_ORIGIN,
        API_GATEWAY_EVENTS_FILE: join(root, 'events.jsonl'),
      });
      const repository = new InMemoryRepository();
      await repository.migrate();
      const authService = createAuthService({ repository, rounds: 4 });
      const user = await authService.createUser({
        email: 'disabled@example.local',
        display_name: 'Disabled User',
        password: 'allowed-secret',
        roles: ['editor'],
      });
      await authService.updateUser(user.user_id, { status: 'disabled' });

      server = startGateway({ host: '127.0.0.1', port: 0, repository, adapters: {}, dataRouter: null });
      await once(server, 'listening');
      const response = await fetch(`http://127.0.0.1:${server.address().port}/panel/login`, {
        method: 'POST',
        headers: jsonHeaders({ origin: TRUSTED_ORIGIN }),
        body: JSON.stringify({ user: 'disabled@example.local', pass: 'allowed-secret' }),
      });
      assert.equal(response.status, 401);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      await rm(root, { recursive: true, force: true });
    }
  });
});
