import { resolveModeRouteTargets } from '@newsroom/adapters';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8099;

export const DEFAULT_ROUTES = Object.freeze({
  n8n: { prefix: '/n8n', target: 'http://127.0.0.1:5678' },
  tts: { prefix: '/tts', target: 'http://127.0.0.1:8088' },
  subtitles: { prefix: '/subtitles', target: 'http://127.0.0.1:8092' },
  radar: { prefix: '/radar', target: 'http://127.0.0.1:8765' },
  monitor: { prefix: '/monitor', target: 'http://127.0.0.1:8790' },
  remotion: { prefix: '/remotion', target: 'http://127.0.0.1:3042' },
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
  apiOrigin: '',
  minShellVersion: '0.1.0',
  runMode: 'local',
  featureFlags: {},
});

/**
 * Compose runs every local worker as its own container, so the gateway target
 * for each prefix is configuration rather than a loopback constant. The run
 * mode supplies the defaults (demo routes to the deterministic worker, local
 * routes to the real CPU workers); `API_GATEWAY_*_TARGET` overrides either.
 */
export function resolveRoutesFromEnv(env = process.env, defaults = DEFAULT_ROUTES) {
  const modeTargets = resolveModeRouteTargets(env || {});
  const routes = {};
  for (const [service, route] of Object.entries(defaults)) {
    const key = `API_GATEWAY_${service.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_TARGET`;
    const envTarget = String(env?.[key] || '').trim();
    const target = envTarget || modeTargets[service] || '';
    routes[service] = { ...route, ...(target ? { target } : {}) };
  }
  return routes;
}

