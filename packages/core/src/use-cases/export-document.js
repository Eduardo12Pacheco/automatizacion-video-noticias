import { buildDocTitle, buildPipedScript } from '../domain/script.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Port of "MVP - Script Download Doc API v1 - Supabase" using the local
 * DocumentExportPort (python-docx/Markdown) instead of Google Drive.
 */
export function createExportDocument({ repository, documentExport } = {}) {
  if (!repository) throw new Error('repository is required');
  if (!documentExport) throw new Error('documentExport is required');
  return {
    async execute(payload = {}) {
      const identity = {
        draftId: String(payload.draft_id ?? payload.draftId ?? '').trim(),
        idNoticia: String(payload.id_noticia ?? payload.idNoticia ?? '').trim(),
        clusterId: String(payload.cluster_id ?? payload.clusterId ?? '').trim(),
      };
      if (!identity.draftId && !identity.idNoticia && !identity.clusterId) {
        throw new ValidationError('debés enviar draft_id o id_noticia o cluster_id');
      }
      const row = await repository.getPublishableScriptDraft(identity);
      if (!row) throw new NotFoundError('borrador no encontrado');
      const docId = String(row.doc_id || '').trim();
      if (!docId) {
        throw new ConflictError('este guion todavía no tiene documento publicado');
      }
      const label = buildDocTitle(row);
      const result = await documentExport.exportDocument({
        docId: docId || null,
        title: label,
        content: row.guion_editado || row.guion_draft || '',
        piped: row.guion_piped || buildPipedScript(row.guion_editado || row.guion_draft || ''),
      });
      if (!result) throw new Error('document export failed');
      return result;
    },
  };
}
