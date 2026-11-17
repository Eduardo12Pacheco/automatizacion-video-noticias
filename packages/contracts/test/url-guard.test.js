const test = require('node:test');
const assert = require('node:assert/strict');

const { BlockedUrlError, assertPublicUrl, isBlockedAddress } = require('../security/url-guard.js');

const publicResolver = async () => ['93.184.216.34'];

test('blocks loopback, private, link-local, CGNAT and IPv6 equivalents', async () => {
  const literalUrls = [
    'http://127.0.0.1/article',
    'http://10.1.2.3/article',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/article',
    'http://[::1]/article',
    'http://[::ffff:127.0.0.1]/article',
    'http://[::ffff:10.0.0.7]/article',
    'http://[fd00::1]/article',
    'http://0.0.0.0/article',
    'http://224.0.0.1/article',
  ];
  for (const url of literalUrls) {
    await assert.rejects(
      () => assertPublicUrl(url, { resolver: publicResolver }),
      (error) => error instanceof BlockedUrlError && error.code === 'ssrf_blocked_url',
      url,
    );
  }
});

test('blocks Compose service names and other single-label hosts', async () => {
  await assert.rejects(() => assertPublicUrl('http://approval-editor:3042/api/projects', { resolver: publicResolver }), BlockedUrlError);
  await assert.rejects(() => assertPublicUrl('http://localhost:8080/', { resolver: publicResolver }), BlockedUrlError);
  await assert.rejects(() => assertPublicUrl('http://api.local/', { resolver: publicResolver }), BlockedUrlError);
});

test('blocks a public-looking hostname that resolves to a private address', async () => {
  await assert.rejects(
    () => assertPublicUrl('https://news.example.com/story', { resolver: async () => ['10.0.0.9'] }),
    BlockedUrlError,
  );
  await assert.rejects(
    () => assertPublicUrl('https://news.example.com/story', { resolver: async () => ['93.184.216.34', '169.254.169.254'] }),
    BlockedUrlError,
  );
});

test('accepts public http(s) URLs and reports non-IP values as unblocked', async () => {
  assert.equal(await assertPublicUrl('https://news.example.com/story', { resolver: publicResolver }), 'https://news.example.com/story');
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('example.com'), false);
  assert.equal(isBlockedAddress('100.64.1.1'), true);
  assert.equal(isBlockedAddress('::ffff:a00:1'), true);
});

test('rejects non-http schemes and malformed URLs', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'not a url', '']) {
    await assert.rejects(() => assertPublicUrl(url, { resolver: publicResolver }), BlockedUrlError, url);
  }
});
