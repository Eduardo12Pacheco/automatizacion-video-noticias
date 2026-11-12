import { RepositoryPort } from '../ports/repository-port.js';
import { nowIso, clone, textOrNull, numberOrNull, integerOrDefault, jsonValue, wordCount, normalizeTimestamps, makeQueueId } from './in-memory-shared.js';
import { inMemoryUserMethods } from './in-memory-users.js';
import { inMemoryVideoProjectMethods } from './in-memory-video-projects.js';
import { randomUUID } from 'node:crypto';

export class InMemoryRepository extends RepositoryPort {
  _options;

  _news = new Map();
  _clusters = new Map();
  _scriptJobs = new Map();
  _drafts = new Map();
  _publishJobs = new Map();
  _videoProjects = new Map();
  _runs = new Map();
  _stagedNews = new Map();
  _stagedClusters = new Map();
  _users = new Map();
  _userRoles = new Map();
  _sessions = new Map();
  _roles = new Map([
    ['admin', { role: 'admin', description: 'Full access' }],
    ['editor', { role: 'editor', description: 'Can edit' }],
    ['viewer', { role: 'viewer', description: 'Read-only' }],
  ]);

  constructor({ now } = {}) {
    super();
    this._options = { now: now || (() => new Date()) };
  }

  _nowIso() {
    return nowIso(this._options.now);
  }

  async migrate() {
    return { applied: 0, adapter: 'memory' };
  }

  async healthCheck() {
    return { ok: true, adapter: 'memory' };
  }

  async close() {
    return undefined;
  }

  // Discovery --------------------------------------------------------------

  async upsertNews(rows = [], { runId = null } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    const now = this._nowIso();
    let valid = 0;
    let upserted = 0;

    for (const raw of input) {
      const id = textOrNull(raw?.id_noticia);
      const titular = textOrNull(raw?.titular);
      if (!id || !titular) continue;
      valid += 1;

      const normalized = normalizeTimestamps({
        id_noticia: id,
        cluster_id: textOrNull(raw.cluster_id),
        seleccion: textOrNull(raw.seleccion),
        jugador: textOrNull(raw.jugador),
        titular,
        fuente: textOrNull(raw.fuente),
        fecha_publicacion: raw.fecha_publicacion ?? null,
        link: textOrNull(raw.link),
        snippet: textOrNull(raw.snippet),
        fuente_origen: textOrNull(raw.fuente_origen),
        estado_revision: textOrNull(raw.estado_revision) || 'pendiente',
        approval_action: textOrNull(raw.approval_action),
        approval_updated_at: raw.approval_updated_at ?? null,
        tema_principal: textOrNull(raw.tema_principal),
        fecha_detectada: raw.fecha_detectada ?? now,
        google_position: numberOrNull(raw.google_position),
        classification_source: textOrNull(raw.classification_source),
        football_signals: textOrNull(raw.football_signals),
        pass_direct: raw.pass_direct == null ? null : Boolean(raw.pass_direct),
        run_id: runId,
        created_at: raw.created_at ?? now,
        updated_at: now,
      });

      if (runId) {
        const key = `${runId}::${id}`;
        const existing = this._stagedNews.get(key);
        this._stagedNews.set(key, {
          run_id: runId,
          id_noticia: id,
          payload: { ...(existing?.payload || {}), ...clone(normalized) },
          created_at: existing?.created_at || now,
        });
      } else {
        const existing = this._news.get(id);
        this._news.set(id, {
          ...(existing || {}),
          ...clone(normalized),
          created_at: existing?.created_at || normalized.created_at,
        });
      }
      upserted += 1;
    }

    return { received: input.length, valid, upserted };
  }

