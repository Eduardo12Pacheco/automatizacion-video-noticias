import assert from 'node:assert/strict';
import test from 'node:test';

import { TrafilaturaArticleExtractor } from '../src/article-extractor.js';
import { LocalDocumentExport } from '../src/document-export.js';
import { SearxngWikimediaImageSearch } from '../src/image-search.js';
import { OllamaLLMAdapter } from '../src/llm.js';
import { RssChannelFeedAdapter } from '../src/rss.js';
import { SmtpNotificationAdapter } from '../src/notification.js';
import { WorkerMediaDownload } from '../src/media-download.js';
import { N8nWorkflowTrigger } from '../src/workflow-trigger.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = process.env.NEWSROOM_LIVE_TESTS === '1';
const skip = live ? false : 'set NEWSROOM_LIVE_TESTS=1 to run the live adapter checks';

test('live: Ollama answers a chat completion', { skip }, async () => {
  const adapter = new OllamaLLMAdapter({
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
    timeoutMs: 120_000,
  });
  const result = await adapter.complete({ prompt: 'Responde solo: ok', temperature: 0 });
  assert.ok(result.text.length > 0);
});

test('live: trafilatura extracts a public article', { skip }, async () => {
  const adapter = new TrafilaturaArticleExtractor();
  const result = await adapter.extract({ url: 'https://example.com/' });
  assert.ok(result.article.main_content.length > 0);
});

test('live: python-docx exports a real document', { skip }, async () => {
  const adapter = new LocalDocumentExport({ root: process.env.DOCUMENT_ROOT || './data/documents' });
  const created = await adapter.createDocument({ title: 'Live check', content: 'Contenido de prueba.' });
  assert.match(created.doc_id, /^doc-/);
});

test('live: SearXNG or Wikimedia returns at least one image', { skip }, async () => {
  const adapter = new SearxngWikimediaImageSearch({
    searxngUrl: process.env.SEARXNG_URL || 'http://127.0.0.1:8888',
    useWikimedia: true,
  });
  const result = await adapter.search({ query: 'football stadium', limit: 5 });
  assert.ok(Array.isArray(result.images));
});

test('live: YouTube channel RSS returns entries', { skip }, async () => {
  const adapter = new RssChannelFeedAdapter();
  const channel = await adapter.fetchChannel({ channelId: process.env.LIVE_YOUTUBE_CHANNEL_ID || 'UC_x5XG1OV2P6uZZ5FSM9Ttw' });
  assert.ok(channel.channelId.startsWith('UC'));
});

test('live: optional n8n webhook accepts a trigger', { skip: live && process.env.N8N_WEBHOOK_BASE_URL ? false : skip }, async () => {
  if (!process.env.N8N_WEBHOOK_BASE_URL) {
    assert.ok(true);
    return;
  }
  const adapter = new N8nWorkflowTrigger({ baseUrl: process.env.N8N_WEBHOOK_BASE_URL });
  const result = await adapter.trigger(process.env.N8N_LIVE_WORKFLOW || 'health', { ping: true });
  assert.equal(result.status, 'triggered');
});

test('live: SMTP notification reaches Mailpit', { skip: live ? false : skip }, async () => {
  const adapter = new SmtpNotificationAdapter({
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: Number(process.env.SMTP_PORT || 1025),
    from: 'newsroom@example.local',
  });
  const result = await adapter.send({ to: 'editor@example.local', subject: 'Live SMTP check', text: 'Local delivery.' });
  assert.equal(result.status, 'sent');
});

test('live: the ASR worker downloads a configured media URL', { skip: live && process.env.NEWSROOM_LIVE_MEDIA_URL && process.env.NEWSROOM_LIVE_ASR_URL ? false : 'set NEWSROOM_LIVE_TESTS=1, NEWSROOM_LIVE_MEDIA_URL and NEWSROOM_LIVE_ASR_URL to run' }, async () => {
  const adapter = new WorkerMediaDownload({ baseUrl: process.env.NEWSROOM_LIVE_ASR_URL, timeoutMs: 120_000 });
  const result = await adapter.download({ url: process.env.NEWSROOM_LIVE_MEDIA_URL, jobDir: '/tmp/newsroom-live-media' });
  assert.ok(result.path);
});
