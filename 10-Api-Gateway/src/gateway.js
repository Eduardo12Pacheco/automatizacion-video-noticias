import http from 'node:http';
import https from 'node:https';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEFAULT_EVENT_RETENTION, JsonlEventRecorder, sanitizeEventContext, selectCorrelationId } from './gateway-events.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8099;

export const DEFAULT_ROUTES = Object.freeze({
  n8n: { prefix: '/n8n', target: 'http://127.0.0.1:5678' },
  tts: { prefix: '/tts', target: 'http://127.0.0.1:8088' },
  subtitles: { prefix: '/subtitles', target: 'http://127.0.0.1:8092' },
  radar: { prefix: '/radar', target: 'http://127.0.0.1:8765' },
  monitor: { prefix: '/monitor', target: 'http://127.0.0.1:8775' },
  remotion: { prefix: '/remotion', target: 'https://remotion-api.example.local' },
  approval: { prefix: '/approval', target: 'http://127.0.0.1:3042' },
});

export const DEFAULT_ALLOWED_HEADERS = Object.freeze([
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-approval-secret',
  'x-user-email',
  'x-user-roles',
  'x-control-panel-shell-version',
  'range',
]);

export const DEFAULT_ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const DEFAULT_EXPOSED_HEADERS = Object.freeze([
  'content-disposition',
  'content-length',
  'content-type',
  'content-range',
  'accept-ranges',
]);

export const DEFAULT_PANEL_BOOTSTRAP = Object.freeze({
  appVersion: '0.1.0',
  settingsVersion: 'gateway-defaults-v1',
  apiOrigin: 'https://api.example.local',
  minShellVersion: '0.1.0',
  featureFlags: {},
});

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_RENDER_UPSTREAM_TIMEOUT_MS = 120_000;
export const DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_PANEL_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const DEFAULT_PRESENCE_TTL_MS = 60_000;

const SERVICE_CREDENTIAL_ENV = Object.freeze({
  n8n: Object.freeze({ apiKey: 'API_GATEWAY_N8N_API_KEY' }),
  tts: Object.freeze({ apiKey: 'API_GATEWAY_TTS_API_KEY', basicUser: 'API_GATEWAY_TTS_BASIC_USER', basicPass: 'API_GATEWAY_TTS_BASIC_PASS' }),
  subtitles: Object.freeze({ apiKey: 'API_GATEWAY_SUBTITLES_API_KEY', basicUser: 'API_GATEWAY_SUBTITLES_BASIC_USER', basicPass: 'API_GATEWAY_SUBTITLES_BASIC_PASS' }),
  radar: Object.freeze({ apiKey: 'API_GATEWAY_RADAR_API_KEY' }),
  monitor: Object.freeze({ apiKey: 'API_GATEWAY_MONITOR_API_KEY' }),
  approval: Object.freeze({ approvalSecret: 'API_GATEWAY_APPROVAL_SECRET' }),
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SECRET_LOG_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret']);
const SECRET_RESPONSE_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret', 'set-cookie']);
const CORS_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]);
const PANEL_SESSION_COOKIE = 'approval-panel-session-v1';
const BROWSER_SUPPLIED_IDENTITY_HEADERS = new Set(['x-user-email', 'x-user-roles', 'x-audit-actor']);
const BROWSER_SUPPLIED_SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret']);
const PROTECTED_MUTATION_ROLE = 'editor';
const LOCAL_SERVICE_NAMES = new Set(['tts', 'subtitles', 'radar', 'monitor', 'approval']);
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PANEL_READ_MODEL_PREFIX = '/panel/read-models';
const GATEWAY_EVENTS_READ_MODEL_PATH = '/panel/read-models/gateway/events';
const GATEWAY_PRESENCE_READ_MODEL_PATH = '/panel/read-models/gateway/presence';
const PANEL_PRESENCE_HEARTBEAT_PATH = '/panel/presence/heartbeat';
const PREPARE_ROUTE_SERVICES = new Set(['approval', 'remotion']);

function resolveRouteUpstreamTimeoutMs(service, upstreamPath) {
  if (service === 'subtitles' && /^\/api\/subtitles\/sessions\/[^/]+\/render(?:\?|$)/.test(upstreamPath)) {
    return DEFAULT_RENDER_UPSTREAM_TIMEOUT_MS;
  }
  if (PREPARE_ROUTE_SERVICES.has(service) && /^\/api\/projects\/create-from-approval(?:\?|$)/.test(upstreamPath)) {
    return DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS;
  }
  return null;
}

function isBrowserSuppliedIdentityHeader(name) {
  const lowerName = String(name || '').toLowerCase();
  return BROWSER_SUPPLIED_IDENTITY_HEADERS.has(lowerName)
    || lowerName.startsWith('x-panel-actor-')
    || lowerName === 'x-panel-session-id';
}

class GatewayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayConfigError';
    this.code = 'gateway_config_error';
  }
}

class PayloadTooLargeError extends Error {
  constructor(message = 'payload_too_large') {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.code = 'payload_too_large';
  }
}

function normalizePrefix(prefix) {
  const clean = `/${String(prefix || '').replace(/^\/+|\/+$/g, '')}`;
  return clean === '/' ? '' : clean;
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function decodePathPrefix(value, maxPasses = 2) {
  let decoded = String(value || '');
  for (let index = 0; index < maxPasses; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function isProtocolRelativeUpstreamPath(path) {
  const normalized = decodePathPrefix(path).replace(/\\/g, '/');
  return normalized.startsWith('//');
}

export function resolveRoute(rawUrl, routes = DEFAULT_ROUTES) {
  const matches = resolveRouteMatches(rawUrl, routes);
  return matches.length === 1 ? matches[0] : null;
}

function resolveRouteMatches(rawUrl, routes = DEFAULT_ROUTES) {
  const parsed = new URL(rawUrl, 'http://gateway.local');
  const matches = [];
  for (const [service, route] of Object.entries(routes)) {
    const prefix = normalizePrefix(route.prefix);
    if (!prefix || !matchesPrefix(parsed.pathname, prefix)) continue;
    const strippedPath = parsed.pathname.slice(prefix.length) || '/';
    if (isProtocolRelativeUpstreamPath(strippedPath)) continue;
    const upstreamPath = `${strippedPath}${parsed.search}`;
    const upstreamTimeoutMs = resolveRouteUpstreamTimeoutMs(service, upstreamPath);
    matches.push({
      service,
      target: route.target,
      upstreamPath,
      ...(upstreamTimeoutMs ? { upstreamTimeoutMs } : {}),
    });
  }
  return matches;
}

export function sanitizeHeadersForLog(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SECRET_LOG_HEADERS.has(name.toLowerCase()) ? '<redacted>' : value,
    ]),
  );
}

function removeHopByHopHeaders(headers = {}) {
  const clean = {};
  const connectionTokens = String(headers.connection || '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens]);
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase())) clean[name] = value;
  }
  return clean;
}