  async listNewsForClustering({ runId = null } = {}) {
    let rows;
    if (runId) {
      rows = [...this._stagedNews.values()]
        .filter((entry) => entry.run_id === runId)
        .map((entry) => entry.payload);
    } else {
      rows = [...this._news.values()];
    }
    rows.sort((left, right) => {
      const byPosition = (left.google_position ?? Number.POSITIVE_INFINITY)
        - (right.google_position ?? Number.POSITIVE_INFINITY);
      if (byPosition !== 0) return byPosition;
      return String(right.fecha_publicacion || '').localeCompare(String(left.fecha_publicacion || ''));
    });
    return { count: rows.length, rows: clone(rows) };
  }

  async resetDiscoveryState() {
    const newsCount = this._news.size;
    this._news.clear();
    this._clusters.clear();
    for (const [id, job] of this._scriptJobs) {
      if (job.status === 'pendiente' || job.status === 'running') this._scriptJobs.delete(id);
    }
    return { deleted_news: newsCount };
  }

  /**
   * Remove one demo story (the ids the seed CLI owns) before re-seeding it.
   * Used by `seed-demo.js --reset` so the E2E suite can run twice against the
   * same database without deleting an operator's unrelated rows.
   */
  async resetDemoStory({ newsIds = [], clusterIds = [] } = {}) {
    const news = new Set((newsIds || []).map(String));
    const clusters = new Set((clusterIds || []).map(String));
    const matches = (row) => news.has(String(row?.id_noticia)) || clusters.has(String(row?.cluster_id));
    let deletedNews = 0;
    let deletedClusters = 0;
    for (const [id, row] of [...this._news.entries()]) {
      if (news.has(String(id)) || clusters.has(String(row?.cluster_id))) {
        this._news.delete(id);
        deletedNews += 1;
      }
    }
    for (const [id, row] of [...this._clusters.entries()]) {
      if (clusters.has(String(id)) || news.has(String(row?.id_noticia))) {
        this._clusters.delete(id);
        deletedClusters += 1;
      }
    }
    for (const [id, row] of [...this._scriptJobs.entries()]) {
      if (news.has(String(id)) || matches(row)) this._scriptJobs.delete(id);
    }
    for (const [id, row] of [...this._drafts.entries()]) {
      if (matches(row)) this._drafts.delete(id);
    }
    for (const [id, row] of [...this._publishJobs.entries()]) {
      if (matches(row)) this._publishJobs.delete(id);
    }
    for (const [id, row] of [...this._videoProjects.entries()]) {
      if (matches(row)) this._videoProjects.delete(id);
    }
    return { deleted_news: deletedNews, deleted_clusters: deletedClusters };
  }

  async resetStaging(runId) {    if (!runId) throw new Error('runId is required');
    let deletedNews = 0;
    let deletedClusters = 0;
    for (const key of [...this._stagedNews.keys()]) {
      if (key.startsWith(`${runId}::`)) {
        this._stagedNews.delete(key);
        deletedNews += 1;
      }
    }
    for (const key of [...this._stagedClusters.keys()]) {
      if (key.startsWith(`${runId}::`)) {
        this._stagedClusters.delete(key);
        deletedClusters += 1;
      }
    }
    return { deleted_news: deletedNews, deleted_clusters: deletedClusters };
  }

