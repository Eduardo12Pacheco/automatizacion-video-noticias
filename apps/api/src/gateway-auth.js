import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  SERVICE_CREDENTIAL_ENV,
  applyCorsHeaders,
} from './gateway-config.js';
import { emitGatewayEvent, readJsonBody, requestBaseContext, writeJson } from './gateway-http.js';
import { isTrustedMutationRequest, rejectCsrf, rejectForbidden, rejectPayloadTooLarge, rejectUnauthenticated } from './gateway-policy.js';
import {
  isCrossSitePanelRequest,
  isExpiredSession,
  normalizePanelSession,
  readPanelSessionToken,
  serializePanelSessionCookie,
  sessionResponse,
  toExpirationTime,
} from './sessions.js';
import { normalizeEmail } from './auth.js';
import { isIP } from 'node:net';

export function buildBasicAuthorization(user, pass) {
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

export function cleanupExpiredSessions(options) {
  options.panelSessions.cleanup(options.now());
}

export async function getVerifiedSession(req, options) {
  cleanupExpiredSessions(options);
  const token = readPanelSessionToken(req);
  if (!token) return null;
  if (options.authService?.getSession) {
    const stored = await options.authService.getSession(token);
    if (stored) return { token, ...normalizePanelSession(stored) };
  }
  const session = options.panelSessions.get(token, options.now());
  if (!session) return null;
  return { token, ...normalizePanelSession(session) };
}


export async function handlePanelSession(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  const session = await getVerifiedSession(req, options);
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

export async function handlePanelLogin(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  if (!isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { action: 'panel.login' });
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
  const clientIp = resolveClientIp(req, options);
  const clientKey = loginThrottleKey(user, clientIp);
  const nowMs = options.now();
  const attempt = options.loginAttempts.get(clientKey, nowMs) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > nowMs) {
    const waitSeconds = Math.ceil((attempt.lockedUntil - nowMs) / 1000);
    writeJson(res, 429, { error: 'too_many_attempts', code: 'too_many_attempts', retry_after_seconds: waitSeconds });
    return;
  }
  const ipAttempt = options.loginIpAttempts.get(clientIp, nowMs) || { count: 0, lockedUntil: 0 };
  if (ipAttempt.lockedUntil > nowMs) {
    const waitSeconds = Math.ceil((ipAttempt.lockedUntil - nowMs) / 1000);
    writeJson(res, 429, { error: 'too_many_attempts', code: 'too_many_attempts', retry_after_seconds: waitSeconds });
    return;
  }

  let authenticated = null;
  if (options.authService?.authenticate) {
    try {
      authenticated = await options.authService.authenticate({ user, password: pass });
    } catch {
      authenticated = null;
    }
  }
  if (!authenticated) {
    const next = { count: attempt.count + 1, lockedUntil: nowMs + Math.min(1000 * 2 ** attempt.count, 60000) };
    const stored = options.loginAttempts.set(clientKey, next, {
      ttlMs: options.loginAttemptTtlMs,
      nowMs,
      // A currently locked key must never be evicted by unrelated usernames.
      evictable: next.lockedUntil <= nowMs,
    });
    const ipCount = ipAttempt.count + 1;
    const ipNext = {
      count: ipCount,
      lockedUntil: ipCount >= options.loginIpFailureLimit ? nowMs + options.loginIpLockMs : 0,
    };
    const ipStored = options.loginIpAttempts.set(clientIp, ipNext, {
      ttlMs: options.loginAttemptTtlMs,
      nowMs,
      evictable: ipNext.lockedUntil <= nowMs,
    });
    if (!stored || !ipStored) {
      // The throttle store is full of live locks: fail closed instead of
      // dropping an existing lock to make room for this attempt.
      emitGatewayEvent(req, options, {
        kind: 'audit',
        severity: 'warning',
        action: 'panel.login',
        outcome: 'rejected',
        status_code: 429,
        reason_code: 'throttle_capacity',
        safe_message: 'Login throttle capacity exhausted',
        context: requestBaseContext(req, { attempted_user: user }),
      });
      writeJson(res, 429, {
        error: 'too_many_attempts',
        code: 'too_many_attempts',
        retry_after_seconds: Math.ceil(options.loginAttemptTtlMs / 1000),
      });
      return;
    }
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

  let session;
  let token;
  if (options.authService && authenticated.source === 'repository') {
    session = await options.authService.createSession({
      user: authenticated.user,
      roles: authenticated.roles,
      ipAddress: clientIp,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    token = session.token;
  }
  if (!session) {
    token = options.createSessionToken();
    session = normalizePanelSession({
      user: authenticated.user,
      roles: authenticated.roles,
      session_id: options.createSessionId(),
      expires_at: new Date(options.now() + options.panelSessionMaxAgeSeconds * 1000).toISOString(),
    });
    options.panelSessions.set(token, session, { ttlMs: options.panelSessionMaxAgeSeconds * 1000, nowMs: options.now() });
  }
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
      secure: requestUsesHttps(req, options),
    }),
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}

export async function handlePanelLogout(req, res, options) {
  applyCorsHeaders(res, req.headers.origin, options);
  if (!isTrustedMutationRequest(req, options)) {
    rejectCsrf(req, res, options, { action: 'panel.logout' });
    return;
  }
  const token = readPanelSessionToken(req);
  const session = token ? options.panelSessions.get(token, options.now()) : null;
  if (token) {
    options.panelSessions.delete(token);
    if (options.authService?.revokeSession) await options.authService.revokeSession(token);
  }
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
      secure: requestUsesHttps(req, options),
    }),
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
  });
}