function splitCsvHeader(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isCorsAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return false;
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function isHttpHeaderToken(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function isValidOriginString(value) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function validateCorsMethods(allowedMethods) {
  const supportedMethods = new Set(DEFAULT_ALLOWED_METHODS);
  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0) {
    throw new GatewayConfigError('allowedMethods must be a non-empty array of supported HTTP methods');
  }
  for (const method of allowedMethods) {
    if (!isHttpHeaderToken(method) || method !== method.toUpperCase() || !supportedMethods.has(method)) {
      throw new GatewayConfigError(`allowedMethods contains unsupported or malformed method '${method}'`);
    }
  }
}

function validateHeaderNames(headerNames, fieldName) {
  if (!Array.isArray(headerNames)) {
    throw new GatewayConfigError(`${fieldName} must be an array of HTTP header names`);
  }
  for (const headerName of headerNames) {
    if (!isHttpHeaderToken(headerName)) {
      throw new GatewayConfigError(`${fieldName} contains malformed header name '${headerName}'`);
    }
  }
}

function validateTrustedMutationOrigins(trustedMutationOrigins) {
  if (trustedMutationOrigins == null) return;
  if (!Array.isArray(trustedMutationOrigins)) {
    throw new GatewayConfigError('trustedMutationOrigins must be an array of explicit origin strings');
  }
  for (const origin of trustedMutationOrigins) {
    if (origin === '*' || !isValidOriginString(origin)) {
      throw new GatewayConfigError('trustedMutationOrigins must contain only explicit http(s) origins');
    }
  }
}

function validateRoutePrefixes(routes) {
  const prefixes = [];
  for (const [service, route] of Object.entries(routes || {})) {
    const prefix = normalizePrefix(route?.prefix);
    if (!prefix) {
      throw new GatewayConfigError(`Route '${service}' prefix must be a non-empty absolute prefix`);
    }
    prefixes.push([service, prefix]);
  }
  for (let left = 0; left < prefixes.length; left += 1) {
    for (let right = left + 1; right < prefixes.length; right += 1) {
      const [leftService, leftPrefix] = prefixes[left];
      const [rightService, rightPrefix] = prefixes[right];
      if (leftPrefix === rightPrefix || matchesPrefix(rightPrefix, leftPrefix) || matchesPrefix(leftPrefix, rightPrefix)) {
        throw new GatewayConfigError(`Route prefixes for '${leftService}' and '${rightService}' are ambiguous`);
      }
    }
  }
}

export class BoundedTtlStore {
  constructor({ maxEntries = 1_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new GatewayConfigError('BoundedTtlStore maxEntries must be a positive safe integer');
    }
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key, nowMs = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, { ttlMs, nowMs = Date.now() } = {}) {
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : Number.POSITIVE_INFINITY;
    this.cleanup(nowMs);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: nowMs + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  delete(key) {
    return this.entries.delete(key);
  }

  cleanup(nowMs = Date.now()) {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }
}

function isTrustedMutationOrigin(origin, trustedMutationOrigins) {
  if (!origin) return false;
  return trustedMutationOrigins.some((trustedOrigin) => trustedOrigin !== '*' && trustedOrigin === origin);
}

function applyCorsHeaders(res, origin, options) {
  const { allowedOrigins, allowedMethods, allowedHeaders, exposedHeaders } = options;
  if (!origin || !isCorsAllowedOrigin(origin, allowedOrigins)) return false;
  const hasWildcard = allowedOrigins.includes('*');
  const exactOriginAllowed = allowedOrigins.includes(origin);
  // Wildcard presence means non-credentialed CORS mode — never set ACAC: true.
  res.setHeader('Access-Control-Allow-Origin', exactOriginAllowed && !hasWildcard ? origin : (exactOriginAllowed ? origin : '*'));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(','));
  res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
  res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(','));
  if (exactOriginAllowed && !hasWildcard) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return true;
}

function routePrefixesForBootstrap(routes = DEFAULT_ROUTES) {
  return Object.fromEntries(
    Object.entries(routes).map(([service, route]) => [service, normalizePrefix(route.prefix) || '/']),
  );
}

function normalizePanelBootstrap(panelBootstrap = {}, routes = DEFAULT_ROUTES) {
  const merged = { ...DEFAULT_PANEL_BOOTSTRAP, ...(panelBootstrap || {}) };
  return {
    app_version: String(merged.appVersion || DEFAULT_PANEL_BOOTSTRAP.appVersion),
    settings_version: String(merged.settingsVersion || DEFAULT_PANEL_BOOTSTRAP.settingsVersion),
    api_origin: String(merged.apiOrigin || DEFAULT_PANEL_BOOTSTRAP.apiOrigin).replace(/\/+$/, ''),
    min_shell_version: String(merged.minShellVersion || DEFAULT_PANEL_BOOTSTRAP.minShellVersion),
    routes: routePrefixesForBootstrap(routes),
    feature_flags: merged.featureFlags && typeof merged.featureFlags === 'object' ? merged.featureFlags : {},
  };
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function requestPath(req) {
  return new URL(req.url || '/', 'http://gateway.local').pathname;
}

function requestBaseContext(req, extra = {}) {
  return {
    headers: req.headers,
    ...extra,
  };
}

function actorFromSession(session) {
  if (!session) return null;
  return {
    user_id: session.user?.user_id,
    email: session.user?.email,
    display_name: session.user?.display_name,
    roles: session.roles,
  };
}

function presenceTtlSeconds(options) {
  return Math.ceil(options.presenceTtlMs / 1000);
}

function normalizePresencePayload(body = {}) {
  const area = String(body.area || '').trim();
  const resourceType = String(body.resource_type || body.resourceType || '').trim();
  const resourceId = String(body.resource_id || body.resourceId || '').trim();
  const mode = String(body.mode || '').trim();
  if (!area || !resourceType || !resourceId || !['viewing', 'editing'].includes(mode)) return null;
  return {
    area,
    resource_type: resourceType,
    resource_id: resourceId,
    mode,
  };
}

function presenceSessionEntry(session, payload, nowMs) {
  return {
    session_id: session.session_id,
    actor: {
      user_id: session.user.user_id,
      email: session.user.email,
      display_name: session.user.display_name,
    },
    area: payload.area,
    resource_type: payload.resource_type,
    resource_id: payload.resource_id,
    mode: payload.mode,
    last_activity_at: new Date(nowMs).toISOString(),
  };
}

function presenceSnapshot(options) {
  const nowMs = options.now();
  options.presenceStore.cleanup(nowMs);
  const sessions = [...options.presenceStore.entries.values()].map((entry) => entry.value);
  const resourcesByKey = new Map();
  for (const session of sessions) {
    const key = `${session.area}\u0000${session.resource_type}\u0000${session.resource_id}`;
    const resource = resourcesByKey.get(key) || {
      area: session.area,
      resource_type: session.resource_type,
      resource_id: session.resource_id,
      sessions: [],
    };
    resource.sessions.push(session.session_id);
    resourcesByKey.set(key, resource);
  }
  for (const resource of resourcesByKey.values()) resource.sessions.sort();
  return {
    sessions: sessions.sort((left, right) => left.session_id.localeCompare(right.session_id)),
    resources: [...resourcesByKey.values()],
    ttl_seconds: presenceTtlSeconds(options),
  };
}

function emitGatewayEvent(req, options, event, session = null) {
  const recorder = options.eventRecorder;
  if (!recorder || typeof recorder.record !== 'function') return;
  const record = {
    correlation_id: req.gatewayCorrelationId,
    actor: actorFromSession(session),
    session_id: session?.session_id,
    origin: req.headers.origin,
    ip: req.socket?.remoteAddress,
    method: req.method,
    path: requestPath(req),
    ...event,
  };
  if (record.context) record.context = sanitizeEventContext(record.context);
  Promise.resolve(recorder.record(record)).catch((error) => {
    options.logger.warn?.('gateway event record failed', sanitizeEventContext({
      error: error?.message || 'record_failed',
      event: {
        kind: record.kind,
        action: record.action,
        correlation_id: record.correlation_id,
        reason_code: record.reason_code,
      },
    }));
  });
}

function buildBasicAuthorization(user, pass) {
  const username = String(user || '').trim();
  const password = String(pass || '');
  if (!username || !password) return '';
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function readServiceCredentialsFromEnv(env = process.env) {
  const sharedApiKey = String(env.API_GATEWAY_SHARED_API_KEY || '').trim();
  const sharedBasicUser = String(env.API_GATEWAY_SHARED_BASIC_USER || '').trim();
  const sharedBasicPass = String(env.API_GATEWAY_SHARED_BASIC_PASS || '');
  const credentials = {};

  for (const [service, names] of Object.entries(SERVICE_CREDENTIAL_ENV)) {
    const serviceCredentials = {};
    const apiKey = String(env[names.apiKey] || sharedApiKey || '').trim();
    const basicUser = String(env[names.basicUser] || sharedBasicUser || '').trim();
    const basicPass = String(env[names.basicPass] || sharedBasicPass || '');
    const basicAuthorization = buildBasicAuthorization(basicUser, basicPass);

    if (apiKey) serviceCredentials['x-api-key'] = apiKey;
    if (basicAuthorization) serviceCredentials.authorization = basicAuthorization;
    if (names.approvalSecret) {
      const approvalSecret = String(env[names.approvalSecret] || '').trim();
      if (approvalSecret) serviceCredentials['x-approval-secret'] = approvalSecret;
    }
    if (Object.keys(serviceCredentials).length) credentials[service] = serviceCredentials;
  }

  return credentials;
}

export function readPanelAuthFromEnv(env = process.env) {
  const user = String(env.API_GATEWAY_PANEL_USER || '').trim();
  const pass = String(env.API_GATEWAY_PANEL_PASS || '');
  if (!user || !pass) return null;
  const email = String(env.API_GATEWAY_PANEL_EMAIL || `${user}@control-panel.local`).trim();
  const displayName = String(env.API_GATEWAY_PANEL_DISPLAY_NAME || email || user).trim();
  return {
    user,
    pass,
    profile: {
      user: {
        user_id: user,
        email,
        display_name: displayName,
      },
      roles: ['editor'],
    },
  };
}

function safeDecodeCookiePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = '') {
  const cookies = new Map();
  for (const part of String(cookieHeader || '').split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (!rawName) continue;
    const name = safeDecodeCookiePart(rawName);
    const value = safeDecodeCookiePart(rawValueParts.join('='));
    if (name == null || value == null) continue;
    cookies.set(name, value);
  }
  return cookies;
}

function readPanelSessionToken(req) {
  return parseCookies(req.headers.cookie).get(PANEL_SESSION_COOKIE) || '';
}

function isCrossSitePanelRequest(req) {
  const origin = String(req.headers.origin || '').trim();
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!origin || !host) return false;
  try {
    return new URL(origin).hostname.toLowerCase() !== host;
  } catch {
    return false;
  }
}

