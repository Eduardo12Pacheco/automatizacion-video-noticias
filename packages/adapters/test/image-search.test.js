import assert from 'node:assert/strict';
import test from 'node:test';

import { SearxngWikimediaImageSearch, mapWikimediaPages } from '../src/image-search.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

test('image search combines SearXNG and Wikimedia results and dedupes URLs', async () => {
  const calls = [];
  const adapter = new SearxngWikimediaImageSearch({
    searxngUrl: 'http://searxng.local:8888',
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/search?')) {
        return response({
          results: [
            { title: 'Uno', img_src: 'https://img.example.local/a.jpg', thumbnail_src: 'https://img.example.local/a-t.jpg', url: 'https://site.example.local/a', img_width: 800, img_height: 600 },
            { title: 'Duplicada', img_src: 'https://img.example.local/a.jpg', url: 'https://site.example.local/a2' },
          ],
        });
      }
      return response({
        query: {
          pages: {
            1: {
              title: 'File:Nicolás Arbelo 2022.jpg',
              imageinfo: [{
                thumburl: 'https://upload.wikimedia.org/b.jpg',
                url: 'https://upload.wikimedia.org/b-big.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:B.jpg',
                width: 1200,
                height: 800,
                extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
              }],
            },
            2: { title: 'File:Logo.svg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/logo.svg', url: 'https://upload.wikimedia.org/logo.svg' }] },
          },
        },
      });
    },
  });

  const result = await adapter.search({ query: 'Nicolás Arbelo', limit: 10 });

  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].source, 'searxng');
  assert.equal(result.images[1].source, 'wikimedia-commons');
  assert.equal(result.images[1].license, 'CC BY-SA 4.0');
  assert.equal(result.meta.sources.searxng.status, 'ok');
  assert.equal(result.meta.sources.wikimedia.status, 'ok');
  assert.ok(calls.some((url) => url.includes('format=json')));
});

test('image search degrades to Wikimedia when SearXNG fails', async () => {
  const adapter = new SearxngWikimediaImageSearch({
    searxngUrl: 'http://searxng.local:8888',
    fetchImpl: async (url) => {
      if (url.includes('/search?')) throw new Error('connection refused');
      return response({ query: { pages: { 1: { title: 'File:A.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', url: 'https://upload.wikimedia.org/a.jpg' }] } } } });
    },
  });

  const result = await adapter.search({ query: 'futbol' });
  assert.equal(result.images.length, 1);
  assert.equal(result.meta.sources.searxng.status, 'error');
});

test('image search raises only when every provider fails', async () => {
  const adapter = new SearxngWikimediaImageSearch({
    searxngUrl: 'http://searxng.local:8888',
    fetchImpl: async () => { throw new Error('offline'); },
  });

  await assert.rejects(() => adapter.search({ query: 'futbol' }), /No image provider answered/);
});

test('mapWikimediaPages ignores non-raster files', () => {
  const items = mapWikimediaPages({
    query: { pages: { 1: { title: 'File:X.svg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x.svg', url: 'https://upload.wikimedia.org/x.svg' }] } } },
  });
  assert.deepEqual(items, []);
});
