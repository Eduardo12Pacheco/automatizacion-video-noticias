import { randomUUID } from 'node:crypto';

import { RepositoryPort } from '../ports/repository-port.js';

const SCHEMA_TIMESTAMP_FIELDS = new Set([
  'created_at',
  'updated_at',
  'fecha_publicacion',
  'fecha_detectada',
  'fecha_creacion_cluster',
  'fecha_borrador',
  'approval_updated_at',
  'queued_at',
  'started_at',
  'completed_at',
  'finished_at',
  'requested_at',
  'expires_at',
  'last_seen_at',
  'revoked_at',
  'last_login_at',
  'published_at',
  'disabled_at',
]);

function nowIso(now = () => new Date()) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(value).toISOString();
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
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

function integerOrDefault(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function jsonValue(value, fallback) {
  return value === undefined ? fallback : clone(value);
}

function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

function normalizeTimestamps(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = SCHEMA_TIMESTAMP_FIELDS.has(key) ? toIso(value) : value;
  }
  return output;
}

function makeQueueId(idNoticia) {
  return String(idNoticia);
}

export class InMemoryRepository extends RepositoryPort {
  #options;

  #news = new Map();
  #clusters = new Map();
  #scriptJobs = new Map();
  #drafts = new Map();
  #publishJobs = new Map();
  #videoProjects = new Map();
  #runs = new Map();
  #stagedNews = new Map();
  #stagedClusters = new Map();
  #users = new Map();
  #userRoles = new Map();
  #sessions = new Map();
  #roles = new Map([
    ['admin', { role: 'admin', description: 'Full access' }],
    ['editor', { role: 'editor', description: 'Can edit' }],
    ['viewer', { role: 'viewer', description: 'Read-only' }],
  ]);

  constructor({ now } = {}) {
    super();
    this.#options = { now: now || (() => new Date()) };
  }

  #nowIso() {
    return nowIso(this.#options.now);
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
    const now = this.#nowIso();
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
        const existing = this.#stagedNews.get(key);
        this.#stagedNews.set(key, {
          run_id: runId,
          id_noticia: id,
          payload: { ...(existing?.payload || {}), ...clone(normalized) },
          created_at: existing?.created_at || now,
        });
      } else {
        const existing = this.#news.get(id);
        this.#news.set(id, {
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
      rows = [...this.#stagedNews.values()]
        .filter((entry) => entry.run_id === runId)
        .map((entry) => entry.payload);
    } else {
      rows = [...this.#news.values()];
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
    const newsCount = this.#news.size;
    this.#news.clear();
    this.#clusters.clear();
    for (const [id, job] of this.#scriptJobs) {
      if (job.status === 'pendiente' || job.status === 'running') this.#scriptJobs.delete(id);
    }
    return { deleted_news: newsCount };
  }

  async resetStaging(runId) {
    if (!runId) throw new Error('runId is required');
    let deletedNews = 0;
    let deletedClusters = 0;
    for (const key of [...this.#stagedNews.keys()]) {
      if (key.startsWith(`${runId}::`)) {
        this.#stagedNews.delete(key);
        deletedNews += 1;
      }
    }
    for (const key of [...this.#stagedClusters.keys()]) {
      if (key.startsWith(`${runId}::`)) {
        this.#stagedClusters.delete(key);
        deletedClusters += 1;
      }
    }
    return { deleted_news: deletedNews, deleted_clusters: deletedClusters };
  }

  async persistClusters(clusters = [], { runId = null } = {}) {
    const input = Array.isArray(clusters) ? clusters : [];
    const now = this.#nowIso();
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
        const existing = this.#stagedClusters.get(key);
        this.#stagedClusters.set(key, {
          run_id: runId,
          cluster_id: clusterId,
          payload: { ...(existing?.payload || {}), ...clone(cluster), ...normalized, sources: clone(sources) },
          created_at: existing?.created_at || now,
        });
        for (const source of sources) {
          const id = textOrNull(source?.id_noticia);
          if (!id) continue;
          const newsKey = `${runId}::${id}`;
          const staged = this.#stagedNews.get(newsKey);
          if (staged) staged.payload.cluster_id = clusterId;
        }
      } else {
        const existing = this.#clusters.get(clusterId);
        this.#clusters.set(clusterId, {
          ...normalized,
          created_at: existing?.created_at || now,
          updated_at: now,
        });
        for (const source of sources) {
          const id = textOrNull(source?.id_noticia);
          const news = id ? this.#news.get(id) : null;
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
    const now = this.#nowIso();
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
    this.#runs.set(runId, row);
    return clone(row);
  }

  async getNewsSearchRun(runId) {
    const row = this.#runs.get(String(runId));
    return row ? clone(row) : null;
  }

  async updateNewsSearchRun(runId, patch = {}) {
    const current = this.#runs.get(String(runId));
    if (!current) return null;
    const allowed = ['status', 'stats', 'error', 'started_at', 'finished_at', 'requested_window'];
    const next = { ...current };
    for (const key of allowed) {
      if (!(key in patch)) continue;
      next[key] = key === 'stats' ? jsonValue(patch[key], {}) : clone(patch[key]);
    }
    next.updated_at = this.#nowIso();
    const normalized = normalizeTimestamps(next);
    this.#runs.set(String(runId), normalized);
    return clone(normalized);
  }

  async promoteNewsSearchRun(runId) {
    const run = this.#runs.get(String(runId));
    if (!run) return null;
    let promotedNews = 0;
    let promotedClusters = 0;

    for (const cluster of this.#stagedClusters.values()) {
      if (cluster.run_id !== runId) continue;
      const payload = { ...cluster.payload, run_id: runId };
      const result = await this.persistClusters([payload], {});
      promotedClusters += result.upserted;
    }

    for (const entry of this.#stagedNews.values()) {
      if (entry.run_id !== runId) continue;
      const news = { ...entry.payload, run_id: runId };
      const existing = this.#news.get(news.id_noticia);
      this.#news.set(news.id_noticia, {
        ...(existing || {}),
        ...clone(news),
        created_at: existing?.created_at || news.created_at,
      });
      promotedNews += 1;
    }

    await this.resetStaging(runId);
    const now = this.#nowIso();
    const next = normalizeTimestamps({
      ...run,
      status: 'promoted',
      finished_at: now,
      updated_at: now,
    });
    this.#runs.set(runId, next);
    return { run: clone(next), promoted_news: promotedNews, promoted_clusters: promotedClusters };
  }

  // Approval ---------------------------------------------------------------

  async listPendingApprovalClusters() {
    const counts = new Map();
    for (const news of this.#news.values()) {
      if (news.estado_revision !== 'pendiente' || !news.cluster_id) continue;
      counts.set(news.cluster_id, (counts.get(news.cluster_id) || 0) + 1);
    }

    const rows = [];
    for (const [clusterId, count] of counts) {
      const cluster = this.#clusters.get(clusterId);
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
    const cluster = this.#clusters.get(String(clusterId));
    if (!cluster) return null;
    const sources = [...this.#news.values()]
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
    const news = this.#news.get(id);
    if (!news) return null;
    const now = this.#nowIso();
    news.estado_revision = normalizedAction === 'approve' ? 'aprobado' : 'rechazado';
    news.approval_action = normalizedAction;
    news.approval_updated_at = now;
    news.updated_at = now;
    if (clusterId && !news.cluster_id) news.cluster_id = String(clusterId);

    if (normalizedAction === 'approve') {
      if (!this.#scriptJobs.has(id)) {
        this.#scriptJobs.set(id, normalizeTimestamps({
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
      const job = this.#scriptJobs.get(id);
      if (job && job.status === 'pendiente') this.#scriptJobs.delete(id);
    }

    if (news.cluster_id) {
      const cluster = this.#clusters.get(news.cluster_id);
      if (cluster) {
        const sourceStates = [...this.#news.values()]
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

  #joinJob(job) {
    const news = this.#news.get(job.id_noticia) || {};
    const cluster = news.cluster_id ? this.#clusters.get(news.cluster_id) || {} : {};
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
    const job = id ? this.#scriptJobs.get(id) : null;
    if (!job || job.status !== 'pendiente') return null;
    const now = this.#nowIso();
    job.status = 'running';
    job.stage = 'claimed';
    job.percent = 5;
    job.attempts = Number(job.attempts || 0) + 1;
    job.started_at = job.started_at || now;
    job.updated_at = now;
    return this.#joinJob(job);
  }

  async updateScriptJobProgress({ idNoticia, status, stage, percent, error } = {}) {
    const job = this.#scriptJobs.get(String(idNoticia));
    if (!job) return null;
    if (status != null) job.status = String(status);
    if (stage != null) job.stage = String(stage);
    if (percent != null) job.percent = Math.max(0, Math.min(100, integerOrDefault(percent, job.percent)));
    if (error != null) job.last_error = String(error).slice(0, 500);
    job.updated_at = this.#nowIso();
    return this.#joinJob(job);
  }

  async completeScriptJob({ idNoticia, draftId, guionDraft, guionEditado, wordCount: count } = {}) {
    const id = String(idNoticia);
    const news = this.#news.get(id) || {};
    const cluster = news.cluster_id ? this.#clusters.get(news.cluster_id) || {} : {};
    const now = this.#nowIso();
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
    this.#drafts.set(draft.draft_id, draft);

    let job = this.#scriptJobs.get(id);
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
    this.#scriptJobs.set(id, job);

    return { job: this.#joinJob(job), draft: clone(draft) };
  }

  async failScriptJob({ idNoticia, error } = {}) {
    const job = this.#scriptJobs.get(String(idNoticia));
    if (!job) return null;
    const now = this.#nowIso();
    job.status = 'fallido';
    job.stage = 'failed';
    job.last_error = String(error ?? 'Script job failed').slice(0, 500);
    job.completed_at = now;
    job.updated_at = now;
    return this.#joinJob(job);
  }

  async getScriptQueueMonitor() {
    return [...this.#scriptJobs.values()]
      .sort((left, right) => String(left.queued_at).localeCompare(String(right.queued_at)))
      .map((job) => {
        const joined = this.#joinJob(job);
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

  #joinDraft(draft) {
    const news = draft.id_noticia ? this.#news.get(draft.id_noticia) || {} : {};
    const cluster = draft.cluster_id ? this.#clusters.get(draft.cluster_id) || {} : {};
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
    return [...this.#drafts.values()]
      .filter((draft) => draft.estado_guion === 'borrador')
      .sort((left, right) => String(right.fecha_borrador).localeCompare(String(left.fecha_borrador)))
      .map((draft) => this.#joinDraft(draft));
  }

  async saveScriptDraft({ draftId, idNoticia, clusterId, guionDraft, guionEditado } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = this.#drafts.get(key);
    const now = this.#nowIso();
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
    this.#drafts.set(key, draft);
    return this.#joinDraft(draft);
  }

  async dismissScriptFromPanel({ draftId, idNoticia, clusterId } = {}) {
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const existing = this.#drafts.get(key);
    const now = this.#nowIso();
    if (existing) {
      existing.estado_guion = 'descartado';
      existing.updated_at = now;
      if (clusterId && !existing.cluster_id) existing.cluster_id = String(clusterId);
    } else {
      this.#drafts.set(key, normalizeTimestamps({
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
    let draft = draftId ? this.#drafts.get(String(draftId)) : null;
    if (!draft && idNoticia) {
      draft = [...this.#drafts.values()].find((row) => row.id_noticia === String(idNoticia));
    }
    if (!draft && clusterId) {
      draft = [...this.#drafts.values()].find((row) => row.cluster_id === String(clusterId));
    }
    return draft ? this.#joinDraft(draft) : null;
  }

  async finalizeScriptPublish(payload = {}) {
    const draftId = payload.draftId ?? payload.p_draft_id;
    const idNoticia = payload.idNoticia ?? payload.p_id_noticia;
    const clusterId = payload.clusterId ?? payload.p_cluster_id;
    const key = textOrNull(draftId) || (idNoticia ? `draft-${idNoticia}` : null);
    if (!key) throw new Error('draftId is required');
    const now = this.#nowIso();
    const existing = this.#drafts.get(key);
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
    this.#drafts.set(key, draft);
    return this.#joinDraft(draft);
  }

  // Publish jobs -----------------------------------------------------------

  async createPublishJob(job = {}) {
    const jobId = textOrNull(job.job_id);
    if (!jobId) throw new Error('job_id is required');
    const now = this.#nowIso();
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
    this.#publishJobs.set(jobId, row);
    return clone(row);
  }

  async updatePublishJob(jobId, patch = {}, { onlyActive = false } = {}) {
    const current = this.#publishJobs.get(String(jobId));
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
    next.updated_at = this.#nowIso();
    const normalized = normalizeTimestamps(next);
    this.#publishJobs.set(String(jobId), normalized);
    return clone(normalized);
  }

  async getPublishJob(jobId) {
    const row = this.#publishJobs.get(String(jobId));
    return row ? clone(row) : null;
  }

  // Video projects ---------------------------------------------------------

  async upsertVideoProject(project = {}) {
    const draftId = textOrNull(project.draft_id ?? project.draftId);
    if (!draftId) throw new Error('draft_id is required');
    const existing = this.#videoProjects.get(draftId);
    const now = this.#nowIso();
    const row = normalizeTimestamps({
      ...(existing || {}),
      draft_id: draftId,
      id_noticia: textOrNull(project.id_noticia) ?? existing?.id_noticia ?? null,
      cluster_id: textOrNull(project.cluster_id) ?? existing?.cluster_id ?? null,
      jugador: textOrNull(project.jugador) ?? existing?.jugador ?? null,
      seleccion: textOrNull(project.seleccion) ?? existing?.seleccion ?? null,
      tema_principal: textOrNull(project.tema_principal) ?? existing?.tema_principal ?? null,
      guion_editado: project.guion_editado ?? existing?.guion_editado ?? null,
      guion_piped: project.guion_piped ?? existing?.guion_piped ?? null,
      segments: jsonValue(project.segments, existing?.segments ?? []),
      image_candidates: jsonValue(project.image_candidates, existing?.image_candidates ?? []),
      image_search_meta: jsonValue(project.image_search_meta, existing?.image_search_meta ?? {}),
      selected_images: jsonValue(project.selected_images, existing?.selected_images ?? []),
      voice_audio: jsonValue(project.voice_audio, existing?.voice_audio ?? {}),
      background_audio: jsonValue(project.background_audio, existing?.background_audio ?? {}),
      editor_state: jsonValue(project.editor_state, existing?.editor_state ?? {}),
      status: textOrNull(project.status) ?? existing?.status ?? 'pending',
      published_at: project.published_at ?? existing?.published_at ?? null,
      disabled_at: project.disabled_at ?? existing?.disabled_at ?? null,
      created_at: existing?.created_at || now,
      updated_at: now,
    });
    this.#videoProjects.set(draftId, row);
    return clone(row);
  }

  async getVideoEditProjects({ draftId = null, limit = 50, includeDetail = true } = {}) {
    if (draftId) {
      const row = this.#videoProjects.get(String(draftId));
      if (!row || row.disabled_at) return { ok: true, projects: [] };
      return { ok: true, projects: [this.#shapeVideoProject(row, includeDetail)] };
    }
    const max = Math.max(1, integerOrDefault(limit, 50));
    const rows = [...this.#videoProjects.values()]
      .filter((row) => !row.disabled_at)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, max)
      .map((row) => this.#shapeVideoProject(row, includeDetail));
    return { ok: true, projects: rows };
  }

  #shapeVideoProject(row, includeDetail) {
    const output = clone(row);
    if (!includeDetail) {
      for (const key of [
        'segments',
        'image_candidates',
        'image_search_meta',
        'selected_images',
        'voice_audio',
        'background_audio',
        'editor_state',
      ]) {
        delete output[key];
      }
    }
    return output;
  }

  #requireVideoProject(draftId) {
    const row = this.#videoProjects.get(String(draftId));
    if (!row || row.disabled_at) throw new Error(`video project not found: ${draftId}`);
    return row;
  }

  async saveVideoProjectSelections({ draftId, selectedImageIds = [] } = {}) {
    const row = this.#requireVideoProject(draftId);
    row.selected_images = clone(Array.isArray(selectedImageIds) ? selectedImageIds : []);
    row.updated_at = this.#nowIso();
    return { ok: true, draft_id: row.draft_id, selected_images: clone(row.selected_images) };
  }

  async saveVideoProjectEditorState({ draftId, editorState = {} } = {}) {
    const row = this.#requireVideoProject(draftId);
    row.editor_state = jsonValue(editorState, {});
    row.updated_at = this.#nowIso();
    return { ok: true, draft_id: row.draft_id, editor_state: clone(row.editor_state) };
  }

  async saveVideoProjectAudio({ draftId, voiceAudio = {}, backgroundAudio = {} } = {}) {
    const row = this.#requireVideoProject(draftId);
    row.voice_audio = jsonValue(voiceAudio, {});
    row.background_audio = jsonValue(backgroundAudio, {});
    row.updated_at = this.#nowIso();
    return {
      ok: true,
      draft_id: row.draft_id,
      voice_audio: clone(row.voice_audio),
      background_audio: clone(row.background_audio),
    };
  }

  async addVideoProjectCustomImages({ draftId, customCandidates = [] } = {}) {
    const row = this.#requireVideoProject(draftId);
    const input = Array.isArray(customCandidates) ? customCandidates : [];
    row.image_candidates = [...(row.image_candidates || []), ...clone(input)];
    row.updated_at = this.#nowIso();
    return {
      ok: true,
      draft_id: row.draft_id,
      added_count: input.length,
      image_candidates: clone(row.image_candidates),
      selected_images: clone(row.selected_images || []),
    };
  }

  async disableVideoEditProject({ draftId } = {}) {
    const row = this.#videoProjects.get(String(draftId));
    if (!row) return { ok: false, draft_id: String(draftId) };
    const now = this.#nowIso();
    row.disabled_at = now;
    row.status = 'disabled';
    row.updated_at = now;
    return { ok: true, draft_id: row.draft_id };
  }

  // Users, roles, sessions -------------------------------------------------

  async listRoles() {
    return [...this.#roles.values()].map((role) => clone(role));
  }

  #userView(user) {
    return {
      ...clone(user),
      roles: [...(this.#userRoles.get(user.user_id) || [])].sort(),
    };
  }

  async createUser({ email, displayName = '', passwordHash, roles = ['editor'] } = {}) {
    const normalizedEmail = textOrNull(email)?.toLowerCase();
    if (!normalizedEmail) throw new Error('email is required');
    if (!passwordHash) throw new Error('passwordHash is required');
    if ([...this.#users.values()].some((user) => user.email === normalizedEmail)) {
      const error = new Error('duplicate email');
      error.code = '23505';
      throw error;
    }
    const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
    for (const role of normalizedRoles) {
      if (!this.#roles.has(role)) throw new Error(`unknown role: ${role}`);
    }
    const now = this.#nowIso();
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
    this.#users.set(user.user_id, user);
    this.#userRoles.set(user.user_id, normalizedRoles.length ? normalizedRoles : ['editor']);
    return this.#userView(user);
  }

  async getUserById(userId) {
    const user = this.#users.get(String(userId));
    return user ? this.#userView(user) : null;
  }

  async getUserByEmail(email) {
    const normalized = textOrNull(email)?.toLowerCase();
    if (!normalized) return null;
    const user = [...this.#users.values()].find((row) => row.email === normalized);
    return user ? this.#userView(user) : null;
  }

  async listUsers() {
    return [...this.#users.values()]
      .sort((left, right) => left.email.localeCompare(right.email))
      .map((user) => this.#userView(user));
  }

  async updateUser(userId, patch = {}) {
    const user = this.#users.get(String(userId));
    if (!user) return null;
    if (patch.status != null) {
      const status = String(patch.status);
      if (!['active', 'disabled'].includes(status)) throw new Error('status must be active or disabled');
      user.status = status;
    }
    if (patch.displayName != null) user.display_name = textOrNull(patch.displayName) || user.email;
    if (patch.passwordHash != null) user.password_hash = String(patch.passwordHash);
    if (patch.lastLoginAt != null) user.last_login_at = toIso(patch.lastLoginAt);
    user.updated_at = this.#nowIso();
    return this.#userView(user);
  }

  async setUserRoles(userId, roles = []) {
    const user = this.#users.get(String(userId));
    if (!user) return null;
    const normalizedRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
    if (!normalizedRoles.length) throw new Error('at least one role is required');
    for (const role of normalizedRoles) {
      if (!this.#roles.has(role)) throw new Error(`unknown role: ${role}`);
    }
    this.#userRoles.set(user.user_id, normalizedRoles);
    user.updated_at = this.#nowIso();
    return this.#userView(user);
  }

  async createSession({ userId, tokenHash, expiresAt, ipAddress = null, userAgent = null } = {}) {
    if (!userId || !tokenHash || !expiresAt) throw new Error('userId, tokenHash and expiresAt are required');
    const now = this.#nowIso();
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
    this.#sessions.set(session.session_id, session);
    return clone(session);
  }

  async getSessionByTokenHash(tokenHash) {
    const session = [...this.#sessions.values()].find((row) => row.token_hash === String(tokenHash));
    if (!session || session.revoked_at) return null;
    if (Date.parse(session.expires_at) <= Date.parse(this.#nowIso())) return null;
    const user = this.#users.get(session.user_id);
    if (!user || user.status !== 'active') return null;
    return {
      ...clone(session),
      user: {
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name,
      },
      roles: [...(this.#userRoles.get(user.user_id) || [])].sort(),
    };
  }

  async touchSession(sessionId, { lastSeenAt = null } = {}) {
    const session = this.#sessions.get(String(sessionId));
    if (!session) return null;
    session.last_seen_at = toIso(lastSeenAt) || this.#nowIso();
    return clone(session);
  }

  async revokeSession(sessionId) {
    const session = this.#sessions.get(String(sessionId));
    if (!session) return false;
    session.revoked_at = this.#nowIso();
    return true;
  }

  async deleteExpiredSessions({ now = null } = {}) {
    const cutoff = toIso(now) || this.#nowIso();
    let deleted = 0;
    for (const [id, session] of this.#sessions) {
      if (session.revoked_at || Date.parse(session.expires_at) <= Date.parse(cutoff)) {
        this.#sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
