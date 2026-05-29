import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_EVENT_RETENTION = Object.freeze({
  max_events: 1_000,
  max_age_days: 14,
  max_bytes: 5 * 1024 * 1024,
});

const SAFE_CONTEXT_HEADER_NAMES = new Set([
  'accept',
  'content-type',
  'origin',
  'referer',
  'user-agent',
  'x-correlation-id',
  'x-request-id',
]);

const SENSITIVE_KEY_PATTERN = /(^|[_-])(authorization|auth|cookie|set-cookie|token|secret|password|passwd|pass|api[_-]?key|approval[_-]?secret|body|payload)([_-]|$)/i;
const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  maxStringLength: 256,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxDepth: 5,
});

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeRetention(retention = {}) {
  const merged = { ...DEFAULT_EVENT_RETENTION, ...(retention || {}) };
  return {
    max_events: Number.isSafeInteger(merged.max_events) && merged.max_events > 0 ? merged.max_events : DEFAULT_EVENT_RETENTION.max_events,
    max_age_days: Number.isFinite(merged.max_age_days) && merged.max_age_days > 0 ? merged.max_age_days : DEFAULT_EVENT_RETENTION.max_age_days,
    max_bytes: Number.isSafeInteger(merged.max_bytes) && merged.max_bytes > 0 ? merged.max_bytes : DEFAULT_EVENT_RETENTION.max_bytes,
  };
}

function redactionMeta(redactedFields, truncatedFields) {
  if (!redactedFields.length && !truncatedFields.length) return {};
  return { __redaction: { redacted_fields: redactedFields, truncated_fields: truncatedFields } };
}

