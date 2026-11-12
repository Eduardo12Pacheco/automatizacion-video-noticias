import { ValidationError } from '../errors.js';

const DISMISS_ACTIONS = new Set(['dismiss', 'dismiss_processed']);

/**
 * Port of the "Script Draft Save" n8n webhook. The editor either persists the
 * edited script or dismisses the draft from the pending panel; both paths share
 * the same identity resolution so a malformed request fails before touching a
 * draft.
 */
export class SaveScriptDraft {
  constructor({ repository } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
  }

  async execute({ action = 'save', draftId = '', idNoticia = '', clusterId = '', guionEditado = '' } = {}) {
    const ids = {
      draftId: String(draftId || '').trim(),
      idNoticia: String(idNoticia || '').trim(),
      clusterId: String(clusterId || '').trim(),
    };
    if (!ids.draftId && !ids.idNoticia) {
      throw new ValidationError('draft_id or id_noticia is required');
    }
    const normalizedAction = String(action || 'save').trim().toLowerCase();
    if (DISMISS_ACTIONS.has(normalizedAction)) {
      const result = await this.repository.dismissScriptFromPanel(ids);
      return { ok: true, dismissed: true, ...result };
    }
    if (normalizedAction !== 'save') {
      throw new ValidationError(`unknown action: ${normalizedAction}`);
    }
    const draft = await this.repository.saveScriptDraft({
      ...ids,
      guionEditado: String(guionEditado ?? ''),
    });
    return { ok: true, draft };
  }
}
