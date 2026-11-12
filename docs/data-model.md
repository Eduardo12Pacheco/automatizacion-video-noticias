# Data model

This document is the source of truth for the local Postgres schema. It was
reverse-engineered during T3 (decision D4) from the only surviving evidence:

- `examples/n8n/workflows.json`: HTTP node bodies, upsert payloads and Code
  node field names/status values.
- The panel read-model shapers under `apps/panel/js/modules/features/`.
- The table/RPC inventory captured in the feature document's Context section.
- No Supabase dump, project or credentials exist any more, so the original
  DDL cannot be recovered byte-for-byte. Names and types below are the chosen
  reconstruction; the n8n/panel wire names are preserved wherever the evidence
  gives them (`id_noticia`, `draft_id`, `estado_revision`, ...).

Migrations live in `infra/db/migrations/` and are applied by
`packages/data/scripts/migrate.js`. SQL is deliberately boring: tables,
constraints and indexes only. The former Supabase RPCs are implemented as
repository methods (`packages/data/src/ports/repository-port.js`) and will be
exposed as core use cases in T4, not as stored procedures.

## ER diagram

```mermaid
erDiagram
  roles ||--o{ user_roles : grants
  users ||--o{ user_roles : has
  users ||--o{ sessions : owns

  news_search_runs ||--o{ noticias_staging : stages
  news_search_runs ||--o{ clusters_staging : stages

  clusters ||--o{ noticias_raw : groups
  noticias_raw ||--o| script_jobs : queues
  noticias_raw ||--o| guiones_noticia : drafts
  clusters ||--o{ guiones_noticia : theme
  noticias_raw ||--o{ guiones_noticia : source

  guiones_noticia ||--o| script_publish_jobs : publishes
  guiones_noticia ||--o| video_edit_projects : renders

  roles {
    text role PK
    text description
  }
  users {
    uuid user_id PK
    citext email UK
    text display_name
    text password_hash
    text status
    timestamptz last_login_at
    timestamptz created_at
    timestamptz updated_at
  }
  user_roles {
    uuid user_id PK,FK
    text role PK,FK
  }
  sessions {
    uuid session_id PK
    uuid user_id FK
    text token_hash UK
    timestamptz expires_at
    timestamptz created_at
    timestamptz last_seen_at
    timestamptz revoked_at
    text ip_address
    text user_agent
  }
  news_search_runs {
    text run_id PK
    text requested_window
    text status
    timestamptz requested_at
    timestamptz started_at
    timestamptz finished_at
    jsonb stats
    text error
    timestamptz created_at
    timestamptz updated_at
  }
  noticias_staging {
    text run_id PK,FK
    text id_noticia PK
    jsonb payload
    timestamptz created_at
  }
  clusters_staging {
    text run_id PK,FK
    text cluster_id PK
    jsonb payload
    timestamptz created_at
  }
  clusters {
    text cluster_id PK
    text run_id
    text seleccion
    text jugador
    text tema_principal
    text resumen_cluster
    text tag_editorial
    numeric avg_google_position
    text estado_revision
    timestamptz fecha_creacion_cluster
    timestamptz created_at
    timestamptz updated_at
  }
  noticias_raw {
    text id_noticia PK
    text cluster_id FK
    text seleccion
    text jugador
    text titular
    text fuente
    timestamptz fecha_publicacion
    text link
    text snippet
    text fuente_origen
    text estado_revision
    text approval_action
    timestamptz approval_updated_at
    text tema_principal
    timestamptz fecha_detectada
    integer google_position
    text classification_source
    text football_signals
    boolean pass_direct
    text run_id
    timestamptz created_at
    timestamptz updated_at
  }
  script_jobs {
    text id_noticia PK,FK
    text queue_id UK
    text status
    text stage
    integer percent
    integer attempts
    text last_error
    timestamptz queued_at
    timestamptz started_at
    timestamptz completed_at
    timestamptz updated_at
  }
  guiones_noticia {
    text draft_id PK
    text id_noticia FK
    text cluster_id FK
    text jugador
    text seleccion
    text tema_principal
    text tag_editorial
    text guion_draft
    text guion_editado
    integer guion_word_count
    text estado_guion
    text doc_id
    text doc_url
    timestamptz fecha_borrador
    timestamptz fecha_publicacion
    timestamptz created_at
    timestamptz updated_at
  }
  script_publish_jobs {
    text job_id PK
    text draft_id FK
    text id_noticia FK
    text cluster_id
    text status
    text stage
    text message
    text error
    jsonb result
    timestamptz started_at
    timestamptz finished_at
    timestamptz created_at
    timestamptz updated_at
  }
  video_edit_projects {
    text draft_id PK,FK
    text id_noticia FK
    text cluster_id
    text jugador
    text seleccion
    text tema_principal
    text guion_editado
    text guion_piped
    jsonb segments
    jsonb image_candidates
    jsonb image_search_meta
    jsonb selected_images
    jsonb voice_audio
    jsonb background_audio
    jsonb editor_state
    text status
    timestamptz published_at
    timestamptz disabled_at
    timestamptz created_at
    timestamptz updated_at
  }
```