function serializePanelSessionCookie(value, { maxAgeSeconds, crossSite = false } = {}) {
  const sameSite = crossSite ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `${encodeURIComponent(PANEL_SESSION_COOKIE)}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; ${sameSite}`;
}

function normalizePanelSession(rawSession = {}) {
  const user = rawSession.user && typeof rawSession.user === 'object' ? rawSession.user : {};
  const roles = Array.isArray(rawSession.roles) ? rawSession.roles.map((role) => String(role)) : [];
  return {
    user: {
      user_id: String(user.user_id || user.id || ''),
      email: String(user.email || ''),
      display_name: String(user.display_name || user.name || user.email || ''),
    },
    roles,
    session_id: String(rawSession.session_id || rawSession.sessionId || ''),
    expires_at: rawSession.expires_at || rawSession.expiresAt || null,
  };
}

function sessionResponse(session) {
  const normalized = normalizePanelSession(session);
  return {
    user: normalized.user,
    roles: normalized.roles,
    session_id: normalized.session_id,
  };
}

function toExpirationTime(value) {
  if (value == null || value === '') return Number.POSITIVE_INFINITY;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isExpiredSession(session, nowMs) {
  return toExpirationTime(session.expires_at) <= nowMs;
}

function cleanupExpiredSessions(options) {
  options.panelSessions.cleanup(options.now());
}

function normalizePanelUser(rawUser = {}) {
  const username = String(rawUser.user || rawUser.username || '').trim();
  const pass = rawUser.pass ?? rawUser.password;
  const passwordHash = rawUser.password_hash ?? rawUser.passwordHash;
  if (!username || (!pass && !passwordHash)) return null;
  const email = String(rawUser.email || `${username}@control-panel.local`).trim();
  const displayName = String(rawUser.display_name || rawUser.displayName || email || username).trim();
  const roles = Array.isArray(rawUser.roles) && rawUser.roles.length
    ? rawUser.roles.map((role) => String(role))
    : ['editor'];
  return {
    user: username,
    pass: pass == null ? null : String(pass),
    password_hash: passwordHash == null ? null : String(passwordHash),
    profile: {
      user: {
        user_id: String(rawUser.user_id || rawUser.userId || username),
        email,
        display_name: displayName,
      },
      roles,
    },
  };
}

function verifyScryptPassword(password, passwordHash) {
  const parts = String(passwordHash || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false;
  const [, , salt, expectedValue] = parts;
  const expected = Buffer.from(expectedValue, 'base64url');
  if (!salt || expected.length === 0) return false;
  const actual = scryptSync(String(password || ''), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function verifyPanelUserPassword(panelUser, password) {
  if (!panelUser) return false;
  if (panelUser.password_hash) return verifyScryptPassword(password, panelUser.password_hash);
  return panelUser.pass != null && String(password) === panelUser.pass;
}

function normalizePanelUsers(panelUsers, panelAuth) {
  const configured = Array.isArray(panelUsers) ? panelUsers : [];
  const users = configured.map(normalizePanelUser).filter(Boolean);
  if (!users.length && panelAuth?.user && panelAuth?.pass) {
    const fallback = normalizePanelUser({
      user: panelAuth.user,
      pass: panelAuth.pass,
      ...(panelAuth.profile?.user || {}),
      roles: panelAuth.profile?.roles || ['editor'],
    });
    if (fallback) users.push(fallback);
  }
  return new Map(users.map((user) => [user.user, user]));
}

export function readPanelUsersFromEnv(env = process.env) {
  const filePath = String(env.API_GATEWAY_PANEL_USERS_FILE || '').trim();
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.users)) return parsed.users;
    throw new GatewayConfigError('API_GATEWAY_PANEL_USERS_FILE must contain an array or { users: [] }');
  }
  const inline = String(env.API_GATEWAY_PANEL_USERS || '').trim();
  if (inline) {
    const parsed = JSON.parse(inline);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.users)) return parsed.users;
    throw new GatewayConfigError('API_GATEWAY_PANEL_USERS must contain an array or { users: [] }');
  }
  const fallback = readPanelAuthFromEnv(env);
  return fallback ? [{ user: fallback.user, pass: fallback.pass, ...(fallback.profile.user || {}), roles: fallback.profile.roles }] : [];
}

function getVerifiedSession(req, options) {
  cleanupExpiredSessions(options);
  const token = readPanelSessionToken(req);
  if (!token) return null;
  const session = options.panelSessions.get(token, options.now());
  if (!session) return null;
  return { token, ...normalizePanelSession(session) };
}

