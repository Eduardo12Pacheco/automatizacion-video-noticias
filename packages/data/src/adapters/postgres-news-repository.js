import { randomUUID } from 'node:crypto';

import { buildClusterRow, buildNewsRow, json, normalizeRow, normalizeRows, textOrNull, upsertClusterRow, upsertNewsRow } from './postgres-helpers.js';
import { PostgresBaseRepository } from './postgres-base-repository.js';

export class PostgresNewsRepository extends PostgresBaseRepository {
  // Discovery --------------------------------------------------------------

  async upsertNews(rows = [], { runId = null } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    let valid = 0;
    let upserted = 0;
    await this._transaction(async (client) => {
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
      const result = await this._pool.query(
        `select payload from noticias_staging where run_id = $1
         order by (payload->>'google_position')::int nulls last,
                  (payload->>'fecha_publicacion') desc nulls last,
                  id_noticia`,
        [runId],
      );
      return { count: result.rowCount, rows: result.rows.map((row) => row.payload) };
    }
    const result = await this._pool.query(
      `select * from noticias_raw
       order by google_position nulls last, fecha_publicacion desc nulls last, id_noticia`,
    );
    return { count: result.rowCount, rows: normalizeRows(result.rows) };
  }

  async resetDiscoveryState() {
    return this._transaction(async (client) => {
      const news = await client.query('delete from noticias_raw');
      await client.query('delete from clusters');
      return { deleted_news: news.rowCount };
    });
  }

  async resetStaging(runId) {
    if (!runId) throw new Error('runId is required');
    return this._transaction(async (client) => {
      const news = await client.query('delete from noticias_staging where run_id = $1', [runId]);
      const clusters = await client.query('delete from clusters_staging where run_id = $1', [runId]);
      return { deleted_news: news.rowCount, deleted_clusters: clusters.rowCount };
    });
  }

  /**
   * Remove one demo story (the ids the seed CLI owns) before re-seeding it.
   * Used by `seed-demo.js --reset` so the E2E suite can run twice against the
   * same database without deleting an operator's unrelated rows.
   */
  async resetDemoStory({ newsIds = [], clusterIds = [] } = {}) {
    const news = (newsIds || []).map(String);
    const clusters = (clusterIds || []).map(String);
    if (!news.length && !clusters.length) {
      return { deleted_news: 0, deleted_clusters: 0 };
    }
    return this._transaction(async (client) => {
      // Child tables first; only the ids owned by the seed are touched.
      await client.query(
        'delete from video_edit_projects where id_noticia = any($1::text[]) or cluster_id = any($2::text[])',
        [news, clusters],
      );
      await client.query(
        'delete from script_publish_jobs where id_noticia = any($1::text[]) or cluster_id = any($2::text[])',
        [news, clusters],
      );
      await client.query(
        'delete from guiones_noticia where id_noticia = any($1::text[]) or cluster_id = any($2::text[])',
        [news, clusters],
      );
      await client.query('delete from script_jobs where id_noticia = any($1::text[])', [news]);
      const deletedNews = await client.query(
        'delete from noticias_raw where id_noticia = any($1::text[]) or cluster_id = any($2::text[])',
        [news, clusters],
      );
      const deletedClusters = await client.query(
        'delete from clusters where cluster_id = any($1::text[])',
        [clusters],
      );
      return { deleted_news: deletedNews.rowCount, deleted_clusters: deletedClusters.rowCount };
    });
  }

  async persistClusters(clusters = [], { runId = null } = {}) {
    const input = Array.isArray(clusters) ? clusters : [];
    let upserted = 0;
    await this._transaction(async (client) => {
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
    const result = await this._pool.query(
      `insert into news_search_runs (run_id, requested_window, status)
       values ($1,$2,'queued') returning *`,
      [runId, requestedWindow || '24h'],
    );
    return normalizeRow(result.rows[0]);
  }

  async getNewsSearchRun(runId) {
    const result = await this._pool.query('select * from news_search_runs where run_id = $1', [String(runId)]);
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
    const result = await this._pool.query(
      `update news_search_runs set ${sets.join(', ')}, updated_at = $${params.length}
       where run_id = $1 returning *`,
      params,
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async promoteNewsSearchRun(runId) {
    return this._transaction(async (client) => {
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
    const result = await this._pool.query(
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
    const cluster = await this._pool.query('select * from clusters where cluster_id = $1', [String(clusterId)]);
    if (!cluster.rowCount) return null;
    const sources = await this._pool.query(
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
    return this._transaction(async (client) => {
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

}
