import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  DemoASRAdapter,
  DemoAuthAdapter,
  DemoTranslationAdapter,
  DemoTTSAdapter,
  DemoVideoRendererAdapter,
} from '../src/demo.js';
import { HttpAuthAdapter } from '../src/auth-port.js';
import {
  HttpASRAdapter,
  HttpTranslationAdapter,
  HttpTTSAdapter,
  HttpVideoRendererAdapter,
} from '../src/worker-ports.js';
import { createAdaptersFromEnv } from '../src/composition.js';

const WAV_BYTES = Buffer.from('RIFF-demo-wav');
const MP4_BYTES = Buffer.from('demo-mp4-bytes');

function startFixtureServer() {
  const requests = [];
  let authRevoked = false;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://fixture.local');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: url.pathname, body, headers: request.headers });

    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const binary = (contentType, bytes) => {
      response.writeHead(200, { 'content-type': contentType });
      response.end(bytes);
    };

    if (url.pathname === '/api/tts/jobs' && request.method === 'POST') {
      return json(202, { job_id: 'job-1', status: 'queued' });
    }
    if (url.pathname === '/api/tts/jobs/job-1' && request.method === 'GET') {
      return json(200, { job_id: 'job-1', status: 'done', download_url: '/api/tts/jobs/job-1/download' });
    }
    if (url.pathname === '/api/tts/jobs/job-1/download') {
      return binary('audio/wav', WAV_BYTES);
    }
    if (url.pathname === '/api/radar/transcribe' && request.method === 'POST') {
      return json(200, {
        segments: [{ start_ms: 0, end_ms: 900, text: 'Hola' }],
        language: 'es',
        device: 'cpu',
        fallback_used: true,
      });
    }
    if (url.pathname === '/api/subtitles/translate' && request.method === 'POST') {
      return json(200, {
        segments: [{ id: 0, text: 'Hello', translated_text: 'Hola', start_ms: 0, end_ms: 900 }],
        target_language: 'es',
      });
    }
    if (url.pathname === '/api/projects/create-from-approval' && request.method === 'POST') {
      return json(201, { ok: true, data: { project_id: 'project-1', status: 'queued' } });
    }
    if (url.pathname === '/api/projects/project-1/render-final' && request.method === 'POST') {
      return json(202, { ok: true, data: { project_id: 'project-1', status: 'queued' } });
    }
    if (url.pathname === '/api/projects/project-1/status') {
      return json(200, { ok: true, data: { project_id: 'project-1', status: 'done', output: '/api/projects/project-1/download/final' } });
    }
    if (url.pathname === '/api/projects/project-1/download/final') {
      return binary('video/mp4', MP4_BYTES);
    }
    if (url.pathname === '/api/auth/authenticate' && request.method === 'POST') {
      return json(200, { user: { user_id: 'u1', email: 'demo@example.local' }, roles: ['admin'], source: 'http' });
    }
    if (url.pathname === '/api/auth/sessions' && request.method === 'POST') {
      return json(201, { session_id: 's1', user: { user_id: 'u1' }, roles: ['admin'], token: 'token-1' });
    }
    if (url.pathname === '/api/auth/sessions/token-1' && request.method === 'GET') {
      if (authRevoked) return json(200, { session: null });
      return json(200, { session: { session_id: 's1', user: { user_id: 'u1' }, roles: ['admin'] } });
    }
    if (url.pathname === '/api/auth/sessions/token-1' && request.method === 'DELETE') {
      authRevoked = true;
      response.writeHead(204);
      return response.end();
    }
    return json(404, { error: { message: 'not found' } });
  });
  return { server, requests };
}

