import { timingSafeEqual } from 'node:crypto';

const JSON_LIMIT = 64 * 1024;

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJson(readBody) {
  const raw = await readBody({ maxBodyBytes: JSON_LIMIT });
  if (!raw || !raw.length) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed;
}

/**
 * Machine-to-machine endpoints used by the optional n8n connector. They are
 * intentionally outside the panel mutation table: callers authenticate with a
 * dedicated bearer token (`JOBS_API_KEY`), never with a panel session, and the
 * endpoints only start existing use cases.
 */
export function createJobsRouter({ useCases = {}, jobQueue = null, apiKey = '' } = {}) {
  const token = String(apiKey || '');

  function matches(pathname = '') {
    return pathname === '/jobs/discover';
  }

  function authorized(headers = {}) {
    if (!token) return false;
    const authorization = String(headers.authorization || '').trim();
    if (authorization.startsWith('Bearer ')) {
      return safeEqual(authorization.slice('Bearer '.length).trim(), token);
    }
    return safeEqual(headers['x-api-key'], token);
  }

  async function discover() {
    if (!useCases.refreshSearch) return json(503, { ok: false, error: 'discovery_unavailable' });
    const started = await useCases.refreshSearch.start({ window: '24h' });
    if (jobQueue) {
      jobQueue.enqueue('refresh-search', { run_id: started.run_id, window: '24h' });
    } else {
      void useCases.refreshSearch.processRun(started.run_id, { window: '24h' }).catch(() => {});
    }
    return json(202, { ok: true, status: 'accepted', run_id: started.run_id, orchestrator: 'n8n' });
  }

  async function handle({ method = 'POST', pathname, headers = {} } = {}) {
    if (!matches(pathname)) return json(404, { ok: false, error: 'not_found' });
    if (String(method || '').toUpperCase() !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    if (!token) return json(503, { ok: false, error: 'jobs_connector_disabled' });
    if (!authorized(headers)) return json(401, { ok: false, error: 'unauthorized' });
    try {
      return await discover();
    } catch (error) {
      const status = Number(error?.statusCode) || 400;
      return json(status, { ok: false, error: error?.code || 'invalid_request', message: String(error?.message || 'Request failed') });
    }
  }

  return { matches, handle, authorized };
}

export { JSON_LIMIT as JOBS_ROUTER_JSON_LIMIT };
