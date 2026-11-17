import { randomUUID } from 'node:crypto';
import { clone, normalizeTimestamps, textOrNull, toIso } from './in-memory-shared.js';

/** User, role and session methods mixed into InMemoryRepository. */
export const inMemoryUserMethods = {
    async listRoles() {
      return [...this._roles.values()].map((role) => clone(role));
    },

    _userView(user) {
      return {
        ...clone(user),
        roles: [...(this._userRoles.get(user.user_id) || [])].sort(),
      };
    },
    async createUser({ email, displayName = '', passwordHash, roles = ['editor'] } = {}) {
      const normalizedEmail = textOrNull(email)?.toLowerCase();
      if (!normalizedEmail) throw new Error('email is required');
      if (!passwordHash) throw new Error('passwordHash is required');
      if ([...this._users.values()].some((user) => user.email === normalizedEmail)) {
        const error = new Error('duplicate email');
        error.code = '23505';
        throw error;
      }
      const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
      for (const role of normalizedRoles) {
        if (!this._roles.has(role)) throw new Error(`unknown role: ${role}`);
      }
      const now = this._nowIso();
      const user = normalizeTimestamps({
        user_id: randomUUID(),
        email: normalizedEmail,
        display_name: textOrNull(displayName) || normalizedEmail,
        password_hash: String(passwordHash),
        status: 'active',
        last_login_at: null,
        created_at: now,
        updated_at: now,
      });
      this._users.set(user.user_id, user);
      this._userRoles.set(user.user_id, normalizedRoles.length ? normalizedRoles : ['editor']);
      return this._userView(user);
    },
    async getUserById(userId) {
      const user = this._users.get(String(userId));
      return user ? this._userView(user) : null;
    },
    async getUserByEmail(email) {
      const normalized = textOrNull(email)?.toLowerCase();
      if (!normalized) return null;
      const user = [...this._users.values()].find((row) => row.email === normalized);
      return user ? this._userView(user) : null;
    },
    async listUsers() {
      return [...this._users.values()]
        .sort((left, right) => left.email.localeCompare(right.email))
        .map((user) => this._userView(user));
    },
    async updateUser(userId, patch = {}) {
      const user = this._users.get(String(userId));
      if (!user) return null;
      if (patch.status != null) {
        const status = String(patch.status);
        if (!['active', 'disabled'].includes(status)) throw new Error('status must be active or disabled');
        user.status = status;
      }
      if (patch.displayName != null) user.display_name = textOrNull(patch.displayName) || user.email;
      if (patch.passwordHash != null) user.password_hash = String(patch.passwordHash);
      if (patch.lastLoginAt != null) user.last_login_at = toIso(patch.lastLoginAt);
      user.updated_at = this._nowIso();
      return this._userView(user);
    },
    async setUserRoles(userId, roles = []) {
      const user = this._users.get(String(userId));
      if (!user) return null;
      const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
      if (!normalizedRoles.length) throw new Error('at least one role is required');
      for (const role of normalizedRoles) {
        if (!this._roles.has(role)) throw new Error(`unknown role: ${role}`);
      }
      this._userRoles.set(user.user_id, normalizedRoles);
      user.updated_at = this._nowIso();
      return this._userView(user);
    },
    async createSession({ userId, tokenHash, expiresAt, ipAddress = null, userAgent = null } = {}) {
      if (!userId || !tokenHash || !expiresAt) throw new Error('userId, tokenHash and expiresAt are required');
      const now = this._nowIso();
      const session = normalizeTimestamps({
        session_id: randomUUID(),
        user_id: String(userId),
        token_hash: String(tokenHash),
        expires_at: expiresAt,
        created_at: now,
        last_seen_at: now,
        revoked_at: null,
        ip_address: textOrNull(ipAddress),
        user_agent: textOrNull(userAgent),
      });
      this._sessions.set(session.session_id, session);
      return clone(session);
    },
    async getSessionByTokenHash(tokenHash) {
      const session = [...this._sessions.values()].find((row) => row.token_hash === String(tokenHash));
      if (!session || session.revoked_at) return null;
      if (Date.parse(session.expires_at) <= Date.parse(this._nowIso())) return null;
      const user = this._users.get(session.user_id);
      if (!user || user.status !== 'active') return null;
      return {
        ...clone(session),
        user: {
          user_id: user.user_id,
          email: user.email,
          display_name: user.display_name,
        },
        roles: [...(this._userRoles.get(user.user_id) || [])].sort(),
      };
    },
    async touchSession(sessionId, { lastSeenAt = null } = {}) {
      const session = this._sessions.get(String(sessionId));
      if (!session) return null;
      session.last_seen_at = toIso(lastSeenAt) || this._nowIso();
      return clone(session);
    },
    async revokeSession(sessionId) {
      const session = this._sessions.get(String(sessionId));
      if (!session) return false;
      session.revoked_at = this._nowIso();
      return true;
    },
    async revokeSessionsForUser(userId) {
      const id = String(userId);
      let revoked = 0;
      for (const session of this._sessions.values()) {
        if (session.user_id === id && !session.revoked_at) {
          session.revoked_at = this._nowIso();
          revoked += 1;
        }
      }
      return revoked;
    },
    async deleteExpiredSessions({ now = null } = {}) {
      const cutoff = toIso(now) || this._nowIso();
      let deleted = 0;
      for (const [id, session] of this._sessions) {
        if (session.revoked_at || Date.parse(session.expires_at) <= Date.parse(cutoff)) {
          this._sessions.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    }
};
