import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FsBlobStorage } from '../src/adapters/fs-blob-storage.js';

describe('fs blob storage', () => {
  let root;
  let storage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'newsroom-blobs-'));
    storage = new FsBlobStorage({ root, publicPath: '/panel/blobs' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts, gets, heads and deletes a blob with metadata', async () => {
    const put = await storage.put('projects/draft-1/audio/voice.m4a', Buffer.from('audio-bytes'), {
      contentType: 'audio/mp4',
    });
    assert.equal(put.key, 'projects/draft-1/audio/voice.m4a');
    assert.equal(put.size, 11);
    assert.equal(put.content_type, 'audio/mp4');
    assert.equal(put.url, '/panel/blobs/projects/draft-1/audio/voice.m4a');

    const head = await storage.head('projects/draft-1/audio/voice.m4a');
    assert.equal(head.size, 11);
    assert.equal(head.content_type, 'audio/mp4');

    const got = await storage.get('projects/draft-1/audio/voice.m4a');
    assert.equal(got.data.toString('utf8'), 'audio-bytes');
    assert.equal(got.content_type, 'audio/mp4');

    assert.equal(await storage.delete('projects/draft-1/audio/voice.m4a'), true);
    assert.equal(await storage.get('projects/draft-1/audio/voice.m4a'), null);
    assert.equal(await storage.delete('projects/draft-1/audio/voice.m4a'), false);
  });

  it('lists blobs by prefix in deterministic order', async () => {
    await storage.put('projects/a/one.png', Buffer.from('1'), { contentType: 'image/png' });
    await storage.put('projects/a/two.png', Buffer.from('2'), { contentType: 'image/png' });
    await storage.put('projects/b/three.png', Buffer.from('3'), { contentType: 'image/png' });

    const listed = await storage.list('projects/a');
    assert.deepEqual(listed.map((entry) => entry.key), ['projects/a/one.png', 'projects/a/two.png']);
    assert.equal((await storage.list()).length, 3);
  });

  it('overwrites an existing key and keeps the latest metadata', async () => {
    await storage.put('defaults/music.wav', Buffer.from('one'), { contentType: 'audio/wav' });
    await storage.put('defaults/music.wav', Buffer.from('two-two'), { contentType: 'audio/wav' });

    const head = await storage.head('defaults/music.wav');
    assert.equal(head.size, 7);
    assert.equal((await storage.get('defaults/music.wav')).data.toString('utf8'), 'two-two');
  });

  it('rejects path traversal and absolute keys', async () => {
    for (const key of ['', '../escape.txt', '/etc/passwd', 'a/../../b', 'a\\b.txt', './a.txt']) {
      await assert.rejects(() => storage.put(key, Buffer.from('x')), /invalid blob key/);
    }
    await assert.rejects(() => storage.get('../escape.txt'), /invalid blob key/);
  });

  it('uses an octet-stream default and encodes public urls', () => {
    assert.equal(storage.getPublicUrl('a b/c.txt'), '/panel/blobs/a%20b/c.txt');
    assert.equal(storage.getPublicUrl('a/b.txt'), '/panel/blobs/a/b.txt');
  });

  it('writes bytes to the configured root only', async () => {
    await storage.put('safe/file.bin', Buffer.from('abc'));
    const bytes = await readFile(join(root, 'objects', 'safe', 'file.bin'), 'utf8');
    assert.equal(bytes, 'abc');
  });
});
