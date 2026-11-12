import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_TIMEOUT_MS = 30_000;

function withHeaders(headers = {}) {
  return { ...JSON_HEADERS, ...headers };
}

export function basicAuthHeader(user = '', pass = '') {
  const value = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Basic ${value}`;
}

export function workerAuthHeaders({ apiKey = '', basicUser = '', basicPass = '' } = {}) {
  const headers = {};
  if (apiKey) headers['x-api-key'] = String(apiKey);
  if (basicUser || basicPass) headers.authorization = basicAuthHeader(basicUser, basicPass);
  return headers;
}

function jsonBody(value) {
  return JSON.stringify(value ?? {});
}

async function readBinaryResponse(response, { adapter }) {
  if (!response?.ok) {
    const detail = await response?.text?.().catch(() => '');
    throw new AdapterError(`${adapter}_http_${response?.status || 'error'}`, `${adapter} request failed (HTTP ${response?.status || 'unknown'}): ${String(detail || '').slice(0, 300)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    content_type: String(response.headers?.get?.('content-type') || 'application/octet-stream'),
  };
}

function projectView(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const projectId = data.project_id ?? data.projectId ?? data.id ?? '';
  const status = data.status ?? data.render?.status ?? 'queued';
  return {
    project_id: String(projectId),
    status: String(status),
    ...(data.output ? { output: String(data.output) } : {}),
    ...(data.render ? { render: data.render } : {}),
  };
}

/** HTTP client for the TTS orchestrator (`services/tts-worker`). */
export class HttpTTSAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8088', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = { ...headers };
  }

  async createJob({ text = '', title = '', requestId = '', voiceProfile = 'default' } = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/tts/jobs`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: withHeaders(this.headers),
      body: jsonBody({ text, ...(title ? { title } : {}), ...(requestId ? { request_id: requestId } : {}), voice_profile: voiceProfile }),
    });
    const payload = await readJsonResponse(response, { adapter: 'tts' });
    return { job_id: String(payload?.job_id || ''), status: String(payload?.status || 'queued') };
  }

  async getJob(jobId = '') {
    const id = encodeURIComponent(String(jobId));
    if (!id) throw new AdapterError('tts_job_id_required', 'TTS job id is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/tts/jobs/${id}`, { timeoutMs: this.timeoutMs });
    const payload = await readJsonResponse(response, { adapter: 'tts' });
    return {
      job_id: String(payload?.job_id || jobId),
      status: String(payload?.status || 'queued'),
      ...(payload?.download_url ? { download_url: String(payload.download_url) } : {}),
    };
  }

  async download(jobId = '') {
    const id = encodeURIComponent(String(jobId));
    if (!id) throw new AdapterError('tts_job_id_required', 'TTS job id is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/tts/jobs/${id}/download`, { timeoutMs: this.timeoutMs });
    return readBinaryResponse(response, { adapter: 'tts' });
  }
}

/** HTTP client for the ASR worker (`services/asr-worker`). */
export class HttpASRAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8765', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = { ...headers };
  }

  async transcribe({ audioPath = '', language = null } = {}) {
    const path = String(audioPath || '').trim();
    if (!path) throw new AdapterError('asr_audio_path_required', 'audioPath is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/radar/transcribe`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: withHeaders(this.headers),
      body: jsonBody({ audio_path: path, ...(language ? { language } : {}) }),
    });
    const payload = await readJsonResponse(response, { adapter: 'asr' });
    return {
      segments: Array.isArray(payload?.segments) ? payload.segments : [],
      ...(payload?.language ? { language: String(payload.language) } : {}),
      ...(payload?.device ? { device: String(payload.device) } : {}),
      fallback_used: payload?.fallback_used === true,
    };
  }
}

/** HTTP client for the subtitles service translation endpoint. */
export class HttpTranslationAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8092', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = { ...headers };
  }

  async translate({ segments = [], sourceLanguage = 'auto', targetLanguage = 'es' } = {}) {
    if (!Array.isArray(segments)) throw new AdapterError('translation_segments_invalid', 'segments must be an array', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/subtitles/translate`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: withHeaders(this.headers),
      body: jsonBody({ segments, source_language: sourceLanguage, target_language: targetLanguage }),
    });
    const payload = await readJsonResponse(response, { adapter: 'translation' });
    return {
      segments: Array.isArray(payload?.segments) ? payload.segments : [],
      target_language: String(payload?.target_language || targetLanguage),
    };
  }
}

/** HTTP client for the renderer/approval project API (`services/renderer`). */
export class HttpVideoRendererAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8088', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = { ...headers };
  }

  async createProject(payload = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/projects/create-from-approval`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: withHeaders(this.headers),
      body: jsonBody(payload),
    });
    return projectView(await readJsonResponse(response, { adapter: 'renderer' }));
  }

  async renderProject(projectId = '', { snapshotHash = '', profile = 'final', async = true } = {}) {
    const id = encodeURIComponent(String(projectId));
    if (!id) throw new AdapterError('renderer_project_id_required', 'projectId is required', { statusCode: 400 });
    const suffix = profile === 'preview' ? 'render-preview' : 'render-final';
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/projects/${id}/${suffix}`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: withHeaders(this.headers),
      body: jsonBody({ snapshotHash, async }),
    });
    return projectView(await readJsonResponse(response, { adapter: 'renderer' }));
  }

  async getRenderStatus(projectId = '') {
    const id = encodeURIComponent(String(projectId));
    if (!id) throw new AdapterError('renderer_project_id_required', 'projectId is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/projects/${id}/status`, { timeoutMs: this.timeoutMs });
    return projectView(await readJsonResponse(response, { adapter: 'renderer' }));
  }

  async downloadRender(projectId = '') {
    const id = encodeURIComponent(String(projectId));
    if (!id) throw new AdapterError('renderer_project_id_required', 'projectId is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/projects/${id}/download/final`, { timeoutMs: this.timeoutMs });
    return readBinaryResponse(response, { adapter: 'renderer' });
  }
}
