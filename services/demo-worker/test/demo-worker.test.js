import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createDemoWorkerServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  server = createDemoWorkerServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() };
}

describe('demo worker', () => {
  it('serves a health endpoint for every proxied worker surface', async () => {
    for (const path of ['/health', '/api/tts/healthz', '/api/subtitles/health']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
    }
  });

  it('creates a completed TTS job and serves a WAV download', async () => {
    const created = await json('/api/tts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Ecuador ajusta su mediocampo para el próximo partido.', voice_profile: 'balanced_default' }),
    });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.job_id.startsWith('tts-demo-'), true);

    const status = await json(`/api/tts/jobs/${created.body.job_id}`);
    assert.equal(status.body.status, 'done');

    const wav = await fetch(`${baseUrl}/api/tts/jobs/${created.body.job_id}/download`);
    assert.equal(wav.status, 200);
    assert.match(wav.headers.get('content-type'), /audio\/wav/);
    assert.equal(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  });

  it('runs the subtitles session and render flow', async () => {
    const created = await json('/api/subtitles/sessions', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=demo' },
      body: '--demo--',
    });
    assert.equal(created.response.status, 201);
    const sessionId = created.body.session_id;

    const detail = await json(`/api/subtitles/sessions/${sessionId}`);
    assert.equal(detail.body.status, 'editing');
    assert.equal(detail.body.current_snapshot_version, 1);

    const segments = await json(`/api/subtitles/sessions/${sessionId}/segments`);
    assert.equal(segments.body.segments.length >= 1, true);

    const render = await json(`/api/subtitles/sessions/${sessionId}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_version: 1 }),
    });
    assert.equal(render.response.status, 202);

    const status = await json(`/api/subtitles/sessions/${sessionId}/render`);
    assert.equal(status.body.job.status, 'succeeded');
    assert.equal(status.body.download.ready, true);

    const video = await fetch(`${baseUrl}/api/subtitles/sessions/${sessionId}/download/file`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type'), /video\/mp4/);
    assert.ok((await video.arrayBuffer()).byteLength > 0);
  });

  it('creates, renders and downloads a demo project', async () => {
    const created = await json('/api/projects/create-from-approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_id: 'draft-demo-news-draft', guion_editado: 'Texto de prueba' }),
    });
    assert.equal(created.response.status, 201);
    const projectId = created.body.data.project_id;

    const render = await json(`/api/projects/${projectId}/render-final`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(render.body.data.status, 'queued');

    const status = await json(`/api/projects/${projectId}/status`);
    assert.equal(status.body.data.status, 'done');

    const video = await fetch(`${baseUrl}/api/projects/${projectId}/download/final`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type'), /video\/mp4/);
  });
});
