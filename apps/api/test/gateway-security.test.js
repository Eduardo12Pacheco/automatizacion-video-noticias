import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { InMemoryRepository } from '@newsroom/data';
import { createAuthService } from '../src/auth.js';
import { BoundedTtlStore, createGatewayServer, readServiceCredentialsFromEnv, DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS, DEFAULT_RENDER_UPSTREAM_TIMEOUT_MS, DEFAULT_SUBTITLES_UPLOAD_MAX_BODY_BYTES, resolveRoute, resolveRoutePolicy } from '../src/gateway.js';
import {
  DEFAULT_EVENT_RETENTION,
  JsonlEventRecorder,
  normalizeGatewayEvent,
  sanitizeEventContext,
  selectCorrelationId,
} from '../src/gateway-events.js';

const servers = [];

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function createUpstream({ status = 200, body = 'ok' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, {
        'content-type': 'text/plain',
        'authorization': 'upstream-secret',
        'access-control-allow-origin': 'https://upstream.invalid',
      });
      res.end(body);
    });
  });
  const port = await listen(server);
  return { requests, target: `http://127.0.0.1:${port}` };
}

async function createGateway(options = {}) {
  const server = createGatewayServer({
    logger: { error() {}, warn() {}, info() {} },
    ...options,
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

function sessionCookie(token = 'valid-token') {
  return `approval-panel-session-v1=${encodeURIComponent(token)}`;
}

function panelSession({ roles = ['editor'], expires_at = Date.now() + 60_000 } = {}) {
  return {
    user: {
      user_id: 'user-1',
      email: 'user@example.com',
      display_name: 'User One',
    },
    roles,
    session_id: 'session-1',
    expires_at,
  };
}

async function createRepositoryAuth(users) {
  const repository = new InMemoryRepository();
  await repository.migrate();
  const authService = createAuthService({ repository, rounds: 4 });
  const created = {};
  for (const [key, spec] of Object.entries(users)) {
    created[key] = await authService.createUser(spec);
  }
  return { authService, users: created };
}

function createRecordingEventRecorder({ queryResult = null, queryError = null } = {}) {
  const events = [];
  const queries = [];
  return {
    events,
    queries,
    async record(event) {
      events.push(event);
    },
    async query(filters) {
      queries.push(filters);
      if (queryError) throw queryError;
      return queryResult || { events, next_cursor: null, retention: { max_events: 1000, max_age_days: 14 } };
    },
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function tempEventFile() {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-events-'));
  return join(dir, 'events.jsonl');
}

// === WU1 RED tests — event schema, sanitization, correlation, JSONL recorder ===

test('gateway event normalization applies schema defaults and default-deny context sanitization', () => {
  const event = normalizeGatewayEvent({
    kind: 'error',
    severity: 'critical',
    correlation_id: 'safe-correlation-1',
    actor: { user_id: 'user-1', email: 'user@example.com', roles: ['editor'] },
    session_id: 'session-1',
    origin: 'https://panel.example',
    ip: '127.0.0.1',
    method: 'POST',
    path: '/workflow/webhook/data',
    route_service: 'workflow',
    action: 'proxy.request',
    outcome: 'failed',
    status_code: 502,
    reason_code: 'upstream_unavailable',
    safe_message: 'Upstream unavailable',
    likely_cause: 'service_offline',
    context: {
      headers: { authorization: 'Bearer super-secret-token', 'x-api-key': 'api-secret', accept: 'application/json' },
      request_id: 'request-1',
      password: 'p@ssw0rd',
      nested: { approval_secret: 'approval-secret', harmless: 'keep-me' },
      body: { token: 'body-token', name: 'unsafe full payload' },
    },
  }, {
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    createEventId: () => 'event-1',
  });

  assert.equal(event.event_id, 'event-1');
  assert.equal(event.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(event.kind, 'error');
  assert.equal(event.severity, 'critical');
  assert.deepEqual(event.actor, { user_id: 'user-1', email: 'user@example.com', roles: ['editor'] });
  assert.equal(event.context.headers.accept, 'application/json');
  assert.equal(event.context.headers.authorization, '<redacted>');
  assert.equal(event.context.headers['x-api-key'], '<redacted>');
  assert.equal(event.context.password, '<redacted>');
  assert.equal(event.context.nested.approval_secret, '<redacted>');
  assert.equal(event.context.nested.harmless, 'keep-me');
  assert.equal(event.context.body, '<redacted>');
  assert.deepEqual(event.context.__redaction, {
    redacted_fields: ['headers.authorization', 'headers.x-api-key', 'password', 'nested.approval_secret', 'body'],
    truncated_fields: [],
  });
});

test('context sanitizer truncates oversized strings and nested collections with metadata', () => {
  const context = sanitizeEventContext({
    safe_message: 'x'.repeat(80),
    nested: { list: ['one', 'two', 'three'] },
  }, { maxStringLength: 12, maxArrayItems: 2, maxDepth: 3 });

  assert.equal(context.safe_message, 'xxxxxxxxxxxx…');
  assert.deepEqual(context.nested.list, ['one', 'two']);
  assert.deepEqual(context.__redaction, {
    redacted_fields: [],
    truncated_fields: ['safe_message', 'nested.list'],
  });
});

test('correlation ID selection accepts only short safe header tokens and generates fallbacks', () => {
  assert.equal(selectCorrelationId({ headers: { 'x-correlation-id': 'trace_ABC-123.9' } }), 'trace_ABC-123.9');
  assert.equal(selectCorrelationId({ headers: { 'x-request-id': 'request-42' } }), 'request-42');
  assert.equal(selectCorrelationId({ headers: { 'x-correlation-id': 'bad token' } }, { createId: () => 'generated-1' }), 'generated-1');
  assert.equal(selectCorrelationId({ headers: { 'x-correlation-id': 'x'.repeat(129) } }, { createId: () => 'generated-2' }), 'generated-2');
});

test('JsonlEventRecorder appends sanitized events and queries by kind, status, actor, service, date, and correlation', async () => {
  const filePath = await tempEventFile();
  const recorder = new JsonlEventRecorder({
    filePath,
    retention: { max_events: 10, max_age_days: 30, max_bytes: 1024 * 1024 },
    now: () => Date.parse('2026-01-10T00:00:00.000Z'),
    createEventId: () => 'event-created',
  });

  await recorder.record({
    event_id: 'audit-1',
    timestamp: '2026-01-09T12:00:00.000Z',
    kind: 'audit',
    correlation_id: 'corr-1',
    actor: { user_id: 'user-1', email: 'user@example.com' },
    route_service: 'workflow',
    action: 'login',
    outcome: 'success',
    status_code: 200,
    context: { password: 'raw-password', request_id: 'request-1' },
  });
  await recorder.record({
    event_id: 'error-1',
    timestamp: '2026-01-10T00:00:00.000Z',
    kind: 'error',
    correlation_id: 'corr-2',
    actor: { user_id: 'user-2', email: 'other@example.com' },
    route_service: 'tts',
    outcome: 'failed',
    status_code: 502,
    reason_code: 'upstream_unavailable',
    context: { token: 'raw-token', request_id: 'request-2' },
  });

  const auditByActor = await recorder.query({ kind: 'audit', actor: 'user@example.com', service: 'workflow', status: 'success', from: '2026-01-09T00:00:00.000Z', to: '2026-01-09T23:59:59.999Z' });
  assert.equal(auditByActor.events.length, 1);
  assert.equal(auditByActor.events[0].event_id, 'audit-1');
  assert.equal(auditByActor.events[0].context.password, '<redacted>');

  const errorByCorrelation = await recorder.query({ kind: 'error', correlation_id: 'corr-2', status: '502' });
  assert.equal(errorByCorrelation.events.length, 1);
  assert.equal(errorByCorrelation.events[0].event_id, 'error-1');
  assert.equal(errorByCorrelation.events[0].context.token, '<redacted>');
  assert.deepEqual(errorByCorrelation.retention, { max_events: 10, max_age_days: 30 });
});

test('JsonlEventRecorder excludes events outside retention and tolerates malformed JSONL lines', async () => {
  const filePath = await tempEventFile();
  const recorder = new JsonlEventRecorder({
    filePath,
    retention: { max_events: 2, max_age_days: 1, max_bytes: 1024 * 1024 },
    now: () => Date.parse('2026-01-10T00:00:00.000Z'),
  });

  await writeFile(filePath, [
    '{"event_id":"old","timestamp":"2026-01-01T00:00:00.000Z","kind":"audit","correlation_id":"old"}',
    'not-json',
    '{"event_id":"recent-1","timestamp":"2026-01-09T12:00:00.000Z","kind":"audit","correlation_id":"recent-1"}',
    '{"event_id":"recent-2","timestamp":"2026-01-09T13:00:00.000Z","kind":"error","correlation_id":"recent-2","status_code":500}',
    '{"event_id":"recent-3","timestamp":"2026-01-09T14:00:00.000Z","kind":"audit","correlation_id":"recent-3"}',
  ].join('\n'));

  const result = await recorder.query({});
  assert.deepEqual(result.events.map((event) => event.event_id), ['recent-3', 'recent-2']);
  assert.equal(result.next_cursor, null);
});

test('JsonlEventRecorder write failure emits only sanitized fallback warning data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-events-fail-'));
  await mkdir(join(dir, 'events.jsonl'));
  const warnings = [];
  const recorder = new JsonlEventRecorder({
    filePath: join(dir, 'events.jsonl'),
    logger: { warn(message, data) { warnings.push({ message, data }); } },
  });

  await recorder.record({
    kind: 'error',
    correlation_id: 'corr-secret-test',
    reason_code: 'write_failed',
    context: { authorization: 'Bearer raw-secret', api_key: 'raw-api-key', safe: 'keep-me' },
  });

  assert.equal(warnings.length, 1);
  const warningJson = JSON.stringify(warnings[0]);
  assert.match(warnings[0].message, /gateway event record failed/);
  assert.equal(warningJson.includes('raw-secret'), false);
  assert.equal(warningJson.includes('raw-api-key'), false);
  assert.equal(warningJson.includes('corr-secret-test'), true);
});

async function fetchWithTransientRetry(url, init = {}, { attempts = 3, retryDelayMs = 10, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      const canRetry = error instanceof TypeError && attempt < attempts;
      if (!canRetry) throw error;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

test('fetchWithTransientRetry retries transient fetch failures without masking HTTP assertions', async () => {
  const attempts = [];
  const response = await fetchWithTransientRetry('http://127.0.0.1:1/ready', {}, {
    attempts: 2,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      attempts.push(url);
      if (attempts.length === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ status: 'not_ready' }), { status: 503 });
    },
  });

  assert.equal(response.status, 503);
  assert.equal(attempts.length, 2);
});

test('unauthenticated external GET/HEAD routes are rejected before upstream proxying', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: {
      workflow: { prefix: '/workflow', target: upstream.target },
      remotion: { prefix: '/remotion', target: upstream.target },
    },
    serviceCredentials: {
      workflow: { 'x-api-key': 'workflow-secret' },
      remotion: { authorization: 'Bearer remotion-secret' },
    },
  });

  for (const [method, path] of [['GET', '/workflow/webhook/data'], ['HEAD', '/remotion/renders/1']]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401);
    if (method !== 'HEAD') {
      assert.equal((await readJson(response)).code, 'unauthenticated');
    }
  }
  assert.equal(upstream.requests.length, 0);
});