function sanitizeValue(value, path, limits, redactedFields, truncatedFields, depth) {
  const fieldName = path[path.length - 1] || '';
  const pathName = path.join('.');
  if (SENSITIVE_KEY_PATTERN.test(fieldName)) {
    redactedFields.push(pathName);
    return '<redacted>';
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) {
      truncatedFields.push(pathName);
      return `${value.slice(0, limits.maxStringLength)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const sliced = value.slice(0, limits.maxArrayItems);
    if (value.length > limits.maxArrayItems) truncatedFields.push(pathName);
    return sliced.map((item, index) => sanitizeValue(item, [...path, String(index)], limits, redactedFields, truncatedFields, depth + 1));
  }
  if (!isPlainObject(value)) return String(value);
  if (depth >= limits.maxDepth) {
    truncatedFields.push(pathName);
    return '<truncated>';
  }
  const entries = Object.entries(value).slice(0, limits.maxObjectKeys);
  if (Object.keys(value).length > limits.maxObjectKeys) truncatedFields.push(pathName);
  const sanitized = {};
  for (const [key, nestedValue] of entries) {
    sanitized[key] = sanitizeValue(nestedValue, [...path, key], limits, redactedFields, truncatedFields, depth + 1);
  }
  return sanitized;
}

function sanitizeHeaders(headers = {}, limits, redactedFields) {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lowerName = name.toLowerCase();
    if (SENSITIVE_KEY_PATTERN.test(lowerName)) {
      redactedFields.push(`headers.${lowerName}`);
      sanitized[lowerName] = '<redacted>';
    } else if (SAFE_CONTEXT_HEADER_NAMES.has(lowerName)) {
      sanitized[lowerName] = typeof value === 'string' && value.length > limits.maxStringLength
        ? `${value.slice(0, limits.maxStringLength)}…`
        : value;
    }
  }
  return sanitized;
}

export function sanitizeEventContext(context = {}, options = {}) {
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...(options || {}) };
  const redactedFields = [];
  const truncatedFields = [];
  const source = isPlainObject(context) ? context : { value: context };
  const sanitized = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === 'headers' && isPlainObject(value)) {
      sanitized.headers = sanitizeHeaders(value, limits, redactedFields);
      continue;
    }
    sanitized[key] = sanitizeValue(value, [key], limits, redactedFields, truncatedFields, 0);
  }
  return { ...sanitized, ...redactionMeta(redactedFields, truncatedFields) };
}

function normalizeActor(actor = {}) {
  if (!isPlainObject(actor)) return null;
  const normalized = {
    ...(actor.user_id || actor.id ? { user_id: String(actor.user_id || actor.id) } : {}),
    ...(actor.email ? { email: String(actor.email) } : {}),
    ...(actor.display_name || actor.name ? { display_name: String(actor.display_name || actor.name) } : {}),
    ...(Array.isArray(actor.roles) ? { roles: actor.roles.map((role) => String(role)) } : {}),
  };
  return Object.keys(normalized).length ? normalized : null;
}

function withDefinedValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== ''));
}

export function isSafeCorrelationId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function selectCorrelationId(req = {}, { createId = randomUUID } = {}) {
  const headers = req.headers || {};
  for (const name of ['x-correlation-id', 'x-request-id']) {
    const value = Array.isArray(headers[name]) ? headers[name][0] : headers[name];
    if (isSafeCorrelationId(value)) return value;
  }
  return createId();
}

export function normalizeGatewayEvent(event = {}, { now = () => new Date(), createEventId = randomUUID } = {}) {
  const timestampSource = event.timestamp || now();
  const timestamp = timestampSource instanceof Date
    ? timestampSource.toISOString()
    : new Date(timestampSource).toISOString();
  const kind = event.kind === 'audit' ? 'audit' : 'error';
  return withDefinedValues({
    event_id: event.event_id || createEventId(),
    timestamp,
    kind,
    severity: event.severity || (kind === 'error' ? 'error' : 'info'),
    correlation_id: isSafeCorrelationId(event.correlation_id) ? event.correlation_id : createEventId(),
    actor: normalizeActor(event.actor),
    session_id: event.session_id ? String(event.session_id) : undefined,
    origin: event.origin ? String(event.origin) : undefined,
    ip: event.ip ? String(event.ip) : undefined,
    method: event.method ? String(event.method).toUpperCase() : undefined,
    path: event.path ? String(event.path) : undefined,
    route_service: event.route_service || event.service ? String(event.route_service || event.service) : undefined,
    action: event.action ? String(event.action) : undefined,
    outcome: event.outcome ? String(event.outcome) : undefined,
    status_code: Number.isSafeInteger(event.status_code) ? event.status_code : undefined,
    reason_code: event.reason_code ? String(event.reason_code) : undefined,
    safe_message: event.safe_message ? String(event.safe_message) : undefined,
    likely_cause: event.likely_cause ? String(event.likely_cause) : undefined,
    context: sanitizeEventContext(event.context || {}),
  });
}

function parseJsonl(content) {
  const events = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch {
      // Malformed historical lines must not break the read model.
    }
  }
  return events;
}

function eventTimestampMs(event) {
  const parsed = Date.parse(String(event.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function actorText(event) {
  const actor = event.actor || {};
  return [actor.user_id, actor.email, actor.display_name, ...(Array.isArray(actor.roles) ? actor.roles : [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function statusMatches(event, status) {
  if (status == null || status === '') return true;
  const expected = String(status).toLowerCase();
  return String(event.status_code ?? '').toLowerCase() === expected || String(event.outcome || '').toLowerCase() === expected;
}

function filterEvents(events, filters = {}, retention, nowMs) {
  const cutoff = nowMs - retention.max_age_days * 24 * 60 * 60 * 1000;
  const fromMs = filters.from ? Date.parse(String(filters.from)) : Number.NEGATIVE_INFINITY;
  const toMs = filters.to ? Date.parse(String(filters.to)) : Number.POSITIVE_INFINITY;
  return events
    .filter((event) => eventTimestampMs(event) >= cutoff)
    .filter((event) => !filters.kind || event.kind === filters.kind)
    .filter((event) => statusMatches(event, filters.status))
    .filter((event) => !filters.service || event.route_service === filters.service || event.service === filters.service)
    .filter((event) => !filters.correlation_id || event.correlation_id === filters.correlation_id)
    .filter((event) => !filters.actor || actorText(event).includes(String(filters.actor).toLowerCase()))
    .filter((event) => {
      const ts = eventTimestampMs(event);
      return ts >= (Number.isFinite(fromMs) ? fromMs : Number.NEGATIVE_INFINITY)
        && ts <= (Number.isFinite(toMs) ? toMs : Number.POSITIVE_INFINITY);
    })
    .sort((left, right) => eventTimestampMs(right) - eventTimestampMs(left));
}

export class JsonlEventRecorder {
  constructor({ filePath, retention = DEFAULT_EVENT_RETENTION, now = Date.now, createEventId = randomUUID, logger = console } = {}) {
    if (!filePath) throw new Error('JsonlEventRecorder requires filePath');
    this.filePath = filePath;
    this.retention = normalizeRetention(retention);
    this.now = now;
    this.createEventId = createEventId;
    this.logger = logger;
  }

  retentionSummary() {
    return {
      max_events: this.retention.max_events,
      max_age_days: this.retention.max_age_days,
    };
  }

  nowDate() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  async readEvents() {
    try {
      return parseJsonl(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async record(event) {
    const normalized = normalizeGatewayEvent(event, { now: () => this.nowDate(), createEventId: this.createEventId });
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const existing = await this.readEvents();
      const retained = filterEvents([...existing, normalized], {}, this.retention, this.nowDate().getTime()).slice(0, this.retention.max_events);
      await writeFile(this.filePath, `${retained.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
      await this.enforceByteLimit();
    } catch (error) {
      this.logger.warn?.('gateway event record failed', sanitizeEventContext({
        error: error?.message || 'record_failed',
        event: {
          event_id: normalized.event_id,
          kind: normalized.kind,
          correlation_id: normalized.correlation_id,
          reason_code: normalized.reason_code,
          context: normalized.context,
        },
      }));
    }
  }

  async enforceByteLimit() {
    const stats = await stat(this.filePath).catch(() => null);
    if (!stats || stats.size <= this.retention.max_bytes) return;
    const retained = (await this.readEvents()).slice(0, this.retention.max_events);
    let next = retained;
    while (next.length > 1 && Buffer.byteLength(`${next.map((event) => JSON.stringify(event)).join('\n')}\n`) > this.retention.max_bytes) {
      next = next.slice(0, -1);
    }
    await writeFile(this.filePath, `${next.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  }

  async query(filters = {}) {
    const limit = Number.isSafeInteger(Number(filters.limit)) && Number(filters.limit) > 0
      ? Math.min(Number(filters.limit), this.retention.max_events)
      : this.retention.max_events;
    const events = filterEvents(await this.readEvents(), filters, this.retention, this.nowDate().getTime()).slice(0, limit);
    return {
      events,
      next_cursor: null,
      retention: this.retentionSummary(),
    };
  }
}