  async persistClusters(clusters = [], { runId = null } = {}) {
    const input = Array.isArray(clusters) ? clusters : [];
    const now = this._nowIso();
    let upserted = 0;

    for (const cluster of input) {
      const clusterId = textOrNull(cluster?.cluster_id);
      if (!clusterId) continue;
      const normalized = normalizeTimestamps({
        cluster_id: clusterId,
        run_id: runId,
        seleccion: textOrNull(cluster.seleccion),
        jugador: textOrNull(cluster.jugador),
        tema_principal: textOrNull(cluster.tema_principal) || 'Sin tema',
        resumen_cluster: textOrNull(cluster.resumen_cluster),
        tag_editorial: textOrNull(cluster.tag_editorial),
        avg_google_position: numberOrNull(cluster.avg_google_position),
        estado_revision: textOrNull(cluster.estado_revision) || 'pendiente',
        fecha_creacion_cluster: cluster.fecha_creacion_cluster ?? now,
        created_at: now,
        updated_at: now,
      });
      const sources = Array.isArray(cluster.sources) ? cluster.sources : [];

      if (runId) {
        const key = `${runId}::${clusterId}`;
        const existing = this._stagedClusters.get(key);
        this._stagedClusters.set(key, {
          run_id: runId,
          cluster_id: clusterId,
          payload: { ...(existing?.payload || {}), ...clone(cluster), ...normalized, sources: clone(sources) },
          created_at: existing?.created_at || now,
        });
        for (const source of sources) {
          const id = textOrNull(source?.id_noticia);
          if (!id) continue;
          const newsKey = `${runId}::${id}`;
          const staged = this._stagedNews.get(newsKey);
          if (staged) staged.payload.cluster_id = clusterId;
        }
      } else {
        const existing = this._clusters.get(clusterId);
        this._clusters.set(clusterId, {
          ...normalized,
          created_at: existing?.created_at || now,
          updated_at: now,
        });
        for (const source of sources) {
          const id = textOrNull(source?.id_noticia);
          const news = id ? this._news.get(id) : null;
          if (news) {
            news.cluster_id = clusterId;
            news.updated_at = now;
          }
        }
      }
      upserted += 1;
    }

    return { upserted };
  }

  async createNewsSearchRun({ requestedWindow = '24h' } = {}) {
    const now = this._nowIso();
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const row = normalizeTimestamps({
      run_id: runId,
      requested_window: requestedWindow || '24h',
      status: 'queued',
      requested_at: now,
      started_at: null,
      finished_at: null,
      stats: {},
      error: null,
      created_at: now,
      updated_at: now,
    });
    this._runs.set(runId, row);
    return clone(row);
  }

  async getNewsSearchRun(runId) {
    const row = this._runs.get(String(runId));
    return row ? clone(row) : null;
  }

  async updateNewsSearchRun(runId, patch = {}) {
    const current = this._runs.get(String(runId));
    if (!current) return null;
    const allowed = ['status', 'stats', 'error', 'started_at', 'finished_at', 'requested_window'];
    const next = { ...current };
    for (const key of allowed) {
      if (!(key in patch)) continue;
      next[key] = key === 'stats' ? jsonValue(patch[key], {}) : clone(patch[key]);
    }
    next.updated_at = this._nowIso();
    const normalized = normalizeTimestamps(next);
    this._runs.set(String(runId), normalized);
    return clone(normalized);
  }

  async promoteNewsSearchRun(runId) {
    const run = this._runs.get(String(runId));
    if (!run) return null;
    let promotedNews = 0;
    let promotedClusters = 0;

    for (const cluster of this._stagedClusters.values()) {
      if (cluster.run_id !== runId) continue;
      const payload = { ...cluster.payload, run_id: runId };
      const result = await this.persistClusters([payload], {});
      promotedClusters += result.upserted;
    }

    for (const entry of this._stagedNews.values()) {
      if (entry.run_id !== runId) continue;
      const news = { ...entry.payload, run_id: runId };
      const existing = this._news.get(news.id_noticia);
      this._news.set(news.id_noticia, {
        ...(existing || {}),
        ...clone(news),
        created_at: existing?.created_at || news.created_at,
      });
      promotedNews += 1;
    }

    await this.resetStaging(runId);
    const now = this._nowIso();
    const next = normalizeTimestamps({
      ...run,
      status: 'promoted',
      finished_at: now,
      updated_at: now,
    });
    this._runs.set(runId, next);
    return { run: clone(next), promoted_news: promotedNews, promoted_clusters: promotedClusters };
  }

  // Approval ---------------------------------------------------------------

