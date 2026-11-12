import assert from 'node:assert/strict';
import test from 'node:test';

import { TrafilaturaArticleExtractor } from '../src/article-extractor.js';

test('TrafilaturaArticleExtractor runs the local CLI and returns the article', async () => {
  const calls = [];
  const adapter = new TrafilaturaArticleExtractor({
    pythonBin: 'python-test',
    scriptPath: '/tmp/adapter-cli.py',
    runCommand: async (options) => {
      calls.push(options);
      return { url: options.args[1], title: 'Titular', main_content: 'Cuerpo del articulo', author: 'Autor' };
    },
  });

  const result = await adapter.extract({ url: 'https://news.example.local/nota' });

  assert.equal(calls[0].pythonBin, 'python-test');
  assert.deepEqual(calls[0].args, ['extract', 'https://news.example.local/nota']);
  assert.equal(result.article.main_content, 'Cuerpo del articulo');
  assert.equal(result.extractor, 'trafilatura');
});

test('TrafilaturaArticleExtractor requires a URL and a body', async () => {
  const adapter = new TrafilaturaArticleExtractor({ runCommand: async () => ({ title: 'Vacio' }) });
  await assert.rejects(() => adapter.extract({ url: '' }), /URL is required/);
  await assert.rejects(() => adapter.extract({ url: 'https://news.example.local/x' }), /no article body/);
});