test('malformed cookies cannot crash auth checks and valid session cookie still works', async () => {
  const upstream = await createUpstream({ body: 'authorized' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
  });

  const rejected = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: { cookie: 'broken=%E0%A4%A' },
  });
  assert.equal(rejected.status, 401);
  assert.equal((await readJson(rejected)).code, 'unauthenticated');

  const allowed = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: { cookie: `broken=%E0%A4%A; ${sessionCookie()}` },
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'authorized');
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'workflow-secret');
});

test('authenticated external reads proxy with sanitized response headers and session identity', async () => {
  const upstream = await createUpstream({ body: 'proxied' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: {
      cookie: sessionCookie(),
      'x-user-email': 'attacker@example.com',
      'x-user-roles': 'admin',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'proxied');
  assert.equal(response.headers.get('authorization'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-panel-actor-email'], 'user@example.com');
  assert.equal(upstream.requests[0].headers['x-user-email'], undefined);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'workflow-secret');
});

test('non-editor protected mutation is forbidden before proxying', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession({ roles: ['viewer'] }) },
    allowedOrigins: ['https://panel.example.local'],
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, 'forbidden');
  assert.equal(upstream.requests.length, 0);
});

test('wildcard CORS never grants credentialed browser access', async () => {
  const baseUrl = await createGateway({ allowedOrigins: ['*'] });

  const response = await fetch(`${baseUrl}/panel/bootstrap`, {
    headers: { origin: 'https://evil.example' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('disallowed preflight and untrusted mutation reject locally without credentialed CORS or proxying', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
  });

  const preflight = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
    },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

  const mutation = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(mutation.status, 403);
  assert.equal((await readJson(mutation)).code, 'csrf_rejected');
  assert.equal(upstream.requests.length, 0);
});

test('wildcard allowedOrigins never satisfies mutation CSRF trust', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['*'],
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, 'csrf_rejected');
  assert.equal(upstream.requests.length, 0);
});

test('explicit trustedMutationOrigins permits valid credentialed mutation', async () => {
  const upstream = await createUpstream({ body: 'mutated' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'mutated');
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'workflow-secret');
});

test('public liveness and local live exceptions remain available without a session', async () => {
  const monitor = await createUpstream({ body: 'live' });
  const baseUrl = await createGateway({
    routes: { monitor: { prefix: '/monitor', target: monitor.target } },
    serviceCredentials: { monitor: { 'x-api-key': 'monitor-secret' } },
  });

  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);

  const live = await fetch(`${baseUrl}/monitor/api/monitor/live`);
  assert.equal(live.status, 200);
  assert.equal(await live.text(), 'live');
  assert.equal(monitor.requests.length, 1);
});

// === WU2 RED tests — bounded TTL auth stores ===

test('expired panel session is ignored after its TTL and protected route returns unauthenticated', async () => {
  const upstream = await createUpstream({ body: 'authorized' });
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: {
      'valid-token': panelSession({ expires_at: new Date(nowMs + 1_000).toISOString() }),
    },
    now: () => nowMs,
  });

  const allowed = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: { cookie: sessionCookie() },
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'authorized');

  nowMs += 1_001;
  const expired = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: { cookie: sessionCookie() },
  });
  assert.equal(expired.status, 401);
  assert.equal((await readJson(expired)).code, 'unauthenticated');
  assert.equal(upstream.requests.length, 1, 'Expired sessions must not authorize proxy requests');
});

test('login attempt TTL expiry removes retained lockout state', async () => {
  let nowMs = 0;
  const baseUrl = await createGateway({
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
    loginAttemptTtlMs: 10,
    now: () => nowMs,
  });

  const badLogin = () => fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers: {
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user: 'admin', pass: 'wrong' }),
  });

  const first = await badLogin();
  assert.equal(first.status, 401);
  assert.equal((await readJson(first)).code, 'invalid_credentials');

  const locked = await badLogin();
  assert.equal(locked.status, 429);
  assert.equal((await readJson(locked)).code, 'too_many_attempts');

  nowMs += 11;
  const afterTtl = await badLogin();
  assert.equal(afterTtl.status, 401);
  assert.equal((await readJson(afterTtl)).code, 'invalid_credentials');
});

