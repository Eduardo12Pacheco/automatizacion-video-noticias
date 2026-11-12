import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

const ALLOWED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

export function validateYouTubeUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new AdapterError('invalid_url', 'Media URL must be an absolute http(s) URL', { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AdapterError('invalid_url', 'Media URL must use http or https', { statusCode: 400 });
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AdapterError('invalid_url', 'Media URL host is not allowed', { statusCode: 400 });
  }
  return url.toString();
}

/**
 * MediaDownloadPort backed by the ASR worker's `/api/radar/download` endpoint.
 * yt-dlp runs only in the Python worker (shared `newsroom-media` package), so
 * the API container does not duplicate its arguments or failure taxonomy.
 */
export class WorkerMediaDownload {
  constructor({
    baseUrl = 'http://127.0.0.1:8765',
    apiKey = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = 30 * 60 * 1000,
  } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30 * 60 * 1000);
  }

  async download({ url = '', jobDir = '' } = {}) {
    const target = validateYouTubeUrl(url);
    const directory = String(jobDir || '').trim();
    if (!directory) throw new AdapterError('job_dir_missing', 'jobDir is required', { statusCode: 400 });

    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/radar/download`, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      },
      body: JSON.stringify({ url: target, job_dir: directory }),
    });
    if (!response?.ok) {
      const text = typeof response?.text === 'function' ? await response.text() : '';
      let detail;
      try {
        detail = text ? JSON.parse(text) : null;
      } catch {
        detail = null;
      }
      const code = detail?.detail?.code || `media_download_http_${response?.status || 'error'}`;
      const message = detail?.detail?.message || text.slice(0, 300) || `media download failed (HTTP ${response?.status || 'unknown'})`;
      throw new AdapterError(code, message);
    }
    const payload = await readJsonResponse(response, { adapter: 'media_download' });
    if (!payload?.path) throw new AdapterError('media_download_no_output', 'The media worker did not return a file path');
    return { path: payload.path, title: payload.title ?? null };
  }
}
