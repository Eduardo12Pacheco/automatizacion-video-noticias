import { DemoAuthAdapter } from './demo.js';
import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_TIMEOUT_MS = 15_000;

function required(value, code, message) {
  const text = String(value || '').trim();
  if (!text) throw new AdapterError(code, message, { statusCode: 400 });
  return text;
}

/**
 * Real auth adapter for the bundled API: it wraps the repository-backed auth
 * service so callers depend on AuthPort instead of the concrete service.
 */
export class LocalAuthAdapter {
  constructor({ authService } = {}) {
    if (!authService) throw new Error('authService is required');
    this.authService = authService;
  }

  authenticate(input = {}) {
    return this.authService.authenticate(input);
  }

  createSession(input = {}) {
    return this.authService.createSession(input);
  }

  getSession(token = '') {
    return this.authService.getSession(token);
  }

  revokeSession(token = '') {
    return this.authService.revokeSession(token);
  }
}

/**
 * HTTP adapter for a future split auth deployment. The contract mirrors the
 * local service: POST /api/auth/authenticate, POST /api/auth/sessions,
 * GET/DELETE /api/auth/sessions/:token.
 */
export class HttpAuthAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8099', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async authenticate({ user = '', password = '' } = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/auth/authenticate`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ user, password }),
    });
    return readJsonResponse(response, { adapter: 'auth' });
  }

  async createSession(payload = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/auth/sessions`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    return readJsonResponse(response, { adapter: 'auth' });
  }

  async getSession(token = '') {
    const value = required(token, 'auth_token_required', 'session token is required');
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/auth/sessions/${encodeURIComponent(value)}`, { timeoutMs: this.timeoutMs });
    const payload = await readJsonResponse(response, { adapter: 'auth' });
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'session')) return payload.session ?? null;
    return payload || null;
  }

  async revokeSession(token = '') {
    const value = required(token, 'auth_token_required', 'session token is required');
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/auth/sessions/${encodeURIComponent(value)}`, {
      timeoutMs: this.timeoutMs,
      method: 'DELETE',
    });
    if (!response?.ok && response?.status !== 204) {
      throw new AdapterError(`auth_http_${response?.status || 'error'}`, `auth request failed (HTTP ${response?.status || 'unknown'})`);
    }
    return undefined;
  }
}

export function createAuthAdapterFromEnv({ env = process.env, authService = null, fetchImpl = globalThis.fetch } = {}) {
  const kind = String(env.AUTH || 'local').trim().toLowerCase();
  if (kind === 'http') return new HttpAuthAdapter({ baseUrl: env.AUTH_BASE_URL || 'http://127.0.0.1:8099', fetchImpl });
  if (kind === 'demo') return new DemoAuthAdapter();
  if (kind === 'none') return null;
  if (!authService) throw new Error('authService is required for AUTH=local');
  return new LocalAuthAdapter({ authService });
}
