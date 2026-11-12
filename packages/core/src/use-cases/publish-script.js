import { extractModelText } from '../domain/news.js';
import {
  buildDocTitle,
  buildPipedScript,
  buildPronunciationPrompt,
  normalizeImageCandidates,
  wordCount,
} from '../domain/script.js';
import { NotFoundError, ValidationError } from '../errors.js';

function normalizeIdentity(payload = {}) {
  return {
    draftId: String(payload.draft_id ?? payload.draftId ?? '').trim(),
    idNoticia: String(payload.id_noticia ?? payload.idNoticia ?? '').trim(),
    clusterId: String(payload.cluster_id ?? payload.clusterId ?? '').trim(),
  };
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Port of "MVP - Script Draft Publish API v2 - Supabase". `start` creates the
 * queued publish job and returns immediately (like the n8n webhook response);
 * `process` runs the document, pronunciation, image-search and video-project
 * stages, recording progress in `script_publish_jobs`.
 */
export class PublishScript {
  constructor({
    repository,
    createVideoProject,
    llm = null,
    documentExport = null,
    imageSearch = null,
    now = () => new Date(),
    createJobId = () => `pub-${Date.now()}-${randomSuffix()}`,
  } = {}) {
    if (!repository) throw new Error('repository is required');
    if (!createVideoProject) throw new Error('createVideoProject is required');
    this.repository = repository;
    this.createVideoProject = createVideoProject;
    this.llm = llm;
    this.documentExport = documentExport;
    this.imageSearch = imageSearch;
    this.now = now;
    this.createJobId = createJobId;
  }

  async start(payload = {}) {
    const identity = normalizeIdentity(payload);
    if (!identity.draftId && !identity.idNoticia && !identity.clusterId) {
      throw new ValidationError('debés enviar draft_id o id_noticia o cluster_id');
    }
    const draft = await this.repository.getPublishableScriptDraft(identity);
    if (!draft) throw new NotFoundError('borrador no encontrado');
    if (!String(draft.guion_editado || draft.guion_draft || '').trim()) {
      throw new ValidationError('guion vacio; no se puede publicar');
    }
    const jobId = String(payload.job_id || this.createJobId());
    const now = new Date(this.now()).toISOString();
    await this.repository.createPublishJob({
      job_id: jobId,
      draft_id: identity.draftId || draft.draft_id || '',
      id_noticia: identity.idNoticia || draft.id_noticia || '',
      cluster_id: identity.clusterId || draft.cluster_id || '',
      status: 'queued',
      stage: 'queued',
      message: 'Procesamiento en cola',
      error: '',
      result: {},
      started_at: now,
    });
    return { job_id: jobId, status: 'queued', stage: 'queued', message: 'Procesamiento iniciado' };
  }

  async process(jobId) {
    const job = await this.repository.getPublishJob(jobId);
    if (!job) throw new NotFoundError('publish job not found');
    if (['completed', 'failed'].includes(job.status)) {
      return { job_id: job.job_id, status: job.status, job };
    }

    const fail = async (error) => {
      const message = String(error?.message || error || 'Error desconocido').slice(0, 1000);
      const updated = await this.repository.updatePublishJob(jobId, {
        status: 'failed',
        stage: 'failed',
        message: 'La publicación falló',
        error: message,
        result: { error: message },
        finished_at: new Date(this.now()).toISOString(),
      });
      return { job_id: jobId, status: 'failed', error: message, job: updated };
    };

    try {
      const draft = await this.repository.getPublishableScriptDraft({
        draftId: job.draft_id,
        idNoticia: job.id_noticia,
        clusterId: job.cluster_id,
      });
      if (!draft) throw new Error('borrador no encontrado');
      const guionFinal = String(draft.guion_editado || draft.guion_draft || '').trim();
      if (!guionFinal) throw new Error('guion vacio; no se puede publicar');

      const piped = buildPipedScript(guionFinal);
      const docTitle = buildDocTitle(draft, this.now());
      await this.repository.updatePublishJob(jobId, {
        status: 'running',
        stage: 'saving_script',
        message: 'Guardando guion y preparando publicación',
      }, { onlyActive: true });

      let pronunciation = guionFinal;
      if (this.llm) {
        await this.repository.updatePublishJob(jobId, {
          status: 'running',
          stage: 'rewriting_pronunciation',
          message: 'Generando TXT de pronunciación',
        }, { onlyActive: true });
        const response = await this.llm.complete({
          prompt: buildPronunciationPrompt(guionFinal),
          system: 'Devolvé el mismo guion con aproximación fonética para locución en español.',
          temperature: 0.1,
        });
        const rewritten = extractModelText(response).trim();
        if (rewritten) pronunciation = rewritten;
      }

      if (!this.documentExport) throw new Error('document export adapter is not configured');
      await this.repository.updatePublishJob(jobId, {
        status: 'running',
        stage: 'creating_doc',
        message: 'Creando documento',
      }, { onlyActive: true });
      const document = await this.documentExport.createDocument({
        title: docTitle,
        content: guionFinal,
        pronunciation,
        draftId: draft.draft_id,
      });
      if (!document?.doc_id) throw new Error('El documento no fue creado');

      await this.repository.updatePublishJob(jobId, {
        status: 'running',
        stage: 'searching_images',
        message: 'Buscando imágenes recientes',
      }, { onlyActive: true });
      const imageQuery = String(draft.jugador || draft.seleccion || draft.tema_principal || draft.titular || '').trim();
      let candidates = [];
      let imageSearchMeta = { query: imageQuery, status: 'not_configured', fetched_at: new Date(this.now()).toISOString() };
      if (this.imageSearch) {
        try {
          const search = await this.imageSearch.search({ query: imageQuery, limit: 100 });
          candidates = normalizeImageCandidates(search?.images || [], { query: imageQuery });
          imageSearchMeta = {
            ...(search?.meta || {}),
            query: imageQuery,
            result_count: candidates.length,
            fetched_at: new Date(this.now()).toISOString(),
            status: candidates.length ? 'ready' : 'no_candidates',
          };
        } catch (error) {
          imageSearchMeta = {
            query: imageQuery,
            status: 'image_search_error',
            error: String(error?.message || error).slice(0, 500),
            fetched_at: new Date(this.now()).toISOString(),
          };
        }
      }

      await this.repository.updatePublishJob(jobId, {
        status: 'running',
        stage: 'finalizing',
        message: 'Guardando resultado final',
      }, { onlyActive: true });
      await this.createVideoProject.execute({
        draft,
        guionPiped: piped,
        imageCandidates: candidates,
        imageSearchMeta,
        status: imageSearchMeta.status === 'image_search_error' ? 'image_search_error' : (candidates.length ? 'ready' : 'no_candidates'),
      });
      await this.repository.finalizeScriptPublish({
        draftId: draft.draft_id,
        idNoticia: draft.id_noticia,
        clusterId: draft.cluster_id,
        docId: document.doc_id,
        docUrl: document.doc_url || '',
        guionEditado: guionFinal,
        guionPiped: piped,
        guionPronunciacion: pronunciation,
        imageCandidates: candidates,
        imageSearchMeta,
        videoProjectStatus: candidates.length ? 'ready' : 'no_candidates',
      });

      const finishedAt = new Date(this.now()).toISOString();
      const result = {
        doc_id: document.doc_id,
        doc_url: document.doc_url || '',
        guion_piped: piped,
        guion_word_count: wordCount(guionFinal),
        image_candidate_count: candidates.length,
        image_search_meta: imageSearchMeta,
      };
      const updated = await this.repository.updatePublishJob(jobId, {
        status: 'completed',
        stage: 'completed',
        message: 'Publicación completada',
        result,
        finished_at: finishedAt,
      });
      return { job_id: jobId, status: 'completed', ...result, job: updated };
    } catch (error) {
      return fail(error);
    }
  }
}