function readJsonBody(req, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      reject(new PayloadTooLargeError());
      return;
    }
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readRawBody(req, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      reject(new PayloadTooLargeError());
      return;
    }
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function handlePanelSession(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = getVerifiedSession(req, options);
  if (!session) {
    writeJson(res, 401, { error: 'unauthenticated', code: 'unauthenticated' }, {
      'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    });
    return;
  }
  writeJson(res, 200, sessionResponse(session), {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

async function handlePanelLogin(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  if (!isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { action: 'panel.login' });
    return;
  }

  const clientKey = req.socket.remoteAddress || 'unknown';
  const nowMs = options.now();
  const attempt = options.loginAttempts.get(clientKey, nowMs) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > nowMs) {
    const waitSeconds = Math.ceil((attempt.lockedUntil - nowMs) / 1000);
    writeJson(res, 429, { error: 'too_many_attempts', code: 'too_many_attempts', retry_after_seconds: waitSeconds });
    return;
  }

  let body = {};
  try {
    body = await readJsonBody(req, { maxBodyBytes: options.maxBodyBytes });
  } catch (error) {
    if (error?.code === 'payload_too_large') {
      rejectPayloadTooLarge(req, res, options, { action: 'panel.login' });
      return;
    }
    emitGatewayEvent(req, options, {
      kind: 'error',
      action: 'panel.login',
      outcome: 'rejected',
      status_code: 400,
      reason_code: 'invalid_json',
      safe_message: 'Invalid JSON login payload',
      context: requestBaseContext(req),
    });
    writeJson(res, 400, { error: 'invalid_json', code: 'invalid_json' });
    return;
  }
  const user = String(body.user || body.username || '').trim();
  const pass = String(body.pass || body.password || '');
  const auth = options.panelUsers.get(user);
  if (!verifyPanelUserPassword(auth, pass)) {
    const next = { count: attempt.count + 1, lockedUntil: nowMs + Math.min(1000 * 2 ** attempt.count, 60000) };
    options.loginAttempts.set(clientKey, next, { ttlMs: options.loginAttemptTtlMs, nowMs });
    emitGatewayEvent(req, options, {
      kind: 'audit',
      severity: 'warning',
      action: 'panel.login',
      outcome: 'failure',
      status_code: 401,
      reason_code: 'invalid_credentials',
      safe_message: 'Invalid panel credentials',
      context: requestBaseContext(req, { attempted_user: user }),
    });
    writeJson(res, 401, { error: 'invalid_credentials', code: 'invalid_credentials' });
    return;
  }
  options.loginAttempts.delete(clientKey);
  const token = options.createSessionToken();
  const profile = auth.profile;
  const session = normalizePanelSession({
    ...profile,
    session_id: options.createSessionId(),
    expires_at: new Date(options.now() + options.panelSessionMaxAgeSeconds * 1000).toISOString(),
  });
  options.panelSessions.set(token, session, { ttlMs: options.panelSessionMaxAgeSeconds * 1000, nowMs: options.now() });
  emitGatewayEvent(req, options, {
    kind: 'audit',
    action: 'panel.login',
    outcome: 'success',
    status_code: 200,
    safe_message: 'Panel login succeeded',
    context: requestBaseContext(req),
  }, session);
  writeJson(res, 200, sessionResponse(session), {
    'set-cookie': serializePanelSessionCookie(token, {
      maxAgeSeconds: options.panelSessionMaxAgeSeconds,
      crossSite: isCrossSitePanelRequest(req),
    }),
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

function handlePanelLogout(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  if (!isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { action: 'panel.logout' });
    return;
  }
  const token = readPanelSessionToken(req);
  const session = token ? options.panelSessions.get(token, options.now()) : null;
  if (token) options.panelSessions.delete(token);
  emitGatewayEvent(req, options, {
    kind: 'audit',
    action: 'panel.logout',
    outcome: 'success',
    status_code: 200,
    safe_message: 'Panel logout succeeded',
    context: requestBaseContext(req),
  }, session ? { token, ...normalizePanelSession(session) } : null);
  writeJson(res, 200, { ok: true }, {
    'set-cookie': serializePanelSessionCookie('', {
      maxAgeSeconds: 0,
      crossSite: isCrossSitePanelRequest(req),
    }),
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

function handlePanelBootstrap(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  writeJson(res, 200, normalizePanelBootstrap(options.panelBootstrap, options.routes), {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
  });
}

function isMutationMethod(method) {
  return !SAFE_READ_METHODS.has(String(method || '').toUpperCase());
}

function isSafeReadMethod(method) {
  return SAFE_READ_METHODS.has(String(method || '').toUpperCase());
}

function compareVersionParts(left, right) {
  const leftParts = String(left || '').split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = String(right || '').split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function shouldRejectStaleShell(req, options) {
  if (!isMutationMethod(req.method)) return false;
  const minShellVersion = normalizePanelBootstrap(options.panelBootstrap, options.routes).min_shell_version;
  const receivedShellVersion = String(req.headers['x-control-panel-shell-version'] || '').trim();
  if (!minShellVersion || !receivedShellVersion) return false;
  return compareVersionParts(receivedShellVersion, minShellVersion) < 0;
}

function rejectStaleShell(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const bootstrap = normalizePanelBootstrap(options.panelBootstrap, options.routes);
  writeJson(res, 409, {
    error: 'stale_shell',
    code: 'stale_shell',
    min_shell_version: bootstrap.min_shell_version,
    received_shell_version: String(req.headers['x-control-panel-shell-version'] || '').trim(),
  }, {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

function handlePreflight(req, res, options) {
  const origin = req.headers.origin;
  const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
  const requestedHeaders = splitCsvHeader(req.headers['access-control-request-headers']);
  const methodAllowed = !requestedMethod || options.allowedMethods.includes(requestedMethod);
  const headersAllowed = requestedHeaders.every((header) => options.allowedHeaders.includes(header));
  const originAllowed = applyCorsHeaders(res, origin, options);

  if (!originAllowed || !methodAllowed || !headersAllowed) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('CORS preflight rejected');
    return;
  }
  res.writeHead(204);
  res.end();
}

function isPublicLocalLivenessRoute(route) {
  if (!route || !LOCAL_SERVICE_NAMES.has(route.service)) return false;
  const pathname = new URL(route.upstreamPath, 'http://gateway.local').pathname;
  return pathname === '/health' || pathname === '/healthz' || pathname === '/api/monitor/live' || pathname === '/api/radar/live';
}

function isPublicLocalMachineRoute(route) {
  if (!route || !LOCAL_SERVICE_NAMES.has(route.service)) return false;
  const pathname = new URL(route.upstreamPath, 'http://gateway.local').pathname;
  return route.service === 'monitor' && pathname === '/api/monitor/boundary/websub-events';
}

function isPublicLocalUnauthenticatedRoute(route) {
  return isPublicLocalLivenessRoute(route) || isPublicLocalMachineRoute(route);
}

function resolvePanelReadModelRoute(rawUrl, routes = DEFAULT_ROUTES) {
  const parsed = new URL(rawUrl, 'http://gateway.local');
  if (!matchesPrefix(parsed.pathname, PANEL_READ_MODEL_PREFIX)) return null;
  const path = parsed.pathname.slice(PANEL_READ_MODEL_PREFIX.length) || '/';
  const query = parsed.search || '';
  const routeFor = (service, upstreamPath) => {
    const configured = routes[service];
    if (!configured?.target) return null;
    return { service, target: configured.target, upstreamPath: `${upstreamPath}${query}` };
  };

  if (path === '/approval/pending') return routeFor('n8n', '/webhook/approval/pending/supabase/v2');
  if (path === '/approval/queue') return routeFor('n8n', '/webhook/approval/queue/supabase/v2');
  if (path === '/approval/topic') return routeFor('n8n', '/webhook/approval/topic/supabase/v2');
  if (path === '/approval/search-refresh/status') return routeFor('n8n', '/webhook/approval/search-refresh/status/supabase/v1');
  if (path === '/scripts/drafts') return routeFor('n8n', '/webhook/mvp-script-drafts-pending/supabase/v2');
  if (path === '/audio/jobs') return routeFor('tts', '/api/tts/jobs');
  const audioJobMatch = path.match(/^\/audio\/jobs\/([^/]+)$/);
  if (audioJobMatch?.[1]) {
    const segment = safePathSegment(audioJobMatch[1]);
    if (!segment.ok) return null;
    return routeFor('tts', `/api/tts/jobs/${segment.value}`);
  }
  if (path === '/subtitles/health') return routeFor('subtitles', '/api/subtitles/health');
  if (path === '/subtitles/sessions') return routeFor('subtitles', '/api/subtitles/sessions');
  const subtitleSessionMatch = path.match(/^\/subtitles\/sessions\/([^/]+)(?:\/(segments|render|download))?$/);
  if (subtitleSessionMatch?.[1]) {
    const segment = safePathSegment(subtitleSessionMatch[1]);
    if (!segment.ok) return null;
    const suffix = subtitleSessionMatch[2] ? `/${subtitleSessionMatch[2]}` : '';
    return routeFor('subtitles', `/api/subtitles/sessions/${segment.value}${suffix}`);
  }
  if (path === '/video-projects') return routeFor('n8n', '/webhook/video-projects/read-model/supabase/v1');
  const videoProjectMatch = path.match(/^\/video-projects\/([^/]+)$/);
  if (videoProjectMatch?.[1]) {
    const segment = safePathSegment(videoProjectMatch[1]);
    if (!segment.ok) return null;
    return routeFor('n8n', `/webhook/video-projects/read-model/supabase/v1/${segment.value}`);
  }
  return null;
}

function isPanelReadModelPath(pathname = '') {
  return matchesPrefix(pathname, PANEL_READ_MODEL_PREFIX);
}

function rejectPolicy({ statusCode = 404, code = 'route_not_found' } = {}) {
  return {
    kind: 'reject',
    route: null,
    statusCode,
    code,
    requiresSession: false,
    requiresEditor: false,
    requiresCsrf: false,
    allowsCredentialInjection: false,
  };
}

function routePolicy(overrides = {}) {
  return {
    kind: 'reject',
    route: null,
    statusCode: 200,
    code: null,
    requiresSession: false,
    requiresEditor: false,
    requiresCsrf: false,
    allowsCredentialInjection: false,
    ...overrides,
  };
}

export function resolveRoutePolicy(req, options = {}) {
  const routes = options.routes || DEFAULT_ROUTES;
  const serviceCredentials = options.serviceCredentials || {};
  const method = String(req?.method || 'GET').toUpperCase();
  const rawUrl = req?.url || '/';
  const parsed = new URL(rawUrl, 'http://gateway.local');
  const pathname = parsed.pathname;

  if (pathname === '/health' || pathname === '/healthz') {
    if (method !== 'GET') return rejectPolicy({ statusCode: 405, code: 'method_not_allowed' });
    return routePolicy({ kind: 'local-health' });
  }

  if (pathname === '/ready') {
    if (method !== 'GET') return rejectPolicy({ statusCode: 405, code: 'method_not_allowed' });
    return routePolicy({ kind: 'ready' });
  }

  if (isPanelReadModelPath(pathname)) {
    if (!isSafeReadMethod(method)) {
      return rejectPolicy({ statusCode: 405, code: 'method_not_allowed' });
    }
    const route = resolvePanelReadModelRoute(rawUrl, routes);
    if (!route) return rejectPolicy({ statusCode: 404, code: 'read_model_not_found' });
    return routePolicy({
      kind: 'read-model',
      route,
      requiresSession: method !== 'OPTIONS',
      allowsCredentialInjection: method !== 'OPTIONS',
    });
  }

  const matches = resolveRouteMatches(rawUrl, routes);
  if (matches.length !== 1) return rejectPolicy({ statusCode: 404, code: 'route_not_found' });
  const route = matches[0];
  if (isPublicLocalUnauthenticatedRoute(route)) {
    return routePolicy({ kind: 'proxy', route });
  }

  const syntheticReq = { method };
  const requiresSession = shouldProtectRequest(syntheticReq, route, { serviceCredentials });
  const requiresEditor = requiresSession && isMutationMethod(method);
  const requiresCsrf = requiresSession && isMutationMethod(method);
  return routePolicy({
    kind: 'proxy',
    route,
    requiresSession,
    requiresEditor,
    requiresCsrf,
    allowsCredentialInjection: requiresSession,
  });
}

function hasInjectedServiceCredentials(route, options) {
  return Object.values(options.serviceCredentials[route?.service] || {}).some((value) => value != null && String(value) !== '');
}

function shouldProtectRequest(req, route, options = { serviceCredentials: {} }) {
  if (isPublicLocalUnauthenticatedRoute(route)) return false;
  if (isMutationMethod(req.method)) return true;
  if (LOCAL_SERVICE_NAMES.has(route?.service) && isPublicLocalLivenessRoute(route)) return false;
  if (hasInjectedServiceCredentials(route, options)) return true;
  return LOCAL_SERVICE_NAMES.has(route?.service);
}

function shouldRequireEditorRole(req) {
  return isMutationMethod(req.method);
}

function rejectUnauthenticated(req, res, options, { action = 'proxy.authorization', route = null } = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  emitGatewayEvent(req, options, {
    kind: 'audit',
    severity: 'warning',
    route_service: route?.service,
    action,
    outcome: 'rejected',
    status_code: 401,
    reason_code: 'unauthenticated',
    safe_message: 'Authentication required',
    context: requestBaseContext(req),
  });
  writeJson(res, 401, { error: 'unauthenticated', code: 'unauthenticated' });
}

function rejectForbidden(req, res, options, { route = null, session = null } = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  emitGatewayEvent(req, options, {
    kind: 'audit',
    severity: 'warning',
    route_service: route?.service,
    action: 'proxy.authorization',
    outcome: 'rejected',
    status_code: 403,
    reason_code: 'forbidden',
    safe_message: 'Required role missing',
    context: requestBaseContext(req, { required_role: PROTECTED_MUTATION_ROLE }),
  }, session);
  writeJson(res, 403, { error: 'forbidden', code: 'forbidden', required_role: PROTECTED_MUTATION_ROLE });
}

function rejectCsrf(req, res, options, { action = 'proxy.csrf', route = null, session = null } = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  emitGatewayEvent(req, options, {
    kind: 'audit',
    severity: 'warning',
    route_service: route?.service,
    action,
    outcome: 'rejected',
    status_code: 403,
    reason_code: 'csrf_rejected',
    safe_message: 'CSRF protection rejected the request',
    context: requestBaseContext(req),
  }, session);
  writeJson(res, 403, { error: 'csrf_rejected', code: 'csrf_rejected' });
}

function rejectPayloadTooLarge(req, res, options, { route = null, session = null, action = 'proxy.payload' } = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  emitGatewayEvent(req, options, {
    kind: 'error',
    severity: 'warning',
    route_service: route?.service,
    action,
    outcome: 'rejected',
    status_code: 413,
    reason_code: 'payload_too_large',
    safe_message: 'Payload exceeds configured size limit',
    context: requestBaseContext(req),
  }, session);
  writeJson(res, 413, { error: 'payload_too_large', code: 'payload_too_large' });
}

function enforceBodySizeLimit(req, res, options) {
  const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBodyBytes) {
    rejectPayloadTooLarge(req, res, options);
    return false;
  }
  return true;
}

function safePathSegment(rawSegment) {
  if (!rawSegment || typeof rawSegment !== 'string') return { ok: false };
  let decoded;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return { ok: false };
  }
  if (!decoded) return { ok: false };
  if (decoded === '.' || decoded === '..') return { ok: false };
  if (decoded.includes('/') || decoded.includes('\\')) return { ok: false };
  if (decoded.includes('\0')) return { ok: false };
  const lowerRaw = rawSegment.toLowerCase();
  if (lowerRaw.includes('%2e') || lowerRaw.includes('%2f') || lowerRaw.includes('%5c')) return { ok: false };
  return { ok: true, value: encodeURIComponent(decoded) };
}

function isTrustedMutationRequest(req, options) {
  if (!isMutationMethod(req.method)) return true;
  const origin = String(req.headers.origin || '').trim();
  return isTrustedMutationOrigin(origin, options.trustedMutationOrigins);
}

function sanitizeProtectedHeaders(headers = {}) {
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (BROWSER_SUPPLIED_SECRET_HEADERS.has(lowerName)) continue;
    if (isBrowserSuppliedIdentityHeader(lowerName)) continue;
    if (lowerName === 'cookie') continue;
    clean[name] = value;
  }
  return clean;
}

function sanitizeUnprotectedHeaders(headers = {}) {
  const clean = { ...headers };
  delete clean.cookie;
  delete clean.Cookie;
  for (const name of Object.keys(clean)) {
    if (BROWSER_SUPPLIED_SECRET_HEADERS.has(name.toLowerCase())) delete clean[name];
    if (isBrowserSuppliedIdentityHeader(name)) delete clean[name];
  }
  return clean;
}

function sanitizeProxyResponseHeaders(headers = {}) {
  const clean = removeHopByHopHeaders(headers);
  for (const name of Object.keys(clean)) {
    if (SECRET_RESPONSE_HEADERS.has(name.toLowerCase())) delete clean[name];
    if (CORS_RESPONSE_HEADERS.has(name.toLowerCase())) delete clean[name];
  }
  return clean;
}

function injectGatewayContext(headers, route, session, options) {
  const next = { ...headers };
  if (session) {
    next['x-panel-actor-id'] = session.user.user_id;
    next['x-panel-actor-email'] = session.user.email;
    next['x-panel-actor-display-name'] = session.user.display_name;
    next['x-panel-actor-roles'] = session.roles.join(',');
    next['x-panel-session-id'] = session.session_id;
  }
  const credentials = options.serviceCredentials[route.service] || {};
  for (const [name, value] of Object.entries(credentials)) {
    if (value != null && String(value) !== '') next[name] = value;
  }
  return next;
}

function actorAuditPayload(session) {
  return {
    actor: session.user.user_id,
    email: session.user.email,
    display_name: session.user.display_name,
    roles: session.roles,
    session_id: session.session_id,
  };
}

function resolveBaseVersionMetadata(body = {}) {
  const baseVersion = body.base_version ?? body.baseVersion;
  const baseSnapshotHash = body.base_snapshot_hash ?? body.baseSnapshotHash ?? body.snapshotHash;
  return {
    ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
    ...(baseSnapshotHash !== undefined ? { base_snapshot_hash: baseSnapshotHash } : {}),
    ...(body.lease_id !== undefined ? { lease_id: body.lease_id } : {}),
  };
}

async function enrichProtectedJsonBody(req, headers, session, options) {
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) return { headers, bodyBuffer: null };
  const rawBody = await readRawBody(req, { maxBodyBytes: options.maxBodyBytes });
  let body = {};
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch {
    return { headers, bodyBuffer: rawBody };
  }
  const enriched = {
    ...body,
    audit_actor: actorAuditPayload(session),
    audit: {
      ...(body.audit && typeof body.audit === 'object' ? body.audit : {}),
      ...resolveBaseVersionMetadata(body),
    },
  };
  const bodyBuffer = Buffer.from(JSON.stringify(enriched));
  return {
    headers: {
      ...headers,
      'content-length': String(bodyBuffer.length),
    },
    bodyBuffer,
  };
}

function proxyRequest(req, res, route, options, session = null, bodyBuffer = null) {
  const target = new URL(route.target);
  const upstreamUrl = new URL(route.upstreamPath, target);
  const protect = shouldProtectRequest(req, route, options);
  const rawHeaders = protect ? sanitizeProtectedHeaders(req.headers) : sanitizeUnprotectedHeaders(req.headers);
  const headers = options.preparedHeaders || (protect
    ? injectGatewayContext(removeHopByHopHeaders(rawHeaders), route, session, options)
    : removeHopByHopHeaders(rawHeaders));
  if (req.gatewayCorrelationId) {
    headers['x-correlation-id'] = req.gatewayCorrelationId;
    headers['x-request-id'] = req.gatewayCorrelationId;
  }
  headers.host = upstreamUrl.host;
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  let timedOut = false;
  const upstreamReq = transport.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = sanitizeProxyResponseHeaders(upstreamRes.headers);
      applyCorsHeaders(res, req.headers.origin, options);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, responseHeaders);
      emitGatewayEvent(req, options, {
        kind: 'audit',
        route_service: route.service,
        action: 'proxy.request',
        outcome: upstreamRes.statusCode && upstreamRes.statusCode >= 400 ? 'failure' : 'success',
        status_code: upstreamRes.statusCode || 502,
        reason_code: upstreamRes.statusCode && upstreamRes.statusCode >= 400 ? 'upstream_error_status' : undefined,
        safe_message: 'Proxied request completed',
        context: requestBaseContext(req, { target: route.target }),
      }, session);
      upstreamRes.pipe(res);
    },
  );

  const upstreamTimeoutMs = route.upstreamTimeoutMs || options.upstreamTimeoutMs;
  if (typeof upstreamReq.setTimeout === 'function') {
    upstreamReq.setTimeout(upstreamTimeoutMs, () => {
      timedOut = true;
      options.logger.warn?.('gateway upstream timeout', {
        service: route.service,
        target: route.target,
        headers: sanitizeHeadersForLog(req.headers),
      });
      emitGatewayEvent(req, options, {
        kind: 'error',
        route_service: route.service,
        action: 'proxy.request',
        outcome: 'failure',
        status_code: 504,
        reason_code: 'upstream_timeout',
        safe_message: 'Upstream request timed out',
        likely_cause: 'upstream_timeout',
        context: requestBaseContext(req, { target: route.target }),
      }, session);
      if (!res.headersSent) {
        applyCorsHeaders(res, req.headers.origin, options);
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_timeout', code: 'upstream_timeout' }));
      }
      upstreamReq.destroy(new Error('upstream_timeout'));
    });
  }

  upstreamReq.on('error', (error) => {
    if (timedOut) return;
    options.logger.error?.('gateway upstream error', {
      service: route.service,
      target: route.target,
      message: error.message,
      headers: sanitizeHeadersForLog(req.headers),
    });
    emitGatewayEvent(req, options, {
      kind: 'error',
      route_service: route.service,
      action: 'proxy.request',
      outcome: 'failure',
      status_code: 502,
      reason_code: 'upstream_unavailable',
      safe_message: 'Upstream service is unavailable',
      likely_cause: 'upstream_unavailable',
      context: requestBaseContext(req, { target: route.target, error: error.message }),
    }, session);
    if (!res.headersSent) {
      applyCorsHeaders(res, req.headers.origin, options);
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'upstream_unavailable', code: 'upstream_unavailable' }));
  });

  if (bodyBuffer) {
    upstreamReq.end(bodyBuffer);
  } else {
    let pipedBytes = 0;
    let limitHit = false;

    req.on('data', (chunk) => {
      if (limitHit) return;
      pipedBytes += chunk.length;
      if (pipedBytes > options.maxBodyBytes) {
        limitHit = true;
        upstreamReq.destroy(new PayloadTooLargeError());
        if (!res.headersSent) {
          rejectPayloadTooLarge(req, res, options, { route, session });
        }
        return;
      }
      upstreamReq.write(chunk);
    });

    req.on('end', () => {
      if (!limitHit) upstreamReq.end();
    });

    req.on('error', (err) => {
      if (!limitHit) upstreamReq.destroy(err);
    });
  }
}

async function proxyProtectedRequest(req, res, route, options, session) {
  const rawHeaders = sanitizeProtectedHeaders(req.headers);
  const baseHeaders = injectGatewayContext(removeHopByHopHeaders(rawHeaders), route, session, options);
  const { headers, bodyBuffer } = await enrichProtectedJsonBody(req, baseHeaders, session, options);
  proxyRequest(req, res, route, { ...options, preparedHeaders: headers }, session, bodyBuffer);
}

function handleReady(req, res, options) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const checks = typeof options.readinessChecks === 'function'
    ? options.readinessChecks()
    : {};
  const results = {};
  let allOk = true;
  for (const [name, check] of Object.entries(checks)) {
    const ok = check?.status === 'ok';
    if (!ok) allOk = false;
    results[name] = {
      status: ok ? 'ok' : 'error',
      ...(check?.message ? { message: check.message } : {}),
    };
  }
  const status = allOk ? 'ready' : 'not_ready';
  writeJson(res, allOk ? 200 : 503, { status, checks: results });
}

function gatewayEventsFilters(rawUrl) {
  const parsed = new URL(rawUrl || '/', 'http://gateway.local');
  const allowed = new Set(['kind', 'status', 'service', 'actor', 'correlation_id', 'from', 'to', 'limit']);
  const filters = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    if (allowed.has(key) && value !== '') filters[key] = value;
  }
  return filters;
}

