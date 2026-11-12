import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdaptersFromEnv } from '../src/composition.js';
import { ConsoleNotificationAdapter } from '../src/notification.js';
import { OllamaLLMAdapter } from '../src/llm.js';
import { SearxngWikimediaImageSearch } from '../src/image-search.js';
import { YtDlpMediaDownload } from '../src/media-download.js';
import { N8nWorkflowTrigger } from '../src/workflow-trigger.js';
import { DemoArticleExtractor, DemoLLMAdapter } from '../src/demo.js';

test('createAdaptersFromEnv selects the local defaults with no keys', () => {
  const adapters = createAdaptersFromEnv({ env: {}, fetchImpl: async () => ({}) });

  assert.ok(adapters.llm instanceof OllamaLLMAdapter);
  assert.ok(adapters.newsSource);
  assert.ok(adapters.articleExtractor);
  assert.ok(adapters.imageSearch instanceof SearxngWikimediaImageSearch);
  assert.ok(adapters.documentExport);
  assert.ok(adapters.notification instanceof ConsoleNotificationAdapter);
  assert.ok(adapters.channelFeed);
  assert.ok(adapters.mediaDownload instanceof YtDlpMediaDownload);
  assert.equal(adapters.workflowTrigger, null);
});

test('createAdaptersFromEnv can disable optional capabilities', () => {
  const adapters = createAdaptersFromEnv({
    env: {
      LLM: 'none',
      NEWS_SOURCE: 'none',
      ARTICLE_EXTRACTOR: 'none',
      IMAGE_SEARCH: 'none',
      DOCUMENT_EXPORT: 'none',
      NOTIFY: 'none',
      CHANNEL_FEED: 'none',
      MEDIA_DOWNLOAD: 'none',
    },
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } }),
  });

  assert.equal(adapters.llm, null);
  assert.equal(adapters.newsSource, undefined);
  assert.equal(adapters.articleExtractor, undefined);
  assert.equal(adapters.imageSearch, undefined);
  assert.equal(adapters.documentExport, undefined);
  assert.equal(adapters.notification, null);
  assert.equal(adapters.channelFeed, undefined);
  assert.equal(adapters.mediaDownload, undefined);
});

test('createAdaptersFromEnv enables the optional n8n trigger and SMTP notification', () => {
  const adapters = createAdaptersFromEnv({
    env: {
      WORKFLOW: 'n8n',
      N8N_WEBHOOK_BASE_URL: 'http://n8n.local:5678/',
      NOTIFY: 'smtp',
      SMTP_HOST: 'smtp.local',
      SMTP_PORT: '2525',
    },
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } }),
  });

  assert.ok(adapters.workflowTrigger instanceof N8nWorkflowTrigger);
  assert.equal(adapters.workflowTrigger.baseUrl, 'http://n8n.local:5678');
  assert.equal(adapters.notification.host, 'smtp.local');
  assert.equal(adapters.notification.port, 2525);
});


test('createAdaptersFromEnv supports the deterministic demo adapters', async () => {
  const adapters = createAdaptersFromEnv({
    env: { LLM: 'demo', ARTICLE_EXTRACTOR: 'demo' },
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });

  assert.ok(adapters.llm instanceof DemoLLMAdapter);
  assert.ok(adapters.articleExtractor instanceof DemoArticleExtractor);

  const extracted = await adapters.articleExtractor.extract({
    url: 'https://example.local/story',
    job: {
      titular: 'Andrade vuelve a entrenar con el grupo',
      jugador: 'Nicolás Andrade',
      seleccion: 'Aurenia',
      tema_principal: 'Andrade vuelve a entrenar con el grupo',
      link: 'https://example.local/story',
    },
  });
  assert.match(extracted.article.main_content, /Andrade/);
  assert.ok(extracted.article.main_content.split(/\s+/).length > 30);

  const completion = await adapters.llm.complete({ prompt: 'genera un guion' });
  assert.ok(completion.text.split(/\s+/).length >= 120);
  assert.equal(completion.provider, 'demo');
});
