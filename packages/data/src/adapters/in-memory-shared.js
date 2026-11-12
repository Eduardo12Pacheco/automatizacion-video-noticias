import { randomUUID } from 'node:crypto';

import { RepositoryPort } from '../ports/repository-port.js';

const SCHEMA_TIMESTAMP_FIELDS = new Set([
  'created_at',
  'updated_at',
  'fecha_publicacion',
  'fecha_detectada',
  'fecha_creacion_cluster',
  'fecha_borrador',
  'approval_updated_at',
  'queued_at',
  'started_at',
  'completed_at',
  'finished_at',
  'requested_at',
  'expires_at',
  'last_seen_at',
  'revoked_at',
  'last_login_at',
  'published_at',
  'disabled_at',
]);

function nowIso(now = () => new Date()) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(value).toISOString();
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrDefault(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function jsonValue(value, fallback) {
  return value === undefined ? fallback : clone(value);
}

function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

function normalizeTimestamps(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = SCHEMA_TIMESTAMP_FIELDS.has(key) ? toIso(value) : value;
  }
  return output;
}

function makeQueueId(idNoticia) {
  return String(idNoticia);
}

export { nowIso, toIso, clone, textOrNull, numberOrNull, integerOrDefault, jsonValue, wordCount, normalizeTimestamps, makeQueueId };
