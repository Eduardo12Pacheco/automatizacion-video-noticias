import { fetchWithTimeout } from './http.js';

const PROBE_TIMEOUT_MS = 5_000;

const LOCAL_ADAPTERS = new Set([
  'ollama', 'console', 'fs', 'rss', 'trafilatura', 'searxng', 'local', 'demo', 'memory', 'worker', 'piper',
]);

const ADAPTER_NAMES = new Map([
  ['OllamaLLMAdapter', 'ollama'],
  ['OpenAICompatibleLLMAdapter', 'openai'],
  ['DemoLLMAdapter', 'demo'],
  ['ConsoleNotificationAdapter', 'console'],
  ['SmtpNotificationAdapter', 'smtp'],
  ['N8nWorkflowTrigger', 'n8n'],
  ['FsBlobStorage', 'fs'],
  ['S3BlobStorage', 's3'],
  ['TrafilaturaArticleExtractor', 'trafilatura'],
  ['SearxngWikimediaImageSearch', 'searxng'],
  ['RssNewsSourceAdapter', 'rss'],
  ['RssChannelFeedAdapter', 'rss'],
  ['LocalDocumentExport', 'local'],
  ['WorkerMediaDownload', 'worker'],
  ['HttpTTSAdapter', 'worker'],
  ['HttpASRAdapter', 'worker'],
  ['HttpTranslationAdapter', 'worker'],
  ['HttpVideoRendererAdapter', 'worker'],
  ['DemoTTSAdapter', 'demo'],
  ['DemoASRAdapter', 'demo'],
  ['DemoTranslationAdapter', 'demo'],
  ['DemoVideoRendererAdapter', 'demo'],
  ['RepositoryAuthAdapter', 'local'],
  ['HttpAuthAdapter', 'http'],
  ['DemoAuthAdapter', 'demo'],
  ['PostgresRepository', 'postgres'],
  ['InMemoryRepository', 'memory'],
]);

export function adapterKind(adapter) {
  if (!adapter) return 'none';
  const name = adapter?.constructor?.name || '';
  return ADAPTER_NAMES.get(name) || String(name || 'custom').replace(/Adapter$/, '').toLowerCase();
}

function httpProbe({ baseUrl, path = '/health', headers = {} } = {}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
  return async ({ fetchImpl }) => {
    if (!baseUrl) return { ok: false, message: 'Adapter is not configured' };
    const response = await fetchWithTimeout(fetchImpl, url, { timeoutMs: PROBE_TIMEOUT_MS, headers });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    return { ok: true, message: `HTTP ${response.status}` };
  };
}

function safeEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function safeHost(value) {
  return String(value || '').trim().split('@').pop().split(/[?#]/)[0];
}

function redactUrls(value) {
  return String(value || '').replace(/\bhttps?:\/\/[^\s'"]+/gi, (match) => {
    const trimmed = match.replace(/[),.;]+$/, '');
    return safeEndpoint(trimmed) || '[redacted-url]';
  });
}

function connector({ id, port, adapter, kind, detail = '', probe = null, env = [] }) {
  return { id, port, adapter: kind, detail, probe, env: [...env] };
}

/**
 * Read-only catalogue of every port the API composes. It never exposes
 * credentials: details are limited to adapter names, model ids, hosts and
 * buckets. `test(id)` runs one bounded probe and records its last result so
 * the next `list()` can report `status: "error"` without leaking the cause.
 */
export function createConnectorRegistry({
  env = process.env,
  adapters = {},
  blobStorage = null,
  repository = null,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const lastResults = new Map();

  const definitions = [
    connector({ id: 'repository', port: 'RepositoryPort', adapter: repository, kind: repository ? adapterKind(repository) : 'none', detail: repository ? adapterKind(repository) : '', env: ['DATABASE_URL'] }),
    connector({ id: 'blob-storage', port: 'BlobStoragePort', adapter: blobStorage, kind: blobStorage ? adapterKind(blobStorage) : 'none', detail: blobStorage?.endpoint ? `${blobStorage.bucket} @ ${safeEndpoint(blobStorage.endpoint)}` : (blobStorage?.root || ''), env: ['STORAGE'] }),
    connector({ id: 'news-source', port: 'NewsSourcePort', adapter: adapters.newsSource, kind: adapters.newsSource ? 'rss' : 'none', detail: 'Google News RSS', env: ['NEWS_SOURCE'] }),
    connector({ id: 'article-extractor', port: 'ArticleExtractorPort', adapter: adapters.articleExtractor, kind: adapterKind(adapters.articleExtractor), detail: adapters.articleExtractor?.pythonBin || '', env: ['ARTICLE_EXTRACTOR'] }),
    connector({ id: 'llm', port: 'LLMPort', adapter: adapters.llm, kind: adapterKind(adapters.llm), detail: [adapters.llm?.model, safeEndpoint(adapters.llm?.baseUrl)].filter(Boolean).join(' @ '), env: ['LLM'] }),
    connector({ id: 'image-search', port: 'ImageSearchPort', adapter: adapters.imageSearch, kind: adapters.imageSearch ? 'searxng' : 'none', detail: safeEndpoint(adapters.imageSearch?.searxngUrl), env: ['IMAGE_SEARCH'] }),
    connector({ id: 'tts', port: 'TTSPort', adapter: adapters.tts, kind: adapterKind(adapters.tts), detail: safeEndpoint(adapters.tts?.baseUrl), env: ['TTS'] }),
    connector({ id: 'asr', port: 'ASRPort', adapter: adapters.asr, kind: adapterKind(adapters.asr), detail: safeEndpoint(adapters.asr?.baseUrl), env: ['ASR'] }),
    connector({ id: 'translation', port: 'TranslationPort', adapter: adapters.translation, kind: adapterKind(adapters.translation), detail: safeEndpoint(adapters.translation?.baseUrl), env: ['TRANSLATION'] }),
    connector({ id: 'video-renderer', port: 'VideoRendererPort', adapter: adapters.videoRenderer, kind: adapterKind(adapters.videoRenderer), detail: safeEndpoint(adapters.videoRenderer?.baseUrl), env: ['RENDERER'] }),
    connector({ id: 'channel-feed', port: 'ChannelFeedPort', adapter: adapters.channelFeed, kind: adapters.channelFeed ? 'rss' : 'none', detail: 'YouTube public RSS', env: ['CHANNEL_FEED'] }),
    connector({ id: 'media-download', port: 'MediaDownloadPort', adapter: adapters.mediaDownload, kind: adapterKind(adapters.mediaDownload), detail: safeEndpoint(adapters.mediaDownload?.baseUrl), env: ['MEDIA_DOWNLOAD'] }),
    connector({ id: 'document-export', port: 'DocumentExportPort', adapter: adapters.documentExport, kind: adapters.documentExport ? 'local' : 'none', detail: adapters.documentExport?.pythonBin || '', env: ['DOCUMENT_EXPORT'] }),
    connector({ id: 'workflow', port: 'WorkflowTriggerPort', adapter: adapters.workflowTrigger, kind: adapterKind(adapters.workflowTrigger), detail: safeEndpoint(adapters.workflowTrigger?.baseUrl), env: ['WORKFLOW'] }),
    connector({ id: 'notification', port: 'NotificationPort', adapter: adapters.notification, kind: adapterKind(adapters.notification), detail: adapters.notification?.host ? `${safeHost(adapters.notification.host)}:${adapters.notification.port}` : '', env: ['NOTIFY'] }),
    connector({ id: 'auth', port: 'AuthPort', adapter: adapters.auth, kind: adapterKind(adapters.auth), detail: '', env: ['AUTH'] }),
  ];

  const probes = {
    repository: async () => {
      if (!repository) return { ok: false, message: 'Repository adapter is not configured' };
      await repository.listPendingApprovalClusters();
      return { ok: true, message: 'Repository responded' };
    },
    'blob-storage': async () => {
      if (!blobStorage) return { ok: false, message: 'Blob storage adapter is not configured' };
      if (typeof blobStorage.verifyConnection === 'function') {
        const result = await blobStorage.verifyConnection();
        return { ok: result.ok !== false, message: result.ok === false ? (result.message || 'Bucket unavailable') : 'Bucket reachable' };
      }
      const key = `.health/connector-probe-${Date.now()}.txt`;
      await blobStorage.put(key, Buffer.from('ok'), { contentType: 'text/plain' });
      const head = await blobStorage.head(key);
      await blobStorage.delete(key);
      return { ok: Boolean(head), message: 'Read/write probe completed' };
    },
    'article-extractor': async () => {
      if (!adapters.articleExtractor) return { ok: false, message: 'Adapter is not configured' };
      return { ok: true, message: `Local adapter ready (${adapters.articleExtractor.pythonBin || 'python'})` };
    },
    llm: async () => {
      const adapter = adapters.llm;
      if (!adapter) return { ok: false, message: 'LLM adapter is not configured' };
      const kind = adapterKind(adapter);
      if (kind === 'demo') return { ok: true, message: 'Deterministic demo model' };
      if (kind === 'ollama') return httpProbe({ baseUrl: adapter.baseUrl, path: '/api/tags' })({ fetchImpl });
      if (kind === 'openai') {
        return httpProbe({
          baseUrl: adapter.baseUrl,
          path: '/models',
          headers: adapter.apiKey ? { authorization: `Bearer ${adapter.apiKey}` } : {},
        })({ fetchImpl });
      }
      return { ok: true, message: 'Adapter active' };
    },
    'image-search': async () => {
      const adapter = adapters.imageSearch;
      if (!adapter) return { ok: false, message: 'Image search adapter is not configured' };
      if (typeof adapter.search === 'function') {
        const result = await adapter.search({ query: 'football stadium', limit: 1 });
        return { ok: Array.isArray(result?.images) && result.images.length > 0, message: `${result?.images?.length || 0} result(s)` };
      }
      return { ok: true, message: 'Adapter active' };
    },
    tts: httpProbe({ get baseUrl() { return adapters.tts?.baseUrl; }, path: '/health' }),
    asr: httpProbe({ get baseUrl() { return adapters.asr?.baseUrl; }, path: '/health' }),
    translation: httpProbe({ get baseUrl() { return adapters.translation?.baseUrl; }, path: '/api/subtitles/health' }),
    'video-renderer': httpProbe({ get baseUrl() { return adapters.videoRenderer?.baseUrl; }, path: '/health' }),
    'media-download': httpProbe({ get baseUrl() { return adapters.mediaDownload?.baseUrl; }, path: '/health' }),
    workflow: httpProbe({ get baseUrl() { return adapters.workflowTrigger?.baseUrl; }, path: '/healthz' }),
    notification: async () => {
      const adapter = adapters.notification;
      if (!adapter) return { ok: false, message: 'Notification adapter is not configured' };
      if (typeof adapter.verify === 'function') return adapter.verify();
      return { ok: true, message: 'Console notifications are always available' };
    },
    auth: async () => {
      if (!adapters.auth) return { ok: false, message: 'Auth adapter is not configured' };
      if (typeof adapters.auth.verify === 'function') return adapters.auth.verify();
      return { ok: true, message: 'Auth adapter active' };
    },
  };

  function statusFor(definition) {
    if (lastResults.get(definition.id)?.ok === false) return 'error';
    if (definition.adapter === 'none') return 'disabled';
    return LOCAL_ADAPTERS.has(definition.adapter) ? 'local' : 'configured';
  }

  function serialize(definition) {
    const result = lastResults.get(definition.id) || null;
    return {
      id: definition.id,
      port: definition.port,
      adapter: definition.adapter,
      status: statusFor(definition),
      detail: definition.detail || '',
      testable: Boolean(probes[definition.id]),
      last_checked_at: result?.checked_at || null,
      last_message: result?.message || '',
      env: definition.env,
    };
  }

  function list() {
    return definitions.map(serialize);
  }

  async function test(id) {
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) return null;
    const probe = probes[id];
    if (!probe) {
      return { id, ok: true, status: 'local', message: 'Local adapter active; no external endpoint to check', checked_at: new Date().toISOString() };
    }
    let result;
    try {
      result = await probe({ fetchImpl });
    } catch (error) {
      result = { ok: false, message: redactUrls(error?.message || error) };
    }
    const record = {
      ok: result?.ok !== false,
      message: redactUrls(result?.message || (result?.ok === false ? 'Connection failed' : 'Connection OK')),
      checked_at: new Date().toISOString(),
    };
    lastResults.set(id, record);
    logger?.debug?.('connector probe', { id, ok: record.ok });
    return { id, ...record, status: statusFor(definition) };
  }

  return { list, test };
}
