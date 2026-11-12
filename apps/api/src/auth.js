import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DomainError, NotFoundError, ValidationError } from '@newsroom/core';

const DEFAULT_ROUNDS = 12;
const VALID_ROLES = new Set(['admin', 'editor', 'viewer']);

export class AuthError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: 'invalid_credentials', statusCode: 401, ...options });
  }
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function hashPassword(password, { rounds = DEFAULT_ROUNDS } = {}) {
  const value = String(password || '');
  if (value.length < 8) throw new ValidationError('password must be at least 8 characters');
  return bcrypt.hash(value, rounds);
}

export function verifyPassword(password, passwordHash) {
  const hash = String(passwordHash || '');
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(password || ''), hash);
  } catch {
    return false;
  }
}

export function hashSessionToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeRoles(roles) {
  const values = Array.isArray(roles) ? roles.map((role) => String(role).trim()).filter(Boolean) : [];
  if (!values.length) throw new ValidationError('at least one role is required');
  const invalid = values.filter((role) => !VALID_ROLES.has(role));
  if (invalid.length) throw new ValidationError(`unknown role: ${invalid.join(', ')}`);
  return [...new Set(values)];
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash: _passwordHash, ...rest } = user;
  return rest;
}

function sessionView(record) {
  if (!record) return null;
  return {
    user: {
      user_id: record.user.user_id,
      email: record.user.email,
      display_name: record.user.display_name,
    },
    roles: [...(record.roles || [])],
    session_id: record.session_id,
    expires_at: record.expires_at,
    last_seen_at: record.last_seen_at || null,
  };
}

/**
 * Local auth service (S9): users, roles and sessions live in the repository
 * (Postgres or in-memory). Passwords are bcrypt hashes; session tokens are
 * random, only their SHA-256 hash is stored. There is deliberately no
 * plaintext environment fallback: the installer seeds the first admin through
 * the bootstrap, and every later login must match an active database user.
 */
export function createAuthService({
  repository = null,
  now = () => Date.now(),
  sessionMaxAgeSeconds = 60 * 60 * 24 * 7,
  rounds = DEFAULT_ROUNDS,
} = {}) {
  if (!repository) throw new Error('repository is required');

  async function authenticate({ user = '', password = '' } = {}) {
    const email = normalizeEmail(user);
    if (repository && email) {
      const record = await repository.getUserByEmail(email);
      if (record && record.status === 'active' && verifyPassword(password, record.password_hash)) {
        await repository.updateUser(record.user_id, { last_login_at: new Date(now()).toISOString() });
        return {
          user: {
            user_id: record.user_id,
            email: record.email,
            display_name: record.display_name,
          },
          roles: [...record.roles],
          source: 'repository',
        };
      }
    }
    throw new AuthError('Invalid credentials');
  }

  async function createSession({ user, roles = [], ipAddress = '', userAgent = '' } = {}) {
    if (!repository) return null;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(now() + sessionMaxAgeSeconds * 1000).toISOString();
    const record = await repository.createSession({
      userId: user.user_id,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent,
    });
    return {
      ...sessionView({
        user,
        roles,
        session_id: record.session_id,
        expires_at: record.expires_at,
      }),
      token,
    };
  }

  async function getSession(token) {
    if (!repository || !token) return null;
    const record = await repository.getSessionByTokenHash(hashSessionToken(token));
    if (!record) return null;
    await repository.touchSession(record.session_id, { lastSeenAt: new Date(now()).toISOString() });
    return sessionView(record);
  }

  async function revokeSession(token) {
    if (!repository || !token) return undefined;
    const record = await repository.getSessionByTokenHash(hashSessionToken(token));
    if (record) await repository.revokeSession(record.session_id);
    return undefined;
  }

  async function listUsers() {
    if (!repository) return [];
    return (await repository.listUsers()).map(publicUser);
  }

  async function createUser({ email, display_name: displayName, password, roles = ['viewer'] } = {}) {
    if (!repository) throw new ValidationError('user repository is not configured');
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) throw new ValidationError('valid email is required');
    const normalizedRoles = normalizeRoles(roles);
    const passwordHash = await hashPassword(password, { rounds });
    const user = await repository.createUser({
      email: normalizedEmail,
      displayName: displayName || normalizedEmail,
      passwordHash,
      roles: normalizedRoles,
    });
    return publicUser(user);
  }

  async function updateUser(userId, { display_name: displayName, status, roles, password } = {}) {
    if (!repository) throw new ValidationError('user repository is not configured');
    const existing = await repository.getUserById(userId);
    if (!existing) throw new NotFoundError('user not found');
    const patch = {};
    if (displayName !== undefined) patch.displayName = String(displayName).trim();
    if (status !== undefined) patch.status = String(status);
    if (password !== undefined) patch.passwordHash = await hashPassword(password, { rounds });
    let updated = Object.keys(patch).length ? await repository.updateUser(userId, patch) : existing;
    if (roles !== undefined) updated = await repository.setUserRoles(userId, normalizeRoles(roles));
    return publicUser(updated);
  }

  return {
    authenticate,
    createSession,
    getSession,
    revokeSession,
    listUsers,
    createUser,
    updateUser,
    listRoles: () => repository.listRoles(),
    normalizeRoles,
  };
}
