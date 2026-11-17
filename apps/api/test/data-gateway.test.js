import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createGatewayServer } from '../src/gateway.js';
import { createAuthService } from '../src/auth.js';
import { createDataRouter } from '../src/data-router.js';
import { InMemoryRepository, FsBlobStorage } from '@newsroom/data';

const MP4_HEADER = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('gateway data routes', () => {
  let server;
  let base;
  let root;
  let repository;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'newsroom-gateway-data-'));
    repository = new InMemoryRepository();
    const authService = createAuthService({ repository, rounds: 4 });
    await authService.createUser({
      email: 'admin@example.local',
      display_name: 'Admin',
      password: 'admin-secret',
      roles: ['admin'],
    });
    await repository.upsertVideoProject({
      draft_id: 'draft-1',
      id_noticia: 'news-1',
      tema_principal: 'Tema',
      segments: [],
      status: 'ready',
    });
    const dataRouter = createDataRouter({
      repository,
      blobStorage: new FsBlobStorage({ root }),
    });
    server = createGatewayServer({
      authService,
      trustedMutationOrigins: ['http://gateway.test'],
      dataRouter,
      logger: { error() {}, warn() {}, info() {} },
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  async function login() {
    const response = await fetch(`${base}/panel/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://gateway.test' },
      body: JSON.stringify({ user: 'admin@example.local', pass: 'admin-secret' }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie);
    return cookie.split(';')[0];
  }

  it('requires a session for data reads', async () => {
    const response = await fetch(`${base}/panel/read-models/video-projects`);
    assert.equal(response.status, 401);
  });

  it('serves read models, accepts uploads and enforces CSRF', async () => {
    const cookie = await login();

    const read = await fetch(`${base}/panel/read-models/video-projects`, {
      headers: { cookie },
    });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.projects.length, 1);
    assert.equal(readBody.projects[0].draft_id, 'draft-1');

    const csrfRejected = await fetch(`${base}/panel/uploads/video-project-audio/projects/draft-1/voice.m4a`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/mp4' },
      body: MP4_HEADER,
    });
    assert.equal(csrfRejected.status, 403);

    const upload = await fetch(`${base}/panel/uploads/video-project-audio/projects/draft-1/voice.m4a`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://gateway.test',
        'content-type': 'audio/mp4',
      },
      body: MP4_HEADER,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.storage_bucket, 'video-project-audio');
    assert.equal(uploaded.storage_path, 'projects/draft-1/voice.m4a');

    const blob = await fetch(`${base}${uploaded.storage_public_url}`, { headers: { cookie } });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'audio/mp4');
    assert.equal(blob.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), MP4_HEADER);
  });

  it('saves project selections through the gateway', async () => {
    const cookie = await login();
    const response = await fetch(`${base}/panel/video-projects/draft-1/selections`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://gateway.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ selectedImageIds: ['candidate-1'] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.selected_images, ['candidate-1']);
  });
});