export function ipv4ToInt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

export function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mapped = raw.toLowerCase().startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return isIP(mapped) ? mapped : '';
}

export function isIpInCidrs(value, cidrs = []) {
  const ip = normalizeIp(value);
  if (!ip) return false;
  for (const cidr of cidrs) {
    const text = String(cidr || '').trim();
    if (!text) continue;
    const [network, prefixText] = text.split('/');
    const networkIp = normalizeIp(network);
    if (!networkIp) continue;
    if (prefixText === undefined) {
      if (networkIp === ip) return true;
      continue;
    }
    const prefix = Number.parseInt(prefixText, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
    const networkInt = ipv4ToInt(networkIp);
    const ipInt = ipv4ToInt(ip);
    if (networkInt == null || ipInt == null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ipInt & mask) === (networkInt & mask)) return true;
  }
  return false;
}

/**
 * Resolve the client address without trusting a spoofed X-Forwarded-For.
 *
 * Forwarded headers are honoured only when the TCP peer is a trusted proxy
 * (TRUSTED_PROXY_CIDRS, the panel container in Compose). The chain is read
 * right-to-left and the first address that is not itself a trusted proxy is
 * the client, so a caller cannot prepend a fake entry. A request that arrives
 * directly at the published API port has an untrusted peer and its XFF header
 * is ignored entirely.
 */
export function resolveClientIp(req = {}, { trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS } = {}) {
  const peer = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (!peer) return 'unknown';
  if (!isIpInCidrs(peer, trustedProxyCidrs)) return peer;
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter(Boolean);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    if (!isIpInCidrs(forwarded[index], trustedProxyCidrs)) return forwarded[index];
  }
  return peer;
}

/**
 * True when the request reached the API over HTTPS, either directly or through
 * the trusted panel proxy (`X-Forwarded-Proto: https`). A direct client that
 * sets the header is ignored, so the Secure cookie flag cannot be forced by an
 * untrusted peer.
 */
export function requestUsesHttps(req = {}, { trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS } = {}) {
  if (req.socket?.encrypted === true) return true;
  const peer = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (!peer || !isIpInCidrs(peer, trustedProxyCidrs)) return false;
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https';
}

export function loginThrottleKey(user, clientIp) {
  return `${normalizeEmail(user)}|${clientIp}`;
}

export function sessionHasRole(session, role) {
  if (!session) return false;
  if (!role) return true;
  if (role === 'admin') return Array.isArray(session.roles) && session.roles.includes('admin');
  return Array.isArray(session.roles)
    && (session.roles.includes(role) || session.roles.includes('admin'));
}

/**
 * The single role gate used by every panel mutation (route table rows) and by
 * the generic proxy policy. Returns the session when allowed, null after the
 * 401/403 response has been written.
 */
export function requireRole(req, res, options, {
  role = null,
  session = null,
  action = 'authorization',
  route = null,
} = {}) {
  if (!session) {
    rejectUnauthenticated(req, res, options, { action, route });
    return null;
  }
  if (!sessionHasRole(session, role)) {
    rejectForbidden(req, res, options, { action, route, session, requiredRole: role });
    return null;
  }
  return session;
}

