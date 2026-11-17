/**
 * Two real run modes.
 *
 * `demo` is instant and deterministic: every AI/media capability uses the
 * stub adapters and no model download is required. `local` is the real local
 * stack: Ollama, trafilatura, Piper and faster-whisper through the worker
 * HTTP ports.
 *
 * Mode selection lives in one place so the API composition root, the gateway
 * proxy targets and the panel bootstrap cannot drift apart. An explicit
 * adapter variable always wins in `local` mode; in `demo` mode the stubs are
 * forced so a leftover `LLM=ollama` cannot turn a demo into a model download.
 */
export const RUN_MODES = Object.freeze(['demo', 'local']);
export const DEFAULT_RUN_MODE = 'local';

export const DEMO_ADAPTER_DEFAULTS = Object.freeze({
  LLM: 'demo',
  ARTICLE_EXTRACTOR: 'demo',
  TTS: 'demo',
  ASR: 'demo',
  TRANSLATION: 'demo',
  RENDERER: 'demo',
  MEDIA_DOWNLOAD: 'none',
  DOCUMENT_EXPORT: 'local',
  NOTIFY: 'console',
});

export const LOCAL_ADAPTER_DEFAULTS = Object.freeze({
  LLM: 'ollama',
  ARTICLE_EXTRACTOR: 'trafilatura',
  TTS: 'worker',
  ASR: 'worker',
  TRANSLATION: 'worker',
  RENDERER: 'worker',
  MEDIA_DOWNLOAD: 'worker',
  DOCUMENT_EXPORT: 'local',
  NOTIFY: 'console',
});

export const DEMO_ROUTE_TARGETS = Object.freeze({
  tts: 'http://demo-worker:8088',
  subtitles: 'http://demo-worker:8088',
  remotion: 'http://demo-worker:8088',
  radar: 'http://demo-worker:8088',
  monitor: 'http://demo-worker:8088',
  approval: 'http://approval-editor:3042',
});

export const LOCAL_ROUTE_TARGETS = Object.freeze({
  tts: 'http://tts-worker:8766',
  subtitles: 'http://subtitles:8092',
  remotion: 'http://renderer:3042',
  approval: 'http://approval-editor:3042',
  radar: 'http://asr-worker:8765',
  monitor: 'http://channel-monitor:8790',
});

export function resolveRunMode(env = {}) {
  const value = String(env?.NEWSROOM_MODE || '').trim().toLowerCase();
  return RUN_MODES.includes(value) ? value : DEFAULT_RUN_MODE;
}

export function isDemoMode(env = {}) {
  return resolveRunMode(env) === 'demo';
}

/**
 * Return a copy of the environment with mode-derived adapter defaults. Only
 * missing or empty values are filled in local mode; demo mode forces its
 * deterministic set because that is what "demo" promises to the visitor.
 */
export function applyRunModeDefaults(env = {}) {
  const mode = resolveRunMode(env);
  const defaults = mode === 'demo' ? DEMO_ADAPTER_DEFAULTS : LOCAL_ADAPTER_DEFAULTS;
  const resolved = { ...env, NEWSROOM_MODE: mode };

  for (const [key, value] of Object.entries(defaults)) {
    const current = String(resolved[key] ?? '').trim();
    if (!current || mode === 'demo') resolved[key] = value;
  }

  if (mode === 'local') {
    if (!String(resolved.OLLAMA_MODEL || '').trim()) resolved.OLLAMA_MODEL = 'qwen2.5:3b-instruct';
    if (!String(resolved.PIPER_MODEL || '').trim()) resolved.PIPER_MODEL = 'es_ES-davefx-medium';
    if (!String(resolved.WHISPER_MODEL || '').trim()) resolved.WHISPER_MODEL = 'small';
  }

  return resolved;
}

/**
 * Proxy targets for the gateway. Demo mode keeps every media route on the
 * deterministic demo worker; local mode points at the real CPU workers. An
 * explicit `API_GATEWAY_<SERVICE>_TARGET` still overrides either default.
 */
export function resolveModeRouteTargets(env = {}) {
  return resolveRunMode(env) === 'demo' ? { ...DEMO_ROUTE_TARGETS } : { ...LOCAL_ROUTE_TARGETS };
}
