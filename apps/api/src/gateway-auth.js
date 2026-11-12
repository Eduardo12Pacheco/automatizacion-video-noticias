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
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';

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

export function normalizePanelUser(rawUser = {}) {
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

export function verifyScryptPassword(password, passwordHash) {
  const parts = String(passwordHash || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false;
  const [, , salt, expectedValue] = parts;
  const expected = Buffer.from(expectedValue, 'base64url');
  if (!salt || expected.length === 0) return false;
  const actual = scryptSync(String(password || ''), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function verifyPanelUserPassword(panelUser, password) {
  if (!panelUser) return false;
  if (panelUser.password_hash) return verifyScryptPassword(password, panelUser.password_hash);
  return panelUser.pass != null && String(password) === panelUser.pass;
}

export function normalizePanelUsers(panelUsers, panelAuth) {
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
  return [];
}

export async function getVerifiedSession(req, options) {
  cleanupExpiredSessions(options);
  const token = readPanelSessionToken(req);
  if (!token) return null;
  if (options.authService) {
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

  let authenticated = null;
  if (options.authService) {
    try {
      authenticated = await options.authService.authenticate({ user, password: pass });
    } catch {
      authenticated = null;
    }
  } else {
    const legacy = options.panelUsers.get(user);
    if (verifyPanelUserPassword(legacy, pass)) {
      authenticated = { user: legacy.profile.user, roles: legacy.profile.roles, source: 'legacy' };
    }
  }
  if (!authenticated) {
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
    if (options.authService) await options.authService.revokeSession(token);
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
 * Forwarded headers are honoured only when the TCP peer is the bundled panel
 * proxy (TRUSTED_PROXY_CIDRS, default the private Compose network).
 */
export function resolveClientIp(req = {}, { trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS } = {}) {
  const peer = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (!peer) return 'unknown';
  if (!isIpInCidrs(peer, trustedProxyCidrs)) return peer;
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return normalizeIp(forwarded) || peer;
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

