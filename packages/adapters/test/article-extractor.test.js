import assert from 'node:assert/strict';
import test from 'node:test';

import { TrafilaturaArticleExtractor } from '../src/article-extractor.js';

test('TrafilaturaArticleExtractor runs the local CLI and returns the article', async () => {
  const calls = [];
  const adapter = new TrafilaturaArticleExtractor({
    pythonBin: 'python-test',
    scriptPath: '/tmp/adapter-cli.py',
    resolver: async () => ['93.184.216.34'],
    runCommand: async (options) => {
      calls.push(options);
      return { url: options.args[1], title: 'Titular', main_content: 'Cuerpo del articulo', author: 'Autor' };
    },
  });

  const result = await adapter.extract({ url: 'https://news.example.com/nota' });

  assert.equal(calls[0].pythonBin, 'python-test');
  assert.deepEqual(calls[0].args, ['extract', 'https://news.example.com/nota']);
  assert.equal(result.article.main_content, 'Cuerpo del articulo');
  assert.equal(result.extractor, 'trafilatura');
});

test('TrafilaturaArticleExtractor requires a URL and a body', async () => {
  const adapter = new TrafilaturaArticleExtractor({ resolver: async () => ['93.184.216.34'], runCommand: async () => ({ title: 'Vacio' }) });
  await assert.rejects(() => adapter.extract({ url: '' }), /URL is required/);
  await assert.rejects(() => adapter.extract({ url: 'https://news.example.com/x' }), /no article body/);
});

test('TrafilaturaArticleExtractor blocks private and single-label article URLs before spawning', async () => {
  let spawned = false;
  const adapter = new TrafilaturaArticleExtractor({
    resolver: async () => ['127.0.0.1'],
    runCommand: async () => { spawned = true; return {}; },
  });

  await assert.rejects(
    () => adapter.extract({ url: 'http://169.254.169.254/latest/meta-data/' }),
    (error) => error.code === 'extract_url_blocked',
  );
  await assert.rejects(
    () => adapter.extract({ url: 'http://approval-editor:3042/api/projects' }),
    (error) => error.code === 'extract_url_blocked',
  );
  await assert.rejects(
    () => adapter.extract({ url: 'https://news.example.com/nota' }),
    (error) => error.code === 'extract_url_blocked',
  );
  assert.equal(spawned, false);
});
