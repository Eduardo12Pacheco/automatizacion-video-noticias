import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { InMemoryRepository, FsBlobStorage } from '../../../packages/data/src/index.js';
import { createDataRouter } from '../src/data-router.js';

function bodyReader(bytes) {
  return async () => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)));
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
      jugador: 'Moisés Caicedo',
      seleccion: 'Ecuador',
      tema_principal: 'Regreso de Caicedo',
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
      readBody: bodyReader(Buffer.from('voice-bytes')),
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.ok, true);
    assert.equal(upload.body.storage_bucket, 'video-project-audio');
    assert.equal(upload.body.storage_path, 'projects/abc/voice/voice.m4a');
    assert.equal(upload.body.storage_public_url, '/panel/blobs/video-project-audio/projects/abc/voice/voice.m4a');
    assert.equal(upload.body.size, 11);

    const blob = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-project-audio/projects/abc/voice/voice.m4a',
      readBody: bodyReader({}),
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers['content-type'], 'audio/mp4');
    assert.equal(blob.body.toString('utf8'), 'voice-bytes');

    const missing = await router.handle({
      method: 'GET',
      pathname: '/panel/blobs/video-project-audio/missing.m4a',
      readBody: bodyReader({}),
    });
    assert.equal(missing.status, 404);
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