test('BoundedTtlStore expires stale entries and evicts oldest entries over capacity', () => {
  const store = new BoundedTtlStore({ maxEntries: 2 });
  store.set('a', { count: 1 }, { ttlMs: 10, nowMs: 0 });
  store.set('b', { count: 2 }, { ttlMs: 100, nowMs: 0 });

  assert.deepEqual(store.get('a', 5), { count: 1 });
  assert.equal(store.get('a', 11), null);
  assert.equal(store.size, 1);

  store.set('c', { count: 3 }, { ttlMs: 100, nowMs: 12 });
  store.set('d', { count: 4 }, { ttlMs: 100, nowMs: 13 });

  assert.equal(store.get('b', 13), null, 'Oldest retained entry must be evicted when capacity is exceeded');
  assert.deepEqual(store.get('c', 13), { count: 3 });
  assert.deepEqual(store.get('d', 13), { count: 4 });
  assert.equal(store.size, 2);
});

// === WU3 RED tests — explicit route policy resolver ===

test('resolveRoutePolicy keeps liveness and ready routes public without credential injection', () => {
  const options = { routes: { monitor: { prefix: '/monitor', target: 'http://127.0.0.1:8775' } }, serviceCredentials: {} };

  for (const url of ['/health', '/healthz', '/ready', '/monitor/api/monitor/live']) {
    const policy = resolveRoutePolicy({ method: 'GET', url }, options);
    assert.equal(policy.requiresSession, false, `${url} must remain public`);
    assert.equal(policy.requiresEditor, false, `${url} must not require editor role`);
    assert.equal(policy.requiresCsrf, false, `${url} must not require CSRF`);
    assert.equal(policy.allowsCredentialInjection, false, `${url} must not inject credentials`);
  }
});

test('public local live proxy route does not inject service credentials', async () => {
  const monitor = await createUpstream({ body: 'live' });
  const baseUrl = await createGateway({
    routes: { monitor: { prefix: '/monitor', target: monitor.target } },
    serviceCredentials: { monitor: { 'x-api-key': 'monitor-secret' } },
  });

  const response = await fetch(`${baseUrl}/monitor/api/monitor/live`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'live');
  assert.equal(monitor.requests.length, 1);
  assert.equal(monitor.requests[0].headers['x-api-key'], undefined, 'Public liveness proxy must not receive injected credentials');
});

test('resolveRoutePolicy makes protected proxy and read-model requirements explicit', () => {
  const options = {
    routes: {
      workflow: { prefix: '/workflow', target: 'http://127.0.0.1:5678' },
      tts: { prefix: '/tts', target: 'http://127.0.0.1:8088' },
    },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
  };

  const readProxy = resolveRoutePolicy({ method: 'GET', url: '/workflow/webhook/data' }, options);
  assert.equal(readProxy.kind, 'proxy');
  assert.equal(readProxy.requiresSession, true);
  assert.equal(readProxy.requiresEditor, false);
  assert.equal(readProxy.requiresCsrf, false);
  assert.equal(readProxy.allowsCredentialInjection, true);

  const mutationProxy = resolveRoutePolicy({ method: 'POST', url: '/workflow/webhook/data' }, options);
  assert.equal(mutationProxy.kind, 'proxy');
  assert.equal(mutationProxy.requiresSession, true);
  assert.equal(mutationProxy.requiresEditor, true);
  assert.equal(mutationProxy.requiresCsrf, true);
  assert.equal(mutationProxy.allowsCredentialInjection, true);

  const readModel = resolveRoutePolicy({ method: 'GET', url: '/panel/read-models/audio/jobs' }, options);
  assert.equal(readModel.kind, 'read-model');
  assert.equal(readModel.requiresSession, true);
  assert.equal(readModel.requiresEditor, false);
  assert.equal(readModel.requiresCsrf, false);
  assert.equal(readModel.allowsCredentialInjection, true);
});

test('subtitle render proxy gets an extended upstream timeout', () => {
  const policy = resolveRoutePolicy({
    method: 'POST',
    url: '/subtitles/api/subtitles/sessions/session_42/render',
  }, {
    routes: { subtitles: { prefix: '/subtitles', target: 'http://127.0.0.1:8092' } },
    serviceCredentials: { subtitles: { 'x-api-key': 'subtitles-secret' } },
  });

  assert.equal(policy.kind, 'proxy');
  assert.equal(policy.route.service, 'subtitles');
  assert.equal(policy.route.upstreamTimeoutMs, DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS);
});

test('local final renders get the long prepare timeout', () => {
  const policy = resolveRoutePolicy({
    method: 'POST',
    url: '/remotion/api/projects/project_42/render-final',
  }, {
    routes: { remotion: { prefix: '/remotion', target: 'http://renderer:3042' } },
  });

  assert.equal(policy.kind, 'proxy');
  assert.equal(policy.route.upstreamTimeoutMs, DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS);
});

test('subtitle session upload route gets an extended body limit', () => {
  const policy = resolveRoutePolicy({
    method: 'POST',
    url: '/subtitles/api/subtitles/sessions',
  }, {
    routes: { subtitles: { prefix: '/subtitles', target: 'http://127.0.0.1:8092' } },
    serviceCredentials: { subtitles: { 'x-api-key': 'subtitles-secret' } },
  });

  assert.equal(policy.kind, 'proxy');
  assert.equal(policy.route.service, 'subtitles');
  assert.equal(DEFAULT_SUBTITLES_UPLOAD_MAX_BODY_BYTES, 500 * 1024 * 1024);
  assert.equal(policy.route.maxBodyBytes, DEFAULT_SUBTITLES_UPLOAD_MAX_BODY_BYTES);
});

test('approval and remotion create-from-approval routes get an extended preparation timeout', () => {
  for (const [service, url] of [
    ['approval', '/approval/api/projects/create-from-approval'],
    ['remotion', '/remotion/api/projects/create-from-approval'],
  ]) {
    const policy = resolveRoutePolicy({
      method: 'POST',
      url,
    }, {
      routes: {
        approval: { prefix: '/approval', target: 'http://127.0.0.1:3042' },
        remotion: { prefix: '/remotion', target: 'https://remotion-api.example.local' },
      },
      serviceCredentials: { approval: { 'x-approval-secret': 'approval-secret' } },
    });

    assert.equal(policy.kind, 'proxy');
    assert.equal(policy.route.service, service);
    assert.equal(policy.route.upstreamTimeoutMs, DEFAULT_PREPARE_UPSTREAM_TIMEOUT_MS);
  }
});

test('unknown proxy route fails closed locally without upstream proxying', async () => {
  const upstream = await createUpstream({ body: 'should-not-proxy' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
  });

  const response = await fetch(`${baseUrl}/unknown/resource`);
  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).code, 'route_not_found');
  assert.equal(upstream.requests.length, 0);

  const ambiguousPolicy = resolveRoutePolicy({ method: 'GET', url: '/api/resource' }, {
    routes: {
      first: { prefix: '/api', target: upstream.target },
      second: { prefix: '/api', target: upstream.target },
    },
    serviceCredentials: {},
  });
  assert.equal(ambiguousPolicy.kind, 'reject');
  assert.equal(ambiguousPolicy.code, 'route_not_found');
});

test('local service routes reject protocol-relative upstream paths before proxying', () => {
  const routes = {
    monitor: { prefix: '/monitor', target: 'http://127.0.0.1:8775' },
    radar: { prefix: '/radar', target: 'http://127.0.0.1:8765' },
    approval: { prefix: '/approval', target: 'http://127.0.0.1:3042' },
  };

  for (const [service, url] of [
    ['monitor', '/monitor//example.com/path'],
    ['monitor', '/monitor/%2f%2fevil.example/path'],
    ['monitor', '/monitor/\\\\evil.example/path'],
    ['radar', '/radar//example.com/api/radar/jobs'],
    ['radar', '/radar/%5c%5cevil.example/api/radar/jobs'],
    ['approval', '/approval//example.com/api/projects'],
    ['approval', '/approval/%2F%5Cevil.example/api/projects'],
  ]) {
    assert.equal(resolveRoute(url, routes), null, `${service} route ${url} must not resolve`);
    const policy = resolveRoutePolicy({ method: 'GET', url }, { routes, serviceCredentials: {} });
    assert.equal(policy.kind, 'reject', `${service} route ${url} must fail closed`);
    assert.equal(policy.code, 'route_not_found');
  }
});