export function firstForwardedValue(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

/**
 * The panel is same-origin behind the panel container's reverse proxy. Derive
 * the public origin from the proxy headers so LAN hostnames work without
 * hard-coding localhost in the bootstrap payload.
 */
export function resolvePanelRequestOrigin(req = {}, fallback = '') {
  const host = firstForwardedValue(req?.headers?.['x-forwarded-host']);
  if (!host) return fallback;
  const proto = firstForwardedValue(req?.headers?.['x-forwarded-proto']) || 'http';
  if (proto !== 'http' && proto !== 'https') return fallback;
  try {
    const parsed = new URL(`${proto}://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_SUBTITLES_UPLOAD_MAX_BODY_BYTES = 500 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_RENDER_UPSTREAM_TIMEOUT_MS = 120_000;
export const DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_PANEL_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const DEFAULT_PRESENCE_TTL_MS = 60_000;
export const DEFAULT_LOGIN_IP_FAILURE_LIMIT = 20;
export const DEFAULT_LOGIN_IP_LOCK_MS = 60_000;
// No proxy is trusted by default: a direct connection to the published API
// must never be able to spoof X-Forwarded-For. Compose sets the panel
// container's own address explicitly.
export const DEFAULT_TRUSTED_PROXY_CIDRS = Object.freeze([]);

export const SERVICE_CREDENTIAL_ENV = Object.freeze({
  n8n: Object.freeze({ apiKey: 'API_GATEWAY_N8N_API_KEY' }),
  tts: Object.freeze({ apiKey: 'API_GATEWAY_TTS_API_KEY', basicUser: 'API_GATEWAY_TTS_BASIC_USER', basicPass: 'API_GATEWAY_TTS_BASIC_PASS' }),
  subtitles: Object.freeze({ apiKey: 'API_GATEWAY_SUBTITLES_API_KEY', basicUser: 'API_GATEWAY_SUBTITLES_BASIC_USER', basicPass: 'API_GATEWAY_SUBTITLES_BASIC_PASS' }),
  radar: Object.freeze({ apiKey: 'API_GATEWAY_RADAR_API_KEY' }),
  monitor: Object.freeze({ apiKey: 'API_GATEWAY_MONITOR_API_KEY' }),
  approval: Object.freeze({ approvalSecret: 'API_GATEWAY_APPROVAL_SECRET' }),
});

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const SECRET_LOG_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret']);
export const SECRET_RESPONSE_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret', 'set-cookie']);
export const CORS_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]);
export const BROWSER_SUPPLIED_IDENTITY_HEADERS = new Set(['x-user-email', 'x-user-roles', 'x-audit-actor']);
export const BROWSER_SUPPLIED_SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'x-approval-secret']);
export const PROTECTED_MUTATION_ROLE = 'editor';
export const LOCAL_SERVICE_NAMES = new Set(['tts', 'subtitles', 'radar', 'monitor', 'approval']);
export const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const PANEL_READ_MODEL_PREFIX = '/panel/read-models';
export const GATEWAY_EVENTS_READ_MODEL_PATH = '/panel/read-models/gateway/events';
export const GATEWAY_PRESENCE_READ_MODEL_PATH = '/panel/read-models/gateway/presence';
export const PANEL_PRESENCE_HEARTBEAT_PATH = '/panel/presence/heartbeat';
export const PREPARE_ROUTE_SERVICES = new Set(['approval', 'remotion']);

export function resolveRouteUpstreamTimeoutMs(service, upstreamPath) {
  if (service === 'subtitles' && /^\/api\/subtitles\/sessions\/[^/]+\/render(?:\?|$)/.test(upstreamPath)) {
    // CPU rendering can legitimately take several minutes in local mode.
    return DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS;
  }
  if (PREPARE_ROUTE_SERVICES.has(service) && (
    /^\/api\/projects\/create-from-approval(?:\?|$)/.test(upstreamPath)
    || /^\/api\/projects\/[^/]+\/render-final(?:\?|$)/.test(upstreamPath)
  )) {
    return DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS;
  }
  return null;
}

export function resolveRouteMaxBodyBytes(service, upstreamPath) {
  if (service === 'subtitles' && /^\/api\/subtitles\/sessions(?:\?|$)/.test(upstreamPath)) {
    return DEFAULT_SUBTITLES_UPLOAD_MAX_BODY_BYTES;
  }
  return null;
}

export function isBrowserSuppliedIdentityHeader(name) {
  const lowerName = String(name || '').toLowerCase();
  return BROWSER_SUPPLIED_IDENTITY_HEADERS.has(lowerName)
    || lowerName.startsWith('x-panel-actor-')
    || lowerName === 'x-panel-session-id';
}

export class GatewayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayConfigError';
    this.code = 'gateway_config_error';
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message = 'payload_too_large') {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.code = 'payload_too_large';
  }
}

export function normalizePrefix(prefix) {
  const clean = `/${String(prefix || '').replace(/^\/+|\/+$/g, '')}`;
  return clean === '/' ? '' : clean;
}

export function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function decodePathPrefix(value, maxPasses = 2) {
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

export function isProtocolRelativeUpstreamPath(path) {
  const normalized = decodePathPrefix(path).replace(/\\/g, '/');
  return normalized.startsWith('//');
}

export function resolveRoute(rawUrl, routes = DEFAULT_ROUTES) {
  const matches = resolveRouteMatches(rawUrl, routes);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveRouteMatches(rawUrl, routes = DEFAULT_ROUTES) {
  const parsed = new URL(rawUrl, 'http://gateway.local');
  const matches = [];
  for (const [service, route] of Object.entries(routes)) {
    const prefix = normalizePrefix(route.prefix);
    if (!prefix || !matchesPrefix(parsed.pathname, prefix)) continue;
    const strippedPath = parsed.pathname.slice(prefix.length) || '/';
    if (isProtocolRelativeUpstreamPath(strippedPath)) continue;
    const upstreamPath = `${strippedPath}${parsed.search}`;
    const upstreamTimeoutMs = resolveRouteUpstreamTimeoutMs(service, upstreamPath);
    const maxBodyBytes = resolveRouteMaxBodyBytes(service, upstreamPath);
    matches.push({
      service,
      target: route.target,
      upstreamPath,
      ...(upstreamTimeoutMs ? { upstreamTimeoutMs } : {}),
      ...(maxBodyBytes ? { maxBodyBytes } : {}),
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

export function removeHopByHopHeaders(headers = {}) {
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

export function splitCsvHeader(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isCorsAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return false;
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

export function isHttpHeaderToken(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

export function isValidOriginString(value) {
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

export function validateCorsMethods(allowedMethods) {
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

export function validateHeaderNames(headerNames, fieldName) {
  if (!Array.isArray(headerNames)) {
    throw new GatewayConfigError(`${fieldName} must be an array of HTTP header names`);
  }
  for (const headerName of headerNames) {
    if (!isHttpHeaderToken(headerName)) {
      throw new GatewayConfigError(`${fieldName} contains malformed header name '${headerName}'`);
    }
  }
}

export function validateTrustedMutationOrigins(trustedMutationOrigins) {
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

export function validateRoutePrefixes(routes) {
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

  /**
   * Store a value and evict the oldest evictable entry when over capacity.
   *
   * Live locks (login throttles) are marked `evictable: false` so a flood of
   * other keys can never clear them. When every entry is a live lock the new
   * value is NOT stored and `false` is returned: callers fail closed instead
   * of silently dropping protection.
   */
  set(key, value, { ttlMs, nowMs = Date.now(), evictable = true } = {}) {
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : Number.POSITIVE_INFINITY;
    this.cleanup(nowMs);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: nowMs + ttl, evictable });
    while (this.entries.size > this.maxEntries) {
      let evicted = false;
      for (const [candidateKey, entry] of this.entries) {
        if (candidateKey === key || !entry.evictable) continue;
        this.entries.delete(candidateKey);
        evicted = true;
        break;
      }
      if (!evicted) {
        this.entries.delete(key);
        return false;
      }
    }
    return true;
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

export function isTrustedMutationOrigin(origin, trustedMutationOrigins) {
  if (!origin) return false;
  return trustedMutationOrigins.some((trustedOrigin) => trustedOrigin !== '*' && trustedOrigin === origin);
}

export function applyCorsHeaders(res, origin, options) {
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

export function routePrefixesForBootstrap(routes = DEFAULT_ROUTES) {
  return Object.fromEntries(
    Object.entries(routes).map(([service, route]) => [service, normalizePrefix(route.prefix) || '/']),
  );
}

function deriveAssetBaseUrl(apiOrigin, routes = DEFAULT_ROUTES) {
  const prefix = normalizePrefix(routes?.approval?.prefix) || '/approval';
  const origin = String(apiOrigin || '').replace(/\/+$/, '');
  return `${origin}${prefix}/api/overlays`;
}

export function normalizePanelBootstrap(panelBootstrap = {}, routes = DEFAULT_ROUTES) {
  const merged = { ...DEFAULT_PANEL_BOOTSTRAP, ...(panelBootstrap || {}) };
  const apiOrigin = String(merged.apiOrigin || DEFAULT_PANEL_BOOTSTRAP.apiOrigin).replace(/\/+$/, '');
  return {
    app_version: String(merged.appVersion || DEFAULT_PANEL_BOOTSTRAP.appVersion),
    settings_version: String(merged.settingsVersion || DEFAULT_PANEL_BOOTSTRAP.settingsVersion),
    api_origin: apiOrigin,
    asset_base_url: String(merged.assetBaseUrl || '').trim() || deriveAssetBaseUrl(apiOrigin, routes),
    min_shell_version: String(merged.minShellVersion || DEFAULT_PANEL_BOOTSTRAP.minShellVersion),
    run_mode: merged.runMode === 'demo' ? 'demo' : 'local',
    routes: routePrefixesForBootstrap(routes),
    feature_flags: merged.featureFlags && typeof merged.featureFlags === 'object' ? merged.featureFlags : {},
  };
}

