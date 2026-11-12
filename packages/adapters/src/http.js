export class AdapterError extends Error {
  constructor(code, message, { statusCode = 502, cause = null } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

export function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export async function readJsonResponse(response, { adapter = 'adapter' } = {}) {
  const status = Number(response?.status ?? 0);
  const text = typeof response?.text === 'function' ? await response.text() : '';
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response?.ok) {
    const detail = parsed?.error?.message || parsed?.error || parsed?.message || text.slice(0, 300);
    throw new AdapterError(`${adapter}_http_${status || 'error'}`, `${adapter} request failed (HTTP ${status || 'unknown'}): ${detail}`);
  }
  if (parsed === null && text) {
    throw new AdapterError(`${adapter}_invalid_json`, `${adapter} returned a non-JSON response`);
  }
  return parsed;
}

export async function fetchWithTimeout(fetchImpl, url, { timeoutMs = 30_000, ...options } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;
  try {
    return await fetchImpl(url, { ...options, signal: controller?.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AdapterError('adapter_timeout', `Request timed out after ${timeoutMs} ms`, { cause: error });
    }
    throw new AdapterError('adapter_unreachable', String(error?.message || error), { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
