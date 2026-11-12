import { NotFoundError, ValidationError } from '../errors.js';

/**
 * Port of "MVP - Approval API - Decision v2 - Supabase". The repository
 * persists the decision and enqueues the script job; the workflow trigger is
 * optional (the local in-process queue may consume the job directly).
 */
export class DecideApproval {
  constructor({ repository, workflowTrigger = null } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
    this.workflowTrigger = workflowTrigger;
  }

  async execute({ id_noticia = '', cluster_id = '', action = '', ...rest } = {}) {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const idNoticia = String(id_noticia || '').trim();
    const clusterId = String(cluster_id || '').trim();
    if (!normalizedAction) throw new ValidationError('Missing required field: action');
    if (!['approve', 'reject'].includes(normalizedAction)) {
      throw new ValidationError('action must be approve or reject');
    }
    if (normalizedAction === 'approve' && (!idNoticia || !clusterId)) {
      throw new ValidationError('Approve requires id_noticia and cluster_id');
    }
    if (!idNoticia && !clusterId) throw new ValidationError('id_noticia is required');

    const result = idNoticia
      ? await this.repository.applyApprovalDecision({ idNoticia, clusterId: clusterId || null, action: normalizedAction })
      : null;
    if (!result) throw new NotFoundError('news item not found');

    const shouldEnqueue = normalizedAction === 'approve';
    if (shouldEnqueue && this.workflowTrigger) {
      await this.workflowTrigger.trigger('script-job-worker', { id_noticia: idNoticia });
    }
    return {
      ok: true,
      enqueued: shouldEnqueue,
      job_id: shouldEnqueue ? idNoticia : null,
      queue_id: shouldEnqueue ? idNoticia : null,
      status: shouldEnqueue ? 'pendiente' : normalizedAction,
      queue_status: shouldEnqueue ? 'pendiente' : normalizedAction,
      cluster_id: clusterId || result.cluster_id || null,
      id_noticia: idNoticia || null,
      should_trigger_generation: shouldEnqueue,
      progress_percent: 0,
      progress_stage: shouldEnqueue ? 'queued' : normalizedAction,
      ...rest,
    };
  }
}
