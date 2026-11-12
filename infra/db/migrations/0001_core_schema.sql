-- 0001_core_schema.sql
-- Local Postgres schema reconstructed during T3 (see docs/data-model.md).
-- RPCs from the former Supabase project are repository methods, not functions.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Users, roles, sessions (S9)
-- ---------------------------------------------------------------------------

create table if not exists roles (
  role text primary key,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists users (
  user_id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  display_name text not null default '',
  password_hash text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_roles (
  user_id uuid not null references users (user_id) on delete cascade,
  role text not null references roles (role) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table if not exists sessions (
  session_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (user_id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip_address text,
  user_agent text
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Discovery runs and staging (ex Edge Functions news-search-api / news-workflow-api)
-- ---------------------------------------------------------------------------

create table if not exists news_search_runs (
  run_id text primary key,
  requested_window text not null default '24h',
  status text not null default 'queued',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists noticias_staging (
  run_id text not null references news_search_runs (run_id) on delete cascade,
  id_noticia text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, id_noticia)
);

create table if not exists clusters_staging (
  run_id text not null references news_search_runs (run_id) on delete cascade,
  cluster_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, cluster_id)
);

-- ---------------------------------------------------------------------------
-- Live approval universe
-- ---------------------------------------------------------------------------

create table if not exists clusters (
  cluster_id text primary key,
  run_id text,
  seleccion text,
  jugador text,
  tema_principal text not null,
  resumen_cluster text,
  tag_editorial text,
  avg_google_position numeric(10, 4),
  estado_revision text not null default 'pendiente'
    check (estado_revision in ('pendiente', 'aprobado', 'rechazado', 'publicado')),
  fecha_creacion_cluster timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clusters_estado_revision_idx on clusters (estado_revision);
create index if not exists clusters_seleccion_jugador_idx on clusters (seleccion, jugador);

create table if not exists noticias_raw (
  id_noticia text primary key,
  cluster_id text references clusters (cluster_id) on delete set null,
  seleccion text,
  jugador text,
  titular text not null,
  fuente text,
  fecha_publicacion timestamptz,
  link text,
  snippet text,
  fuente_origen text,
  estado_revision text not null default 'pendiente'
    check (estado_revision in ('pendiente', 'aprobado', 'rechazado', 'publicado')),
  approval_action text,
  approval_updated_at timestamptz,
  tema_principal text,
  fecha_detectada timestamptz not null default now(),
  google_position integer,
  classification_source text,
  football_signals text,
  pass_direct boolean,
  run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists noticias_raw_cluster_id_idx on noticias_raw (cluster_id);
create index if not exists noticias_raw_estado_revision_idx on noticias_raw (estado_revision);
create index if not exists noticias_raw_fecha_publicacion_idx on noticias_raw (fecha_publicacion desc);
create index if not exists noticias_raw_jugador_idx on noticias_raw (jugador);

-- ---------------------------------------------------------------------------
-- Script queue and drafts
-- ---------------------------------------------------------------------------

create table if not exists script_jobs (
  id_noticia text primary key references noticias_raw (id_noticia) on delete cascade,
  queue_id text not null unique,
  status text not null default 'pendiente',
  stage text not null default 'queued',
  percent integer not null default 0 check (percent between 0 and 100),
  attempts integer not null default 0,
  last_error text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists script_jobs_status_idx on script_jobs (status);
create index if not exists script_jobs_queued_at_idx on script_jobs (queued_at);

create table if not exists guiones_noticia (
  draft_id text primary key,
  id_noticia text references noticias_raw (id_noticia) on delete set null,
  cluster_id text references clusters (cluster_id) on delete set null,
  jugador text,
  seleccion text,
  tema_principal text,
  tag_editorial text,
  guion_draft text,
  guion_editado text,
  guion_word_count integer,
  estado_guion text not null default 'borrador'
    check (estado_guion in ('borrador', 'publicado', 'descartado')),
  doc_id text,
  doc_url text,
  fecha_borrador timestamptz not null default now(),
  fecha_publicacion timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guiones_noticia_estado_guion_idx on guiones_noticia (estado_guion);
create index if not exists guiones_noticia_id_noticia_idx on guiones_noticia (id_noticia);
create index if not exists guiones_noticia_cluster_id_idx on guiones_noticia (cluster_id);

create table if not exists script_publish_jobs (
  job_id text primary key,
  draft_id text,
  id_noticia text,
  cluster_id text,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  stage text not null default 'queued',
  message text not null default '',
  error text not null default '',
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists script_publish_jobs_status_idx on script_publish_jobs (status);
create index if not exists script_publish_jobs_draft_id_idx on script_publish_jobs (draft_id);
create index if not exists script_publish_jobs_created_at_idx on script_publish_jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- Video edit projects
-- ---------------------------------------------------------------------------

create table if not exists video_edit_projects (
  draft_id text primary key,
  id_noticia text references noticias_raw (id_noticia) on delete set null,
  cluster_id text,
  jugador text,
  seleccion text,
  tema_principal text,
  guion_editado text,
  guion_piped text,
  segments jsonb not null default '[]'::jsonb,
  image_candidates jsonb not null default '[]'::jsonb,
  image_search_meta jsonb not null default '{}'::jsonb,
  selected_images jsonb not null default '[]'::jsonb,
  voice_audio jsonb not null default '{}'::jsonb,
  background_audio jsonb not null default '{}'::jsonb,
  editor_state jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  published_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_edit_projects_status_idx on video_edit_projects (status);
create index if not exists video_edit_projects_updated_at_idx on video_edit_projects (updated_at desc);
