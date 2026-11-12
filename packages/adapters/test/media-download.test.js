import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerMediaDownload, validateYouTubeUrl } from '../src/media-download.js';

test('validateYouTubeUrl only accepts YouTube media URLs', () => {
  assert.equal(validateYouTubeUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.throws(() => validateYouTubeUrl('http://127.0.0.1/private'), /host is not allowed/);
  assert.throws(() => validateYouTubeUrl('file:///etc/passwd'), /http or https/);
});

test('WorkerMediaDownload posts the job to the ASR worker and returns its path', async () => {
  const calls = [];
  const adapter = new WorkerMediaDownload({
    baseUrl: 'http://asr.test:8765/',
    apiKey: 'worker-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        async json() { return { path: '/media/job-1/source.webm', title: 'Demo highlight' }; },
        async text() { return JSON.stringify({ path: '/media/job-1/source.webm', title: 'Demo highlight' }); },
      };
    },
  });

  const result = await adapter.download({ url: 'https://youtu.be/abc123', jobDir: '/media/job-1' });

  assert.equal(calls[0].url, 'http://asr.test:8765/api/radar/download');
  assert.equal(calls[0].options.headers['x-api-key'], 'worker-key');
  assert.deepEqual(calls[0].body, { url: 'https://youtu.be/abc123', job_dir: '/media/job-1' });
  assert.deepEqual(result, { path: '/media/job-1/source.webm', title: 'Demo highlight' });
});

test('WorkerMediaDownload surfaces the worker failure code', async () => {
  const adapter = new WorkerMediaDownload({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async text() { return JSON.stringify({ detail: { code: 'yt_dlp_geo_blocked', message: 'blocked in your country' } }); },
    }),
  });

  await assert.rejects(
    () => adapter.download({ url: 'https://youtu.be/abc123', jobDir: '/media/job-1' }),
    (error) => error.code === 'yt_dlp_geo_blocked' && /blocked/.test(error.message),
  );
});

test('WorkerMediaDownload requires a job directory before calling the worker', async () => {
  const adapter = new WorkerMediaDownload({ fetchImpl: async () => assert.fail('fetch must not run') });
  await assert.rejects(
    () => adapter.download({ url: 'https://youtu.be/abc123' }),
    (error) => error.code === 'job_dir_missing',
  );
});