test('authenticated protocol-relative local service route does not reach upstream', async () => {
  const upstream = await createUpstream({ body: 'must-not-reach' });
  const baseUrl = await createGateway({
    routes: { radar: { prefix: '/radar', target: upstream.target } },
    serviceCredentials: { radar: { 'x-api-key': 'radar-secret' } },
    panelSessions: { 'valid-token': panelSession() },
  });

  const response = await fetch(`${baseUrl}/radar//example.com/api/radar/jobs`, {
    headers: { cookie: sessionCookie() },
  });

  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).code, 'route_not_found');
  assert.equal(upstream.requests.length, 0);
});

// === WU2 TRIANGULATE tests ===

test('explicit-origin CORS allows legitimate credentialed requests with echoed origin', async () => {
  const upstream = await createUpstream({ body: 'proxied' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local', 'http://localhost:5500'],
  });

  // Legitimate credentialed request from explicit allowed origin
  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: {
      origin: 'https://panel.example.local',
      cookie: sessionCookie(),
    },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'proxied');
  // Explicit origin echoed, not wildcard
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://panel.example.local');
  // Credentialed CORS header set for explicit origin
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  // Vary: Origin required per spec
  assert.equal(response.headers.get('vary'), 'Origin');
  // Proxied successfully
  assert.equal(upstream.requests.length, 1);
});

test('explicit-origin credentialed CORS does NOT grant credentials to non-allowed origins', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    allowedOrigins: ['https://panel.example.local'],
  });

  // Request from a non-allowed origin (not in the list, no wildcard)
  const response = await fetch(`${baseUrl}/panel/bootstrap`, {
    headers: { origin: 'https://evil.example' },
  });

  // Bootstrap is public so 200, but CORS should NOT grant credentials
  assert.equal(response.status, 200);
  // No ACAO for disallowed origin (no wildcard, not in list)
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(upstream.requests.length, 0);
});

// === WU2 RED tests ===

test('wildcard CORS presence disables credentials even when explicit origins are also configured', async () => {
  const upstream = await createUpstream({ body: 'hi' });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['*', 'https://example.com'],
  });

  // Origin explicitly in the list — but * is also present
  const response = await fetch(`${baseUrl}/panel/bootstrap`, {
    headers: { origin: 'https://example.com' },
  });

  // Spec: wildcard presence must disable ALL credentialed CORS responses
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-credentials'), null,
    'Must NOT set ACAC: true when * is present in allowedOrigins');
  assert.equal(response.headers.get('vary'), 'Origin');

  // Also verify the explicit origin gets echoed back (not wildcard)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.com');
});

test('disallowed OPTIONS preflight to gateway route returns 403 with no credential-granting CORS headers', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    allowedOrigins: ['https://panel.example.local'],
  });

  const preflight = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'GET',
    },
  });

  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null,
    'Must NOT grant credentialed CORS on rejected preflight');
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(upstream.requests.length, 0, 'Rejected preflight must NOT reach upstream');
});

test('mutation from allowed origin without CSRF trust rejects before proxying and credential injection', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://trusted.example'],
  });

  // Mutation with session but no origin header → no CSRF trust
  const mutation = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(mutation.status, 403);
  const body = await readJson(mutation);
  assert.equal(body.code, 'csrf_rejected');
  assert.equal(upstream.requests.length, 0,
    'CSRF-rejected mutation must NOT reach upstream — zero proxy');
  // Verify no credential injection happened (upstream never called)
});

test('invalid allowedOrigins config throws GatewayConfigError on server creation', async () => {
  // Empty string in allowedOrigins
  assert.throws(() => {
    createGatewayServer({
      panelAuth: { user: 'admin', pass: 'secret' },
      allowedOrigins: ['https://good.example', ''],
      logger: { error() {}, warn() {}, info() {} },
    });
  }, (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error');

  // Non-array allowedOrigins
  assert.throws(() => {
    createGatewayServer({
      panelAuth: { user: 'admin', pass: 'secret' },
      allowedOrigins: 'not-an-array',
      logger: { error() {}, warn() {}, info() {} },
    });
  }, (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error');

  // Non-string entry in allowedOrigins
  assert.throws(() => {
    createGatewayServer({
      panelAuth: { user: 'admin', pass: 'secret' },
      allowedOrigins: [42],
      logger: { error() {}, warn() {}, info() {} },
    });
  }, (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error');

  // Valid config still works
  const server = createGatewayServer({
    panelAuth: { user: 'admin', pass: 'secret' },
    allowedOrigins: ['https://good.example'],
    logger: { error() {}, warn() {}, info() {} },
  });
  assert.ok(server);
  server.close();
});

// === WU3 RED tests — Proxied body limits and dynamic path safety ===

async function createBodyRecordingUpstream() {
  const requests = [];
  let totalBytesReceived = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => {
      totalBytesReceived += chunk.length;
      chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  const port = await listen(server);
  return { requests, target: `http://127.0.0.1:${port}`, get totalBytes() { return totalBytesReceived; } };
}

test('declared Content-Length exceeding maxBodyBytes is rejected with 413 before proxying', async () => {
  const upstream = await createBodyRecordingUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    maxBodyBytes: 64,
  });

  // Non-JSON POST through protected route — body check currently MISSING for non-JSON
  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'text/plain',
    },
    body: 'x'.repeat(512),
  });

  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.equal(body.code, 'payload_too_large');
  assert.equal(upstream.totalBytes, 0, 'Upstream MUST receive zero body bytes for oversized body');
  assert.equal(upstream.requests.length, 0, 'Upstream MUST NOT be called for oversized body');
});

test('subtitle session upload can exceed the default proxy body limit', async () => {
  const upstream = await createBodyRecordingUpstream();
  const baseUrl = await createGateway({
    routes: { subtitles: { prefix: '/subtitles', target: upstream.target } },
    serviceCredentials: { subtitles: { 'x-api-key': 'subtitles-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    maxBodyBytes: 64,
  });

  const response = await fetch(`${baseUrl}/subtitles/api/subtitles/sessions`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'multipart/form-data; boundary=test',
    },
    body: 'x'.repeat(512),
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, '/api/subtitles/sessions');
  assert.equal(upstream.requests[0].body.length, 512);
});

test('streaming body exceeding maxBodyBytes is rejected with 413 and upstream receives no over-limit bytes', async () => {
  const upstream = await createBodyRecordingUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    maxBodyBytes: 128,
  });

  // Non-JSON POST — currently pipes body to upstream WITHOUT byte counting
  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'text/plain',
    },
    body: Buffer.alloc(1024, 'A'),
  });

  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.equal(body.code, 'payload_too_large');
  // Upstream MUST NOT receive bytes beyond the configured limit
  assert.ok(upstream.totalBytes <= 128 + 64,
    `upstream received ${upstream.totalBytes} bytes, expected ≤ ~192 (limit+slack)`);
});

test('dynamic read-model path traversal ".." returns 400 or 404 and zero upstream requests', async () => {
  const upstream = await createUpstream({ body: 'ok' });
  const baseUrl = await createGateway({
    routes: {
      tts: { prefix: '/tts', target: upstream.target },
      workflow: { prefix: '/workflow', target: upstream.target },
    },
    panelSessions: { 'valid-token': panelSession() },
  });

  // ../ traversal in dynamic segments — both bare and with extra segments
  for (const path of [
    // Long traversal chains that don't match regex
    '/panel/read-models/video-projects/../../workflow/webhook/secret',
    '/panel/read-models/audio/jobs/../sessions',
    '/panel/read-models/subtitles/sessions/../../../admin',
    // Bare ".." that matches regex but must be rejected
    '/panel/read-models/video-projects/..',
    '/panel/read-models/audio/jobs/..',
    '/panel/read-models/subtitles/sessions/..',
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { cookie: sessionCookie() },
    });
    assert.ok(response.status === 400 || response.status === 404,
      `Expected 400 or 404 for traversal path ${path}, got ${response.status}`);
  }

  assert.equal(upstream.requests.length, 0,
    'Traversal paths MUST NOT result in upstream requests');
});

