import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import pg from 'pg';

import { RepositoryPort } from '../ports/repository-port.js';

const { Pool } = pg;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../infra/db/migrations/', import.meta.url));

export class PostgresBaseRepository extends RepositoryPort {
  _pool;
  _ownsPool;

  constructor({ connectionString = process.env.DATABASE_URL, pool = null } = {}) {
    super();
    if (pool) {
      this._pool = pool;
      this._ownsPool = false;
    } else {
      if (!connectionString) throw new Error('DATABASE_URL is required for the Postgres adapter');
      this._pool = new Pool({ connectionString });
      this._ownsPool = true;
    }
  }

  async migrate() {
    const client = await this._pool.connect();
    try {
      await client.query(`create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )`);
      const entries = (await readdir(MIGRATIONS_DIR))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      let applied = 0;
      for (const name of entries) {
        const already = await client.query('select 1 from schema_migrations where version = $1', [name]);
        if (already.rowCount) continue;
        const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (version) values ($1)', [name]);
          await client.query('commit');
          applied += 1;
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      }
      return { applied, adapter: 'postgres' };
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    const result = await this._pool.query('select 1 as ok');
    return { ok: result.rows[0]?.ok === 1, adapter: 'postgres' };
  }

  async close() {
    if (this._ownsPool) await this._pool.end();
  }

  /** Test-only escape hatch for truncating the disposable contract database. */
  _poolForTests() {
    return this._pool;
  }

  async _transaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

}
