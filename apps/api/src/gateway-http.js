import { DEFAULT_MAX_BODY_BYTES, HOP_BY_HOP_HEADERS, PayloadTooLargeError, SECRET_LOG_HEADERS } from './gateway-config.js';
import { sanitizeEventContext } from './gateway-events.js';

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


export function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function requestPath(req) {
  return new URL(req.url || '/', 'http://gateway.local').pathname;
}

export function requestBaseContext(req, extra = {}) {
  return {
    headers: req.headers,
    ...extra,
  };
}

export function actorFromSession(session) {
  if (!session) return null;
  return {
    user_id: session.user?.user_id,
    email: session.user?.email,
    display_name: session.user?.display_name,
    roles: session.roles,
  };
}

export function emitGatewayEvent(req, options, event, session = null) {
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


export function readJsonBody(req, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
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

export function readRawBody(req, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
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

