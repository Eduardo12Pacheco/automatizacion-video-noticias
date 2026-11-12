import { buildDocTitle, buildPipedScript, buildVideoSegments, wordCount } from '../domain/script.js';
import { ValidationError } from '../errors.js';

/**
 * Shared video-project projection used by publish and manual creation. It is
 * the local equivalent of the n8n "Build Video Edit Project" plus the
 * upsert into `video_edit_projects`.
 */
export class CreateVideoProject {
  constructor({ repository, now = () => new Date() } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
    this.now = now;
  }

  async execute({
    draft = {},
    guionPiped = '',
    imageCandidates = [],
    imageSearchMeta = {},
    status = 'ready',
    segmentSource = 'guion_piped',
  } = {}) {
    const draftId = String(draft.draft_id || '').trim();
    if (!draftId) throw new ValidationError('draft_id is required to create a video project');
    const piped = String(guionPiped || '').trim() || buildPipedScript(draft.guion_editado || draft.guion_draft || '');
    const segments = buildVideoSegments(piped).map((segment) => ({ ...segment, source: segmentSource }));
    return this.repository.upsertVideoProject({
      draft_id: draftId,
      id_noticia: draft.id_noticia || null,
      cluster_id: draft.cluster_id || null,
      jugador: draft.jugador || null,
      seleccion: draft.seleccion || null,
      tema_principal: draft.tema_principal || buildDocTitle(draft, this.now()),
      guion_editado: draft.guion_editado || draft.guion_draft || '',
      guion_piped: piped,
      segments,
      image_candidates: Array.isArray(imageCandidates) ? imageCandidates : [],
      image_search_meta: imageSearchMeta || {},
      status: status || 'ready',
      published_at: draft.fecha_publicacion || null,
    });
  }
}
