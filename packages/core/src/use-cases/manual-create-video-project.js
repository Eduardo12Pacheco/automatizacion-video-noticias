import { buildPipedScript, buildVideoSegments, normalizeImageCandidates } from '../domain/script.js';
import { NotFoundError, ValidationError } from '../errors.js';

function clean(value) {
  return String(value ?? '').trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'manual';
}

/**
 * Port of "MVP - Manual Video Project Create API v1 - Supabase": create a
 * manual news row, script draft and pending video project, then resolve the
 * image candidates asynchronously.
 */
export class ManualCreateVideoProject {
  constructor({
    repository,
    imageSearch = null,
    now = () => new Date(),
    createJobId = () => `manual-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
    this.imageSearch = imageSearch;
    this.now = now;
    this.createJobId = createJobId;
  }

  async start(payload = {}) {
    const title = clean(payload.title || payload.titulo || payload.tema_principal || payload.topic);
    const player = clean(payload.jugador || payload.player);
    const country = clean(payload.seleccion || payload.country);
    const rawScript = clean(payload.guion_piped || payload.guionPiped || payload.script || payload.guion);
    if (!title) throw new ValidationError('title is required');
    if (!player) throw new ValidationError('jugador is required');
    if (!country) throw new ValidationError('seleccion is required');
    if (!rawScript) throw new ValidationError('guion_piped is required');

    const now = new Date(this.now()).toISOString();
    const day = now.slice(0, 10);
    const suffix = Math.random().toString(36).slice(2, 8);
    const draftId = clean(payload.draft_id) || `manual-${slug(player)}-${slug(title)}-${day}-${suffix}`;
    const idNoticia = clean(payload.id_noticia) || `manual-news-${slug(player)}-${day}-${suffix}`;
    const clusterId = clean(payload.cluster_id) || `manual-cluster-${slug(player)}-${day}-${suffix}`;
    const jobId = String(payload.job_id || this.createJobId());
    const piped = rawScript.includes('|') ? rawScript : buildPipedScript(rawScript);
    const blocks = piped.split('|').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const guionText = blocks.join('\n\n');
    const segments = buildVideoSegments(piped).map((segment) => ({ ...segment, phrase: segment.text, source: 'manual_guion_piped' }));

    // noticias_raw.cluster_id is a foreign key in Postgres; create the manual
    // cluster before the news row so the same payload works on both adapters.
    await this.repository.persistClusters([{
      cluster_id: clusterId,
      seleccion: country,
      jugador: player,
      tema_principal: title,
      resumen_cluster: null,
      tag_editorial: 'otros',
      estado_revision: 'aprobado',
      fecha_creacion_cluster: now,
      sources: [],
    }]);
    await this.repository.upsertNews([{
      id_noticia: idNoticia,
      cluster_id: clusterId,
      seleccion: country,
      jugador: player,
      titular: title,
      fuente: 'Manual',
      fecha_publicacion: now,
      link: clean(payload.link) || null,
      snippet: clean(payload.snippet) || null,
      fuente_origen: 'manual',
      estado_revision: 'aprobado',
      tema_principal: title,
      classification_source: 'manual',
      pass_direct: true,
    }]);
    await this.repository.saveScriptDraft({
      draftId,
      idNoticia,
      clusterId,
      guionDraft: guionText,
      guionEditado: guionText,
    });
    await this.repository.upsertVideoProject({
      draft_id: draftId,
      id_noticia: idNoticia,
      cluster_id: clusterId,
      jugador: player,
      seleccion: country,
      tema_principal: title,
      guion_editado: guionText,
      guion_piped: piped,
      segments,
      image_candidates: [],
      image_search_meta: {
        provider: 'image-search',
        query: player,
        player,
        country,
        topic: title,
        origin: 'manual',
        status: 'searching_images',
        requested_at: now,
      },
      status: 'pending',
    });
    await this.repository.createPublishJob({
      job_id: jobId,
      draft_id: draftId,
      id_noticia: idNoticia,
      cluster_id: clusterId,
      status: 'queued',
      stage: 'queued',
      message: 'Creando proyecto manual',
      error: '',
      result: {},
      started_at: now,
    });

    return {
      job_id: jobId,
      draft_id: draftId,
      id_noticia: idNoticia,
      cluster_id: clusterId,
      status: 'queued',
      stage: 'queued',
      message: 'Proyecto manual iniciado',
    };
  }

  async process(jobId) {
    const job = await this.repository.getPublishJob(jobId);
    if (!job) throw new NotFoundError('publish job not found');
    if (['completed', 'failed'].includes(job.status)) {
      return { job_id: jobId, status: job.status, job };
    }
    try {
      const draft = await this.repository.getPublishableScriptDraft({
        draftId: job.draft_id,
        idNoticia: job.id_noticia,
        clusterId: job.cluster_id,
      });
      if (!draft) throw new Error('manual draft not found');
      const query = String(draft.jugador || draft.seleccion || draft.tema_principal || '').trim();
      let candidates = [];
      let meta = {
        provider: 'image-search',
        query,
        origin: 'manual',
        status: 'not_configured',
        fetched_at: new Date(this.now()).toISOString(),
      };
      if (this.imageSearch) {
        await this.repository.updatePublishJob(jobId, {
          status: 'running',
          stage: 'searching_images',
          message: 'Buscando imágenes',
        }, { onlyActive: true });
        try {
          const search = await this.imageSearch.search({ query, limit: 100 });
          candidates = normalizeImageCandidates(search?.images || [], { query });
          meta = {
            ...(search?.meta || {}),
            provider: 'image-search',
            query,
            origin: 'manual',
            result_count: candidates.length,
            status: candidates.length ? 'ready' : 'no_candidates',
            fetched_at: new Date(this.now()).toISOString(),
          };
        } catch (error) {
          meta = {
            ...meta,
            status: 'image_search_error',
            error: String(error?.message || error).slice(0, 500),
          };
        }
      }
      await this.repository.upsertVideoProject({
        draft_id: draft.draft_id,
        id_noticia: draft.id_noticia,
        cluster_id: draft.cluster_id,
        jugador: draft.jugador,
        seleccion: draft.seleccion,
        tema_principal: draft.tema_principal,
        guion_editado: draft.guion_editado,
        guion_piped: draft.guion_piped || buildPipedScript(draft.guion_editado || ''),
        segments: draft.segments || buildVideoSegments(draft.guion_piped || ''),
        image_candidates: candidates,
        image_search_meta: meta,
        status: meta.status === 'image_search_error' ? 'image_search_error' : (candidates.length ? 'ready' : 'no_candidates'),
      });
      const updated = await this.repository.updatePublishJob(jobId, {
        status: 'completed',
        stage: 'completed',
        message: 'Proyecto manual completado',
        result: { image_candidate_count: candidates.length, image_search_meta: meta },
        finished_at: new Date(this.now()).toISOString(),
      });
      return { job_id: jobId, status: 'completed', image_candidate_count: candidates.length, job: updated };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      const updated = await this.repository.updatePublishJob(jobId, {
        status: 'failed',
        stage: 'failed',
        message: 'El proyecto manual falló',
        error: message,
        finished_at: new Date(this.now()).toISOString(),
      });
      return { job_id: jobId, status: 'failed', error: message, job: updated };
    }
  }
}