test('encoded traversal segments are blocked and never reach upstream', async () => {
  const upstream = await createUpstream({ body: 'ok' });
  const baseUrl = await createGateway({
    routes: {
      tts: { prefix: '/tts', target: upstream.target },
      subtitles: { prefix: '/subtitles', target: upstream.target },
      workflow: { prefix: '/workflow', target: upstream.target },
    },
    panelSessions: { 'valid-token': panelSession() },
  });

  // Encoded traversal and separator attacks
  const cases = [
    '/panel/read-models/video-projects/%2e%2e%2f',       // ../
    '/panel/read-models/audio/jobs/%2f',                   // encoded slash
    '/panel/read-models/video-projects/%5c..%5c',         // \..\
    '/panel/read-models/video-projects/..%2f',             // ../  
    '/panel/read-models/subtitles/sessions/%2e%2e',       // ..
    '/panel/read-models/audio/jobs/test%2fbypass',        // test/bypass
  ];

  for (const path of cases) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { cookie: sessionCookie() },
    });
    assert.ok([400, 404].includes(response.status),
      `Expected 400 or 404 for encoded traversal ${path}, got ${response.status}`);
  }

  assert.equal(upstream.requests.length, 0,
    'Encoded traversal/separator segments MUST NOT result in upstream requests');
});

// === WU3 TRIANGULATE tests ===

test('body exactly at maxBodyBytes proxies normally', async () => {
  const upstream = await createBodyRecordingUpstream();
  const maxBytes = 128;
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    maxBodyBytes: maxBytes,
  });

  const exactBody = 'x'.repeat(maxBytes);
  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'text/plain',
    },
    body: exactBody,
  });

  assert.equal(response.status, 200, 'Body exactly at maxBodyBytes MUST proxy normally');
});

test('safe encoded IDs proxy normally through read-model routes', async () => {
  const upstream = await createUpstream({ body: 'ok' });
  const baseUrl = await createGateway({
    routes: {
      tts: { prefix: '/tts', target: upstream.target },
      subtitles: { prefix: '/subtitles', target: upstream.target },
      workflow: { prefix: '/workflow', target: upstream.target },
    },
    panelSessions: { 'valid-token': panelSession() },
  });

  // Valid encoded IDs that should be safe
  const validIds = [
    '/panel/read-models/audio/jobs/job-001',
    '/panel/read-models/subtitles/sessions/session_42/segments',
  ];

  for (const path of validIds) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { cookie: sessionCookie() },
    });
    assert.equal(response.status, 200,
      `Safe encoded ID ${path} MUST proxy normally, got ${response.status}`);
  }

  assert.equal(upstream.requests.length, validIds.length,
    'Every safe encoded ID MUST result in one upstream request');
});

// === WU4 RED tests — /ready, audit context, broader config validation ===

// --- Health / Healthz dedicated liveness ---

test('/health and /healthz return lightweight 200 JSON without panel auth', async () => {
  const baseUrl = await createGateway();

  for (const path of ['/health', '/healthz']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    const body = await readJson(response);
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptime_ms === 'number');
  }
});

// --- /ready endpoint ---

test('/ready returns 200 ready when all readiness checks pass', async () => {
  const baseUrl = await createGateway({
    readinessChecks: () => ({
      config: { status: 'ok' },
      routes: { status: 'ok', message: 'All routes configured' },
    }),
  });

  const response = await fetchWithTransientRetry(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.config.status, 'ok');
  assert.equal(body.checks.routes.status, 'ok');
  assert.equal(body.checks.routes.message, 'All routes configured');
});

test('/ready returns 503 not_ready when any check fails', async () => {
  const baseUrl = await createGateway({
    readinessChecks: () => ({
      config: { status: 'ok' },
      database: { status: 'error', message: 'Connection refused' },
    }),
  });

  const response = await fetchWithTransientRetry(`${baseUrl}/ready`);
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.config.status, 'ok');
  assert.equal(body.checks.database.status, 'error');
  assert.equal(body.checks.database.message, 'Connection refused');
});

test('/ready defaults to ready when no readiness checks are configured', async () => {
  const baseUrl = await createGateway();
  const response = await fetchWithTransientRetry(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'ready');
});

// --- Audit context in authorized JSON proxy ---

test('authorized JSON proxy body includes session-derived audit_actor and excludes client-forged identity', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
  });

  // Session-derived audit_actor
  const res1 = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'test' }),
  });
  assert.equal(res1.status, 200);
  const body1 = JSON.parse(upstream.requests[0].body);
  assert.ok(body1.audit_actor, 'audit_actor must be present in proxied JSON body');
  assert.equal(body1.audit_actor.actor, 'user-1');
  assert.equal(body1.audit_actor.email, 'user@example.com');
  assert.equal(body1.audit_actor.session_id, 'session-1');
  assert.deepStrictEqual(body1.audit_actor.roles, ['editor']);

  // Client-forged audit_actor is overwritten by session-derived
  upstream.requests.length = 0;
  const res2 = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'evil',
      audit_actor: { actor: 'hacker', email: 'evil@bad.com', roles: ['admin'] },
    }),
  });
  assert.equal(res2.status, 200);
  const body2 = JSON.parse(upstream.requests[0].body);
  assert.equal(body2.audit_actor.actor, 'user-1', 'client-forged audit_actor.actor must be overwritten');
  assert.equal(body2.audit_actor.email, 'user@example.com', 'client-forged audit_actor.email must be overwritten');
  assert.deepStrictEqual(body2.audit_actor.roles, ['editor'], 'client-forged roles must be overwritten');

  // Base-version audit metadata is preserved
  upstream.requests.length = 0;
  const res3 = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'update',
      base_version: 'v3',
      lease_id: 'lease-42',
    }),
  });
  assert.equal(res3.status, 200);
  const body3 = JSON.parse(upstream.requests[0].body);
  assert.equal(body3.action, 'update');
  assert.equal(body3.audit.base_version, 'v3', 'base_version must be preserved in audit metadata');
  assert.equal(body3.audit.lease_id, 'lease-42', 'lease_id must be preserved in audit metadata');
});

test('unauthenticated JSON POST produces no upstream request or audit body', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    allowedOrigins: ['https://panel.example.local'],
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'sneaky' }),
  });
  assert.equal(response.status, 401);
  assert.equal((await readJson(response)).code, 'unauthenticated');
  assert.equal(upstream.requests.length, 0, 'Unauthenticated JSON POST must NOT reach upstream');
});

// --- Broader config validation ---

