/**
 * Local read models for the approval and script views. They deliberately keep
 * the wire shapes used by the panel (the ex-n8n HTTP endpoints) and never
 * expose transport details.
 */
export function buildReadModels({ repository } = {}) {
  if (!repository) throw new Error('repository is required');

  async function pendingApproval() {
    const items = await repository.listPendingApprovalClusters();
    return { ok: true, total: items.length, items };
  }

  async function approvalTopic(clusterId) {
    const item = clusterId ? await repository.getApprovalTopicDetail(String(clusterId)) : null;
    return { ok: true, item };
  }

  async function approvalQueue() {
    const rows = await repository.getScriptQueueMonitor();
    const items = rows.map((row) => ({
      job_id: row.queue_id,
      queue_id: row.queue_id,
      cluster_id: row.cluster_id ?? null,
      id_noticia: row.id_noticia ?? null,
      draft_id: row.id_noticia ? `draft-${row.id_noticia}` : null,
      tema_principal: row.tema_principal ?? row.titular ?? 'Sin título',
      jugador: row.jugador ?? null,
      seleccion: row.seleccion ?? null,
      titular: row.titular ?? row.tema_principal ?? 'Sin titular',
      fuente: row.fuente ?? null,
      status: row.estado_queue ?? row.status ?? 'pendiente',
      progress: {
        stage: row.progress_stage ?? row.stage ?? 'queued',
        percent: Number.isFinite(Number(row.progress_percent ?? row.percent))
          ? Math.max(0, Math.min(100, Math.round(Number(row.progress_percent ?? row.percent))))
          : 0,
      },
      attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
      last_error: row.last_error ?? null,
      queued_at: row.fecha_encolado_guion ?? row.queued_at ?? null,
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
      updated_at: row.updated_at ?? null,
    }));
    return { ok: true, items, total: items.length };
  }

  async function scriptDrafts() {
    const drafts = await repository.getPendingScriptDrafts();
    return { status: 'ok', total: drafts.length, drafts };
  }

  async function videoProjects({ draftId = null, limit = 50, includeDetail = true } = {}) {
    return repository.getVideoEditProjects({ draftId, limit, includeDetail });
  }

  async function searchRefreshStatus(runId) {
    const run = runId ? await repository.getNewsSearchRun(runId) : null;
    if (!run) return { status: 'not_found', run_id: runId || null, message: 'Run no encontrado' };
    return run;
  }

  async function publishJob(jobId) {
    const job = jobId ? await repository.getPublishJob(jobId) : null;
    if (!job) {
      return {
        job_id: jobId || null,
        status: 'not_found',
        stage: 'not_found',
        message: 'Job no encontrado',
        error: '',
        result: {},
      };
    }
    return job;
  }

  return {
    pendingApproval,
    approvalTopic,
    approvalQueue,
    scriptDrafts,
    videoProjects,
    searchRefreshStatus,
    publishJob,
  };
}
