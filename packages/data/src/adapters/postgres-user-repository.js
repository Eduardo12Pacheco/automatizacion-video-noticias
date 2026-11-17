import { normalizeRow, normalizeRows, textOrNull } from './postgres-helpers.js';
import { PostgresVideoRepository } from './postgres-video-repository.js';

export class PostgresUserRepository extends PostgresVideoRepository {
  // Users, roles and sessions ----------------------------------------------

  async listRoles() {
    const result = await this._pool.query('select role, description, created_at from roles order by role');
    return normalizeRows(result.rows);
  }

  async _userWithRoles(client, where, params) {
    const result = await client.query(
      `select u.*, coalesce(array_agg(ur.role order by ur.role) filter (where ur.role is not null), '{}') as roles
       from users u left join user_roles ur on ur.user_id = u.user_id
       where ${where} group by u.user_id limit 1`,
      params,
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async createUser({ email, displayName = '', passwordHash, roles = ['editor'] } = {}) {
    const normalizedEmail = textOrNull(email)?.toLowerCase();
    if (!normalizedEmail) throw new Error('email is required');
    if (!passwordHash) throw new Error('passwordHash is required');
    const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
    return this._transaction(async (client) => {
      const inserted = await client.query(
        `insert into users (email, display_name, password_hash, status)
         values ($1,$2,$3,'active') returning *`,
        [normalizedEmail, textOrNull(displayName) || normalizedEmail, String(passwordHash)],
      );
      const userId = inserted.rows[0].user_id;
      const finalRoles = normalizedRoles.length ? normalizedRoles : ['editor'];
      for (const role of finalRoles) {
        await client.query('insert into user_roles (user_id, role) values ($1,$2)', [userId, role]);
      }
      return this._userWithRoles(client, 'u.user_id = $1', [userId]);
    });
  }

  async getUserById(userId) {
    const client = await this._pool.connect();
    try {
      return await this._userWithRoles(client, 'u.user_id = $1', [String(userId)]);
    } finally {
      client.release();
    }
  }

  async getUserByEmail(email) {
    const normalized = textOrNull(email)?.toLowerCase();
    if (!normalized) return null;
    const client = await this._pool.connect();
    try {
      return await this._userWithRoles(client, 'lower(u.email::text) = $1', [normalized]);
    } finally {
      client.release();
    }
  }

  async listUsers() {
    const result = await this._pool.query(
      `select u.*, coalesce(array_agg(ur.role order by ur.role) filter (where ur.role is not null), '{}') as roles
       from users u left join user_roles ur on ur.user_id = u.user_id
       group by u.user_id order by u.email`,
    );
    return normalizeRows(result.rows);
  }

  async updateUser(userId, patch = {}) {
    const sets = [];
    const params = [String(userId)];
    if (patch.status != null) {
      if (!['active', 'disabled'].includes(String(patch.status))) throw new Error('status must be active or disabled');
      params.push(String(patch.status));
      sets.push(`status = $${params.length}`);
    }
    if (patch.displayName != null) {
      params.push(textOrNull(patch.displayName) || '');
      sets.push(`display_name = $${params.length}`);
    }
    if (patch.passwordHash != null) {
      params.push(String(patch.passwordHash));
      sets.push(`password_hash = $${params.length}`);
    }
    if (patch.lastLoginAt != null) {
      params.push(patch.lastLoginAt);
      sets.push(`last_login_at = $${params.length}::timestamptz`);
    }
    if (!sets.length) return this.getUserById(userId);
    const updated = await this._pool.query(
      `update users set ${sets.join(', ')}, updated_at = now() where user_id = $1 returning user_id`,
      params,
    );
    return updated.rowCount ? this.getUserById(userId) : null;
  }

  async setUserRoles(userId, roles = []) {
    const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
    if (!normalizedRoles.length) throw new Error('at least one role is required');
    return this._transaction(async (client) => {
      const user = await client.query('select user_id from users where user_id = $1', [String(userId)]);
      if (!user.rowCount) return null;
      await client.query('delete from user_roles where user_id = $1', [String(userId)]);
      for (const role of normalizedRoles) {
        await client.query('insert into user_roles (user_id, role) values ($1,$2)', [String(userId), role]);
      }
      await client.query('update users set updated_at = now() where user_id = $1', [String(userId)]);
      return this._userWithRoles(client, 'u.user_id = $1', [String(userId)]);
    });
  }

  async createSession({ userId, tokenHash, expiresAt, ipAddress = null, userAgent = null } = {}) {
    if (!userId || !tokenHash || !expiresAt) throw new Error('userId, tokenHash and expiresAt are required');
    const result = await this._pool.query(
      `insert into sessions (user_id, token_hash, expires_at, ip_address, user_agent)
       values ($1,$2,$3,$4,$5) returning *`,
      [String(userId), String(tokenHash), expiresAt, textOrNull(ipAddress), textOrNull(userAgent)],
    );
    return normalizeRow(result.rows[0]);
  }

  async getSessionByTokenHash(tokenHash) {
    const result = await this._pool.query(
      `select s.*, u.email, u.display_name, u.status as user_status,
              coalesce(array_agg(ur.role order by ur.role) filter (where ur.role is not null), '{}') as roles
       from sessions s
       join users u on u.user_id = s.user_id
       left join user_roles ur on ur.user_id = u.user_id
       where s.token_hash = $1 and s.revoked_at is null
         and s.expires_at > now() and u.status = 'active'
       group by s.session_id, u.email, u.display_name, u.status`,
      [String(tokenHash)],
    );
    if (!result.rowCount) return null;
    const row = normalizeRow(result.rows[0]);
    return {
      session_id: row.session_id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      expires_at: row.expires_at,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      revoked_at: row.revoked_at,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      user: { user_id: row.user_id, email: row.email, display_name: row.display_name },
      roles: row.roles,
    };
  }

  async touchSession(sessionId, { lastSeenAt = null } = {}) {
    const result = await this._pool.query(
      `update sessions set last_seen_at = coalesce($2::timestamptz, now())
       where session_id = $1 returning *`,
      [String(sessionId), lastSeenAt],
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async revokeSession(sessionId) {
    const result = await this._pool.query(
      'update sessions set revoked_at = now() where session_id = $1',
      [String(sessionId)],
    );
    return result.rowCount > 0;
  }

  async revokeSessionsForUser(userId) {
    const result = await this._pool.query(
      'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [String(userId)],
    );
    return result.rowCount;
  }

  async deleteExpiredSessions({ now = null } = {}) {
    const result = await this._pool.query(
      `delete from sessions where revoked_at is not null or expires_at <= coalesce($1::timestamptz, now())`,
      [now],
    );
    return result.rowCount;
  }
}