test('invalid maxBodyBytes throws GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  assert.throws(
    () => createGatewayServer({ ...baseOpts, maxBodyBytes: 0 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  assert.throws(
    () => createGatewayServer({ ...baseOpts, maxBodyBytes: -1 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  assert.throws(
    () => createGatewayServer({ ...baseOpts, maxBodyBytes: 1.5 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
});

test('invalid route target scheme throws GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  assert.throws(
    () => createGatewayServer({ ...baseOpts, routes: { bad: { prefix: '/x', target: 'ftp://evil.example' } } }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  assert.throws(
    () => createGatewayServer({ ...baseOpts, routes: { bad: { prefix: '/x', target: 'just-a-string' } } }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
});

test('invalid timeout or session max-age throws GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  assert.throws(
    () => createGatewayServer({ ...baseOpts, upstreamTimeoutMs: 0 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  assert.throws(
    () => createGatewayServer({ ...baseOpts, upstreamTimeoutMs: -1000 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  assert.throws(
    () => createGatewayServer({ ...baseOpts, panelSessionMaxAgeSeconds: -1 }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
});

test('unsupported injected credential headers throw GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  assert.throws(
    () => createGatewayServer({
      ...baseOpts,
      serviceCredentials: { workflow: { 'x-custom-header': 'value' } },
    }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );
  // Supported headers must still work
  const server = createGatewayServer({
    ...baseOpts,
    serviceCredentials: { workflow: { 'x-api-key': 'valid', authorization: 'Basic xyz' } },
  });
  assert.ok(server);
  server.close();
});

// === WU4 RED tests — expanded startup config validation ===

test('malformed or unsupported CORS methods and header names throw GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  for (const allowedMethods of [
    ['GET', 'TRACE'],
    ['GET', 'BAD METHOD'],
    ['GET', ''],
  ]) {
    assert.throws(
      () => createGatewayServer({ ...baseOpts, allowedMethods }),
      (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
      `allowedMethods ${JSON.stringify(allowedMethods)} must be rejected`,
    );
  }

  for (const allowedHeaders of [
    ['content type'],
    ['x-good', 'bad@header'],
    [''],
  ]) {
    assert.throws(
      () => createGatewayServer({ ...baseOpts, allowedHeaders }),
      (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
      `allowedHeaders ${JSON.stringify(allowedHeaders)} must be rejected`,
    );
  }
});

test('unsafe target URLs, route prefixes, and trusted mutation origins throw GatewayConfigError', () => {
  const baseOpts = {
    panelAuth: { user: 'admin', pass: 'secret' },
    logger: { error() {}, warn() {}, info() {} },
  };

  assert.throws(
    () => createGatewayServer({ ...baseOpts, routes: { bad: { prefix: '/bad', target: 'https://user:pass@example.com' } } }),
    (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
  );

  for (const routes of [
    { bad: { prefix: '', target: 'http://127.0.0.1:8080' } },
    { first: { prefix: '/api', target: 'http://127.0.0.1:8080' }, second: { prefix: '/api', target: 'http://127.0.0.1:8081' } },
    { first: { prefix: '/api', target: 'http://127.0.0.1:8080' }, second: { prefix: '/api/v1', target: 'http://127.0.0.1:8081' } },
  ]) {
    assert.throws(
      () => createGatewayServer({ ...baseOpts, routes }),
      (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
      `routes ${JSON.stringify(routes)} must be rejected`,
    );
  }

  for (const trustedMutationOrigins of [
    ['*'],
    [''],
    ['not-a-url'],
    ['https://trusted.example/path'],
  ]) {
    assert.throws(
      () => createGatewayServer({ ...baseOpts, trustedMutationOrigins }),
      (err) => err.name === 'GatewayConfigError' && err.code === 'gateway_config_error',
      `trustedMutationOrigins ${JSON.stringify(trustedMutationOrigins)} must be rejected`,
    );
  }
});

// === WU4 TRIANGULATE tests — readiness failure shape + audit metadata preservation ===

test('/ready with multiple failing checks returns deterministic JSON shape', async () => {
  const baseUrl = await createGateway({
    readinessChecks: () => ({
      database: { status: 'error', message: 'timeout' },
      cache: { status: 'error', message: 'unreachable' },
    }),
  });

  const response = await fetchWithTransientRetry(`${baseUrl}/ready`);
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.status, 'not_ready');
  assert.equal(Object.keys(body.checks).length, 2);
  for (const check of Object.values(body.checks)) {
    assert.ok(check.status);
  }
});

test('/ready with mixed ok and error checks returns not_ready', async () => {
  const baseUrl = await createGateway({
    readinessChecks: () => ({
      config: { status: 'ok' },
      database: { status: 'error', message: 'offline' },
    }),
  });

  const response = await fetchWithTransientRetry(`${baseUrl}/ready`);
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.config.status, 'ok');
  assert.equal(body.checks.database.status, 'error');
});

test('existing audit metadata fields are preserved alongside session-derived audit_actor', async () => {
  const upstream = await createUpstream();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(),
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      data: 'payload',
      audit: { custom_field: 'keep-me' },
      audit_actor: { actor: 'forged' },
    }),
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(upstream.requests[0].body);
  assert.equal(body.audit_actor.actor, 'user-1', 'Session-derived actor overwrites client-forged');
  assert.equal(body.audit.custom_field, 'keep-me', 'Existing audit metadata preserved');
  assert.equal(body.data, 'payload');
});

// === Error/Audit Observability WU2 RED tests — correlation, emitters, read model ===

test('gateway returns one correlation ID per request and forwards it to proxied upstreams', async () => {
  const upstream = await createUpstream({ body: 'correlated' });
  const recorder = createRecordingEventRecorder();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
    eventRecorder: recorder,
    createCorrelationId: () => 'generated-correlation-1',
  });

  const generated = await fetch(`${baseUrl}/health`);
  assert.equal(generated.headers.get('x-correlation-id'), 'generated-correlation-1');

  const proxied = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: {
      cookie: sessionCookie(),
      'x-correlation-id': 'client-corr-123',
    },
  });

  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get('x-correlation-id'), 'client-corr-123');
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-correlation-id'], 'client-corr-123');
  assert.equal(upstream.requests[0].headers['x-request-id'], 'client-corr-123');
  assert.equal(recorder.events.some((event) => event.correlation_id === 'client-corr-123' && event.action === 'proxy.request' && event.outcome === 'success'), true);
});

test('gateway emits sanitized audit and error events for auth and rejection paths', async () => {
  const upstream = await createUpstream();
  const recorder = createRecordingEventRecorder();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession({ roles: ['viewer'] }) },
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
    eventRecorder: recorder,
  });

  await fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers: { origin: 'https://panel.example.local', 'content-type': 'application/json', 'x-correlation-id': 'login-fail' },
    body: JSON.stringify({ user: 'admin', pass: 'wrong-password', api_key: 'raw-api-key' }),
  });

  const successRecorder = createRecordingEventRecorder();
  const { authService: successAuth } = await createRepositoryAuth({
    admin: { email: 'admin@example.local', display_name: 'Admin', password: 'admin-secret', roles: ['admin'] },
  });
  const successBaseUrl = await createGateway({
    authService: successAuth,
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
    eventRecorder: successRecorder,
  });
  const login = await fetch(`${successBaseUrl}/panel/login`, {
    method: 'POST',
    headers: { origin: 'https://panel.example.local', 'content-type': 'application/json', 'x-correlation-id': 'login-ok' },
    body: JSON.stringify({ user: 'admin@example.local', pass: 'admin-secret' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  await fetch(`${successBaseUrl}/workflow/webhook/data`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-correlation-id': 'csrf-corr' }, body: '{}' });
  await fetch(`${successBaseUrl}/panel/logout`, { method: 'POST', headers: { origin: 'https://panel.example.local', cookie, 'x-correlation-id': 'logout-ok' } });
  await fetch(`${baseUrl}/workflow/webhook/data`, { method: 'POST', headers: { cookie: sessionCookie(), origin: 'https://panel.example.local', 'content-type': 'application/json', 'x-correlation-id': 'forbidden-corr' }, body: '{}' });
  const payloadRecorder = createRecordingEventRecorder();
  const payloadBaseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession() },
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
    maxBodyBytes: 16,
    eventRecorder: payloadRecorder,
  });
  await fetch(`${payloadBaseUrl}/workflow/webhook/data`, { method: 'POST', headers: { cookie: sessionCookie(), origin: 'https://panel.example.local', 'content-type': 'text/plain', 'x-correlation-id': 'payload-corr' }, body: 'x'.repeat(64) });

  const allEvents = [...recorder.events, ...successRecorder.events, ...payloadRecorder.events];
  const actions = allEvents.map((event) => `${event.action}:${event.outcome}:${event.reason_code || ''}`);
  assert.equal(actions.includes('panel.login:failure:invalid_credentials'), true);
  assert.equal(actions.includes('panel.login:success:'), true);
  assert.equal(actions.includes('panel.logout:success:'), true);
  assert.equal(actions.includes('proxy.authorization:rejected:forbidden'), true);
  assert.equal(actions.includes('proxy.csrf:rejected:csrf_rejected'), true);
  assert.equal(actions.includes('proxy.payload:rejected:payload_too_large'), true);
  assert.equal(JSON.stringify(allEvents).includes('wrong-password'), false);
  assert.equal(JSON.stringify(allEvents).includes('raw-api-key'), false);
});

test('gateway emits proxy failure events with safe context without changing upstream failure response', async () => {
  const recorder = createRecordingEventRecorder();
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: 'http://127.0.0.1:1' } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
    eventRecorder: recorder,
  });

  const response = await fetch(`${baseUrl}/workflow/webhook/data`, {
    headers: { cookie: sessionCookie(), authorization: 'Bearer raw-secret', 'x-correlation-id': 'proxy-fail-corr' },
  });

  assert.equal(response.status, 502);
  assert.equal((await readJson(response)).code, 'upstream_unavailable');
  const event = recorder.events.find((entry) => entry.kind === 'error' && entry.action === 'proxy.request' && entry.reason_code === 'upstream_unavailable');
  assert.equal(event.correlation_id, 'proxy-fail-corr');
  assert.equal(event.route_service, 'workflow');
  assert.equal(JSON.stringify(event).includes('raw-secret'), false);
});

