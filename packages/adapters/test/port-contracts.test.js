import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASRPort,
  ArticleExtractorPort,
  AuthPort,
  BlobStoragePort,
  ChannelFeedPort,
  DocumentExportPort,
  ImageSearchPort,
  LLMPort,
  MediaDownloadPort,
  NewsSourcePort,
  NotificationPort,
  RepositoryPort,
  TTSPort,
  TranslationPort,
  VideoRendererPort,
  WorkflowTriggerPort,
  verifyPortContracts,
} from '@newsroom/core';

import {
  ConsoleNotificationAdapter,
  HttpASRAdapter,
  HttpAuthAdapter,
  HttpTTSAdapter,
  HttpTranslationAdapter,
  HttpVideoRendererAdapter,
  LocalAuthAdapter,
  LocalDocumentExport,
  N8nWorkflowTrigger,
  OllamaLLMAdapter,
  OpenAICompatibleLLMAdapter,
  RssChannelFeedAdapter,
  RssNewsSourceAdapter,
  SearxngWikimediaImageSearch,
  SmtpNotificationAdapter,
  TrafilaturaArticleExtractor,
  WorkerMediaDownload,
  createAdaptersFromEnv,
} from '../src/index.js';
import {
  DemoTTSAdapter,
  DemoASRAdapter,
  DemoArticleExtractor,
  DemoAuthAdapter,
  DemoLLMAdapter,
  DemoTranslationAdapter,
  DemoVideoRendererAdapter,
} from '../src/demo.js';

const noFetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const baseUrl = 'http://127.0.0.1:1';

describe('every adapter satisfies its declared port contract', () => {
  it('covers the demo, local and HTTP variants of each capability', () => {
    const authService = {
      authenticate() {}, createSession() {}, getSession() {}, revokeSession() {},
    };
    const pairs = [
      { portClass: LLMPort, label: 'ollama', adapter: new OllamaLLMAdapter({ fetchImpl: noFetch }) },
      { portClass: LLMPort, label: 'openai-compatible', adapter: new OpenAICompatibleLLMAdapter({ fetchImpl: noFetch }) },
      { portClass: LLMPort, label: 'demo', adapter: new DemoLLMAdapter() },
      { portClass: NewsSourcePort, label: 'rss', adapter: new RssNewsSourceAdapter({ fetchImpl: noFetch }) },
      { portClass: ArticleExtractorPort, label: 'trafilatura', adapter: new TrafilaturaArticleExtractor({ runCommand: async () => ({}) }) },
      { portClass: ArticleExtractorPort, label: 'demo', adapter: new DemoArticleExtractor() },
      { portClass: ImageSearchPort, label: 'searxng+wikimedia', adapter: new SearxngWikimediaImageSearch({ fetchImpl: noFetch }) },
      { portClass: ChannelFeedPort, label: 'rss', adapter: new RssChannelFeedAdapter({ fetchImpl: noFetch }) },
      { portClass: MediaDownloadPort, label: 'worker', adapter: new WorkerMediaDownload({ baseUrl, fetchImpl: noFetch }) },
      { portClass: NotificationPort, label: 'console', adapter: new ConsoleNotificationAdapter({ logger: { log() {} } }) },
      { portClass: NotificationPort, label: 'smtp', adapter: new SmtpNotificationAdapter({ host: '127.0.0.1' }) },
      { portClass: DocumentExportPort, label: 'local', adapter: new LocalDocumentExport({ root: '/tmp/newsroom-port-contracts' }) },
      { portClass: WorkflowTriggerPort, label: 'n8n', adapter: new N8nWorkflowTrigger({ baseUrl, fetchImpl: noFetch }) },
      { portClass: TTSPort, label: 'http', adapter: new HttpTTSAdapter({ baseUrl, fetchImpl: noFetch }) },
      { portClass: TTSPort, label: 'demo', adapter: new DemoTTSAdapter() },
      { portClass: ASRPort, label: 'http', adapter: new HttpASRAdapter({ baseUrl, fetchImpl: noFetch }) },
      { portClass: ASRPort, label: 'demo', adapter: new DemoASRAdapter() },
      { portClass: TranslationPort, label: 'http', adapter: new HttpTranslationAdapter({ baseUrl, fetchImpl: noFetch }) },
      { portClass: TranslationPort, label: 'demo', adapter: new DemoTranslationAdapter() },
      { portClass: VideoRendererPort, label: 'http', adapter: new HttpVideoRendererAdapter({ baseUrl, fetchImpl: noFetch }) },
      { portClass: VideoRendererPort, label: 'demo', adapter: new DemoVideoRendererAdapter() },
      { portClass: AuthPort, label: 'local', adapter: new LocalAuthAdapter({ authService }) },
      { portClass: AuthPort, label: 'http', adapter: new HttpAuthAdapter({ baseUrl, fetchImpl: noFetch }) },
      { portClass: AuthPort, label: 'demo', adapter: new DemoAuthAdapter() },
    ];
    assert.deepEqual(verifyPortContracts(pairs), []);
  });

  it('covers the adapters selected by the demo composition root', () => {
    const adapters = createAdaptersFromEnv({ env: { NEWSROOM_MODE: 'demo' }, fetchImpl: noFetch });
    const pairs = [
      { portClass: LLMPort, label: 'composition.llm', adapter: adapters.llm },
      { portClass: NewsSourcePort, label: 'composition.newsSource', adapter: adapters.newsSource },
      { portClass: ArticleExtractorPort, label: 'composition.articleExtractor', adapter: adapters.articleExtractor },
      { portClass: ImageSearchPort, label: 'composition.imageSearch', adapter: adapters.imageSearch },
      { portClass: ChannelFeedPort, label: 'composition.channelFeed', adapter: adapters.channelFeed },
      { portClass: MediaDownloadPort, label: 'composition.mediaDownload', adapter: adapters.mediaDownload },
      { portClass: NotificationPort, label: 'composition.notification', adapter: adapters.notification },
      { portClass: DocumentExportPort, label: 'composition.documentExport', adapter: adapters.documentExport },
      { portClass: TTSPort, label: 'composition.tts', adapter: adapters.tts },
      { portClass: ASRPort, label: 'composition.asr', adapter: adapters.asr },
      { portClass: TranslationPort, label: 'composition.translation', adapter: adapters.translation },
      { portClass: VideoRendererPort, label: 'composition.videoRenderer', adapter: adapters.videoRenderer },
    ].filter(({ adapter }) => adapter);
    assert.deepEqual(verifyPortContracts(pairs), []);
  });

  it('exposes RepositoryPort and BlobStoragePort from core', () => {
    assert.ok(RepositoryPort.methods.includes('upsertNews'));
    assert.ok(BlobStoragePort.methods.includes('getPublicUrl'));
  });
});
