import { clone, integerOrDefault, jsonValue, normalizeTimestamps, textOrNull } from './in-memory-shared.js';

/** Video-project read/write methods mixed into InMemoryRepository. */
export const inMemoryVideoProjectMethods = {
    async upsertVideoProject(project = {}) {
      const draftId = textOrNull(project.draft_id ?? project.draftId);
      if (!draftId) throw new Error('draft_id is required');
      const existing = this._videoProjects.get(draftId);
      const now = this._nowIso();
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
      this._videoProjects.set(draftId, row);
      return clone(row);
    },
    async getVideoEditProjects({ draftId = null, limit = 50, includeDetail = true } = {}) {
      if (draftId) {
        const row = this._videoProjects.get(String(draftId));
        if (!row || row.disabled_at) return { ok: true, projects: [] };
        return { ok: true, projects: [this._shapeVideoProject(row, includeDetail)] };
      }
      const max = Math.max(1, integerOrDefault(limit, 50));
      const rows = [...this._videoProjects.values()]
        .filter((row) => !row.disabled_at)
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
        .slice(0, max)
        .map((row) => this._shapeVideoProject(row, includeDetail));
      return { ok: true, projects: rows };
    },

    _shapeVideoProject(row, includeDetail) {
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
    },

    _requireVideoProject(draftId) {
      const row = this._videoProjects.get(String(draftId));
      if (!row || row.disabled_at) throw new Error(`video project not found: ${draftId}`);
      return row;
    },
    async saveVideoProjectSelections({ draftId, selectedImageIds = [] } = {}) {
      const row = this._requireVideoProject(draftId);
      row.selected_images = clone(Array.isArray(selectedImageIds) ? selectedImageIds : []);
      row.updated_at = this._nowIso();
      return { ok: true, draft_id: row.draft_id, selected_images: clone(row.selected_images) };
    },
    async saveVideoProjectEditorState({ draftId, editorState = {} } = {}) {
      const row = this._requireVideoProject(draftId);
      row.editor_state = jsonValue(editorState, {});
      row.updated_at = this._nowIso();
      return { ok: true, draft_id: row.draft_id, editor_state: clone(row.editor_state) };
    },
    async saveVideoProjectAudio({ draftId, voiceAudio = {}, backgroundAudio = {} } = {}) {
      const row = this._requireVideoProject(draftId);
      row.voice_audio = jsonValue(voiceAudio, {});
      row.background_audio = jsonValue(backgroundAudio, {});
      row.updated_at = this._nowIso();
      return {
        ok: true,
        draft_id: row.draft_id,
        voice_audio: clone(row.voice_audio),
        background_audio: clone(row.background_audio),
      };
    },
    async addVideoProjectCustomImages({ draftId, customCandidates = [] } = {}) {
      const row = this._requireVideoProject(draftId);
      const input = Array.isArray(customCandidates) ? customCandidates : [];
      row.image_candidates = [...(row.image_candidates || []), ...clone(input)];
      row.updated_at = this._nowIso();
      return {
        ok: true,
        draft_id: row.draft_id,
        added_count: input.length,
        image_candidates: clone(row.image_candidates),
        selected_images: clone(row.selected_images || []),
      };
    },
    async disableVideoEditProject({ draftId } = {}) {
      const row = this._videoProjects.get(String(draftId));
      if (!row) return { ok: false, draft_id: String(draftId) };
      const now = this._nowIso();
      row.disabled_at = now;
      row.status = 'disabled';
      row.updated_at = now;
      return { ok: true, draft_id: row.draft_id };
    }

    // Users, roles, sessions -------------------------------------------------
};
