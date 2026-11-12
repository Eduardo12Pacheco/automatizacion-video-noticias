import {
  DEFAULT_ROUTES,
  LOCAL_SERVICE_NAMES,
  PANEL_READ_MODEL_PREFIX,
  PROTECTED_MUTATION_ROLE,
  SAFE_READ_METHODS,
  applyCorsHeaders,
  isTrustedMutationOrigin,
  matchesPrefix,
  normalizePanelBootstrap,
  resolveRouteMatches,
  splitCsvHeader,
} from './gateway-config.js';
import { emitGatewayEvent, requestBaseContext, writeJson } from './gateway-http.js';

export function isMutationMethod(method) {
  return !SAFE_READ_METHODS.has(String(method || '').toUpperCase());
}

export function isSafeReadMethod(method) {
  return SAFE_READ_METHODS.has(String(method || '').toUpperCase());
}

export function compareVersionParts(left, right) {
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

export function shouldRejectStaleShell(req, options) {
  if (!isMutationMethod(req.method)) return false;
  const minShellVersion = normalizePanelBootstrap(options.panelBootstrap, options.routes).min_shell_version;
  const receivedShellVersion = String(req.headers['x-control-panel-shell-version'] || '').trim();
  if (!minShellVersion || !receivedShellVersion) return false;
  return compareVersionParts(receivedShellVersion, minShellVersion) < 0;
}

export function rejectStaleShell(req, res, options) {
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

export function handlePreflight(req, res, options) {
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

export function isPublicLocalLivenessRoute(route) {
  if (!route || !LOCAL_SERVICE_NAMES.has(route.service)) return false;
  const pathname = new URL(route.upstreamPath, 'http://gateway.local').pathname;
  return pathname === '/health' || pathname === '/healthz' || pathname === '/api/monitor/live' || pathname === '/api/radar/live';
}

export function isPublicLocalUnauthenticatedRoute(route) {
  return isPublicLocalLivenessRoute(route);
}

export function resolvePanelReadModelRoute(rawUrl, routes = DEFAULT_ROUTES) {
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

export function isPanelReadModelPath(pathname = '') {
  return matchesPrefix(pathname, PANEL_READ_MODEL_PREFIX);
}

export function rejectPolicy({ statusCode = 404, code = 'route_not_found' } = {}) {
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

export function routePolicy(overrides = {}) {
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

export function hasInjectedServiceCredentials(route, options) {
  return Object.values(options.serviceCredentials[route?.service] || {}).some((value) => value != null && String(value) !== '');
}

export function shouldProtectRequest(req, route, options = { serviceCredentials: {} }) {
  if (isPublicLocalUnauthenticatedRoute(route)) return false;
  if (isMutationMethod(req.method)) return true;
  if (LOCAL_SERVICE_NAMES.has(route?.service) && isPublicLocalLivenessRoute(route)) return false;
  if (hasInjectedServiceCredentials(route, options)) return true;
  return LOCAL_SERVICE_NAMES.has(route?.service);
}

export function shouldRequireEditorRole(req) {
  return isMutationMethod(req.method);
}

export function rejectUnauthenticated(req, res, options, { action = 'proxy.authorization', route = null } = {}) {
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

export function rejectForbidden(req, res, options, {
  route = null,
  session = null,
  action = 'proxy.authorization',
  requiredRole = PROTECTED_MUTATION_ROLE,
} = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  const role = requiredRole || PROTECTED_MUTATION_ROLE;
  emitGatewayEvent(req, options, {
    kind: 'audit',
    severity: 'warning',
    route_service: route?.service,
    action,
    outcome: 'rejected',
    status_code: 403,
    reason_code: 'forbidden',
    safe_message: 'Required role missing',
    context: requestBaseContext(req, { required_role: role }),
  }, session);
  writeJson(res, 403, { error: 'forbidden', code: 'forbidden', required_role: role });
}

export function rejectCsrf(req, res, options, { action = 'proxy.csrf', route = null, session = null } = {}) {
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

export function rejectPayloadTooLarge(req, res, options, { route = null, session = null, action = 'proxy.payload' } = {}) {
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

export function routeBodyLimit(route, options) {
  return route?.maxBodyBytes || options.maxBodyBytes;
}

export function enforceBodySizeLimit(req, res, options, route = null) {
  const maxBodyBytes = routeBodyLimit(route, options);
  const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    rejectPayloadTooLarge(req, res, options, { route });
    return false;
  }
  return true;
}

export function safePathSegment(rawSegment) {
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

export function isTrustedMutationRequest(req, options) {
  if (!isMutationMethod(req.method)) return true;
  const origin = String(req.headers.origin || '').trim();
  return isTrustedMutationOrigin(origin, options.trustedMutationOrigins);
}

