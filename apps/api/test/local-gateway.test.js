import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { InMemoryRepository } from '../../../packages/data/src/index.js';
import { createAdminRouter } from '../src/admin-router.js';
import { createAuthService } from '../src/auth.js';
import { createCoreRuntime } from '../src/core-runtime.js';
import { createGatewayServer } from '../src/gateway.js';
import { createLocalRouter } from '../src/local-router.js';

const ORIGIN = 'http://panel.example.test';
const NEWS = [
  {
    id_noticia: 'news-1',
    seleccion: 'Ecuador',
    jugador: 'Moisés Caicedo',
    titular: 'Caicedo anotó con el Chelsea',
    fuente: 'Example Sports',
    fecha_publicacion: '2026-11-10T10:00:00.000Z',
    link: 'https://news.example.local/caicedo-1',
    snippet: 'Gol del mediocampista.',
    estado_revision: 'pendiente',
    tema_principal: 'Gol de Caicedo',
    google_position: 1,
  },
];
const CLUSTER = {
  cluster_id: 'cluster-local-gateway',
  seleccion: 'Ecuador',
  jugador: 'Moisés Caicedo',
  tema_principal: 'Gol de Caicedo',
  resumen_cluster: 'Caicedo anotó.',
  tag_editorial: 'club',
  fecha_creacion_cluster: '2026-11-10T11:00:00.000Z',
  sources: [{ id_noticia: 'news-1', source_order: 0 }],
};

const servers = [];

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body = null } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body != null) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('gateway with local auth and workflow routers', () => {
  let baseUrl;
  let repository;

  before(async () => {
    repository = new InMemoryRepository();
    await repository.migrate();
    const authService = createAuthService({ repository, rounds: 4 });
    await authService.createUser({
      email: 'admin@example.local',
      display_name: 'Demo Admin',
      password: 'admin-secret',
      roles: ['admin'],
    });
    const runtime = createCoreRuntime({ repository, logger: { error() {}, info() {}, warn() {} } });
    const localRouter = createLocalRouter({
      repository,
      readModels: runtime.readModels,
      useCases: runtime.useCases,
      jobQueue: null,
    });
    const adminRouter = createAdminRouter({ authService });
    const server = createGatewayServer({
      allowedOrigins: [ORIGIN],
      trustedMutationOrigins: [ORIGIN],
      authService,
      localRouter,
      adminRouter,
      logger: { error() {}, warn() {}, info() {} },
    });
    const port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  it('logs in against a repository user and exposes admin user management', async () => {
    const login = await request(baseUrl, '/panel/login', {
      method: 'POST',
      body: { user: 'admin@example.local', password: 'admin-secret' },
    });
    assert.equal(login.status, 200);
    const payload = await login.json();
    assert.deepEqual(payload.roles, ['admin']);
    const cookie = cookieFrom(login);

    const session = await request(baseUrl, '/panel/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.email, 'admin@example.local');

    const users = await request(baseUrl, '/panel/admin/users', { cookie });
    assert.equal(users.status, 200);
    assert.equal((await users.json()).users.length, 1);

    const created = await request(baseUrl, '/panel/admin/users', {
      method: 'POST',
      cookie,
      body: {
        email: 'editor@example.local',
        display_name: 'Demo Editor',
        password: 'editor-secret',
        roles: ['editor'],
      },
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).user.email, 'editor@example.local');
  });

  it('lets editors use the local approval workflow and blocks non-admins from admin routes', async () => {
    await repository.upsertNews(structuredClone(NEWS));
    await repository.persistClusters([structuredClone(CLUSTER)]);

    const login = await request(baseUrl, '/panel/login', {
      method: 'POST',
      body: { user: 'editor@example.local', password: 'editor-secret' },
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);

    const adminDenied = await request(baseUrl, '/panel/admin/users', { cookie });
    assert.equal(adminDenied.status, 403);

    const pending = await request(baseUrl, '/panel/read-models/approval/pending', { cookie });
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).total, 1);

    const decision = await request(baseUrl, '/webhook/approval/decision/supabase/v2', {
      method: 'POST',
      cookie,
      body: { id_noticia: 'news-1', cluster_id: CLUSTER.cluster_id, action: 'approve' },
    });
    assert.equal(decision.status, 200);
    assert.equal((await decision.json()).enqueued, true);

    const queue = await request(baseUrl, '/webhook/approval/queue/supabase/v2', { cookie });
    assert.equal((await queue.json()).total, 1);
  });

  it('rejects local mutations with a forged user header instead of the session', async () => {
    const login = await request(baseUrl, '/panel/login', {
      method: 'POST',
      body: { user: 'editor@example.local', password: 'editor-secret' },
    });
    const cookie = cookieFrom(login);
    const response = await fetch(`${baseUrl}/webhook/approval/decision/supabase/v2`, {
      method: 'POST',
      headers: {
        origin: 'http://evil.example.test',
        cookie,
        'content-type': 'application/json',
        'x-user-email': 'admin@example.local',
        'x-user-roles': 'admin',
      },
      body: JSON.stringify({ id_noticia: 'news-1', cluster_id: CLUSTER.cluster_id, action: 'approve' }),
    });
    assert.equal(response.status, 403);
  });
});