  async listPendingApprovalClusters() {
    const counts = new Map();
    for (const news of this._news.values()) {
      if (news.estado_revision !== 'pendiente' || !news.cluster_id) continue;
      counts.set(news.cluster_id, (counts.get(news.cluster_id) || 0) + 1);
    }

    const rows = [];
    for (const [clusterId, count] of counts) {
      const cluster = this._clusters.get(clusterId);
      if (!cluster) continue;
      rows.push({
        ...clone(cluster),
        cantidad_fuentes: count,
        cantidad_fuentes_total: count,
      });
    }
    rows.sort((left, right) => {
      const byDate = String(right.fecha_creacion_cluster || '').localeCompare(String(left.fecha_creacion_cluster || ''));
      return byDate !== 0 ? byDate : String(left.cluster_id).localeCompare(String(right.cluster_id));
    });
    return rows;
  }

  async getApprovalTopicDetail(clusterId) {
    if (!clusterId) return null;
    const cluster = this._clusters.get(String(clusterId));
    if (!cluster) return null;
    const sources = [...this._news.values()]
      .filter((news) => news.cluster_id === cluster.cluster_id)
      .sort((left, right) => {
        const byPosition = (left.google_position ?? Number.POSITIVE_INFINITY)
          - (right.google_position ?? Number.POSITIVE_INFINITY);
        if (byPosition !== 0) return byPosition;
        return String(right.fecha_publicacion || '').localeCompare(String(left.fecha_publicacion || ''));
      })
      .map((news, index) => ({ ...clone(news), index: index + 1 }));
    return {
      ...clone(cluster),
      cantidad_fuentes: sources.length,
      cantidad_fuentes_total: sources.length,
      sources,
    };
  }

  async applyApprovalDecision({ idNoticia, clusterId = null, action } = {}) {
    const id = textOrNull(idNoticia);
    const normalizedAction = textOrNull(action);
    if (!id) throw new Error('idNoticia is required');
    if (!['approve', 'reject'].includes(normalizedAction)) {
      throw new Error('action must be approve or reject');
    }
    const news = this._news.get(id);
    if (!news) return null;
    const now = this._nowIso();
    news.estado_revision = normalizedAction === 'approve' ? 'aprobado' : 'rechazado';
    news.approval_action = normalizedAction;
    news.approval_updated_at = now;
    news.updated_at = now;
    if (clusterId && !news.cluster_id) news.cluster_id = String(clusterId);

    if (normalizedAction === 'approve') {
      if (!this._scriptJobs.has(id)) {
        this._scriptJobs.set(id, normalizeTimestamps({
          id_noticia: id,
          queue_id: makeQueueId(id),
          status: 'pendiente',
          stage: 'queued',
          percent: 0,
          attempts: 0,
          last_error: null,
          queued_at: now,
          started_at: null,
          completed_at: null,
          updated_at: now,
        }));
      }
    } else {
      const job = this._scriptJobs.get(id);
      if (job && job.status === 'pendiente') this._scriptJobs.delete(id);
    }

    if (news.cluster_id) {
      const cluster = this._clusters.get(news.cluster_id);
      if (cluster) {
        const sourceStates = [...this._news.values()]
          .filter((row) => row.cluster_id === cluster.cluster_id)
          .map((row) => row.estado_revision);
        if (sourceStates.includes('pendiente')) cluster.estado_revision = 'pendiente';
        else if (sourceStates.includes('aprobado')) cluster.estado_revision = 'aprobado';
        else if (sourceStates.includes('publicado')) cluster.estado_revision = 'publicado';
        else cluster.estado_revision = 'rechazado';
        cluster.updated_at = now;
      }
    }

    return clone(news);
  }

  // Script queue -----------------------------------------------------------