async function handleGatewayEventsReadModel(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = getVerifiedSession(req, options);
  if (!session) {
    rejectUnauthenticated(req, res, options, { action: 'gateway.events.read' });
    return;
  }
  try {
    const result = options.eventRecorder && typeof options.eventRecorder.query === 'function'
      ? await options.eventRecorder.query(gatewayEventsFilters(req.url || '/'))
      : { events: [], next_cursor: null, retention: { max_events: DEFAULT_EVENT_RETENTION.max_events, max_age_days: DEFAULT_EVENT_RETENTION.max_age_days } };
    emitGatewayEvent(req, options, {
      kind: 'audit',
      action: 'gateway.events.read',
      outcome: 'success',
      status_code: 200,
      safe_message: 'Gateway events read',
      context: requestBaseContext(req, { filters: gatewayEventsFilters(req.url || '/') }),
    }, session);
    writeJson(res, 200, result, {
      'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    });
  } catch (error) {
    emitGatewayEvent(req, options, {
      kind: 'error',
      action: 'gateway.events.read',
      outcome: 'failure',
      status_code: 500,
      reason_code: 'event_read_failed',
      safe_message: 'Gateway events read failed',
      likely_cause: 'event_recorder_failure',
      context: requestBaseContext(req, { error: 'event_read_failed' }),
    }, session);
    writeJson(res, 500, { error: 'event_read_failed', code: 'event_read_failed' }, {
      'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    });
  }
}

async function handlePresenceHeartbeat(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = getVerifiedSession(req, options);
  if (!session) {
    rejectUnauthenticated(req, res, options, { action: 'panel.presence.authorization' });
    return;
  }
  let body = {};
  try {
    body = await readJsonBody(req, { maxBodyBytes: options.maxBodyBytes });
  } catch (error) {
    if (error?.code === 'payload_too_large') {
      rejectPayloadTooLarge(req, res, options, { action: 'panel.presence.heartbeat', session });
      return;
    }
    writeJson(res, 400, { error: 'invalid_json', code: 'invalid_json' });
    return;
  }
  const payload = normalizePresencePayload(body);
  if (!payload) {
    writeJson(res, 400, { error: 'invalid_presence', code: 'invalid_presence' });
    return;
  }
  const nowMs = options.now();
  options.presenceStore.set(session.session_id, presenceSessionEntry(session, payload, nowMs), {
    ttlMs: options.presenceTtlMs,
    nowMs,
  });
  writeJson(res, 200, { ok: true, ttl_seconds: presenceTtlSeconds(options) }, {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

function handlePresenceReadModel(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = getVerifiedSession(req, options);
  if (!session) {
    rejectUnauthenticated(req, res, options, { action: 'gateway.presence.read' });
    return;
  }
  writeJson(res, 200, presenceSnapshot(options), {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

export function createGatewayServer({
  routes = DEFAULT_ROUTES,
  allowedOrigins = [
    'https://panel.example.local',
    'https://example.local',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:4177',
  ],
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = DEFAULT_ALLOWED_HEADERS,
  exposedHeaders = DEFAULT_EXPOSED_HEADERS,
  trustedMutationOrigins = null,
  panelBootstrap = DEFAULT_PANEL_BOOTSTRAP,
  panelSessions = {},
  panelAuth = null,
  panelUsers = [],
  serviceCredentials = {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  panelSessionMaxAgeSeconds = DEFAULT_PANEL_SESSION_MAX_AGE_SECONDS,
  maxPanelSessions = 1_000,
  maxLoginAttempts = 1_000,
  loginAttemptTtlMs = 15 * 60 * 1000,
  maxPresenceSessions = 1_000,
  presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
  readinessChecks = null,
  now = Date.now,
  createSessionToken = randomUUID,
  createSessionId = randomUUID,
  createCorrelationId = randomUUID,
  eventRecorder = null,
  logger = console,
} = {}) {
  const normalizedPanelUsers = normalizePanelUsers(panelUsers, panelAuth);
  if (!normalizedPanelUsers.size) {
    throw new GatewayConfigError('API Gateway panel auth requires configured panel users or API_GATEWAY_PANEL_USER and API_GATEWAY_PANEL_PASS fallback');
  }
  if (!Array.isArray(allowedOrigins)) {
    throw new GatewayConfigError('allowedOrigins must be an array of non-empty origin strings');
  }
  for (const origin of allowedOrigins) {
    if (typeof origin !== 'string' || origin.trim() === '') {
      throw new GatewayConfigError('allowedOrigins must contain only non-empty string entries');
    }
  }
  validateCorsMethods(allowedMethods);
  validateHeaderNames(allowedHeaders, 'allowedHeaders');
  validateHeaderNames(exposedHeaders, 'exposedHeaders');
  validateTrustedMutationOrigins(trustedMutationOrigins);
  validateRoutePrefixes(routes);

  // Validate numeric limits — must be positive safe integers
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new GatewayConfigError('maxBodyBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new GatewayConfigError('upstreamTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(panelSessionMaxAgeSeconds) || panelSessionMaxAgeSeconds <= 0) {
    throw new GatewayConfigError('panelSessionMaxAgeSeconds must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPanelSessions) || maxPanelSessions <= 0) {
    throw new GatewayConfigError('maxPanelSessions must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxLoginAttempts) || maxLoginAttempts <= 0) {
    throw new GatewayConfigError('maxLoginAttempts must be a positive safe integer');
  }
  if (!Number.isSafeInteger(loginAttemptTtlMs) || loginAttemptTtlMs <= 0) {
    throw new GatewayConfigError('loginAttemptTtlMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPresenceSessions) || maxPresenceSessions <= 0) {
    throw new GatewayConfigError('maxPresenceSessions must be a positive safe integer');
  }
  if (!Number.isSafeInteger(presenceTtlMs) || presenceTtlMs <= 0) {
    throw new GatewayConfigError('presenceTtlMs must be a positive safe integer');
  }

  // Validate route target schemes
  for (const [service, route] of Object.entries(routes)) {
    let parsed;
    try {
      parsed = new URL(route.target);
    } catch {
      throw new GatewayConfigError(`Route '${service}' target must be a valid http: or https: URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new GatewayConfigError(`Route '${service}' target scheme must be http: or https:`);
    }
    if (parsed.username || parsed.password) {
      throw new GatewayConfigError(`Route '${service}' target must not contain username or password userinfo`);
    }
  }

  // Validate service credential header names
  const SUPPORTED_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret']);
  for (const [service, creds] of Object.entries(serviceCredentials)) {
    for (const headerName of Object.keys(creds)) {
      if (!SUPPORTED_CREDENTIAL_HEADERS.has(headerName.toLowerCase())) {
        throw new GatewayConfigError(`Unsupported injected credential header '${headerName}' for service '${service}'`);
      }
    }
  }

  const initialNowMs = now();
  const panelSessionStore = new BoundedTtlStore({ maxEntries: maxPanelSessions });
  for (const [token, rawSession] of Object.entries(panelSessions || {})) {
    const session = normalizePanelSession(rawSession);
    const expiresAtMs = toExpirationTime(session.expires_at);
    const ttlMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - initialNowMs)
      : panelSessionMaxAgeSeconds * 1000;
    panelSessionStore.set(token, session, { ttlMs, nowMs: initialNowMs });
  }

  const options = {
    routes,
    allowedOrigins,
    trustedMutationOrigins: Array.isArray(trustedMutationOrigins) ? trustedMutationOrigins : allowedOrigins,
    allowedMethods,
    allowedHeaders,
    exposedHeaders,
    panelBootstrap,
    panelSessions: panelSessionStore,
    panelAuth,
    panelUsers: normalizedPanelUsers,
    serviceCredentials,
    maxBodyBytes,
    upstreamTimeoutMs,
    panelSessionMaxAgeSeconds,
    loginAttemptTtlMs,
    readinessChecks,
    now,
    createSessionToken,
    createSessionId,
    createCorrelationId,
    eventRecorder,
    logger,
    loginAttempts: new BoundedTtlStore({ maxEntries: maxLoginAttempts }),
    presenceStore: new BoundedTtlStore({ maxEntries: maxPresenceSessions }),
    presenceTtlMs,
  };
  const startTime = options.now();
  return http.createServer((req, res) => {
    req.gatewayCorrelationId = selectCorrelationId(req, { createId: options.createCorrelationId });
    res.setHeader('x-correlation-id', req.gatewayCorrelationId);
    const panelPath = (req.url || '').split('?')[0];

    if (req.method === 'GET' && (panelPath === '/health' || panelPath === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime_ms: options.now() - startTime, version: '0.1.0' }));
      return;
    }

    if (panelPath === '/ready') {
      handleReady(req, res, options);
      return;
    }

    if (panelPath === '/panel/bootstrap') {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      handlePanelBootstrap(req, res, options);
      return;
    }
    if (panelPath === '/panel/session') {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      handlePanelSession(req, res, options);
      return;
    }
    if (panelPath === '/panel/login') {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      void handlePanelLogin(req, res, options);
      return;
    }
    if (panelPath === '/panel/logout') {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      handlePanelLogout(req, res, options);
      return;
    }
    if (panelPath === PANEL_PRESENCE_HEARTBEAT_PATH) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (req.method !== 'POST') {
        applyCorsHeaders(res, req.headers.origin, options);
        writeJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' });
        return;
      }
      void handlePresenceHeartbeat(req, res, options);
      return;
    }
    if (panelPath === GATEWAY_EVENTS_READ_MODEL_PATH) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (!isSafeReadMethod(req.method) || String(req.method || '').toUpperCase() === 'OPTIONS') {
        applyCorsHeaders(res, req.headers.origin, options);
        writeJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' });
        return;
      }
      void handleGatewayEventsReadModel(req, res, options);
      return;
    }
    if (panelPath === GATEWAY_PRESENCE_READ_MODEL_PATH) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (!isSafeReadMethod(req.method) || String(req.method || '').toUpperCase() === 'OPTIONS') {
        applyCorsHeaders(res, req.headers.origin, options);
        writeJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' });
        return;
      }
      handlePresenceReadModel(req, res, options);
      return;
    }
    if (isPanelReadModelPath(panelPath)) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      if (!isSafeReadMethod(req.method) || String(req.method || '').toUpperCase() === 'OPTIONS') {
        applyCorsHeaders(res, req.headers.origin, options);
        writeJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' });
        return;
      }
      const readModelRoute = resolvePanelReadModelRoute(req.url || '/', routes);
      if (!readModelRoute) {
        applyCorsHeaders(res, req.headers.origin, options);
        writeJson(res, 404, { error: 'read_model_not_found', code: 'read_model_not_found' });
        return;
      }
      const session = getVerifiedSession(req, options);
      if (!session) {
        rejectUnauthenticated(req, res, options, { action: 'read-model.authorization', route: readModelRoute });
        return;
      }
      void proxyProtectedRequest(req, res, readModelRoute, options, session).catch((error) => {
        options.logger.error?.('gateway read-model proxy error', { service: readModelRoute.service, message: error.message });
        emitGatewayEvent(req, options, {
          kind: 'error',
          route_service: readModelRoute.service,
          action: 'read-model.proxy',
          outcome: 'failure',
          status_code: error?.code === 'payload_too_large' ? 413 : 502,
          reason_code: error?.code === 'payload_too_large' ? 'payload_too_large' : 'upstream_unavailable',
          safe_message: 'Read-model proxy failed',
          context: requestBaseContext(req, { error: error.message }),
        }, session);
        if (!res.headersSent) {
          applyCorsHeaders(res, req.headers.origin, options);
          if (error?.code === 'payload_too_large') {
            writeJson(res, 413, { error: 'payload_too_large', code: 'payload_too_large' });
          } else {
            writeJson(res, 502, { error: 'upstream_unavailable', code: 'upstream_unavailable' });
          }
        }
      });
      return;
    }
    if (req.method === 'OPTIONS') {
      handlePreflight(req, res, options);
      return;
    }
    const policy = resolveRoutePolicy(req, options);
    if (policy.kind === 'reject') {
      applyCorsHeaders(res, req.headers.origin, options);
      emitGatewayEvent(req, options, {
        kind: policy.statusCode >= 500 ? 'error' : 'audit',
        action: 'route.policy',
        outcome: 'rejected',
        status_code: policy.statusCode,
        reason_code: policy.code,
        safe_message: 'Gateway route policy rejected the request',
        context: requestBaseContext(req),
      });
      writeJson(res, policy.statusCode, { error: policy.code, code: policy.code });
      return;
    }
    const route = policy.route;
    if (shouldRejectStaleShell(req, options)) {
      rejectStaleShell(req, res, options);
      return;
    }
    let session = null;
    if (policy.requiresSession) {
      session = getVerifiedSession(req, options);
      if (!session) {
        rejectUnauthenticated(req, res, options, { route });
        return;
      }
      if (policy.requiresEditor && !session.roles.includes(PROTECTED_MUTATION_ROLE)) {
        rejectForbidden(req, res, options, { route, session });
        return;
      }
      if (policy.requiresCsrf && !isTrustedMutationRequest(req, options)) {
        rejectCsrf(req, res, options, { route, session });
        return;
      }
    }
    if (!enforceBodySizeLimit(req, res, options)) {
      emitGatewayEvent(req, options, {
        kind: 'error',
        route_service: route?.service,
        action: 'proxy.payload',
        outcome: 'rejected',
        status_code: 413,
        reason_code: 'payload_too_large',
        safe_message: 'Payload exceeds configured size limit',
        context: requestBaseContext(req),
      }, session);
      return;
    }
    if (session) {
      void proxyProtectedRequest(req, res, route, options, session).catch((error) => {
        options.logger.error?.('gateway protected proxy error', { service: route.service, message: error.message });
        emitGatewayEvent(req, options, {
          kind: 'error',
          route_service: route.service,
          action: error?.code === 'payload_too_large' ? 'proxy.payload' : 'proxy.request',
          outcome: error?.code === 'payload_too_large' ? 'rejected' : 'failure',
          status_code: error?.code === 'payload_too_large' ? 413 : 502,
          reason_code: error?.code === 'payload_too_large' ? 'payload_too_large' : 'upstream_unavailable',
          safe_message: error?.code === 'payload_too_large' ? 'Payload exceeds configured size limit' : 'Protected proxy failed',
          context: requestBaseContext(req, { error: error.message }),
        }, session);
        if (!res.headersSent) {
          applyCorsHeaders(res, req.headers.origin, options);
          if (error?.code === 'payload_too_large') {
            writeJson(res, 413, { error: 'payload_too_large', code: 'payload_too_large' });
          } else {
            writeJson(res, 502, { error: 'upstream_unavailable', code: 'upstream_unavailable' });
          }
        }
      });
      return;
    }
    proxyRequest(req, res, route, options, session);
  });
}

function readAllowedOrigins() {
  return (process.env.API_GATEWAY_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readTrustedMutationOrigins() {
  return (process.env.API_GATEWAY_TRUSTED_MUTATION_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function defaultGatewayEventsFilePath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime-logs', 'gateway-events.jsonl');
}

export function startGateway({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const allowedOrigins = readAllowedOrigins();
  const trustedMutationOrigins = readTrustedMutationOrigins();
  const eventRecorder = new JsonlEventRecorder({
    filePath: process.env.API_GATEWAY_EVENTS_FILE || defaultGatewayEventsFilePath(),
    retention: {
      max_events: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_EVENTS || '', 10) || DEFAULT_EVENT_RETENTION.max_events,
      max_age_days: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_AGE_DAYS || '', 10) || DEFAULT_EVENT_RETENTION.max_age_days,
      max_bytes: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_BYTES || '', 10) || DEFAULT_EVENT_RETENTION.max_bytes,
    },
    logger: console,
  });
  const server = createGatewayServer({
    allowedOrigins: allowedOrigins.length ? allowedOrigins : undefined,
    trustedMutationOrigins: trustedMutationOrigins.length ? trustedMutationOrigins : undefined,
    panelAuth: readPanelAuthFromEnv(),
    panelUsers: readPanelUsersFromEnv(),
    serviceCredentials: readServiceCredentialsFromEnv(),
    eventRecorder,
  });
  server.listen(port, host, () => {
    console.info(`Control Panel API Gateway listening on http://${host}:${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startGateway({
    host: process.env.API_GATEWAY_HOST || DEFAULT_HOST,
    port: Number(process.env.API_GATEWAY_PORT || DEFAULT_PORT),
  });
}
