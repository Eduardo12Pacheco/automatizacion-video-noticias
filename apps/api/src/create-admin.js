import { normalizeEmail, createAuthService, hashPassword } from './auth.js';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Validates the inputs needed to bootstrap the first administrator (S9).
 * The installer generates the password when it runs non-interactively, so this
 * is the single place that enforces the minimum policy for every entrypoint.
 */
export function validateBootstrapInput({ email, password, resetPassword = false } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    throw new Error('a valid admin email is required');
  }
  if (resetPassword || password !== undefined) {
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }
  return normalized;
}

function withoutPasswordHash(user) {
  if (!user) return null;
  const { password_hash: _passwordHash, ...rest } = user;
  return rest;
}

/**
 * Creates the first admin or repairs an existing account so it can administer
 * the installation. It is intentionally idempotent: re-running the installer
 * must not reset a password the owner already changed.
 */
export async function ensureAdminUser({
  repository = null,
  email,
  password,
  displayName = '',
  resetPassword = false,
} = {}) {
  if (!repository) throw new Error('a repository is required');
  const normalizedEmail = validateBootstrapInput({ email, password, resetPassword });
  const existing = await repository.getUserByEmail(normalizedEmail);

  if (existing) {
    const roles = [...new Set([...(existing.roles || []), 'admin'])].sort();
    const rolesChanged = roles.length !== (existing.roles || []).length;
    let updated = existing;
    if (rolesChanged) updated = await repository.setUserRoles(existing.user_id, roles);
    if (existing.status !== 'active') {
      updated = await repository.updateUser(existing.user_id, { status: 'active' });
    }
    if (resetPassword) {
      updated = await repository.updateUser(existing.user_id, {
        passwordHash: await hashPassword(password),
      });
    }
    return {
      created: false,
      existing: true,
      roles_changed: rolesChanged,
      password_changed: Boolean(resetPassword),
      user: withoutPasswordHash(updated),
    };
  }

  const authService = createAuthService({ repository });
  const user = await authService.createUser({
    email: normalizedEmail,
    display_name: displayName,
    password,
    roles: ['admin'],
  });
  return {
    created: true,
    existing: false,
    roles_changed: true,
    password_changed: true,
    user,
  };
}