## Tables

### Users, roles and sessions (S9)

| Table | Purpose |
|---|---|
| `roles` | Seeded `admin`, `editor`, `viewer`. Server-side authorisation reads these rows. |
| `users` | Local accounts. `password_hash` stores an Argon2id/bcrypt hash produced by the API (never a plaintext password). `status` is `active` or `disabled`. |
| `user_roles` | Many-to-many roles; at least one role per user is enforced by the API, not by a trigger. |
| `sessions` | Server-side session store. The browser cookie carries a random token; only its SHA-256 hash is stored in `token_hash`. Expired/revoked rows are deleted by cleanup. |

`email` uses `citext` so login is case-insensitive. UUIDs are generated by
`gen_random_uuid()` (`pgcrypto`), so no client-supplied identifiers are needed.

### Discovery and approval

`news_search_runs` is the state machine for an "Approval Search Refresh" run
(`queued` → `discovery_running` → `discovery_succeeded` → `cluster_running` →
`cluster_succeeded` → `promoting` → `promoted`, with `failed` as terminal).
The n8n edge functions accepted `create_run`, `get_run`, `update_run`,
`reset_staging` and `promote_run`; those actions are repository methods now.

Staged discovery results are stored as JSON payloads in `noticias_staging` and
`clusters_staging`. The original edge functions treated staged data as an
opaque snapshot until `promote_run`; keeping JSONB here avoids duplicating the
large `noticias_raw`/`clusters` column list and keeps SQL simple.

`noticias_raw` is the live approval universe. `estado_revision` is
`pendiente`/`aprobado`/`rechazado`/`publicado`; `approval_action` records the
last decision (`approve`/`reject`). `google_position` and
`classification_source` come from the discovery workflow (`heuristic`/`ai`).

`clusters` groups two or more news rows into an editorial theme. The discovery
workflow computes `avg_google_position`; the panel reads
`cantidad_fuentes`/`sources` from `get_pending_approval_clusters` and
`get_approval_topic_detail`, which the repository assembles by joining
`noticias_raw`.

### Script queue and drafts

`script_jobs` is the write-model behind `get_script_queue_monitor`,
`claim_script_job`, `update_script_job_progress`, `complete_script_job` and
`fail_script_job`. `queue_id` is a stable display id (defaults to
`id_noticia`). A claimed job is removed from the pending queue by setting
`status` to `running`; `complete_script_job` also upserts the draft.

`guiones_noticia` holds generated/edited scripts. `estado_guion` is
`borrador`/`publicado`/`descartado`. `get_pending_script_drafts` returns drafts
that are not published and not dismissed. `save_script_draft` updates
`guion_editado`; `dismiss_script_from_panel` sets `estado_guion='descartado'`.
`get_publishable_script_draft` returns the draft plus source snapshot needed by
the publish workflow. `finalize_script_publish` sets `estado_guion='publicado'`
and the Google-compatible document fields (`doc_id`, `doc_url`,
`fecha_publicacion`).

### Publish jobs