test('authenticated gateway events read model filters events and rejects unauthenticated reads', async () => {
  const recorder = createRecordingEventRecorder({
    queryResult: {
      events: [{ event_id: 'event-1', kind: 'error', correlation_id: 'corr-1', context: { token: '<redacted>' } }],
      next_cursor: null,
      retention: { max_events: 50, max_age_days: 7 },
    },
  });
  const baseUrl = await createGateway({
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
    eventRecorder: recorder,
  });

  const rejected = await fetch(`${baseUrl}/panel/read-models/gateway/events?kind=error`);
  assert.equal(rejected.status, 401);
  assert.equal((await readJson(rejected)).code, 'unauthenticated');

  const response = await fetch(`${baseUrl}/panel/read-models/gateway/events?kind=error&status=502&service=workflow&actor=user-1&correlation_id=corr-1&limit=25`, {
    headers: { cookie: sessionCookie(), 'x-user-email': 'attacker@example.com', 'x-correlation-id': 'read-corr' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-correlation-id'), 'read-corr');
  assert.deepEqual(await readJson(response), {
    events: [{ event_id: 'event-1', kind: 'error', correlation_id: 'corr-1', context: { token: '<redacted>' } }],
    next_cursor: null,
    retention: { max_events: 50, max_age_days: 7 },
  });
  assert.deepEqual(recorder.queries[0], { kind: 'error', status: '502', service: 'workflow', actor: 'user-1', correlation_id: 'corr-1', limit: '25' });
});

test('gateway events read-model failure returns safe error and records sanitized failure event', async () => {
  const recorder = createRecordingEventRecorder({ queryError: new Error('database password=raw-secret offline') });
  const baseUrl = await createGateway({
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
    eventRecorder: recorder,
  });

  const response = await fetch(`${baseUrl}/panel/read-models/gateway/events?kind=audit`, {
    headers: { cookie: sessionCookie(), 'x-correlation-id': 'read-fail-corr', authorization: 'Bearer raw-token' },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await readJson(response), { error: 'event_read_failed', code: 'event_read_failed' });
  const failureEvent = recorder.events.find((event) => event.action === 'gateway.events.read' && event.reason_code === 'event_read_failed');
  assert.equal(failureEvent.kind, 'error');
  assert.equal(failureEvent.actor.email, 'user@example.com');
  assert.equal(JSON.stringify(failureEvent).includes('raw-token'), false);
  assert.equal(JSON.stringify(failureEvent).includes('raw-secret'), false);
});

// === API Gateway real multi-user presence PR1 RED tests — same-access configured users ===

test('configured panel users authenticate into distinct equivalent editor sessions', async () => {
  const { authService, users } = await createRepositoryAuth({
    alice: { email: 'alice@example.com', display_name: 'Alice Editor', password: 'alice-secret', roles: ['editor'] },
    bob: { email: 'bob@example.com', display_name: 'Bob Editor', password: 'bob-secret', roles: ['editor'] },
  });
  const baseUrl = await createGateway({
    authService,
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
  });

  const login = (user, pass) => fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers: { origin: 'https://panel.example.local', 'content-type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });

  const aliceLogin = await login('alice@example.com', 'alice-secret');
  const bobLogin = await login('bob@example.com', 'bob-secret');

  assert.equal(aliceLogin.status, 200);
  assert.equal(bobLogin.status, 200);
  const aliceBody = await readJson(aliceLogin);
  const bobBody = await readJson(bobLogin);
  assert.deepEqual(aliceBody.user, { user_id: users.alice.user_id, email: 'alice@example.com', display_name: 'Alice Editor' });
  assert.deepEqual(aliceBody.roles, ['editor']);
  assert.ok(aliceBody.session_id);
  assert.deepEqual(bobBody.user, { user_id: users.bob.user_id, email: 'bob@example.com', display_name: 'Bob Editor' });
  assert.deepEqual(bobBody.roles, ['editor']);
  assert.notEqual(aliceBody.session_id, bobBody.session_id);

  for (const response of [aliceLogin, bobLogin]) {
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    const sessionResponse = await fetch(`${baseUrl}/panel/session`, { headers: { cookie } });
    assert.equal(sessionResponse.status, 200);
    assert.deepEqual((await readJson(sessionResponse)).roles, ['editor']);
  }
});

test('unknown configured panel user is rejected without creating a session actor', async () => {
  const { authService } = await createRepositoryAuth({
    alice: { email: 'alice@example.com', display_name: 'Alice Editor', password: 'alice-secret', roles: ['editor'] },
  });
  const baseUrl = await createGateway({
    authService,
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
  });

  const rejected = await fetch(`${baseUrl}/panel/login`, {
    method: 'POST',
    headers: { origin: 'https://panel.example.local', 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'mallory@example.com', pass: 'alice-secret' }),
  });

  assert.equal(rejected.status, 401);
  assert.equal((await readJson(rejected)).code, 'invalid_credentials');
  assert.equal(rejected.headers.get('set-cookie'), null);

  const sessionResponse = await fetch(`${baseUrl}/panel/session`);
  assert.equal(sessionResponse.status, 401);
  assert.equal((await readJson(sessionResponse)).code, 'unauthenticated');
});

test('browser-forged internal actor and session headers are stripped before any upstream proxy', async () => {
  const monitor = await createUpstream({ body: 'live' });
  const baseUrl = await createGateway({
    routes: { monitor: { prefix: '/monitor', target: monitor.target } },
    serviceCredentials: { monitor: { 'x-api-key': 'monitor-secret' } },
  });

  const response = await fetch(`${baseUrl}/monitor/api/monitor/live`, {
    headers: {
      'x-panel-actor-id': 'mallory',
      'x-panel-actor-email': 'mallory@example.com',
      'x-panel-actor-display-name': 'Mallory',
      'x-panel-actor-roles': 'admin',
      'x-panel-session-id': 'forged-session',
      'x-audit-actor': 'mallory',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(monitor.requests.length, 1);
  for (const headerName of [
    'x-panel-actor-id',
    'x-panel-actor-email',
    'x-panel-actor-display-name',
    'x-panel-actor-roles',
    'x-panel-session-id',
    'x-audit-actor',
  ]) {
    assert.equal(monitor.requests[0].headers[headerName], undefined, `${headerName} must not be forwarded from browsers`);
  }
});

test('configured user proxy and audit events keep per-person session attribution despite forged headers', async () => {
  const upstream = await createUpstream();
  const recorder = createRecordingEventRecorder();
  const { authService, users } = await createRepositoryAuth({
    alice: { email: 'alice@example.com', display_name: 'Alice Editor', password: 'alice-secret', roles: ['editor'] },
    bob: { email: 'bob@example.com', display_name: 'Bob Editor', password: 'bob-secret', roles: ['editor'] },
  });
  const baseUrl = await createGateway({
    routes: { workflow: { prefix: '/workflow', target: upstream.target } },
    serviceCredentials: { workflow: { 'x-api-key': 'workflow-secret' } },
    authService,
    eventRecorder: recorder,
    allowedOrigins: ['https://panel.example.local'],
    trustedMutationOrigins: ['https://panel.example.local'],
  });

  const login = async (user, pass) => {
    const response = await fetch(`${baseUrl}/panel/login`, {
      method: 'POST',
      headers: { origin: 'https://panel.example.local', 'content-type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')?.split(';')[0];
  };

  const aliceCookie = await login('alice@example.com', 'alice-secret');
  const bobCookie = await login('bob@example.com', 'bob-secret');
  const bobSession = await readJson(await fetch(`${baseUrl}/panel/session`, { headers: { cookie: bobCookie } }));

  const proxied = await fetch(`${baseUrl}/workflow/webhook/data`, {
    method: 'POST',
    headers: {
      cookie: bobCookie,
      origin: 'https://panel.example.local',
      'content-type': 'application/json',
      'x-panel-actor-email': 'alice@example.com',
      'x-panel-session-id': 'alice-session',
    },
    body: JSON.stringify({ action: 'save', base_version: 'v7' }),
  });

  assert.equal(proxied.status, 200);
  assert.equal(upstream.requests.at(-1).headers['x-panel-actor-email'], 'bob@example.com');
  assert.equal(upstream.requests.at(-1).headers['x-panel-session-id'], bobSession.session_id);
  const upstreamBody = JSON.parse(upstream.requests.at(-1).body);
  assert.equal(upstreamBody.audit_actor.actor, users.bob.user_id);
  assert.equal(upstreamBody.audit_actor.session_id, bobSession.session_id);
  assert.equal(upstreamBody.audit.base_version, 'v7');

  const loginEvents = recorder.events.filter((event) => event.action === 'panel.login' && event.outcome === 'success');
  assert.deepEqual(loginEvents.map((event) => event.actor.email), ['alice@example.com', 'bob@example.com']);
  const proxyEvent = recorder.events.find((event) => event.action === 'proxy.request' && event.outcome === 'success');
  assert.equal(proxyEvent.actor.email, 'bob@example.com');
  assert.equal(proxyEvent.session_id, bobSession.session_id);
});

// === API Gateway real multi-user presence PR2 RED tests — presence API/read model ===

test('presence heartbeat requires an authenticated panel session and leaves read model empty when rejected', async () => {
  const baseUrl = await createGateway({
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
  });

  const rejected = await fetch(`${baseUrl}/panel/presence/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ area: 'video-projects', resource_type: 'video_project', resource_id: 'project-1', mode: 'editing' }),
  });

  assert.equal(rejected.status, 401);
  assert.equal((await readJson(rejected)).code, 'unauthenticated');

  const readModel = await fetch(`${baseUrl}/panel/read-models/gateway/presence`, {
    headers: { cookie: sessionCookie() },
  });
  assert.equal(readModel.status, 200);
  assert.deepEqual(await readJson(readModel), { sessions: [], resources: [], ttl_seconds: 60 });
});

test('presence heartbeat stores verified actor/session and groups same-resource occupancy while ignoring forged headers', async () => {
  const baseUrl = await createGateway({
    panelSessions: {
      'alice-token': {
        user: { user_id: 'alice', email: 'alice@example.com', display_name: 'Alice Admin' },
        roles: ['admin'],
        session_id: 'alice-session',
        expires_at: Date.now() + 60_000,
      },
      'bob-token': {
        user: { user_id: 'bob', email: 'bob@example.com', display_name: 'Bob Admin' },
        roles: ['admin'],
        session_id: 'bob-session',
        expires_at: Date.now() + 60_000,
      },
    },
    presenceTtlMs: 60_000,
    now: () => Date.parse('2026-05-28T10:00:00.000Z'),
  });

  const heartbeat = (cookie, mode, forged = {}) => fetch(`${baseUrl}/panel/presence/heartbeat`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      ...forged,
    },
    body: JSON.stringify({ area: 'video-projects', resource_type: 'video_project', resource_id: 'project-1', mode }),
  });

  const alice = await heartbeat(sessionCookie('alice-token'), 'editing', {
    'x-panel-actor-id': 'mallory',
    'x-panel-session-id': 'mallory-session',
    'x-presence-actor-id': 'mallory',
  });
  const bob = await heartbeat(sessionCookie('bob-token'), 'viewing');

  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);
  assert.deepEqual(await readJson(alice), { ok: true, ttl_seconds: 60 });

  const response = await fetch(`${baseUrl}/panel/read-models/gateway/presence`, {
    headers: { cookie: sessionCookie('alice-token') },
  });

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.ttl_seconds, 60);
  assert.equal(body.sessions.length, 2);
  assert.deepEqual(body.sessions.map((entry) => [entry.session_id, entry.actor.user_id, entry.mode]).sort(), [
    ['alice-session', 'alice', 'editing'],
    ['bob-session', 'bob', 'viewing'],
  ]);
  assert.equal(JSON.stringify(body).includes('mallory'), false, 'presence identity must come from the verified session');
  assert.deepEqual(body.resources, [{
    area: 'video-projects',
    resource_type: 'video_project',
    resource_id: 'project-1',
    sessions: ['alice-session', 'bob-session'],
  }]);
});

test('presence read model excludes expired sessions by TTL without changing route authorization', async () => {
  let nowMs = Date.parse('2026-05-28T10:00:00.000Z');
  const baseUrl = await createGateway({
    panelSessions: {
      'alice-token': {
        user: { user_id: 'alice', email: 'alice@example.com', display_name: 'Alice Admin' },
        roles: ['admin'],
        session_id: 'alice-session',
        expires_at: Date.now() + 60_000,
      },
      'bob-token': {
        user: { user_id: 'bob', email: 'bob@example.com', display_name: 'Bob Admin' },
        roles: ['admin'],
        session_id: 'bob-session',
        expires_at: Date.now() + 60_000,
      },
    },
    presenceTtlMs: 1_000,
    now: () => nowMs,
  });

  await fetch(`${baseUrl}/panel/presence/heartbeat`, {
    method: 'POST',
    headers: { cookie: sessionCookie('alice-token'), 'content-type': 'application/json' },
    body: JSON.stringify({ area: 'video-projects', resource_type: 'video_project', resource_id: 'project-1', mode: 'editing' }),
  });
  nowMs += 1_100;
  await fetch(`${baseUrl}/panel/presence/heartbeat`, {
    method: 'POST',
    headers: { cookie: sessionCookie('bob-token'), 'content-type': 'application/json' },
    body: JSON.stringify({ area: 'video-projects', resource_type: 'video_project', resource_id: 'project-1', mode: 'viewing' }),
  });

  const response = await fetch(`${baseUrl}/panel/read-models/gateway/presence`, {
    headers: { cookie: sessionCookie('bob-token') },
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.sessions.map((entry) => entry.session_id), ['bob-session']);
  assert.equal(body.resources[0].sessions.includes('alice-session'), false);

  const sessionResponse = await fetch(`${baseUrl}/panel/session`, { headers: { cookie: sessionCookie('alice-token') } });
  assert.equal(sessionResponse.status, 200, 'Presence TTL must not expire or change panel authorization');
});

test('routine presence heartbeats are memory-only and do not pollute audit/error events', async () => {
  const recorder = createRecordingEventRecorder();
  const baseUrl = await createGateway({
    panelSessions: { 'valid-token': panelSession({ roles: ['admin'] }) },
    eventRecorder: recorder,
  });

  const heartbeat = await fetch(`${baseUrl}/panel/presence/heartbeat`, {
    method: 'POST',
    headers: { cookie: sessionCookie(), 'content-type': 'application/json', 'x-correlation-id': 'presence-corr' },
    body: JSON.stringify({ area: 'subtitles', resource_type: 'subtitle_session', resource_id: 'subtitle-1', mode: 'viewing' }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(recorder.events.some((event) => String(event.action || '').includes('presence')), false);

  const events = await fetch(`${baseUrl}/panel/read-models/gateway/events`, {
    headers: { cookie: sessionCookie() },
  });
  assert.equal(events.status, 200);
  const body = await readJson(events);
  assert.equal(body.events.some((event) => String(event.action || '').includes('presence')), false);
});

test('the gateway injects the internal renderer token for the remotion route', () => {
  const credentials = readServiceCredentialsFromEnv({ API_GATEWAY_RENDERER_API_KEY: 'renderer-secret' });
  assert.deepEqual(credentials.remotion, { 'x-api-key': 'renderer-secret' });
});
