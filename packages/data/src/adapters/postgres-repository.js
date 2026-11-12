import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { RepositoryPort } from '../ports/repository-port.js';

const { Pool } = pg;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../infra/db/migrations/', import.meta.url));
const NUMERIC_FIELDS = new Set([
  'avg_google_position',
  'progress_percent',
  'cantidad_fuentes',
  'cantidad_fuentes_total',
  'guion_word_count',
  'percent',
  'attempts',
  'added_count',
  'promoted_news',
  'promoted_clusters',
  'deleted',
]);

function normalizeRow(row) {
  if (!row) return row;
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      output[key] = Number.isNaN(value.getTime()) ? null : value.toISOString();
    } else if (value != null && typeof value === 'string' && NUMERIC_FIELDS.has(key)) {
      const parsed = Number(value);
      output[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      output[key] = value;
    }
  }
  return output;
}

function normalizeRows(rows = []) {
  return rows.map(normalizeRow);
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

function json(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function buildNewsRow(raw, { runId = null } = {}) {
  return {
    id_noticia: textOrNull(raw.id_noticia),
    cluster_id: textOrNull(raw.cluster_id),
    seleccion: textOrNull(raw.seleccion),
    jugador: textOrNull(raw.jugador),
    titular: textOrNull(raw.titular),
    fuente: textOrNull(raw.fuente),
    fecha_publicacion: raw.fecha_publicacion ?? null,
    link: textOrNull(raw.link),
    snippet: textOrNull(raw.snippet),
    fuente_origen: textOrNull(raw.fuente_origen),
    estado_revision: textOrNull(raw.estado_revision) || 'pendiente',
    approval_action: textOrNull(raw.approval_action),
    approval_updated_at: raw.approval_updated_at ?? null,
    tema_principal: textOrNull(raw.tema_principal),
    fecha_detectada: raw.fecha_detectada ?? new Date(),
    google_position: numberOrNull(raw.google_position),
    classification_source: textOrNull(raw.classification_source),
    football_signals: textOrNull(raw.football_signals),
    pass_direct: raw.pass_direct == null ? null : Boolean(raw.pass_direct),
    run_id: runId ?? textOrNull(raw.run_id),
  };
}

function buildClusterRow(raw, { runId = null } = {}) {
  return {
    cluster_id: textOrNull(raw.cluster_id),
    run_id: runId ?? textOrNull(raw.run_id),
    seleccion: textOrNull(raw.seleccion),
    jugador: textOrNull(raw.jugador),
    tema_principal: textOrNull(raw.tema_principal) || 'Sin tema',
    resumen_cluster: textOrNull(raw.resumen_cluster),
    tag_editorial: textOrNull(raw.tag_editorial),
    avg_google_position: numberOrNull(raw.avg_google_position),
    estado_revision: textOrNull(raw.estado_revision) || 'pendiente',
    fecha_creacion_cluster: raw.fecha_creacion_cluster ?? new Date(),
  };
}

async function upsertNewsRow(client, row) {
  const existingResult = await client.query('select * from noticias_raw where id_noticia = $1', [row.id_noticia]);
  const existing = existingResult.rows[0] || {};
  const merged = {
    ...existing,
    ...row,
    cluster_id: row.cluster_id ?? existing.cluster_id ?? null,
    created_at: existing.created_at || new Date(),
  };
  const result = await client.query(
    `insert into noticias_raw (
      id_noticia, cluster_id, seleccion, jugador, titular, fuente, fecha_publicacion,
      link, snippet, fuente_origen, estado_revision, approval_action, approval_updated_at,
      tema_principal, fecha_detectada, google_position, classification_source,
      football_signals, pass_direct, run_id, created_at, updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now()
    )
    on conflict (id_noticia) do update set
      cluster_id = excluded.cluster_id,
      seleccion = excluded.seleccion,
      jugador = excluded.jugador,
      titular = excluded.titular,
      fuente = excluded.fuente,
      fecha_publicacion = excluded.fecha_publicacion,
      link = excluded.link,
      snippet = excluded.snippet,
      fuente_origen = excluded.fuente_origen,
      estado_revision = excluded.estado_revision,
      approval_action = excluded.approval_action,
      approval_updated_at = excluded.approval_updated_at,
      tema_principal = excluded.tema_principal,
      fecha_detectada = excluded.fecha_detectada,
      google_position = excluded.google_position,
      classification_source = excluded.classification_source,
      football_signals = excluded.football_signals,
      pass_direct = excluded.pass_direct,
      run_id = excluded.run_id,
      updated_at = now()
    returning *`,
    [
      merged.id_noticia, merged.cluster_id, merged.seleccion, merged.jugador, merged.titular,
      merged.fuente, merged.fecha_publicacion, merged.link, merged.snippet, merged.fuente_origen,
      merged.estado_revision, merged.approval_action, merged.approval_updated_at,
      merged.tema_principal, merged.fecha_detectada, merged.google_position,
      merged.classification_source, merged.football_signals, merged.pass_direct, merged.run_id,
      merged.created_at,
    ],
  );
  return normalizeRow(result.rows[0]);
}

async function upsertClusterRow(client, row, sources = []) {
  const result = await client.query(
    `insert into clusters (
      cluster_id, run_id, seleccion, jugador, tema_principal, resumen_cluster, tag_editorial,
      avg_google_position, estado_revision, fecha_creacion_cluster, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
    on conflict (cluster_id) do update set
      run_id = excluded.run_id,
      seleccion = excluded.seleccion,
      jugador = excluded.jugador,
      tema_principal = excluded.tema_principal,
      resumen_cluster = excluded.resumen_cluster,
      tag_editorial = excluded.tag_editorial,
      avg_google_position = excluded.avg_google_position,
      estado_revision = excluded.estado_revision,
      fecha_creacion_cluster = excluded.fecha_creacion_cluster,
      updated_at = now()
    returning *`,
    [
      row.cluster_id, row.run_id, row.seleccion, row.jugador, row.tema_principal,
      row.resumen_cluster, row.tag_editorial, row.avg_google_position, row.estado_revision,
      row.fecha_creacion_cluster,
    ],
  );
  const ids = (Array.isArray(sources) ? sources : [])
    .map((source) => textOrNull(source?.id_noticia))
    .filter(Boolean);
  if (ids.length) {
    await client.query(
      'update noticias_raw set cluster_id = $1, updated_at = now() where id_noticia = any($2::text[])',
      [row.cluster_id, ids],
    );
  }
  return normalizeRow(result.rows[0]);
}

const JOB_JOIN_SQL = `
  select
    j.id_noticia, j.queue_id, j.status, j.stage, j.percent, j.attempts, j.last_error,
    j.queued_at, j.started_at, j.completed_at, j.updated_at,
    n.link, n.jugador, n.seleccion, n.titular, n.fuente, n.snippet, n.fecha_publicacion,
    n.fecha_detectada, n.fuente_origen, n.cluster_id,
    coalesce(c.tema_principal, n.tema_principal) as tema_principal,
    c.cluster_id as cluster_ref
  from script_jobs j
  left join noticias_raw n on n.id_noticia = j.id_noticia
  left join clusters c on c.cluster_id = n.cluster_id
`;

function shapeJobRow(row) {
  const normalized = normalizeRow(row);
  return {
    ...normalized,
    cluster_id: normalized.cluster_id ?? normalized.cluster_ref ?? null,
    tema_principal: normalized.tema_principal ?? null,
  };
}

const DRAFT_JOIN_SQL = `
  select
    g.*, n.titular, n.fuente, n.link, n.fecha_publicacion as fecha_publicacion_noticia,
    coalesce(n.titular, c.tema_principal) as titulo_noticia,
    coalesce(g.tema_principal, c.tema_principal) as tema_principal,
    coalesce(g.jugador, n.jugador, c.jugador) as jugador,
    coalesce(g.seleccion, n.seleccion, c.seleccion) as seleccion,
    coalesce(g.tag_editorial, c.tag_editorial) as tag_editorial,
    c.resumen_cluster
  from guiones_noticia g
  left join noticias_raw n on n.id_noticia = g.id_noticia
  left join clusters c on c.cluster_id = g.cluster_id
`;

export class PostgresRepository extends RepositoryPort {
  #pool;
  #ownsPool;

  constructor({ connectionString = process.env.DATABASE_URL, pool = null } = {}) {
    super();
    if (pool) {
      this.#pool = pool;
      this.#ownsPool = false;
    } else {
      if (!connectionString) throw new Error('DATABASE_URL is required for the Postgres adapter');
      this.#pool = new Pool({ connectionString });
      this.#ownsPool = true;
    }
  }

  async migrate() {
    const client = await this.#pool.connect();
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
    const result = await this.#pool.query('select 1 as ok');
    return { ok: result.rows[0]?.ok === 1, adapter: 'postgres' };
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end();
  }

  /** Test-only escape hatch for truncating the disposable contract database. */
  _poolForTests() {
    return this.#pool;
  }

  async #transaction(fn) {
    const client = await this.#pool.connect();
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

  // Discovery --------------------------------------------------------------

  async upsertNews(rows = [], { runId = null } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    let valid = 0;
    let upserted = 0;
    await this.#transaction(async (client) => {
      for (const raw of input) {
        const row = buildNewsRow(raw, { runId });
        if (!row.id_noticia || !row.titular) continue;
        valid += 1;
        if (runId) {
          const payload = { ...row, run_id: runId };
          await client.query(
            `insert into noticias_staging (run_id, id_noticia, payload)
             values ($1,$2,$3::jsonb)
             on conflict (run_id, id_noticia) do update
               set payload = noticias_staging.payload || excluded.payload`,
            [runId, row.id_noticia, JSON.stringify(payload)],
          );
        } else {
          await upsertNewsRow(client, row);
        }
        upserted += 1;
      }
    });
    return { received: input.length, valid, upserted };
  }

  async listNewsForClustering({ runId = null } = {}) {
    if (runId) {
      const result = await this.#pool.query(
        `select payload from noticias_staging where run_id = $1
         order by (payload->>'google_position')::int nulls last,
                  (payload->>'fecha_publicacion') desc nulls last,
                  id_noticia`,
        [runId],
      );
      return { count: result.rowCount, rows: result.rows.map((row) => row.payload) };
    }
    const result = await this.#pool.query(
      `select * from noticias_raw
       order by google_position nulls last, fecha_publicacion desc nulls last, id_noticia`,
    );
    return { count: result.rowCount, rows: normalizeRows(result.rows) };
  }

  async resetDiscoveryState() {
    return this.#transaction(async (client) => {
      const news = await client.query('delete from noticias_raw');
      await client.query('delete from clusters');
      return { deleted_news: news.rowCount };
    });
  }

  async resetStaging(runId) {
    if (!runId) throw new Error('runId is required');
    return this.#transaction(async (client) => {
      const news = await client.query('delete from noticias_staging where run_id = $1', [runId]);
      const clusters = await client.query('delete from clusters_staging where run_id = $1', [runId]);
      return { deleted_news: news.rowCount, deleted_clusters: clusters.rowCount };
    });
  }

  async persistClusters(clusters = [], { runId = null } = {}) {
    const input = Array.isArray(clusters) ? clusters : [];
    let upserted = 0;
    await this.#transaction(async (client) => {
      for (const raw of input) {
        const row = buildClusterRow(raw, { runId });
        if (!row.cluster_id) continue;
        const sources = Array.isArray(raw.sources) ? raw.sources : [];
        if (runId) {
          const payload = { ...raw, ...row, sources };
          await client.query(
            `insert into clusters_staging (run_id, cluster_id, payload)
             values ($1,$2,$3::jsonb)
             on conflict (run_id, cluster_id) do update set payload = excluded.payload`,
            [runId, row.cluster_id, JSON.stringify(payload)],
          );
          for (const source of sources) {
            const id = textOrNull(source?.id_noticia);
            if (!id) continue;
            await client.query(
              `update noticias_staging
               set payload = jsonb_set(payload, '{cluster_id}', to_jsonb($3::text), true)
               where run_id = $1 and id_noticia = $2`,
              [runId, id, row.cluster_id],
            );
          }
        } else {
          await upsertClusterRow(client, row, sources);
        }
        upserted += 1;
      }
    });
    return { upserted };
  }

  async createNewsSearchRun({ requestedWindow = '24h' } = {}) {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const result = await this.#pool.query(
      `insert into news_search_runs (run_id, requested_window, status)
       values ($1,$2,'queued') returning *`,
      [runId, requestedWindow || '24h'],
    );
    return normalizeRow(result.rows[0]);
  }

  async getNewsSearchRun(runId) {
    const result = await this.#pool.query('select * from news_search_runs where run_id = $1', [String(runId)]);
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async updateNewsSearchRun(runId, patch = {}) {
    const allowed = ['status', 'stats', 'error', 'started_at', 'finished_at', 'requested_window'];
    const sets = [];
    const params = [String(runId)];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      params.push(key === 'stats' ? json(patch[key], {}) : patch[key]);
      sets.push(`${key} = $${params.length}${key === 'stats' ? '::jsonb' : ''}`);
    }
    if (!sets.length) return this.getNewsSearchRun(runId);
    params.push(new Date());
    const result = await this.#pool.query(
      `update news_search_runs set ${sets.join(', ')}, updated_at = $${params.length}
       where run_id = $1 returning *`,
      params,
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async promoteNewsSearchRun(runId) {
    return this.#transaction(async (client) => {
      const run = await client.query('select * from news_search_runs where run_id = $1', [runId]);
      if (!run.rowCount) return null;

      const stagedClusters = await client.query(
        'select payload from clusters_staging where run_id = $1 order by cluster_id',
        [runId],
      );
      let promotedClusters = 0;
      for (const entry of stagedClusters.rows) {
        await upsertClusterRow(client, buildClusterRow(entry.payload, { runId }), entry.payload.sources || []);
        promotedClusters += 1;
      }

      const stagedNews = await client.query(
        'select payload from noticias_staging where run_id = $1 order by id_noticia',
        [runId],
      );
      let promotedNews = 0;
      for (const entry of stagedNews.rows) {
        await upsertNewsRow(client, buildNewsRow(entry.payload, { runId }));
        promotedNews += 1;
      }

      await client.query('delete from noticias_staging where run_id = $1', [runId]);
      await client.query('delete from clusters_staging where run_id = $1', [runId]);
      const updated = await client.query(
        `update news_search_runs set status = 'promoted', finished_at = now(), updated_at = now()
         where run_id = $1 returning *`,
        [runId],
      );
      return {
        run: normalizeRow(updated.rows[0]),
        promoted_news: promotedNews,
        promoted_clusters: promotedClusters,
      };
    });
  }

  // Approval ---------------------------------------------------------------

  async listPendingApprovalClusters() {
    const result = await this.#pool.query(
      `select c.*, count(n.id_noticia)::int as cantidad_fuentes,
              count(n.id_noticia)::int as cantidad_fuentes_total
       from clusters c
       join noticias_raw n on n.cluster_id = c.cluster_id and n.estado_revision = 'pendiente'
       group by c.cluster_id
       order by c.fecha_creacion_cluster desc, c.cluster_id`,
    );
    return normalizeRows(result.rows);
  }

  async getApprovalTopicDetail(clusterId) {
    const cluster = await this.#pool.query('select * from clusters where cluster_id = $1', [String(clusterId)]);
    if (!cluster.rowCount) return null;
    const sources = await this.#pool.query(
      `select n.*, row_number() over (
         order by n.google_position nulls last, n.fecha_publicacion desc nulls last, n.id_noticia
       )::int as index
       from noticias_raw n where n.cluster_id = $1
       order by n.google_position nulls last, n.fecha_publicacion desc nulls last, n.id_noticia`,
      [String(clusterId)],
    );
    return {
      ...normalizeRow(cluster.rows[0]),
      cantidad_fuentes: sources.rowCount,
      cantidad_fuentes_total: sources.rowCount,
      sources: normalizeRows(sources.rows),
    };
  }

  async applyApprovalDecision({ idNoticia, clusterId = null, action } = {}) {
    const id = textOrNull(idNoticia);
    const normalizedAction = textOrNull(action);
    if (!id) throw new Error('idNoticia is required');
    if (!['approve', 'reject'].includes(normalizedAction)) {
      throw new Error('action must be approve or reject');
    }
    return this.#transaction(async (client) => {
      const updated = await client.query(
        `update noticias_raw
         set estado_revision = $2, approval_action = $3, approval_updated_at = now(), updated_at = now(),
             cluster_id = coalesce(cluster_id, $4)
         where id_noticia = $1 returning *`,
        [id, normalizedAction === 'approve' ? 'aprobado' : 'rechazado', normalizedAction, clusterId],
      );
      if (!updated.rowCount) return null;

      if (normalizedAction === 'approve') {
        await client.query(
          `insert into script_jobs (id_noticia, queue_id, status, stage, percent, attempts, queued_at, updated_at)
           values ($1, $1, 'pendiente', 'queued', 0, 0, now(), now())
           on conflict (id_noticia) do nothing`,
          [id],
        );
      } else {
        await client.query(
          "delete from script_jobs where id_noticia = $1 and status = 'pendiente'",
          [id],
        );
      }

      const clusterIdValue = updated.rows[0].cluster_id;
      if (clusterIdValue) {
        await client.query(
          `update clusters c set
             estado_revision = case
               when exists (select 1 from noticias_raw n where n.cluster_id = c.cluster_id and n.estado_revision = 'pendiente') then 'pendiente'
               when exists (select 1 from noticias_raw n where n.cluster_id = c.cluster_id and n.estado_revision = 'aprobado') then 'aprobado'
               when exists (select 1 from noticias_raw n where n.cluster_id = c.cluster_id and n.estado_revision = 'publicado') then 'publicado'
               else 'rechazado'
             end,
             updated_at = now()
           where c.cluster_id = $1`,
          [clusterIdValue],
        );
      }
      return normalizeRow(updated.rows[0]);
    });
  }

  // Script queue -----------------------------------------------------------

  async claimScriptJob({ idNoticia } = {}) {
    const id = textOrNull(idNoticia);
    if (!id) return null;
    return this.#transaction(async (client) => {
      const claimed = await client.query(
        `update script_jobs
         set status = 'running', stage = 'claimed', percent = 5,
             attempts = attempts + 1, started_at = coalesce(started_at, now()), updated_at = now()
         where id_noticia = $1 and status = 'pendiente'
         returning *`,
        [id],
      );
      if (!claimed.rowCount) return null;
      const joined = await client.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [id]);
      return shapeJobRow(joined.rows[0]);
    });
  }

  async updateScriptJobProgress({ idNoticia, status, stage, percent, error } = {}) {
    const sets = [];
    const params = [String(idNoticia)];
    if (status != null) { params.push(String(status)); sets.push(`status = $${params.length}`); }
    if (stage != null) { params.push(String(stage)); sets.push(`stage = $${params.length}`); }
    if (percent != null) {
      params.push(Math.max(0, Math.min(100, Number(percent))));
      sets.push(`percent = $${params.length}::int`);
    }
    if (error != null) { params.push(String(error).slice(0, 500)); sets.push(`last_error = $${params.length}`); }
    if (!sets.length) return this.getScriptQueueMonitorRow(String(idNoticia));
    const updated = await this.#pool.query(
      `update script_jobs set ${sets.join(', ')}, updated_at = now()
       where id_noticia = $1 returning *`,
      params,
    );
    if (!updated.rowCount) return null;
    return this.getScriptQueueMonitorRow(String(idNoticia));
  }

  async getScriptQueueMonitorRow(idNoticia) {
    const result = await this.#pool.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [idNoticia]);
    return result.rowCount ? shapeJobRow(result.rows[0]) : null;
  }

  async completeScriptJob({ idNoticia, draftId, guionDraft, guionEditado, wordCount: count } = {}) {
    const id = String(idNoticia);
    return this.#transaction(async (client) => {
      const context = await client.query(
        `select n.cluster_id, n.jugador, n.seleccion,
                coalesce(c.tema_principal, n.tema_principal) as tema_principal
         from noticias_raw n left join clusters c on c.cluster_id = n.cluster_id
         where n.id_noticia = $1`,
        [id],
      );
      const news = context.rows[0] || {};
      const key = textOrNull(draftId) || `draft-${id}`;
      const finalText = guionEditado ?? guionDraft ?? '';
      const draft = await client.query(
        `insert into guiones_noticia (
           draft_id, id_noticia, cluster_id, jugador, seleccion, tema_principal,
           guion_draft, guion_editado, guion_word_count, estado_guion, fecha_borrador
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrador',now())
         on conflict (draft_id) do update set
           id_noticia = excluded.id_noticia,
           cluster_id = excluded.cluster_id,
           jugador = excluded.jugador,
           seleccion = excluded.seleccion,
           tema_principal = excluded.tema_principal,
           guion_draft = excluded.guion_draft,
           guion_editado = excluded.guion_editado,
           guion_word_count = excluded.guion_word_count,
           estado_guion = 'borrador',
           updated_at = now()
         returning *`,
        [
          key, id, news.cluster_id ?? null, news.jugador ?? null, news.seleccion ?? null,
          news.tema_principal ?? null, guionDraft ?? finalText, finalText,
          count ?? wordCount(finalText),
        ],
      );
      const job = await client.query(
        `insert into script_jobs (id_noticia, queue_id, status, stage, percent, attempts, queued_at, updated_at)
         values ($1,$1,'completado','completed',100,0,now(),now())
         on conflict (id_noticia) do update set
           status = 'completado', stage = 'completed', percent = 100,
           last_error = null, completed_at = now(), updated_at = now()
         returning *`,
        [id],
      );
      const joined = await client.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [id]);
      return {
        job: shapeJobRow(joined.rows[0]),
        draft: normalizeRow(draft.rows[0]),
      };
    });
  }

  async failScriptJob({ idNoticia, error } = {}) {
    const result = await this.#pool.query(
      `update script_jobs
       set status = 'fallido', stage = 'failed', last_error = $2, completed_at = now(), updated_at = now()
       where id_noticia = $1 returning *`,
      [String(idNoticia), String(error ?? 'Script job failed').slice(0, 500)],
    );
    if (!result.rowCount) return null;
    const joined = await this.#pool.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [String(idNoticia)]);
    return shapeJobRow(joined.rows[0]);
  }

  async getScriptQueueMonitor() {
    const result = await this.#pool.query(
      `select j.queue_id, n.cluster_id, j.id_noticia,
              coalesce(c.tema_principal, n.tema_principal) as tema_principal,
              n.titular, n.jugador, n.seleccion, n.fuente,
              j.status as estado_queue, j.stage as progress_stage, j.percent as progress_percent,
              j.attempts, j.last_error, j.queued_at as fecha_encolado_guion,
              j.started_at, j.completed_at, j.updated_at
       from script_jobs j
       left join noticias_raw n on n.id_noticia = j.id_noticia
       left join clusters c on c.cluster_id = n.cluster_id
       order by j.queued_at, j.id_noticia`,
    );
    return normalizeRows(result.rows);
  }

  async getPendingScriptDrafts() {
    const result = await this.#pool.query(
      `${DRAFT_JOIN_SQL}
       where g.estado_guion = 'borrador'
       order by g.fecha_borrador desc, g.draft_id`,
    );
    return normalizeRows(result.rows);
  }

  async saveScriptDraft({ draftId, idNoticia, clusterId, guionDraft, guionEditado } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const text = guionEditado ?? guionDraft ?? '';
    const result = await this.#pool.query(
      `insert into guiones_noticia (
         draft_id, id_noticia, cluster_id, guion_draft, guion_editado, guion_word_count,
         estado_guion, fecha_borrador
       ) values ($1,$2,$3,$4,$5,$6,'borrador',now())
       on conflict (draft_id) do update set
         id_noticia = coalesce(excluded.id_noticia, guiones_noticia.id_noticia),
         cluster_id = coalesce(excluded.cluster_id, guiones_noticia.cluster_id),
         guion_draft = coalesce(excluded.guion_draft, guiones_noticia.guion_draft),
         guion_editado = excluded.guion_editado,
         guion_word_count = excluded.guion_word_count,
         updated_at = now()
       returning *`,
      [key, idNoticia ?? null, clusterId ?? null, guionDraft ?? text, text, wordCount(text)],
    );
    const joined = await this.#pool.query(`${DRAFT_JOIN_SQL} where g.draft_id = $1`, [key]);
    return normalizeRow(joined.rows[0] ?? result.rows[0]);
  }

  async dismissScriptFromPanel({ draftId, idNoticia, clusterId } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = await this.#pool.query('select 1 from guiones_noticia where draft_id = $1', [key]);
    if (existing.rowCount) {
      await this.#pool.query(
        `update guiones_noticia set estado_guion = 'descartado',
           cluster_id = coalesce(cluster_id, $2), updated_at = now()
         where draft_id = $1`,
        [key, clusterId ?? null],
      );
    } else {
      await this.#pool.query(
        `insert into guiones_noticia (draft_id, id_noticia, cluster_id, guion_draft, guion_editado,
           guion_word_count, estado_guion)
         values ($1,$2,$3,'','',0,'descartado')`,
        [key, idNoticia ?? null, clusterId ?? null],
      );
    }
    return { ok: true, draft_id: key };
  }

  async getPublishableScriptDraft({ draftId, idNoticia, clusterId } = {}) {
    let where = '';
    let params = [];
    if (draftId) {
      where = 'g.draft_id = $1';
      params = [String(draftId)];
    } else if (idNoticia) {
      where = 'g.id_noticia = $1';
      params = [String(idNoticia)];
    } else if (clusterId) {
      where = 'g.cluster_id = $1';
      params = [String(clusterId)];
    } else {
      return null;
    }
    const result = await this.#pool.query(`${DRAFT_JOIN_SQL} where ${where} limit 1`, params);
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async finalizeScriptPublish(payload = {}) {
    const draftId = payload.draftId ?? payload.p_draft_id;
    const idNoticia = payload.idNoticia ?? payload.p_id_noticia;
    const clusterId = payload.clusterId ?? payload.p_cluster_id;
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const guionEditado = payload.guionEditado ?? payload.p_guion_editado ?? null;
    const guionDraft = payload.guionDraft ?? payload.p_guion_draft ?? null;
    const docId = payload.docId ?? payload.p_doc_id ?? null;
    const docUrl = payload.docUrl ?? payload.p_doc_url ?? null;

    const result = await this.#pool.query(
      `insert into guiones_noticia (
         draft_id, id_noticia, cluster_id, guion_draft, guion_editado, guion_word_count,
         estado_guion, doc_id, doc_url, fecha_borrador, fecha_publicacion
       ) values ($1,$2,$3,$4,$5,$6,'publicado',$7,$8,now(),now())
       on conflict (draft_id) do update set
         id_noticia = coalesce(excluded.id_noticia, guiones_noticia.id_noticia),
         cluster_id = coalesce(excluded.cluster_id, guiones_noticia.cluster_id),
         guion_draft = coalesce(excluded.guion_draft, guiones_noticia.guion_draft),
         guion_editado = coalesce(excluded.guion_editado, guiones_noticia.guion_editado),
         guion_word_count = coalesce(excluded.guion_word_count, guiones_noticia.guion_word_count),
         estado_guion = 'publicado',
         doc_id = coalesce(excluded.doc_id, guiones_noticia.doc_id),
         doc_url = coalesce(excluded.doc_url, guiones_noticia.doc_url),
         fecha_publicacion = now(),
         updated_at = now()
       returning *`,
      [
        key, idNoticia ?? null, clusterId ?? null, guionDraft, guionEditado,
        guionEditado == null ? null : wordCount(guionEditado), docId, docUrl,
      ],
    );
    const joined = await this.#pool.query(`${DRAFT_JOIN_SQL} where g.draft_id = $1`, [key]);
    return normalizeRow(joined.rows[0] ?? result.rows[0]);
  }

  // Publish jobs -----------------------------------------------------------

  async createPublishJob(job = {}) {
    const jobId = textOrNull(job.job_id);
    if (!jobId) throw new Error('job_id is required');
    const result = await this.#pool.query(
      `insert into script_publish_jobs (
         job_id, draft_id, id_noticia, cluster_id, status, stage, message, error, result, started_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,coalesce($10::timestamptz, now()))
       returning *`,
      [
        jobId, textOrNull(job.draft_id), textOrNull(job.id_noticia), textOrNull(job.cluster_id),
        textOrNull(job.status) || 'queued', textOrNull(job.stage) || 'queued',
        textOrNull(job.message) || '', textOrNull(job.error) || '', json(job.result, {}),
        job.started_at ?? null,
      ],
    );
    return normalizeRow(result.rows[0]);
  }

  async updatePublishJob(jobId, patch = {}, { onlyActive = false } = {}) {
    const allowed = ['status', 'stage', 'message', 'error', 'result', 'finished_at'];
    const sets = [];
    const params = [String(jobId)];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      params.push(key === 'result' ? json(patch[key], {}) : patch[key]);
      sets.push(`${key} = $${params.length}${key === 'result' ? '::jsonb' : ''}`);
    }
    if (!sets.length) {
      return this.getPublishJob(jobId);
    }
    const activeFilter = onlyActive
      ? "and status not in ('completed','failed') and finished_at is null"
      : '';
    const result = await this.#pool.query(
      `update script_publish_jobs set ${sets.join(', ')}, updated_at = now()
       where job_id = $1 ${activeFilter} returning *`,
      params,
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async getPublishJob(jobId) {
    const result = await this.#pool.query('select * from script_publish_jobs where job_id = $1', [String(jobId)]);
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  // Video projects ---------------------------------------------------------

  async upsertVideoProject(project = {}) {
    const draftId = textOrNull(project.draft_id ?? project.draftId);
    if (!draftId) throw new Error('draft_id is required');
    const existing = (await this.#pool.query('select * from video_edit_projects where draft_id = $1', [draftId])).rows[0];
    const row = {
      ...(existing || {}),
      ...project,
      draft_id: draftId,
      segments: project.segments ?? existing?.segments ?? [],
      image_candidates: project.image_candidates ?? existing?.image_candidates ?? [],
      image_search_meta: project.image_search_meta ?? existing?.image_search_meta ?? {},
      selected_images: project.selected_images ?? existing?.selected_images ?? [],
      voice_audio: project.voice_audio ?? existing?.voice_audio ?? {},
      background_audio: project.background_audio ?? existing?.background_audio ?? {},
      editor_state: project.editor_state ?? existing?.editor_state ?? {},
      status: textOrNull(project.status) ?? existing?.status ?? 'pending',
    };
    const result = await this.#pool.query(
      `insert into video_edit_projects (
         draft_id, id_noticia, cluster_id, jugador, seleccion, tema_principal,
         guion_editado, guion_piped, segments, image_candidates, image_search_meta,
         selected_images, voice_audio, background_audio, editor_state, status,
         published_at, disabled_at, created_at, updated_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
         $13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,coalesce($19::timestamptz, now()),now()
       )
       on conflict (draft_id) do update set
         id_noticia = excluded.id_noticia,
         cluster_id = excluded.cluster_id,
         jugador = excluded.jugador,
         seleccion = excluded.seleccion,
         tema_principal = excluded.tema_principal,
         guion_editado = excluded.guion_editado,
         guion_piped = excluded.guion_piped,
         segments = excluded.segments,
         image_candidates = excluded.image_candidates,
         image_search_meta = excluded.image_search_meta,
         selected_images = excluded.selected_images,
         voice_audio = excluded.voice_audio,
         background_audio = excluded.background_audio,
         editor_state = excluded.editor_state,
         status = excluded.status,
         published_at = excluded.published_at,
         disabled_at = excluded.disabled_at,
         updated_at = now()
       returning *`,
      [
        draftId, textOrNull(row.id_noticia), textOrNull(row.cluster_id), textOrNull(row.jugador),
        textOrNull(row.seleccion), textOrNull(row.tema_principal), textOrNull(row.guion_editado),
        textOrNull(row.guion_piped), json(row.segments, []), json(row.image_candidates, []),
        json(row.image_search_meta, {}), json(row.selected_images, []), json(row.voice_audio, {}),
        json(row.background_audio, {}), json(row.editor_state, {}), row.status,
        row.published_at ?? null, row.disabled_at ?? null, row.created_at ?? null,
      ],
    );
    return normalizeRow(result.rows[0]);
  }

  async getVideoEditProjects({ draftId = null, limit = 50, includeDetail = true } = {}) {
    const columns = includeDetail
      ? '*'
      : `draft_id, id_noticia, cluster_id, jugador, seleccion, tema_principal, guion_editado,
         guion_piped, status, published_at, disabled_at, created_at, updated_at`;
    if (draftId) {
      const result = await this.#pool.query(
        `select ${columns} from video_edit_projects where draft_id = $1 and disabled_at is null`,
        [String(draftId)],
      );
      return { ok: true, projects: normalizeRows(result.rows) };
    }
    const max = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
    const result = await this.#pool.query(
      `select ${columns} from video_edit_projects
       where disabled_at is null
       order by updated_at desc, draft_id
       limit $1`,
      [max],
    );
    return { ok: true, projects: normalizeRows(result.rows) };
  }

  async #requireVideoProject(draftId) {
    const result = await this.#pool.query(
      'select draft_id from video_edit_projects where draft_id = $1 and disabled_at is null',
      [String(draftId)],
    );
    if (!result.rowCount) throw new Error(`video project not found: ${draftId}`);
  }

  async saveVideoProjectSelections({ draftId, selectedImageIds = [] } = {}) {
    await this.#requireVideoProject(draftId);
    const result = await this.#pool.query(
      `update video_edit_projects
       set selected_images = $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, selected_images`,
      [String(draftId), json(Array.isArray(selectedImageIds) ? selectedImageIds : [], [])],
    );
    const row = normalizeRow(result.rows[0]);
    return { ok: true, draft_id: row.draft_id, selected_images: row.selected_images };
  }

  async saveVideoProjectEditorState({ draftId, editorState = {} } = {}) {
    await this.#requireVideoProject(draftId);
    const result = await this.#pool.query(
      `update video_edit_projects
       set editor_state = $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, editor_state`,
      [String(draftId), json(editorState, {})],
    );
    const row = normalizeRow(result.rows[0]);
    return { ok: true, draft_id: row.draft_id, editor_state: row.editor_state };
  }

  async saveVideoProjectAudio({ draftId, voiceAudio = {}, backgroundAudio = {} } = {}) {
    await this.#requireVideoProject(draftId);
    const result = await this.#pool.query(
      `update video_edit_projects
       set voice_audio = $2::jsonb, background_audio = $3::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, voice_audio, background_audio`,
      [String(draftId), json(voiceAudio, {}), json(backgroundAudio, {})],
    );
    const row = normalizeRow(result.rows[0]);
    return {
      ok: true,
      draft_id: row.draft_id,
      voice_audio: row.voice_audio,
      background_audio: row.background_audio,
    };
  }

  async addVideoProjectCustomImages({ draftId, customCandidates = [] } = {}) {
    await this.#requireVideoProject(draftId);
    const input = Array.isArray(customCandidates) ? customCandidates : [];
    const result = await this.#pool.query(
      `update video_edit_projects
       set image_candidates = image_candidates || $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, image_candidates, selected_images`,
      [String(draftId), json(input, [])],
    );
    const row = normalizeRow(result.rows[0]);
    return {
      ok: true,
      draft_id: row.draft_id,
      added_count: input.length,
      image_candidates: row.image_candidates,
      selected_images: row.selected_images,
    };
  }

  async disableVideoEditProject({ draftId } = {}) {
    const result = await this.#pool.query(
      `update video_edit_projects
       set disabled_at = now(), status = 'disabled', updated_at = now()
       where draft_id = $1 returning draft_id`,
      [String(draftId)],
    );
    return { ok: result.rowCount > 0, draft_id: String(draftId) };
  }

  // Users, roles and sessions ----------------------------------------------

  async listRoles() {
    const result = await this.#pool.query('select role, description, created_at from roles order by role');
    return normalizeRows(result.rows);
  }

  async #userWithRoles(client, where, params) {
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
    return this.#transaction(async (client) => {
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
      return this.#userWithRoles(client, 'u.user_id = $1', [userId]);
    });
  }

  async getUserById(userId) {
    const client = await this.#pool.connect();
    try {
      return await this.#userWithRoles(client, 'u.user_id = $1', [String(userId)]);
    } finally {
      client.release();
    }
  }

  async getUserByEmail(email) {
    const normalized = textOrNull(email)?.toLowerCase();
    if (!normalized) return null;
    const client = await this.#pool.connect();
    try {
      return await this.#userWithRoles(client, 'lower(u.email::text) = $1', [normalized]);
    } finally {
      client.release();
    }
  }

  async listUsers() {
    const result = await this.#pool.query(
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
    const updated = await this.#pool.query(
      `update users set ${sets.join(', ')}, updated_at = now() where user_id = $1 returning user_id`,
      params,
    );
    return updated.rowCount ? this.getUserById(userId) : null;
  }

  async setUserRoles(userId, roles = []) {
    const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
    if (!normalizedRoles.length) throw new Error('at least one role is required');
    return this.#transaction(async (client) => {
      const user = await client.query('select user_id from users where user_id = $1', [String(userId)]);
      if (!user.rowCount) return null;
      await client.query('delete from user_roles where user_id = $1', [String(userId)]);
      for (const role of normalizedRoles) {
        await client.query('insert into user_roles (user_id, role) values ($1,$2)', [String(userId), role]);
      }
      await client.query('update users set updated_at = now() where user_id = $1', [String(userId)]);
      return this.#userWithRoles(client, 'u.user_id = $1', [String(userId)]);
    });
  }

  async createSession({ userId, tokenHash, expiresAt, ipAddress = null, userAgent = null } = {}) {
    if (!userId || !tokenHash || !expiresAt) throw new Error('userId, tokenHash and expiresAt are required');
    const result = await this.#pool.query(
      `insert into sessions (user_id, token_hash, expires_at, ip_address, user_agent)
       values ($1,$2,$3,$4,$5) returning *`,
      [String(userId), String(tokenHash), expiresAt, textOrNull(ipAddress), textOrNull(userAgent)],
    );
    return normalizeRow(result.rows[0]);
  }

  async getSessionByTokenHash(tokenHash) {
    const result = await this.#pool.query(
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
    const result = await this.#pool.query(
      `update sessions set last_seen_at = coalesce($2::timestamptz, now())
       where session_id = $1 returning *`,
      [String(sessionId), lastSeenAt],
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async revokeSession(sessionId) {
    const result = await this.#pool.query(
      'update sessions set revoked_at = now() where session_id = $1',
      [String(sessionId)],
    );
    return result.rowCount > 0;
  }

  async deleteExpiredSessions({ now = null } = {}) {
    const result = await this.#pool.query(
      `delete from sessions where revoked_at is not null or expires_at <= coalesce($1::timestamptz, now())`,
      [now],
    );
    return result.rowCount;
  }
}
