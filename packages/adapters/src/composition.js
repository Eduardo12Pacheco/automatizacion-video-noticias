import { TrafilaturaArticleExtractor } from './article-extractor.js';
import { DemoASRAdapter, DemoArticleExtractor, DemoLLMAdapter, DemoTranslationAdapter, DemoVideoRendererAdapter, DemoTTSAdapter } from './demo.js';
import { LocalDocumentExport } from './document-export.js';
import { SearxngWikimediaImageSearch } from './image-search.js';
import { OllamaLLMAdapter, OpenAICompatibleLLMAdapter } from './llm.js';
import { WorkerMediaDownload } from './media-download.js';
import { ConsoleNotificationAdapter, SmtpNotificationAdapter } from './notification.js';
import { RssChannelFeedAdapter, RssNewsSourceAdapter } from './rss.js';
import { N8nWorkflowTrigger } from './workflow-trigger.js';
import { HttpASRAdapter, HttpTranslationAdapter, HttpTTSAdapter, HttpVideoRendererAdapter, workerAuthHeaders } from './worker-ports.js';
import { createAuthAdapterFromEnv } from './auth-port.js';
import { applyRunModeDefaults } from './run-mode.js';

function choice(value, fallback) {
  return String(value || fallback || '').trim().toLowerCase();
}

