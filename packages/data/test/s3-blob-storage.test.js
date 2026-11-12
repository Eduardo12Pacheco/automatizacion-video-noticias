import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it, test } from 'node:test';

import { S3BlobStorage } from '../src/adapters/s3-blob-storage.js';

// Minimal path-style S3 server: enough for the adapter contract and to assert
// that every request is SigV4-signed. It is a protocol double, not MinIO; the
// opt-in live test below runs the same contract against a real MinIO.
function startFakeS3({ bucket = 'newsroom' } = {}) {
  const objects = new Map();
  const seen = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://s3.local');
    seen.push({ method: req.method, path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });
    const segments = url.pathname.split('/').filter(Boolean);
    const requestBucket = segments.shift();
    const key = segments.map(decodeURIComponent).join('/');
    if (requestBucket !== bucket) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }
    if (!key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const matching = [...objects.entries()].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${matching.map(([name, item]) => `<Contents><Key>${name}</Key><Size>${item.data.length}</Size><ETag>&quot;${item.etag}&quot;</ETag><LastModified>${new Date(0).toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(body);
      return;
    }
    if (!key && req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (!key && req.method === 'PUT') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'PUT' && key) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      objects.set(key, { data, contentType: req.headers['content-type'] || 'application/octet-stream', etag: 'etag-1' });
      res.writeHead(200, { etag: '"etag-1"' });
      res.end();
      return;
    }
    const stored = objects.get(key);
    if (!stored) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-type': stored.contentType,
        'content-length': String(stored.data.length),
        etag: `"${stored.etag}"`,
        'last-modified': new Date(0).toUTCString(),
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': stored.contentType,
        'content-length': String(stored.data.length),
        etag: `"${stored.etag}"`,
        'last-modified': new Date(0).toUTCString(),
      });
      res.end(stored.data);
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

describe('S3 blob storage adapter', () => {
  let fake;
  let storage;

  before(async () => {
    fake = await startFakeS3();
    storage = new S3BlobStorage({
      endpoint: fake.endpoint,
      bucket: 'newsroom',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
      region: 'us-east-1',
    });
  });

  after(async () => {
    await fake.close();
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
    assert.equal(head.url, '/panel/blobs/projects/draft-1/audio/voice.m4a');

    const got = await storage.get('projects/draft-1/audio/voice.m4a');
    assert.equal(got.data.toString('utf8'), 'audio-bytes');
    assert.equal(got.content_type, 'audio/mp4');

    assert.equal(await storage.delete('projects/draft-1/audio/voice.m4a'), true);
    assert.equal(await storage.get('projects/draft-1/audio/voice.m4a'), null);
    assert.equal(await storage.delete('projects/draft-1/audio/voice.m4a'), false);
  });

  it('lists blobs by prefix in deterministic order', async () => {
    await storage.put('a/one.png', Buffer.from('1'), { contentType: 'image/png' });
    await storage.put('a/two.png', Buffer.from('2'), { contentType: 'image/png' });
    await storage.put('b/three.png', Buffer.from('3'), { contentType: 'image/png' });
    const listed = await storage.list('a');
    assert.deepEqual(listed.map((entry) => entry.key), ['a/one.png', 'a/two.png']);
  });

  it('signs every request with SigV4 and never exposes keys in the URL', async () => {
    fake.seen.length = 0;
    await storage.head('a/one.png');
    assert.match(fake.seen[0].authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request/);
    assert.equal(fake.seen[0].path, '/newsroom/a/one.png');
    assert.equal(fake.seen[0].query.toString(), '');
  });

  it('rejects path traversal and absolute keys', async () => {
    for (const key of ['', '../escape.txt', '/etc/passwd', 'a/../../b', 'a\\b.txt', './a.txt']) {
      await assert.rejects(() => storage.put(key, Buffer.from('x')), /invalid blob key/);
    }
  });

  it('verifies the bucket connection', async () => {
    const result = await storage.verifyConnection();
    assert.equal(result.ok, true);
  });
});

const liveEndpoint = process.env.S3_TEST_ENDPOINT;
test('live: S3 adapter round-trips through a MinIO container', {
  skip: liveEndpoint ? false : 'set S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY and S3_TEST_SECRET_KEY to run against MinIO',
}, async () => {
  const storage = new S3BlobStorage({
    endpoint: liveEndpoint,
    bucket: process.env.S3_TEST_BUCKET || 'newsroom',
    accessKey: process.env.S3_TEST_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_TEST_SECRET_KEY || 'minioadmin',
    region: process.env.S3_TEST_REGION || 'us-east-1',
  });
  await storage.ensureBucket();
  const key = `probe/data-${Date.now()}.txt`;
  const put = await storage.put(key, Buffer.from('minio roundtrip'), { contentType: 'text/plain' });
  assert.equal(put.size, 15);
  const got = await storage.get(key);
  assert.equal(got.data.toString('utf8'), 'minio roundtrip');
  assert.equal(await storage.delete(key), true);
});