  _joinJob(job) {
    const news = this._news.get(job.id_noticia) || {};
    const cluster = news.cluster_id ? this._clusters.get(news.cluster_id) || {} : {};
    return {
      ...clone(news),
      ...clone(cluster),
      id_noticia: job.id_noticia,
      queue_id: job.queue_id,
      status: job.status,
      stage: job.stage,
      percent: job.percent,
      attempts: job.attempts,
      last_error: job.last_error,
      started_at: job.started_at,
      completed_at: job.completed_at,
      updated_at: job.updated_at,
      tema_principal: cluster.tema_principal ?? news.tema_principal ?? news.titular ?? null,
      titular: news.titular ?? null,
      jugador: news.jugador ?? cluster.jugador ?? null,
      seleccion: news.seleccion ?? cluster.seleccion ?? null,
      fuente: news.fuente ?? null,
      link: news.link ?? null,
      snippet: news.snippet ?? null,
      cluster_id: news.cluster_id ?? cluster.cluster_id ?? null,
    };
  }

  async claimScriptJob({ idNoticia } = {}) {
    const id = textOrNull(idNoticia);
    const job = id ? this._scriptJobs.get(id) : null;
    if (!job || job.status !== 'pendiente') return null;
    const now = this._nowIso();
    job.status = 'running';
    job.stage = 'claimed';
    job.percent = 5;
    job.attempts = Number(job.attempts || 0) + 1;
    job.started_at = job.started_at || now;
    job.updated_at = now;
    return this._joinJob(job);
  }

  async updateScriptJobProgress({ idNoticia, status, stage, percent, error } = {}) {
    const job = this._scriptJobs.get(String(idNoticia));
    if (!job) return null;
    if (status != null) job.status = String(status);
    if (stage != null) job.stage = String(stage);
    if (percent != null) job.percent = Math.max(0, Math.min(100, integerOrDefault(percent, job.percent)));
    if (error != null) job.last_error = String(error).slice(0, 500);
    job.updated_at = this._nowIso();
    return this._joinJob(job);
  }

  async completeScriptJob({ idNoticia, draftId, guionDraft, guionEditado, wordCount: count } = {}) {
    const id = String(idNoticia);
    const news = this._news.get(id) || {};
    const cluster = news.cluster_id ? this._clusters.get(news.cluster_id) || {} : {};
    const now = this._nowIso();
    const finalText = guionEditado ?? guionDraft ?? '';
    const draft = await this.saveScriptDraft({
      draftId: draftId || `draft-${id}`,
      idNoticia: id,
      clusterId: news.cluster_id,
      guionDraft,
      guionEditado: finalText,
    });
    draft.guion_draft = guionDraft ?? draft.guion_draft ?? finalText;
    draft.guion_editado = finalText;
    draft.guion_word_count = count ?? wordCount(finalText);
    draft.jugador = news.jugador ?? cluster.jugador ?? draft.jugador ?? null;
    draft.seleccion = news.seleccion ?? cluster.seleccion ?? draft.seleccion ?? null;
    draft.tema_principal = cluster.tema_principal ?? news.tema_principal ?? draft.tema_principal ?? null;
    draft.estado_guion = 'borrador';
    draft.fecha_borrador = draft.fecha_borrador || now;
    draft.updated_at = now;
    this._drafts.set(draft.draft_id, draft);

    let job = this._scriptJobs.get(id);
    if (!job) {
      job = normalizeTimestamps({
        id_noticia: id,
        queue_id: makeQueueId(id),
        status: 'pendiente',
        stage: 'queued',
        percent: 0,
        attempts: 0,
        last_error: null,
        queued_at: now,
        started_at: null,
        completed_at: null,
        updated_at: now,
      });
    }
    job.status = 'completado';
    job.stage = 'completed';
    job.percent = 100;
    job.last_error = null;
    job.completed_at = now;
    job.updated_at = now;
    this._scriptJobs.set(id, job);

    return { job: this._joinJob(job), draft: clone(draft) };
  }

  async failScriptJob({ idNoticia, error } = {}) {
    const job = this._scriptJobs.get(String(idNoticia));
    if (!job) return null;
    const now = this._nowIso();
    job.status = 'fallido';
    job.stage = 'failed';
    job.last_error = String(error ?? 'Script job failed').slice(0, 500);
    job.completed_at = now;
    job.updated_at = now;
    return this._joinJob(job);
  }

