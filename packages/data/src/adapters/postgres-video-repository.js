import { json, normalizeRow, normalizeRows, textOrNull } from './postgres-helpers.js';
import { PostgresScriptRepository } from './postgres-script-repository.js';

export class PostgresVideoRepository extends PostgresScriptRepository {
  // Video projects ---------------------------------------------------------

  async upsertVideoProject(project = {}) {
    const draftId = textOrNull(project.draft_id ?? project.draftId);
    if (!draftId) throw new Error('draft_id is required');
    const existing = (await this._pool.query('select * from video_edit_projects where draft_id = $1', [draftId])).rows[0];
    const row = {
      ...(existing || {}),
      ...project,
      draft_id: draftId,
      segments: project.segments ?? existing?.segments ?? [],
      image_candidates: project.image_candidates ?? existing?.image_candidates ?? [],
      image_search_meta: project.image_search_meta ?? existing?.image_search_meta ?? {},
      selected_images: project.selected_images ?? existing?.selected_images ?? [],
      voice_audio: project.voice_audio ?? existing?.voice_audio ?? {},
      background_audio: project.background_audio ?? existing?.background_audio ?? {},
      editor_state: project.editor_state ?? existing?.editor_state ?? {},
      status: textOrNull(project.status) ?? existing?.status ?? 'pending',
    };
    const result = await this._pool.query(
      `insert into video_edit_projects (
         draft_id, id_noticia, cluster_id, jugador, seleccion, tema_principal,
         guion_editado, guion_piped, segments, image_candidates, image_search_meta,
         selected_images, voice_audio, background_audio, editor_state, status,
         published_at, disabled_at, created_at, updated_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
         $13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,coalesce($19::timestamptz, now()),now()
       )
       on conflict (draft_id) do update set
         id_noticia = excluded.id_noticia,
         cluster_id = excluded.cluster_id,
         jugador = excluded.jugador,
         seleccion = excluded.seleccion,
         tema_principal = excluded.tema_principal,
         guion_editado = excluded.guion_editado,
         guion_piped = excluded.guion_piped,
         segments = excluded.segments,
         image_candidates = excluded.image_candidates,
         image_search_meta = excluded.image_search_meta,
         selected_images = excluded.selected_images,
         voice_audio = excluded.voice_audio,
         background_audio = excluded.background_audio,
         editor_state = excluded.editor_state,
         status = excluded.status,
         published_at = excluded.published_at,
         disabled_at = excluded.disabled_at,
         updated_at = now()
       returning *`,
      [
        draftId, textOrNull(row.id_noticia), textOrNull(row.cluster_id), textOrNull(row.jugador),
        textOrNull(row.seleccion), textOrNull(row.tema_principal), textOrNull(row.guion_editado),
        textOrNull(row.guion_piped), json(row.segments, []), json(row.image_candidates, []),
        json(row.image_search_meta, {}), json(row.selected_images, []), json(row.voice_audio, {}),
        json(row.background_audio, {}), json(row.editor_state, {}), row.status,
        row.published_at ?? null, row.disabled_at ?? null, row.created_at ?? null,
      ],
    );
    return normalizeRow(result.rows[0]);
  }

  async getVideoEditProjects({ draftId = null, limit = 50, includeDetail = true } = {}) {
    const columns = includeDetail
      ? '*'
      : `draft_id, id_noticia, cluster_id, jugador, seleccion, tema_principal, guion_editado,
         guion_piped, status, published_at, disabled_at, created_at, updated_at`;
    if (draftId) {
      const result = await this._pool.query(
        `select ${columns} from video_edit_projects where draft_id = $1 and disabled_at is null`,
        [String(draftId)],
      );
      return { ok: true, projects: normalizeRows(result.rows) };
    }
    const max = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
    const result = await this._pool.query(
      `select ${columns} from video_edit_projects
       where disabled_at is null
       order by updated_at desc, draft_id
       limit $1`,
      [max],
    );
    return { ok: true, projects: normalizeRows(result.rows) };
  }

  async _requireVideoProject(draftId) {
    const result = await this._pool.query(
      'select draft_id from video_edit_projects where draft_id = $1 and disabled_at is null',
      [String(draftId)],
    );
    if (!result.rowCount) throw new Error(`video project not found: ${draftId}`);
  }

  async saveVideoProjectSelections({ draftId, selectedImageIds = [] } = {}) {
    await this._requireVideoProject(draftId);
    const result = await this._pool.query(
      `update video_edit_projects
       set selected_images = $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, selected_images`,
      [String(draftId), json(Array.isArray(selectedImageIds) ? selectedImageIds : [], [])],
    );
    const row = normalizeRow(result.rows[0]);
    return { ok: true, draft_id: row.draft_id, selected_images: row.selected_images };
  }

  async saveVideoProjectEditorState({ draftId, editorState = {} } = {}) {
    await this._requireVideoProject(draftId);
    const result = await this._pool.query(
      `update video_edit_projects
       set editor_state = $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, editor_state`,
      [String(draftId), json(editorState, {})],
    );
    const row = normalizeRow(result.rows[0]);
    return { ok: true, draft_id: row.draft_id, editor_state: row.editor_state };
  }

  async saveVideoProjectAudio({ draftId, voiceAudio = {}, backgroundAudio = {} } = {}) {
    await this._requireVideoProject(draftId);
    const result = await this._pool.query(
      `update video_edit_projects
       set voice_audio = $2::jsonb, background_audio = $3::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, voice_audio, background_audio`,
      [String(draftId), json(voiceAudio, {}), json(backgroundAudio, {})],
    );
    const row = normalizeRow(result.rows[0]);
    return {
      ok: true,
      draft_id: row.draft_id,
      voice_audio: row.voice_audio,
      background_audio: row.background_audio,
    };
  }

  async addVideoProjectCustomImages({ draftId, customCandidates = [] } = {}) {
    await this._requireVideoProject(draftId);
    const input = Array.isArray(customCandidates) ? customCandidates : [];
    const result = await this._pool.query(
      `update video_edit_projects
       set image_candidates = image_candidates || $2::jsonb, updated_at = now()
       where draft_id = $1 returning draft_id, image_candidates, selected_images`,
      [String(draftId), json(input, [])],
    );
    const row = normalizeRow(result.rows[0]);
    return {
      ok: true,
      draft_id: row.draft_id,
      added_count: input.length,
      image_candidates: row.image_candidates,
      selected_images: row.selected_images,
    };
  }

  async disableVideoEditProject({ draftId } = {}) {
    const result = await this._pool.query(
      `update video_edit_projects
       set disabled_at = now(), status = 'disabled', updated_at = now()
       where draft_id = $1 returning draft_id`,
      [String(draftId)],
    );
    return { ok: result.rowCount > 0, draft_id: String(draftId) };
  }

}