function intEnv(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name] ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(env, name, fallback = false) {
  const value = String(env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

/**
 * One composition root for every T5 adapter. Each port has a local default;
 * `*_ADAPTER=none` (or the documented equivalents) leaves it unset so the API
 * can keep serving the read/save surfaces without that capability.
 */
export function createAdaptersFromEnv({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runCommand = undefined,
  logger = console,
  authService = null,
} = {}) {
  // NEWSROOM_MODE supplies the adapter defaults; explicit variables win in
  // local mode, while demo mode forces the deterministic set (D10).
  env = applyRunModeDefaults(env);
  const pythonBin = String(env.PYTHON_BIN || 'python3').trim() || 'python3';
  const adapters = {};

  const llmKind = choice(env.LLM, 'ollama');
  if (llmKind === 'ollama') {
    adapters.llm = new OllamaLLMAdapter({
      baseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      model: env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      fetchImpl,
      timeoutMs: intEnv(env, 'LLM_TIMEOUT_MS', 300_000),
    });
  } else if (llmKind === 'demo') {
    adapters.llm = new DemoLLMAdapter();
  } else if (llmKind === 'openai') {
    adapters.llm = new OpenAICompatibleLLMAdapter({
      baseUrl: env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1',
      model: env.OPENAI_MODEL || env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      apiKey: env.OPENAI_API_KEY || '',
      fetchImpl,
      timeoutMs: intEnv(env, 'LLM_TIMEOUT_MS', 300_000),
    });
  } else {
    adapters.llm = null;
  }

  if (choice(env.NEWS_SOURCE, 'rss') !== 'none') {
    adapters.newsSource = new RssNewsSourceAdapter({
      fetchImpl,
      timeoutMs: intEnv(env, 'RSS_TIMEOUT_MS', 30_000),
    });
  }

  const articleKind = choice(env.ARTICLE_EXTRACTOR, 'trafilatura');
  if (articleKind === 'demo') {
    adapters.articleExtractor = new DemoArticleExtractor();
  } else if (articleKind !== 'none') {
    adapters.articleExtractor = new TrafilaturaArticleExtractor({
      pythonBin,
      scriptPath: env.LOCAL_ADAPTER_SCRIPT || undefined,
      timeoutMs: intEnv(env, 'ARTICLE_EXTRACT_TIMEOUT_MS', 60_000),
      ...(runCommand ? { runCommand } : {}),
    });
  }

  if (choice(env.IMAGE_SEARCH, 'searxng') !== 'none') {
    adapters.imageSearch = new SearxngWikimediaImageSearch({
      searxngUrl: env.SEARXNG_URL || 'http://127.0.0.1:8888',
      useWikimedia: boolEnv(env, 'IMAGE_SEARCH_WIKIMEDIA', true),
      fetchImpl,
      timeoutMs: intEnv(env, 'IMAGE_SEARCH_TIMEOUT_MS', 30_000),
    });
  }

  if (choice(env.DOCUMENT_EXPORT, 'local') !== 'none') {
    adapters.documentExport = new LocalDocumentExport({
      pythonBin,
      scriptPath: env.LOCAL_ADAPTER_SCRIPT || undefined,
      root: env.DOCUMENT_ROOT || './data/documents',
      timeoutMs: intEnv(env, 'DOCUMENT_EXPORT_TIMEOUT_MS', 60_000),
      ...(runCommand ? { runCommand } : {}),
    });
  }

  const notifyKind = choice(env.NOTIFY, 'console');
  if (notifyKind === 'smtp') {
    adapters.notification = new SmtpNotificationAdapter({
      host: env.SMTP_HOST || '127.0.0.1',
      port: intEnv(env, 'SMTP_PORT', 1025),
      secure: boolEnv(env, 'SMTP_SECURE', false),
      starttls: boolEnv(env, 'SMTP_STARTTLS', false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || 'newsroom@example.local',
      timeoutMs: intEnv(env, 'SMTP_TIMEOUT_MS', 15_000),
    });
  } else if (notifyKind === 'console') {
    adapters.notification = new ConsoleNotificationAdapter({ logger });
  } else {
    adapters.notification = null;
  }

  if (choice(env.WORKFLOW, 'none') === 'n8n') {
    adapters.workflowTrigger = new N8nWorkflowTrigger({
      baseUrl: env.N8N_WEBHOOK_BASE_URL || env.N8N_BASE_URL || 'http://127.0.0.1:5678',
      timeoutMs: intEnv(env, 'WORKFLOW_TIMEOUT_MS', 15_000),
      fetchImpl,
      ...(env.N8N_WEBHOOK_TOKEN ? { headers: { authorization: `Bearer ${env.N8N_WEBHOOK_TOKEN}` } } : {}),
    });
  } else {
    adapters.workflowTrigger = null;
  }

  if (choice(env.CHANNEL_FEED, 'rss') !== 'none') {
    adapters.channelFeed = new RssChannelFeedAdapter({
      fetchImpl,
      timeoutMs: intEnv(env, 'RSS_TIMEOUT_MS', 30_000),
      feedUrl: env.YOUTUBE_RSS_URL || 'https://www.youtube.com/feeds/videos.xml',
    });
  }

  // `yt-dlp` is the pre-T15 name for the same worker-backed adapter; keep it
  // working for existing .env files while no code spawns yt-dlp in Node.
  const mediaDownload = choice(env.MEDIA_DOWNLOAD, 'worker');
  if (mediaDownload === 'worker' || mediaDownload === 'yt-dlp') {
    adapters.mediaDownload = new WorkerMediaDownload({
      baseUrl: env.ASR_BASE_URL || 'http://127.0.0.1:8765',
      apiKey: env.ASR_API_KEY || '',
      fetchImpl,
      timeoutMs: intEnv(env, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 30 * 60 * 1000),
    });
  } else if (mediaDownload !== 'none') {
    throw new Error(`Unsupported MEDIA_DOWNLOAD adapter: ${mediaDownload}`);
  }


  const workerKinds = {
    tts: choice(env.TTS, 'worker'),
    asr: choice(env.ASR, 'worker'),
    translation: choice(env.TRANSLATION, 'worker'),
    renderer: choice(env.RENDERER, 'worker'),
  };
  if (workerKinds.tts === 'worker') {
    adapters.tts = new HttpTTSAdapter({
      baseUrl: env.TTS_BASE_URL || 'http://127.0.0.1:8088',
      fetchImpl,
      timeoutMs: intEnv(env, 'TTS_TIMEOUT_MS', 60_000),
      headers: workerAuthHeaders({ apiKey: env.TTS_API_KEY, basicUser: env.TTS_BASIC_USER, basicPass: env.TTS_BASIC_PASS }),
    });
  } else if (workerKinds.tts === 'demo') {
    adapters.tts = new DemoTTSAdapter();
  }
  if (workerKinds.asr === 'worker') {
    adapters.asr = new HttpASRAdapter({
      baseUrl: env.ASR_BASE_URL || 'http://127.0.0.1:8765',
      fetchImpl,
      timeoutMs: intEnv(env, 'ASR_TIMEOUT_MS', 120_000),
      headers: workerAuthHeaders({ apiKey: env.ASR_API_KEY }),
    });
  } else if (workerKinds.asr === 'demo') {
    adapters.asr = new DemoASRAdapter();
  }
  if (workerKinds.translation === 'worker') {
    adapters.translation = new HttpTranslationAdapter({
      baseUrl: env.SUBTITLES_BASE_URL || 'http://127.0.0.1:8092',
      fetchImpl,
      timeoutMs: intEnv(env, 'TRANSLATION_TIMEOUT_MS', 120_000),
      headers: workerAuthHeaders({ apiKey: env.SUBTITLES_API_KEY, basicUser: env.SUBTITLES_BASIC_USER, basicPass: env.SUBTITLES_BASIC_PASS }),
    });
  } else if (workerKinds.translation === 'demo') {
    adapters.translation = new DemoTranslationAdapter();
  }
  if (workerKinds.renderer === 'worker') {
    adapters.videoRenderer = new HttpVideoRendererAdapter({
      baseUrl: env.RENDERER_BASE_URL || 'http://127.0.0.1:8088',
      fetchImpl,
      timeoutMs: intEnv(env, 'RENDERER_TIMEOUT_MS', 30 * 60 * 1000),
      headers: workerAuthHeaders({ apiKey: env.RENDERER_API_KEY }),
    });
  } else if (workerKinds.renderer === 'demo') {
    adapters.videoRenderer = new DemoVideoRendererAdapter();
  }

  const authKind = choice(env.AUTH, 'local');
  if (authService || authKind !== 'local') {
    adapters.auth = createAuthAdapterFromEnv({ env, authService, fetchImpl });
  }

  return adapters;
}