  async getScriptQueueMonitor() {
    return [...this._scriptJobs.values()]
      .sort((left, right) => String(left.queued_at).localeCompare(String(right.queued_at)))
      .map((job) => {
        const joined = this._joinJob(job);
        return {
          queue_id: job.queue_id,
          cluster_id: joined.cluster_id,
          id_noticia: job.id_noticia,
          tema_principal: joined.tema_principal,
          titular: joined.titular,
          jugador: joined.jugador,
          seleccion: joined.seleccion,
          fuente: joined.fuente,
          estado_queue: job.status,
          progress_stage: job.stage,
          progress_percent: job.percent,
          attempts: job.attempts,
          last_error: job.last_error,
          fecha_encolado_guion: job.queued_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          updated_at: job.updated_at,
        };
      });
  }

  // Drafts -----------------------------------------------------------------

  _joinDraft(draft) {
    const news = draft.id_noticia ? this._news.get(draft.id_noticia) || {} : {};
    const cluster = draft.cluster_id ? this._clusters.get(draft.cluster_id) || {} : {};
    return {
      ...clone(draft),
      titulo_noticia: news.titular ?? cluster.tema_principal ?? draft.tema_principal ?? null,
      titular: news.titular ?? null,
      fuente: news.fuente ?? null,
      link: news.link ?? null,
      fecha_publicacion_noticia: news.fecha_publicacion ?? null,
      tema_principal: draft.tema_principal ?? cluster.tema_principal ?? null,
      jugador: draft.jugador ?? news.jugador ?? cluster.jugador ?? null,
      seleccion: draft.seleccion ?? news.seleccion ?? cluster.seleccion ?? null,
      resumen_cluster: cluster.resumen_cluster ?? null,
      tag_editorial: draft.tag_editorial ?? cluster.tag_editorial ?? null,
    };
  }

  async getPendingScriptDrafts() {
    return [...this._drafts.values()]
      .filter((draft) => draft.estado_guion === 'borrador')
      .sort((left, right) => String(right.fecha_borrador).localeCompare(String(left.fecha_borrador)))
      .map((draft) => this._joinDraft(draft));
  }

  async saveScriptDraft({ draftId, idNoticia, clusterId, guionDraft, guionEditado } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = this._drafts.get(key);
    const now = this._nowIso();
    const text = guionEditado ?? guionDraft ?? existing?.guion_editado ?? '';
    const draft = normalizeTimestamps({
      ...(existing || {}),
      draft_id: key,
      id_noticia: textOrNull(idNoticia) ?? existing?.id_noticia ?? null,
      cluster_id: textOrNull(clusterId) ?? existing?.cluster_id ?? null,
      guion_draft: guionDraft ?? existing?.guion_draft ?? text,
      guion_editado: text,
      guion_word_count: wordCount(text),
      estado_guion: existing?.estado_guion || 'borrador',
      fecha_borrador: existing?.fecha_borrador || now,
      created_at: existing?.created_at || now,
      updated_at: now,
    });
    this._drafts.set(key, draft);
    return this._joinDraft(draft);
  }

  async dismissScriptFromPanel({ draftId, idNoticia, clusterId } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = this._drafts.get(key);
    const now = this._nowIso();
    if (existing) {
      existing.estado_guion = 'descartado';
      existing.updated_at = now;
      if (clusterId && !existing.cluster_id) existing.cluster_id = String(clusterId);
    } else {
      this._drafts.set(key, normalizeTimestamps({
        draft_id: key,
        id_noticia: textOrNull(idNoticia),
        cluster_id: textOrNull(clusterId),
        guion_draft: '',
        guion_editado: '',
        guion_word_count: 0,
        estado_guion: 'descartado',
        fecha_borrador: now,
        created_at: now,
        updated_at: now,
      }));
    }
    return { ok: true, draft_id: key };
  }

