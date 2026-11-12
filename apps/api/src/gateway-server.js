import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_EXPOSED_HEADERS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PANEL_BOOTSTRAP,
  DEFAULT_PANEL_SESSION_MAX_AGE_SECONDS,
  DEFAULT_PRESENCE_TTL_MS,
  DEFAULT_ROUTES,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  GATEWAY_EVENTS_READ_MODEL_PATH,
  GATEWAY_PRESENCE_READ_MODEL_PATH,
  PANEL_PRESENCE_HEARTBEAT_PATH,
  PROTECTED_MUTATION_ROLE,
  BoundedTtlStore,
  GatewayConfigError,
  applyCorsHeaders,
  matchesPrefix,
  normalizePanelBootstrap,
  validateCorsMethods,
  validateHeaderNames,
  validateRoutePrefixes,
  validateTrustedMutationOrigins,
} from './gateway-config.js';
import { selectCorrelationId } from './gateway-events.js';
import { emitGatewayEvent, readRawBody, requestBaseContext, writeJson } from './gateway-http.js';
import { getVerifiedSession, handlePanelLogin, handlePanelLogout, handlePanelSession, normalizePanelUsers, requireRole } from './gateway-auth.js';
import {
  enforceBodySizeLimit,
  handlePreflight,
  isPanelReadModelPath,
  isSafeReadMethod,
  isTrustedMutationRequest,
  rejectCsrf,
  rejectPayloadTooLarge,
  rejectStaleShell,
  rejectUnauthenticated,
  resolvePanelReadModelRoute,
  resolveRoutePolicy,
  shouldRejectStaleShell,
} from './gateway-policy.js';
import { proxyProtectedRequest, proxyRequest } from './gateway-proxy.js';
import {
  handleGatewayEventsReadModel,
  handlePanelBootstrap,
  handlePresenceHeartbeat,
  handlePresenceReadModel,
  handleReady,
} from './gateway-read-models.js';
import { matchPanelMutation } from './route-table.js';
import { normalizePanelSession, toExpirationTime } from './sessions.js';

export async function handlePanelDataRequest(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const parsed = new URL(req.url || '/', 'http://gateway.local');
  const pathname = parsed.pathname;
  const method = String(req.method || 'GET').toUpperCase();
  const mutation = matchPanelMutation(method, pathname);

  const session = await getVerifiedSession(req, options);
  if (!requireRole(req, res, options, {
    session,
    role: mutation?.role || null,
    action: 'panel.data.authorization',
  })) {
    return;
  }
  if (mutation && !isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { action: 'panel.data.csrf', session });
    return;
  }

  let result;
  try {
    result = await options.dataRouter.handle({
      method,
      pathname,
      searchParams: parsed.searchParams,
      headers: req.headers,
      readBody: (limits = {}) => readRawBody(req, {
        maxBodyBytes: limits.maxBodyBytes || options.maxBodyBytes,
      }),
    });
  } catch (error) {
    if (error?.code === 'payload_too_large') {
      rejectPayloadTooLarge(req, res, options, { session, action: 'panel.data.payload' });
      return;
    }
    emitGatewayEvent(req, options, {
      kind: 'error',
      action: 'panel.data.request',
      outcome: 'failure',
      status_code: 400,
      reason_code: 'invalid_request',
      safe_message: 'Panel data request failed',
      context: requestBaseContext(req, { error: error.message }),
    }, session);
    if (!res.headersSent) writeJson(res, 400, { ok: false, error: 'invalid_request' });
    return;
  }

  const headers = result.headers || {};
  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    writeJson(res, result.status, result.body, headers);
    return;
  }
  res.writeHead(result.status, headers);
  res.end(result.body ?? undefined);
}

