import { DRAFT_JOIN_SQL, JOB_JOIN_SQL, json, normalizeRow, normalizeRows, shapeJobRow, textOrNull, wordCount } from './postgres-helpers.js';
import { PostgresNewsRepository } from './postgres-news-repository.js';

export class PostgresScriptRepository extends PostgresNewsRepository {
  // Script queue -----------------------------------------------------------

  async claimScriptJob({ idNoticia } = {}) {
    const id = textOrNull(idNoticia);
    if (!id) return null;
    return this._transaction(async (client) => {
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
    const updated = await this._pool.query(
      `update script_jobs set ${sets.join(', ')}, updated_at = now()
       where id_noticia = $1 returning *`,
      params,
    );
    if (!updated.rowCount) return null;
    return this.getScriptQueueMonitorRow(String(idNoticia));
  }

  async getScriptQueueMonitorRow(idNoticia) {
    const result = await this._pool.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [idNoticia]);
    return result.rowCount ? shapeJobRow(result.rows[0]) : null;
  }

  async completeScriptJob({ idNoticia, draftId, guionDraft, guionEditado, wordCount: count } = {}) {
    const id = String(idNoticia);
    return this._transaction(async (client) => {
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
    const result = await this._pool.query(
      `update script_jobs
       set status = 'fallido', stage = 'failed', last_error = $2, completed_at = now(), updated_at = now()
       where id_noticia = $1 returning *`,
      [String(idNoticia), String(error ?? 'Script job failed').slice(0, 500)],
    );
    if (!result.rowCount) return null;
    const joined = await this._pool.query(`${JOB_JOIN_SQL} where j.id_noticia = $1`, [String(idNoticia)]);
    return shapeJobRow(joined.rows[0]);
  }

  async getScriptQueueMonitor() {
    const result = await this._pool.query(
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
    const result = await this._pool.query(
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
    const result = await this._pool.query(
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
    const joined = await this._pool.query(`${DRAFT_JOIN_SQL} where g.draft_id = $1`, [key]);
    return normalizeRow(joined.rows[0] ?? result.rows[0]);
  }

  async dismissScriptFromPanel({ draftId, idNoticia, clusterId } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = await this._pool.query('select 1 from guiones_noticia where draft_id = $1', [key]);
    if (existing.rowCount) {
      await this._pool.query(
        `update guiones_noticia set estado_guion = 'descartado',
           cluster_id = coalesce(cluster_id, $2), updated_at = now()
         where draft_id = $1`,
        [key, clusterId ?? null],
      );
    } else {
      await this._pool.query(
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
    const result = await this._pool.query(`${DRAFT_JOIN_SQL} where ${where} limit 1`, params);
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

    const result = await this._pool.query(
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
    const joined = await this._pool.query(`${DRAFT_JOIN_SQL} where g.draft_id = $1`, [key]);
    return normalizeRow(joined.rows[0] ?? result.rows[0]);
  }

  // Publish jobs -----------------------------------------------------------

  async createPublishJob(job = {}) {
    const jobId = textOrNull(job.job_id);
    if (!jobId) throw new Error('job_id is required');
    const result = await this._pool.query(
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
    const result = await this._pool.query(
      `update script_publish_jobs set ${sets.join(', ')}, updated_at = now()
       where job_id = $1 ${activeFilter} returning *`,
      params,
    );
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

  async getPublishJob(jobId) {
    const result = await this._pool.query('select * from script_publish_jobs where job_id = $1', [String(jobId)]);
    return result.rowCount ? normalizeRow(result.rows[0]) : null;
  }

}
