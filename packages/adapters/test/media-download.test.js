import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YtDlpMediaDownload, classifyYtDlpFailure, validateYouTubeUrl } from '../src/media-download.js';

test('validateYouTubeUrl only accepts YouTube media URLs', () => {
  assert.equal(validateYouTubeUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.throws(() => validateYouTubeUrl('http://127.0.0.1/private'), /host is not allowed/);
  assert.throws(() => validateYouTubeUrl('file:///etc/passwd'), /http or https/);
});

test('classifyYtDlpFailure maps the common yt-dlp errors', () => {
  assert.equal(classifyYtDlpFailure('ERROR: Sign in to confirm you are not a bot'), 'yt_dlp_bot_check');
  assert.equal(classifyYtDlpFailure('Video unavailable'), 'yt_dlp_private_or_removed');
  assert.equal(classifyYtDlpFailure('not available in your country'), 'yt_dlp_geo_blocked');
  assert.equal(classifyYtDlpFailure('something else'), 'yt_dlp_failed');
});

test('YtDlpMediaDownload spawns the local binary and returns the downloaded file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'newsroom-ytdlp-'));
  let spawned = null;
  const adapter = new YtDlpMediaDownload({
    binary: 'yt-dlp-test',
    spawnImpl: (binary, args, options) => {
      spawned = { binary, args, options };
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(async () => {
        await writeFile(join(dir, 'source.m4a'), 'audio');
        child.emit('close', 0);
      }, 5);
      return child;
    },
  });

  const result = await adapter.download({ url: 'https://youtu.be/abc123', jobDir: dir });

  assert.equal(spawned.binary, 'yt-dlp-test');
  assert.ok(spawned.args.includes('--no-playlist'));
  assert.ok(spawned.args.includes('--max-filesize'));
  assert.match(spawned.args[spawned.args.indexOf('--output') + 1], /source\.%\(ext\)s$/);
  assert.equal(result.path, join(dir, 'source.m4a'));
});

test('YtDlpMediaDownload surfaces a classified failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'newsroom-ytdlp-'));
  const adapter = new YtDlpMediaDownload({
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stderr.emit('data', 'ERROR: Video unavailable');
        child.emit('close', 1);
      }, 5);
      return child;
    },
  });

  await assert.rejects(
    () => adapter.download({ url: 'https://youtu.be/abc123', jobDir: dir }),
    (error) => error.code === 'yt_dlp_private_or_removed',
  );
});