export async function handleLocalRouterRequest(req, res, options, router, { admin = false } = {}) {
  applyCorsHeaders(res, req.headers.origin, options);
  const parsed = new URL(req.url || '/', 'http://gateway.local');
  const pathname = parsed.pathname;
  const method = String(req.method || 'GET').toUpperCase();
  const safeRead = method === 'GET' || method === 'HEAD';
  const mutation = admin ? null : matchPanelMutation(method, pathname);
  const mutating = admin ? !safeRead : Boolean(mutation);

  const session = await getVerifiedSession(req, options);
  if (!requireRole(req, res, options, {
    session,
    role: admin ? 'admin' : mutation?.role || null,
    action: admin ? 'panel.admin.authorization' : 'panel.local.authorization',
  })) {
    return;
  }
  if (mutating && !isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { session, action: admin ? 'panel.admin.csrf' : 'panel.local.csrf' });
    return;
  }

  let result;
  try {
    result = await router.handle({
      method,
      pathname,
      searchParams: parsed.searchParams,
      headers: req.headers,
      actor: { ...session.user, roles: session.roles },
      readBody: (limits = {}) => readRawBody(req, {
        maxBodyBytes: limits.maxBodyBytes || options.maxBodyBytes,
      }),
    });
  } catch (error) {
    if (error?.code === 'payload_too_large') {
      rejectPayloadTooLarge(req, res, options, { session, action: admin ? 'panel.admin.payload' : 'panel.local.payload' });
      return;
    }
    emitGatewayEvent(req, options, {
      kind: 'error',
      action: admin ? 'panel.admin.request' : 'panel.local.request',
      outcome: 'failure',
      status_code: 400,
      reason_code: 'invalid_request',
      safe_message: 'Panel request failed',
      context: requestBaseContext(req, { error: error.message }),
    }, session);
    if (!res.headersSent) writeJson(res, 400, { ok: false, error: 'invalid_request' });
    return;
  }

  const headers = result.headers || {};
  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    writeJson(res, result.status, result.body, headers);
    return;
  }
  res.writeHead(result.status, headers);
  res.end(result.body ?? undefined);
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
  trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS,
  maxPresenceSessions = 1_000,
  presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
  readinessChecks = null,
  now = Date.now,
  createSessionToken = randomUUID,
  createSessionId = randomUUID,
  createCorrelationId = randomUUID,
  eventRecorder = null,
  dataRouter = null,
  localRouter = null,
  adminRouter = null,
  authService = null,
  logger = console,
} = {}) {
  const normalizedPanelUsers = normalizePanelUsers(panelUsers, panelAuth);
  if (!normalizedPanelUsers.size && !authService) {
    throw new GatewayConfigError('API Gateway panel auth requires an auth service or configured panel users');
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

  if (!Array.isArray(trustedProxyCidrs) || trustedProxyCidrs.some((cidr) => typeof cidr !== 'string' || !cidr.trim())) {
    throw new GatewayConfigError('trustedProxyCidrs must be an array of CIDR strings');
  }

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
    trustedProxyCidrs,
    readinessChecks,
    now,
    createSessionToken,
    createSessionId,
    createCorrelationId,
    eventRecorder,
    dataRouter,
    localRouter,
    adminRouter,
    authService,
    logger,
    loginAttempts: new BoundedTtlStore({ maxEntries: maxLoginAttempts }),
    presenceStore: new BoundedTtlStore({ maxEntries: maxPresenceSessions }),
    presenceTtlMs,
  };
  const startTime = options.now();
  return createServer(async (req, res) => {
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
      void handlePanelSession(req, res, options);
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
      void handlePanelLogout(req, res, options);
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
      void handlePresenceReadModel(req, res, options);
      return;
    }
    if (options.adminRouter?.matches(panelPath)) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      void handleLocalRouterRequest(req, res, options, options.adminRouter, { admin: true });
      return;
    }
    if (options.localRouter?.matches(panelPath)) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      void handleLocalRouterRequest(req, res, options, options.localRouter);
      return;
    }
    if (options.dataRouter?.matches(panelPath)) {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, options);
        return;
      }
      void handlePanelDataRequest(req, res, options);
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
      const session = await getVerifiedSession(req, options);
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
      session = await getVerifiedSession(req, options);
      if (!requireRole(req, res, options, {
        session,
        role: policy.requiresEditor ? PROTECTED_MUTATION_ROLE : null,
        action: 'proxy.authorization',
        route,
      })) {
        return;
      }
      if (policy.requiresCsrf && !isTrustedMutationRequest(req, options)) {
        rejectCsrf(req, res, options, { route, session });
        return;
      }
    }
    if (!enforceBodySizeLimit(req, res, options, route)) {
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