describe('worker port contracts', () => {
  let fixture;
  let baseUrl;

  before(async () => {
    fixture = startFixtureServer();
    await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${fixture.server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => fixture.server.close(resolve));
  });

  async function assertTtsContract(adapter) {
    const created = await adapter.createJob({ text: 'Aurenia prepara el partido del domingo.', title: 'Demo', voiceProfile: 'es' });
    assert.equal(typeof created.job_id, 'string');
    assert.equal(created.status.length > 0, true);
    const job = await adapter.getJob(created.job_id);
    assert.equal(job.job_id, created.job_id);
    assert.equal(job.status, 'done');
    const download = await adapter.download(created.job_id);
    assert.equal(download.bytes.length > 0, true);
    assert.equal(typeof download.content_type, 'string');
  }

  async function assertAsrContract(adapter) {
    const result = await adapter.transcribe({ audioPath: '/tmp/demo.wav', language: 'es' });
    assert.equal(Array.isArray(result.segments), true);
    assert.equal(result.segments.length > 0, true);
    assert.equal(typeof result.segments[0].text, 'string');
  }

  async function assertTranslationContract(adapter) {
    const result = await adapter.translate({
      segments: [{ id: 0, text: 'Hello', start_ms: 0, end_ms: 900 }],
      sourceLanguage: 'en',
      targetLanguage: 'es',
    });
    assert.equal(Array.isArray(result.segments), true);
    assert.equal(result.segments.length, 1);
    assert.equal(result.target_language, 'es');
    assert.equal(typeof result.segments[0].translated_text, 'string');
  }

  async function assertRendererContract(adapter) {
    const created = await adapter.createProject({ title: 'Demo project', voice_audio: { public_url: 'https://example.local/voice.wav' } });
    assert.equal(typeof created.project_id, 'string');
    const render = await adapter.renderProject(created.project_id, { snapshotHash: 'hash-1' });
    assert.equal(render.project_id, created.project_id);
    const status = await adapter.getRenderStatus(created.project_id);
    assert.equal(status.status.length > 0, true);
    const download = await adapter.downloadRender(created.project_id);
    assert.equal(download.bytes.length > 0, true);
    assert.equal(download.content_type, 'video/mp4');
  }

  async function assertAuthContract(adapter, credentials) {
    const authenticated = await adapter.authenticate(credentials);
    assert.equal(typeof authenticated.user.email, 'string');
    assert.equal(Array.isArray(authenticated.roles), true);
    const session = await adapter.createSession({ user: authenticated.user, roles: authenticated.roles, ipAddress: '127.0.0.1' });
    assert.equal(typeof session.token, 'string');
    const stored = await adapter.getSession(session.token);
    assert.equal(stored.user.user_id, authenticated.user.user_id);
    await adapter.revokeSession(session.token);
    assert.equal(await adapter.getSession(session.token), null);
  }

  it('TTS HTTP adapter and demo adapter satisfy the same contract', async () => {
    await assertTtsContract(new HttpTTSAdapter({ baseUrl, headers: { 'x-api-key': 'test-key' } }));
    await assertTtsContract(new DemoTTSAdapter());
    const post = fixture.requests.find((entry) => entry.path === '/api/tts/jobs');
    assert.equal(post.headers['x-api-key'], 'test-key');
    assert.equal(post.body.voice_profile, 'es');
  });

  it('ASR HTTP adapter and demo adapter satisfy the same contract', async () => {
    await assertAsrContract(new HttpASRAdapter({ baseUrl }));
    await assertAsrContract(new DemoASRAdapter());
    const post = fixture.requests.find((entry) => entry.path === '/api/radar/transcribe');
    assert.deepEqual(post.body, { audio_path: '/tmp/demo.wav', language: 'es' });
  });

  it('translation HTTP adapter and demo adapter satisfy the same contract', async () => {
    await assertTranslationContract(new HttpTranslationAdapter({ baseUrl }));
    await assertTranslationContract(new DemoTranslationAdapter());
    const post = fixture.requests.find((entry) => entry.path === '/api/subtitles/translate');
    assert.equal(post.body.target_language, 'es');
  });

  it('renderer HTTP adapter and demo adapter satisfy the same contract', async () => {
    await assertRendererContract(new HttpVideoRendererAdapter({ baseUrl }));
    await assertRendererContract(new DemoVideoRendererAdapter());
    const render = fixture.requests.find((entry) => entry.path === '/api/projects/project-1/render-final');
    assert.deepEqual(render.body, { snapshotHash: 'hash-1', async: true });
  });

  it('auth local, HTTP and demo adapters satisfy the same contract', async () => {
    const storage = new Map();
    let sequence = 0;
    const authService = {
      async authenticate({ user, password }) {
        if (user !== 'demo@example.local' || password !== 'demo-password') throw new Error('invalid');
        return { user: { user_id: 'u1', email: user }, roles: ['admin'], source: 'repository' };
      },
      async createSession({ user, roles }) {
        sequence += 1;
        const session = { user, roles, token: `local-${sequence}`, session_id: `s-${sequence}`, expires_at: new Date().toISOString() };
        storage.set(session.token, session);
        return session;
      },
      async getSession(token) {
        return storage.get(token) || null;
      },
      async revokeSession(token) {
        storage.delete(token);
      },
    };
    const { LocalAuthAdapter } = await import('../src/auth-port.js');
    await assertAuthContract(new LocalAuthAdapter({ authService }), { user: 'demo@example.local', password: 'demo-password' });
    await assertAuthContract(new HttpAuthAdapter({ baseUrl }), { user: 'demo@example.local', password: 'demo-password' });
    await assertAuthContract(new DemoAuthAdapter(), { user: 'demo@example.local', password: 'demo-password' });
  });
});

describe('worker adapter composition', () => {
  it('selects demo and worker adapters from env without network calls at construction', () => {
    const demo = createAdaptersFromEnv({ env: { TTS: 'demo', ASR: 'demo', TRANSLATION: 'demo', RENDERER: 'demo' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(demo.tts.constructor.name, 'DemoTTSAdapter');
    assert.equal(demo.asr.constructor.name, 'DemoASRAdapter');
    assert.equal(demo.translation.constructor.name, 'DemoTranslationAdapter');
    assert.equal(demo.videoRenderer.constructor.name, 'DemoVideoRendererAdapter');

    const workers = createAdaptersFromEnv({ env: { TTS: 'worker', ASR: 'worker', TRANSLATION: 'worker', RENDERER: 'worker' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(workers.tts.constructor.name, 'HttpTTSAdapter');
    assert.equal(workers.asr.constructor.name, 'HttpASRAdapter');
    assert.equal(workers.translation.constructor.name, 'HttpTranslationAdapter');
    assert.equal(workers.videoRenderer.constructor.name, 'HttpVideoRendererAdapter');

    const auth = createAdaptersFromEnv({ env: { AUTH: 'demo' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(auth.auth.constructor.name, 'DemoAuthAdapter');

    const none = createAdaptersFromEnv({ env: { TTS: 'none', ASR: 'none', TRANSLATION: 'none', RENDERER: 'none', AUTH: 'none' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(none.tts, undefined);
    assert.equal(none.asr, undefined);
    assert.equal(none.translation, undefined);
    assert.equal(none.videoRenderer, undefined);
  });
});
