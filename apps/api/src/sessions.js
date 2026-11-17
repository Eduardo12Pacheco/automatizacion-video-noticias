export const PANEL_SESSION_COOKIE = 'approval-panel-session-v1';

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

export function readPanelSessionToken(req) {
  return parseCookies(req.headers.cookie).get(PANEL_SESSION_COOKIE) || '';
}

export function isCrossSitePanelRequest(req) {
  const origin = String(req.headers.origin || '').trim();
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!origin || !host) return false;
  try {
    return new URL(origin).hostname.toLowerCase() !== host;
  } catch {
    return false;
  }
}

export function serializePanelSessionCookie(value, { maxAgeSeconds, crossSite = false, secure = false } = {}) {
  const sameSite = crossSite ? 'SameSite=None' : 'SameSite=Lax';
  const secureFlag = crossSite || secure ? '; Secure' : '';
  return `${encodeURIComponent(PANEL_SESSION_COOKIE)}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; ${sameSite}${secureFlag}`;
}

export function normalizePanelSession(rawSession = {}) {
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

export function sessionResponse(session) {
  const normalized = normalizePanelSession(session);
  return {
    user: normalized.user,
    roles: normalized.roles,
    session_id: normalized.session_id,
  };
}

export function toExpirationTime(value) {
  if (value == null || value === '') return Number.POSITIVE_INFINITY;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function isExpiredSession(session, nowMs) {
  return toExpirationTime(session.expires_at) <= nowMs;
}
