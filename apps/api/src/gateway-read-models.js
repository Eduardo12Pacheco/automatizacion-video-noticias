import { applyCorsHeaders, normalizePanelBootstrap, resolvePanelRequestOrigin } from './gateway-config.js';
import { DEFAULT_EVENT_RETENTION } from './gateway-events.js';
import { emitGatewayEvent, readJsonBody, requestBaseContext, writeJson } from './gateway-http.js';
import { getVerifiedSession, requireRole } from './gateway-auth.js';
import { rejectPayloadTooLarge, rejectUnauthenticated } from './gateway-policy.js';
import { normalizePresencePayload, presenceSessionEntry, presenceSnapshot, presenceTtlSeconds } from './presence.js';

export function handlePanelBootstrap(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const apiOrigin = resolvePanelRequestOrigin(req, options.panelBootstrap?.apiOrigin || '');
  writeJson(res, 200, normalizePanelBootstrap({ ...options.panelBootstrap, ...(apiOrigin ? { apiOrigin } : {}) }, options.routes), {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
  });
}


export function handleReady(req, res, options) {
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

export function gatewayEventsFilters(rawUrl) {
  const parsed = new URL(rawUrl || '/', 'http://gateway.local');
  const allowed = new Set(['kind', 'status', 'service', 'actor', 'correlation_id', 'from', 'to', 'limit']);
  const filters = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    if (allowed.has(key) && value !== '') filters[key] = value;
  }
  return filters;
}

export async function handleGatewayEventsReadModel(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = await getVerifiedSession(req, options);
  if (!requireRole(req, res, options, {
    session,
    role: 'admin',
    action: 'gateway.events.read',
  })) {
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

export async function handlePresenceHeartbeat(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = await getVerifiedSession(req, options);
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

export async function handlePresenceReadModel(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = await getVerifiedSession(req, options);
  if (!requireRole(req, res, options, {
    session,
    role: 'admin',
    action: 'gateway.presence.read',
  })) {
    return;
  }
  writeJson(res, 200, presenceSnapshot(options), {
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