  async getPublishableScriptDraft({ draftId, idNoticia, clusterId } = {}) {
    let draft = draftId ? this._drafts.get(String(draftId)) : null;
    if (!draft && idNoticia) {
      draft = [...this._drafts.values()].find((row) => row.id_noticia === String(idNoticia));
    }
    if (!draft && clusterId) {
      draft = [...this._drafts.values()].find((row) => row.cluster_id === String(clusterId));
    }
    return draft ? this._joinDraft(draft) : null;
  }

  async finalizeScriptPublish(payload = {}) {
    const draftId = payload.draftId ?? payload.p_draft_id;
    const idNoticia = payload.idNoticia ?? payload.p_id_noticia;
    const clusterId = payload.clusterId ?? payload.p_cluster_id;
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const now = this._nowIso();
    const existing = this._drafts.get(key);
    const body = payload.guionEditado ?? payload.p_guion_editado ?? existing?.guion_editado ?? '';
    const draft = normalizeTimestamps({
      ...(existing || {}),
      draft_id: key,
      id_noticia: textOrNull(idNoticia) ?? existing?.id_noticia ?? null,
      cluster_id: textOrNull(clusterId) ?? existing?.cluster_id ?? null,
      guion_draft: payload.guionDraft ?? existing?.guion_draft ?? body,
      guion_editado: body,
      guion_word_count: payload.wordCount ?? wordCount(body),
      estado_guion: 'publicado',
      doc_id: payload.docId ?? payload.p_doc_id ?? existing?.doc_id ?? null,
      doc_url: payload.docUrl ?? payload.p_doc_url ?? existing?.doc_url ?? null,
      fecha_publicacion: payload.fechaPublicacion ?? payload.p_fecha_publicacion ?? now,
      fecha_borrador: existing?.fecha_borrador || now,
      created_at: existing?.created_at || now,
      updated_at: now,
    });
    this._drafts.set(key, draft);
    return this._joinDraft(draft);
  }

  // Publish jobs -----------------------------------------------------------

  async createPublishJob(job = {}) {
    const jobId = textOrNull(job.job_id);
    if (!jobId) throw new Error('job_id is required');
    const now = this._nowIso();
    const row = normalizeTimestamps({
      job_id: jobId,
      draft_id: textOrNull(job.draft_id),
      id_noticia: textOrNull(job.id_noticia),
      cluster_id: textOrNull(job.cluster_id),
      status: textOrNull(job.status) || 'queued',
      stage: textOrNull(job.stage) || 'queued',
      message: textOrNull(job.message) || '',
      error: textOrNull(job.error) || '',
      result: jsonValue(job.result, {}),
      started_at: job.started_at ?? now,
      finished_at: job.finished_at ?? null,
      created_at: now,
      updated_at: now,
    });
    this._publishJobs.set(jobId, row);
    return clone(row);
  }

  async updatePublishJob(jobId, patch = {}, { onlyActive = false } = {}) {
    const current = this._publishJobs.get(String(jobId));
    if (!current) return null;
    if (onlyActive && (['completed', 'failed'].includes(current.status) || current.finished_at)) {
      return null;
    }
    const allowed = ['status', 'stage', 'message', 'error', 'result', 'finished_at'];
    const next = { ...current };
    for (const key of allowed) {
      if (!(key in patch)) continue;
      next[key] = key === 'result' ? jsonValue(patch[key], {}) : clone(patch[key]);
    }
    next.updated_at = this._nowIso();
    const normalized = normalizeTimestamps(next);
    this._publishJobs.set(String(jobId), normalized);
    return clone(normalized);
  }

  async getPublishJob(jobId) {
    const row = this._publishJobs.get(String(jobId));
    return row ? clone(row) : null;
  }

  // Video projects ---------------------------------------------------------
}

Object.assign(InMemoryRepository.prototype, inMemoryUserMethods, inMemoryVideoProjectMethods);