`script_publish_jobs` is the progress record used by the panel's
`Webhook Publish Status` endpoint. Status values seen in n8n are `queued`,
`running`, `completed`, `failed`; stages are `queued`, `saving_script`,
`creating_doc`, `rewriting_pronunciation`, `searching_images`,
`caching_images`, `uploading_txt`, `finalizing`, `completed`, `failed`.
`onlyActive` updates (the n8n PATCH filter) require `status` not in
`(completed, failed)` and `finished_at is null`.

### Video projects

`video_edit_projects` is the read/write model behind all six video-project
RPCs. JSONB columns preserve the exact wire shapes:

- `segments`: `[{id, order, text, phrase, selected_image_id, duration_seconds, notes, source}]`
- `image_candidates`: candidate objects cached/openable by the panel
- `image_search_meta`: provider/query/window/status metadata
- `selected_images`: ordered list of candidate ids/URLs
- `voice_audio` / `background_audio`: `{kind, bucket, storage_path, public_url, name, size, mime_type, ...}`
- `editor_state`: the panel editor snapshot (`phase`, `motion`, `media`, ...)

`disable_video_edit_project` is a soft delete: it sets `disabled_at` and
`status='disabled'`, preserving the project and its media for audit. Reads
exclude disabled projects by default.

## RPC → repository method mapping

| Former Supabase RPC | Repository method |
|---|---|
| `claim_script_job` | `claimScriptJob({ idNoticia })` |
| `update_script_job_progress` | `updateScriptJobProgress({ idNoticia, status, stage, percent, error })` |
| `complete_script_job` | `completeScriptJob({ idNoticia, draftId, guionDraft, guionEditado, wordCount })` |
| `fail_script_job` | `failScriptJob({ idNoticia, error })` |
| `get_script_queue_monitor` | `getScriptQueueMonitor()` |
| `get_pending_script_drafts` | `getPendingScriptDrafts()` |
| `save_script_draft` | `saveScriptDraft({ draftId, idNoticia, clusterId, guionEditado })` |
| `dismiss_script_from_panel` | `dismissScriptFromPanel({ draftId, idNoticia, clusterId })` |
| `get_publishable_script_draft` | `getPublishableScriptDraft({ draftId, idNoticia, clusterId })` |
| `finalize_script_publish` | `finalizeScriptPublish({ ... })` |
| `get_pending_approval_clusters` | `listPendingApprovalClusters()` |
| `get_approval_topic_detail` | `getApprovalTopicDetail(clusterId)` |
| `apply_approval_decision` | `applyApprovalDecision({ idNoticia, clusterId, action })` |
| `get_video_edit_projects` | `getVideoEditProjects({ draftId, limit, includeDetail })` |
| `save_video_project_selections` | `saveVideoProjectSelections({ draftId, selectedImageIds })` |
| `save_video_project_editor_state` | `saveVideoProjectEditorState({ draftId, editorState })` |
| `save_video_project_audio` | `saveVideoProjectAudio({ draftId, voiceAudio, backgroundAudio })` |
| `add_video_project_custom_images` | `addVideoProjectCustomImages({ draftId, customCandidates })` |
| `disable_video_edit_project` | `disableVideoEditProject({ draftId })` |

The edge-function actions (`create_run`, `get_run`, `update_run`,
`reset_staging`, `promote_run`, `upsert_news`, `list_news_for_clustering`,
`persist_clusters`, staging variants) map to the news-search-run and news
repository methods.

## Repository contract conventions

- Adapters return **snake_case records**, matching the existing n8n/panel wire
  contract, so T4 does not need a second naming layer.
- Method arguments are **camelCase** (`draftId`, `idNoticia`) because they are
  called from JavaScript use cases.
- Timestamps are ISO-8601 strings in UTC; JSON/JSONB values are plain objects;
  `numeric` values are JS numbers (or `null`).
- All methods are `async`; missing optional records return `null`/`[]`, never
  `undefined`.
- Both adapters must pass `packages/data/test/repository-contract.test.js`.
  The Postgres run is opt-in via `TEST_DATABASE_URL` (the suite skips
  otherwise); CI uses a throwaway Postgres container.
