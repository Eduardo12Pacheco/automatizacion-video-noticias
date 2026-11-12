import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { RepositoryPort } from '../ports/repository-port.js';

export const { Pool } = pg;

export const NUMERIC_FIELDS = new Set([
  'avg_google_position',
  'progress_percent',
  'cantidad_fuentes',
  'cantidad_fuentes_total',
  'guion_word_count',
  'percent',
  'attempts',
  'added_count',
  'promoted_news',
  'promoted_clusters',
  'deleted',
]);

export function normalizeRow(row) {
  if (!row) return row;
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      output[key] = Number.isNaN(value.getTime()) ? null : value.toISOString();
    } else if (value != null && typeof value === 'string' && NUMERIC_FIELDS.has(key)) {
      const parsed = Number(value);
      output[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeRows(rows = []) {
  return rows.map(normalizeRow);
}

export function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

export function json(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function buildNewsRow(raw, { runId = null } = {}) {
  return {
    id_noticia: textOrNull(raw.id_noticia),
    cluster_id: textOrNull(raw.cluster_id),
    seleccion: textOrNull(raw.seleccion),
    jugador: textOrNull(raw.jugador),
    titular: textOrNull(raw.titular),
    fuente: textOrNull(raw.fuente),
    fecha_publicacion: raw.fecha_publicacion ?? null,
    link: textOrNull(raw.link),
    snippet: textOrNull(raw.snippet),
    fuente_origen: textOrNull(raw.fuente_origen),
    estado_revision: textOrNull(raw.estado_revision) || 'pendiente',
    approval_action: textOrNull(raw.approval_action),
    approval_updated_at: raw.approval_updated_at ?? null,
    tema_principal: textOrNull(raw.tema_principal),
    fecha_detectada: raw.fecha_detectada ?? new Date(),
    google_position: numberOrNull(raw.google_position),
    classification_source: textOrNull(raw.classification_source),
    football_signals: textOrNull(raw.football_signals),
    pass_direct: raw.pass_direct == null ? null : Boolean(raw.pass_direct),
    run_id: runId ?? textOrNull(raw.run_id),
  };
}

export function buildClusterRow(raw, { runId = null } = {}) {
  return {
    cluster_id: textOrNull(raw.cluster_id),
    run_id: runId ?? textOrNull(raw.run_id),
    seleccion: textOrNull(raw.seleccion),
    jugador: textOrNull(raw.jugador),
    tema_principal: textOrNull(raw.tema_principal) || 'Sin tema',
    resumen_cluster: textOrNull(raw.resumen_cluster),
    tag_editorial: textOrNull(raw.tag_editorial),
    avg_google_position: numberOrNull(raw.avg_google_position),
    estado_revision: textOrNull(raw.estado_revision) || 'pendiente',
    fecha_creacion_cluster: raw.fecha_creacion_cluster ?? new Date(),
  };
}

export async function upsertNewsRow(client, row) {
  const existingResult = await client.query('select * from noticias_raw where id_noticia = $1', [row.id_noticia]);
  const existing = existingResult.rows[0] || {};
  const merged = {
    ...existing,
    ...row,
    cluster_id: row.cluster_id ?? existing.cluster_id ?? null,
    created_at: existing.created_at || new Date(),
  };
  const result = await client.query(
    `insert into noticias_raw (
      id_noticia, cluster_id, seleccion, jugador, titular, fuente, fecha_publicacion,
      link, snippet, fuente_origen, estado_revision, approval_action, approval_updated_at,
      tema_principal, fecha_detectada, google_position, classification_source,
      football_signals, pass_direct, run_id, created_at, updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now()
    )
    on conflict (id_noticia) do update set
      cluster_id = excluded.cluster_id,
      seleccion = excluded.seleccion,
      jugador = excluded.jugador,
      titular = excluded.titular,
      fuente = excluded.fuente,
      fecha_publicacion = excluded.fecha_publicacion,
      link = excluded.link,
      snippet = excluded.snippet,
      fuente_origen = excluded.fuente_origen,
      estado_revision = excluded.estado_revision,
      approval_action = excluded.approval_action,
      approval_updated_at = excluded.approval_updated_at,
      tema_principal = excluded.tema_principal,
      fecha_detectada = excluded.fecha_detectada,
      google_position = excluded.google_position,
      classification_source = excluded.classification_source,
      football_signals = excluded.football_signals,
      pass_direct = excluded.pass_direct,
      run_id = excluded.run_id,
      updated_at = now()
    returning *`,
    [
      merged.id_noticia, merged.cluster_id, merged.seleccion, merged.jugador, merged.titular,
      merged.fuente, merged.fecha_publicacion, merged.link, merged.snippet, merged.fuente_origen,
      merged.estado_revision, merged.approval_action, merged.approval_updated_at,
      merged.tema_principal, merged.fecha_detectada, merged.google_position,
      merged.classification_source, merged.football_signals, merged.pass_direct, merged.run_id,
      merged.created_at,
    ],
  );
  return normalizeRow(result.rows[0]);
}

export async function upsertClusterRow(client, row, sources = []) {
  const result = await client.query(
    `insert into clusters (
      cluster_id, run_id, seleccion, jugador, tema_principal, resumen_cluster, tag_editorial,
      avg_google_position, estado_revision, fecha_creacion_cluster, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
    on conflict (cluster_id) do update set
      run_id = excluded.run_id,
      seleccion = excluded.seleccion,
      jugador = excluded.jugador,
      tema_principal = excluded.tema_principal,
      resumen_cluster = excluded.resumen_cluster,
      tag_editorial = excluded.tag_editorial,
      avg_google_position = excluded.avg_google_position,
      estado_revision = excluded.estado_revision,
      fecha_creacion_cluster = excluded.fecha_creacion_cluster,
      updated_at = now()
    returning *`,
    [
      row.cluster_id, row.run_id, row.seleccion, row.jugador, row.tema_principal,
      row.resumen_cluster, row.tag_editorial, row.avg_google_position, row.estado_revision,
      row.fecha_creacion_cluster,
    ],
  );
  const ids = (Array.isArray(sources) ? sources : [])
    .map((source) => textOrNull(source?.id_noticia))
    .filter(Boolean);
  if (ids.length) {
    await client.query(
      'update noticias_raw set cluster_id = $1, updated_at = now() where id_noticia = any($2::text[])',
      [row.cluster_id, ids],
    );
  }
  return normalizeRow(result.rows[0]);
}

export const JOB_JOIN_SQL = `
  select
    j.id_noticia, j.queue_id, j.status, j.stage, j.percent, j.attempts, j.last_error,
    j.queued_at, j.started_at, j.completed_at, j.updated_at,
    n.link, n.jugador, n.seleccion, n.titular, n.fuente, n.snippet, n.fecha_publicacion,
    n.fecha_detectada, n.fuente_origen, n.cluster_id,
    coalesce(c.tema_principal, n.tema_principal) as tema_principal,
    c.cluster_id as cluster_ref
  from script_jobs j
  left join noticias_raw n on n.id_noticia = j.id_noticia
  left join clusters c on c.cluster_id = n.cluster_id
`;

export function shapeJobRow(row) {
  const normalized = normalizeRow(row);
  return {
    ...normalized,
    cluster_id: normalized.cluster_id ?? normalized.cluster_ref ?? null,
    tema_principal: normalized.tema_principal ?? null,
  };
}

export const DRAFT_JOIN_SQL = `
  select
    g.*, n.titular, n.fuente, n.link, n.fecha_publicacion as fecha_publicacion_noticia,
    coalesce(n.titular, c.tema_principal) as titulo_noticia,
    coalesce(g.tema_principal, c.tema_principal) as tema_principal,
    coalesce(g.jugador, n.jugador, c.jugador) as jugador,
    coalesce(g.seleccion, n.seleccion, c.seleccion) as seleccion,
    coalesce(g.tag_editorial, c.tag_editorial) as tag_editorial,
    c.resumen_cluster
  from guiones_noticia g
  left join noticias_raw n on n.id_noticia = g.id_noticia
  left join clusters c on c.cluster_id = g.cluster_id
`;

