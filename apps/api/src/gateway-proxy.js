import http from 'node:http';
import https from 'node:https';

import {
  BROWSER_SUPPLIED_IDENTITY_HEADERS,
  BROWSER_SUPPLIED_SECRET_HEADERS,
  CORS_RESPONSE_HEADERS,
  SECRET_RESPONSE_HEADERS,
  PayloadTooLargeError,
  applyCorsHeaders,
  isBrowserSuppliedIdentityHeader,
} from './gateway-config.js';
import { emitGatewayEvent, removeHopByHopHeaders, requestBaseContext, sanitizeHeadersForLog, writeJson } from './gateway-http.js';
import { readRawBody } from './gateway-http.js';
import { rejectPayloadTooLarge, routeBodyLimit, shouldProtectRequest } from './gateway-policy.js';

export function sanitizeProtectedHeaders(headers = {}) {
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

export function sanitizeUnprotectedHeaders(headers = {}) {
  const clean = { ...headers };
  delete clean.cookie;
  delete clean.Cookie;
  for (const name of Object.keys(clean)) {
    if (BROWSER_SUPPLIED_SECRET_HEADERS.has(name.toLowerCase())) delete clean[name];
    if (isBrowserSuppliedIdentityHeader(name)) delete clean[name];
  }
  return clean;
}

export function sanitizeProxyResponseHeaders(headers = {}) {
  const clean = removeHopByHopHeaders(headers);
  for (const name of Object.keys(clean)) {
    if (SECRET_RESPONSE_HEADERS.has(name.toLowerCase())) delete clean[name];
    if (CORS_RESPONSE_HEADERS.has(name.toLowerCase())) delete clean[name];
  }
  return clean;
}

export function injectGatewayContext(headers, route, session, options) {
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

export function actorAuditPayload(session) {
  return {
    actor: session.user.user_id,
    email: session.user.email,
    display_name: session.user.display_name,
    roles: session.roles,
    session_id: session.session_id,
  };
}

export function resolveBaseVersionMetadata(body = {}) {
  const baseVersion = body.base_version ?? body.baseVersion;
  const baseSnapshotHash = body.base_snapshot_hash ?? body.baseSnapshotHash ?? body.snapshotHash;
  return {
    ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
    ...(baseSnapshotHash !== undefined ? { base_snapshot_hash: baseSnapshotHash } : {}),
    ...(body.lease_id !== undefined ? { lease_id: body.lease_id } : {}),
  };
}

export async function enrichProtectedJsonBody(req, headers, session, options) {
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

export function proxyRequest(req, res, route, options, session = null, bodyBuffer = null) {
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
  const maxBodyBytes = routeBodyLimit(route, options);
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
      if (pipedBytes > maxBodyBytes) {
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

export async function proxyProtectedRequest(req, res, route, options, session) {
  const rawHeaders = sanitizeProtectedHeaders(req.headers);
  const baseHeaders = injectGatewayContext(removeHopByHopHeaders(rawHeaders), route, session, options);
  const { headers, bodyBuffer } = await enrichProtectedJsonBody(req, baseHeaders, session, options);
  proxyRequest(req, res, route, { ...options, preparedHeaders: headers }, session, bodyBuffer);
}

