import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { InMemoryRepository, FsBlobStorage } from '@newsroom/data';
import { createDataRouter } from '../src/data-router.js';

function bodyReader(bytes) {
  return async () => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)));
}

const MP4_HEADER = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function upload(router, pathname, contentType, bytes) {
  return router.handle({
    method: 'POST',
    pathname,
    headers: { 'content-type': contentType },
    readBody: bodyReader(bytes),
  });
}

describe('panel data router', () => {
  let root;
  let repository;
  let router;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'newsroom-api-data-'));
    repository = new InMemoryRepository();
    const blobStorage = new FsBlobStorage({ root });
    router = createDataRouter({ repository, blobStorage });
    await repository.upsertVideoProject({
      draft_id: 'draft-1',
      id_noticia: 'news-1',
      jugador: 'Nicolás Arbelo',
      seleccion: 'Aurenia',
      tema_principal: 'Regreso de Arbelo',
      segments: [{ id: 'seg-001', order: 1, text: 'Guion' }],
      image_candidates: [],
      selected_images: [],
      status: 'ready',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('exposes the video-project read model without Supabase', async () => {
    const response = await router.handle({
      method: 'GET',
      pathname: '/panel/read-models/video-projects',
      searchParams: new URLSearchParams('limit=10'),
      readBody: bodyReader({}),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.projects.length, 1);
    assert.equal(response.body.projects[0].draft_id, 'draft-1');

    const detail = await router.handle({
      method: 'GET',
      pathname: '/panel/read-models/video-projects',
      searchParams: new URLSearchParams('draft_id=draft-1'),
      readBody: bodyReader({}),
    });
    assert.equal(detail.body.projects[0].segments.length, 1);
  });

  it('stores uploads through the API and serves them back as blobs', async () => {
    const upload = await router.handle({
      method: 'POST',
      pathname: '/panel/uploads/video-project-audio/projects/abc/voice/voice.m4a',
      headers: { 'content-type': 'audio/mp4', 'x-file-name': 'voice.m4a' },
      readBody: bodyReader(MP4_HEADER),
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.ok, true);
    assert.equal(upload.body.storage_bucket, 'video-project-audio');
    assert.equal(upload.body.storage_path, 'projects/abc/voice/voice.m4a');
    assert.equal(upload.body.storage_public_url, '/panel/blobs/video-project-audio/projects/abc/voice/voice.m4a');
    assert.equal(upload.body.size, MP4_HEADER.length);

    const blob = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-project-audio/projects/abc/voice/voice.m4a',
      readBody: bodyReader({}),
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers['content-type'], 'audio/mp4');
    assert.equal(blob.headers['x-content-type-options'], 'nosniff');
    assert.equal(blob.headers['content-security-policy'], "sandbox; default-src 'none'");
    assert.equal(blob.headers['content-disposition'], undefined);
    assert.deepEqual(blob.body, MP4_HEADER);

    const missing = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-project-audio/missing.m4a',
      readBody: bodyReader({}),
    });
    assert.equal(missing.status, 404);
  });

  it('never serves active content inline', async () => {
    const html = await upload(
      router,
      '/panel/uploads/video-candidates-temp/projects/abc/evil.html',
      'text/html',
      Buffer.from('<!doctype html><script>alert(1)</script>'),
    );
    assert.equal(html.status, 201);

    const svg = await upload(
      router,
      '/panel/uploads/video-candidates-temp/projects/abc/evil.svg',
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    assert.equal(svg.status, 201);

    const xml = await upload(
      router,
      '/panel/uploads/video-candidates-temp/projects/abc/feed.xml',
      'application/xml',
      Buffer.from('<?xml version="1.0"?><root/>'),
    );
    assert.equal(xml.status, 201);

    for (const pathname of [
      '/panel/blobs/video-candidates-temp/projects/abc/evil.html',
      '/panel/blobs/video-candidates-temp/projects/abc/evil.svg',
      '/panel/blobs/video-candidates-temp/projects/abc/feed.xml',
    ]) {
      const blob = await router.handle({ method: 'GET', pathname, readBody: bodyReader({}) });
      assert.equal(blob.status, 200, pathname);
      assert.equal(blob.headers['content-type'], 'application/octet-stream', pathname);
      assert.match(blob.headers['content-disposition'], /^attachment; filename="/, pathname);
      assert.equal(blob.headers['content-security-policy'], "sandbox; default-src 'none'", pathname);
      assert.equal(blob.headers['x-content-type-options'], 'nosniff', pathname);
    }
  });

  it('keeps allow-listed images and audio inline after magic-byte validation', async () => {
    const png = await upload(
      router,
      '/panel/uploads/video-candidates-temp/projects/abc/candidate.png',
      'image/png',
      PNG_HEADER,
    );
    assert.equal(png.status, 201);
    const image = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-candidates-temp/projects/abc/candidate.png',
      readBody: bodyReader({}),
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['content-disposition'], undefined);
    assert.equal(image.headers['content-security-policy'], "sandbox; default-src 'none'");

    const audio = await upload(
      router,
      '/panel/uploads/video-project-audio/projects/abc/voice/voice.wav',
      'audio/wav',
      Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]),
    );
    assert.equal(audio.status, 201);
    const served = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-project-audio/projects/abc/voice/voice.wav',
      readBody: bodyReader({}),
    });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'audio/wav');
    assert.equal(served.headers['content-disposition'], undefined);
  });

  it('rejects an allow-listed media type whose bytes do not match', async () => {
    for (const [contentType, pathname] of [
      ['image/png', '/panel/uploads/video-candidates-temp/projects/abc/fake.png'],
      ['audio/mp4', '/panel/uploads/video-project-audio/projects/abc/fake.m4a'],
      ['video/mp4', '/panel/uploads/video-project-videos/projects/abc/fake.mp4'],
    ]) {
      const response = await upload(router, pathname, contentType, Buffer.from('<html>not media</html>'));
      assert.equal(response.status, 415, contentType);
      assert.equal(response.body.error, 'unsupported_media_type', contentType);
    }
  });

  it('rejects unknown buckets and traversal paths on upload', async () => {
    const badBucket = await router.handle({
      method: 'POST',
      pathname: '/panel/uploads/not-a-bucket/file.bin',
      headers: { 'content-type': 'application/octet-stream' },
      readBody: bodyReader(Buffer.from('x')),
    });
    assert.equal(badBucket.status, 400);
    assert.equal(badBucket.body.error, 'invalid_bucket');

    const traversal = await router.handle({
      method: 'POST',
      pathname: '/panel/uploads/video-project-audio/..%2Fescape.bin',
      headers: { 'content-type': 'application/octet-stream' },
      readBody: bodyReader(Buffer.from('x')),
    });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.error, 'invalid_storage_path');
  });

  it('saves selections, editor state, audio and custom images', async () => {
    const selections = await router.handle({
      method: 'POST',
      pathname: '/panel/video-projects/draft-1/selections',
      readBody: bodyReader({ selectedImageIds: ['candidate-1'] }),
    });
    assert.equal(selections.status, 200);
    assert.deepEqual(selections.body.selected_images, ['candidate-1']);

    const editor = await router.handle({
      method: 'PUT',
      pathname: '/panel/video-projects/draft-1/editor-state',
      readBody: bodyReader({ editorState: { phase: 'preview_ready' } }),
    });
    assert.equal(editor.status, 200);
    assert.equal(editor.body.editor_state.phase, 'preview_ready');

    const audio = await router.handle({
      method: 'POST',
      pathname: '/panel/video-projects/draft-1/audio',
      readBody: bodyReader({
        voiceAudio: { public_url: '/panel/blobs/voice.m4a', kind: 'voice' },
        backgroundAudio: { public_url: '/panel/blobs/music.wav', kind: 'background' },
      }),
    });
    assert.equal(audio.status, 200);
    assert.equal(audio.body.voice_audio.kind, 'voice');

    const images = await router.handle({
      method: 'POST',
      pathname: '/panel/video-projects/draft-1/custom-images',
      readBody: bodyReader({ customCandidates: [{ id: 'custom-1' }] }),
    });
    assert.equal(images.status, 200);
    assert.equal(images.body.added_count, 1);
  });

  it('returns 404 for missing projects and 405 for wrong methods', async () => {
    const missing = await router.handle({
      method: 'POST',
      pathname: '/panel/video-projects/missing/selections',
      readBody: bodyReader({ selectedImageIds: [] }),
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'video_project_not_found');

    const wrong = await router.handle({
      method: 'GET',
      pathname: '/panel/video-projects/draft-1/selections',
      readBody: bodyReader({}),
    });
    assert.equal(wrong.status, 405);
  });

  it('soft-disables a project so it disappears from reads', async () => {
    const disabled = await router.handle({
      method: 'POST',
      pathname: '/panel/video-projects/draft-1/disable',
      readBody: bodyReader({}),
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.ok, true);

    const read = await router.handle({
      method: 'GET',
      pathname: '/panel/read-models/video-projects',
      searchParams: new URLSearchParams(),
      readBody: bodyReader({}),
    });
    assert.equal(read.body.projects.length, 0);
  });
});
