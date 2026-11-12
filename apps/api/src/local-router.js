import { DomainError, SaveScriptDraft, buildReadModels } from '@newsroom/core';

const JSON_LIMIT = 1024 * 1024;

// Deprecated Supabase-era paths stay accepted for existing n8n webhooks, but
// the panel and all new integrations use the neutral paths.
export const LEGACY_WEBHOOK_ALIASES = Object.freeze({
  '/webhook/approval/pending/supabase/v2': '/webhook/approval/pending/v2',
  '/webhook/approval/queue/supabase/v2': '/webhook/approval/queue/v2',
  '/webhook/approval/topic/supabase/v2': '/webhook/approval/topic/v2',
  '/webhook/approval/decision/supabase/v2': '/webhook/approval/decision/v2',
  '/webhook/approval/search-refresh/supabase/v2': '/webhook/approval/search-refresh/v2',
  '/webhook/approval/search-refresh/status/supabase/v1': '/webhook/approval/search-refresh/status/v1',
  '/webhook/mvp-script-drafts-pending/supabase/v2': '/webhook/mvp-script-drafts-pending/v2',
  '/webhook/mvp-script-draft-save/supabase/v2': '/webhook/mvp-script-draft-save/v2',
  '/webhook/mvp-script-publish/supabase/v2': '/webhook/mvp-script-publish/v2',
  '/webhook/mvp-script-publish-status/supabase/v1': '/webhook/mvp-script-publish-status/v1',
  '/webhook/mvp-script-download-doc/supabase/v1': '/webhook/mvp-script-download-doc/v1',
});

export function normalizeLocalWorkflowPath(pathname = '') {
  return LEGACY_WEBHOOK_ALIASES[pathname] || pathname;
}

export const LOCAL_MUTATION_ROUTES = Object.freeze([
  {
    id: 'local-decision',
    methods: ['POST'],
    path: '/webhook/approval/decision/v2',
    examplePath: '/webhook/approval/decision/v2',
  },
  {
    id: 'local-search-refresh',
    methods: ['POST'],
    path: '/webhook/approval/search-refresh/v2',
    examplePath: '/webhook/approval/search-refresh/v2',
  },
  {
    id: 'local-search-refresh-status',
    methods: ['POST'],
    path: '/webhook/approval/search-refresh/status/v1',
    examplePath: '/webhook/approval/search-refresh/status/v1',
  },
  {
    id: 'local-save-draft',
    methods: ['POST'],
    path: '/webhook/mvp-script-draft-save/v2',
    examplePath: '/webhook/mvp-script-draft-save/v2',
  },
  {
    id: 'local-publish',
    methods: ['POST'],
    path: '/webhook/mvp-script-publish/v2',
    examplePath: '/webhook/mvp-script-publish/v2',
  },
  {
    id: 'local-publish-status',
    methods: ['POST'],
    path: '/webhook/mvp-script-publish-status/v1',
    examplePath: '/webhook/mvp-script-publish-status/v1',
  },
  {
    id: 'local-download-document',
    methods: ['POST'],
    path: '/webhook/mvp-script-download-doc/v1',
    examplePath: '/webhook/mvp-script-download-doc/v1',
  },
  {
    id: 'local-manual-create',
    methods: ['POST'],
    path: '/webhook/video-projects/manual-create/v1',
    examplePath: '/webhook/video-projects/manual-create/v1',
  },
]);

const ROUTES = Object.freeze([
  '/webhook/approval/pending/v2',
  '/webhook/approval/queue/v2',
  '/webhook/approval/topic/v2',
  '/webhook/approval/decision/v2',
  '/webhook/approval/search-refresh/v2',
  '/webhook/approval/search-refresh/status/v1',
  '/webhook/mvp-script-drafts-pending/v2',
  '/webhook/mvp-script-draft-save/v2',
  '/webhook/mvp-script-publish/v2',
  '/webhook/mvp-script-publish-status/v1',
  '/webhook/mvp-script-download-doc/v1',
  '/webhook/video-projects/manual-create/v1',
  '/panel/read-models/approval/pending',
  '/panel/read-models/approval/queue',
  '/panel/read-models/approval/topic',
  '/panel/read-models/approval/search-refresh/status',
  '/panel/read-models/scripts/drafts',
]);

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function errorResponse(error) {
  const status = Number(error?.statusCode) || 400;
  return json(status, {
    ok: false,
    status: 'error',
    error: error?.code || 'invalid_request',
    code: error?.code || 'invalid_request',
    message: String(error?.message || 'Request failed'),
  });
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

function assertMethod(method, expected) {
  if (method !== expected) return json(405, { ok: false, error: 'method_not_allowed' });
  return null;
}

function signedCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * HTTP surface for the n8n workflow logic that now lives in packages/core.
 * The gateway owns authentication, CSRF and role checks; this router only
 * translates panel/webhook paths into use-case calls.
 */
export function createLocalRouter({
  repository,
  readModels = null,
  useCases = {},
  jobQueue = null,
} = {}) {
  if (!repository) throw new Error('repository is required');
  const models = readModels || buildReadModels({ repository });

  function matches(pathname = '') {
    return ROUTES.includes(normalizeLocalWorkflowPath(pathname));
  }

  async function startRefresh(body) {
    if (!useCases.refreshSearch) throw new DomainError('refresh search adapter is not configured', { statusCode: 503 });
    const started = await useCases.refreshSearch.start({ window: body.window ?? body.requested_window ?? body.when });
    if (jobQueue) {
      jobQueue.enqueue('refresh-search', {
        run_id: started.run_id,
        window: body.window ?? body.requested_window ?? body.when ?? '24h',
      });
    } else {
      void useCases.refreshSearch.processRun(started.run_id, { window: body.window ?? '24h' }).catch(() => {});
    }
    return json(202, started);
  }

  async function searchRefreshStatus(searchParams, body = {}) {
    const runId = String(searchParams.get('run_id') || body.run_id || '').trim();
    if (!runId) return json(400, { ok: false, error: 'run_id_required', message: 'run_id is required' });
    const run = await models.searchRefreshStatus(runId);
    const status = String(run?.status || '').toLowerCase();
    return json(200, status === 'promoted' ? { ...run, status: 'succeeded' } : run);
  }

  const saveScriptDraft = useCases.saveScriptDraft || new SaveScriptDraft({ repository });

  async function saveDraft(body) {
    const result = await saveScriptDraft.execute({
      action: body.action ?? body.intent ?? 'save',
      draftId: body.draft_id ?? '',
      idNoticia: body.id_noticia ?? '',
      clusterId: body.cluster_id ?? '',
      guionEditado: body.guion_editado ?? '',
    });
    return json(200, result);
  }

  async function startPublish(body) {
    if (!useCases.publishScript) throw new DomainError('publish adapter is not configured', { statusCode: 503 });
    const started = await useCases.publishScript.start(body);
    if (jobQueue) jobQueue.enqueue('publish-script', { job_id: started.job_id });
    else void useCases.publishScript.process(started.job_id).catch(() => {});
    return json(200, started);
  }

  async function publishStatus(body) {
    const jobId = String(body.job_id ?? '').trim();
    if (!jobId) return json(400, { ok: false, error: 'job_id_required', message: 'debés enviar job_id' });
    return json(200, await models.publishJob(jobId));
  }

  async function startManual(body) {
    if (!useCases.manualCreateVideoProject) throw new DomainError('manual project adapter is not configured', { statusCode: 503 });
    const started = await useCases.manualCreateVideoProject.start(body);
    if (jobQueue) jobQueue.enqueue('manual-video', { job_id: started.job_id });
    else void useCases.manualCreateVideoProject.process(started.job_id).catch(() => {});
    return json(202, started);
  }

  async function downloadDocument(body) {
    if (!useCases.exportDocument) throw new DomainError('document export adapter is not configured', { statusCode: 503 });
    const result = await useCases.exportDocument.execute(body);
    return {
      status: 200,
      headers: {
        'content-type': result.content_type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename="${String(result.filename || 'guion.docx').replace(/"/g, '')}"`,
        'content-length': String(result.bytes?.length ?? 0),
      },
      body: result.bytes,
    };
  }

  async function handle({ method = 'GET', pathname, searchParams = new URLSearchParams(), readBody } = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const routePath = normalizeLocalWorkflowPath(pathname);
    const read = readBody || (async () => Buffer.alloc(0));
    try {
      if (routePath === '/webhook/approval/pending/v2' || pathname === '/panel/read-models/approval/pending') {
        const wrong = assertMethod(upperMethod, 'GET');
        return wrong || json(200, await models.pendingApproval());
      }
      if (routePath === '/webhook/approval/queue/v2' || pathname === '/panel/read-models/approval/queue') {
        const wrong = assertMethod(upperMethod, 'GET');
        return wrong || json(200, await models.approvalQueue());
      }
      if (routePath === '/webhook/approval/topic/v2' || pathname === '/panel/read-models/approval/topic') {
        const wrong = assertMethod(upperMethod, 'GET');
        if (wrong) return wrong;
        const clusterId = String(searchParams.get('cluster_id') || '').trim();
        if (!clusterId) return json(400, { ok: false, error: 'cluster_id_required', message: 'cluster_id is required' });
        return json(200, await models.approvalTopic(clusterId));
      }
      if (routePath === '/webhook/approval/search-refresh/status/v1' || pathname === '/panel/read-models/approval/search-refresh/status') {
        if (upperMethod === 'GET') return searchRefreshStatus(searchParams);
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || searchRefreshStatus(searchParams, await readJson(read));
      }
      if (routePath === '/webhook/approval/decision/v2') {
        const wrong = assertMethod(upperMethod, 'POST');
        if (wrong) return wrong;
        if (!useCases.decideApproval) throw new DomainError('approval adapter is not configured', { statusCode: 503 });
        const body = await readJson(read);
        const result = await useCases.decideApproval.execute(body);
        if (result.enqueued && result.id_noticia) {
          if (jobQueue && useCases.draftScript) {
            try {
              jobQueue.enqueue('draft-script', { id_noticia: result.id_noticia });
            } catch {
              void useCases.draftScript.execute({ id_noticia: result.id_noticia }).catch(() => {});
            }
          } else if (useCases.draftScript) {
            void useCases.draftScript.execute({ id_noticia: result.id_noticia }).catch(() => {});
          }
        }
        return json(200, result);
      }
      if (routePath === '/webhook/approval/search-refresh/v2') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || startRefresh(await readJson(read));
      }
      if (routePath === '/webhook/mvp-script-drafts-pending/v2' || pathname === '/panel/read-models/scripts/drafts') {
        const wrong = assertMethod(upperMethod, 'GET');
        return wrong || json(200, await models.scriptDrafts());
      }
      if (routePath === '/webhook/mvp-script-draft-save/v2') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || saveDraft(await readJson(read));
      }
      if (routePath === '/webhook/mvp-script-publish/v2') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || startPublish(await readJson(read));
      }
      if (routePath === '/webhook/mvp-script-publish-status/v1') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || publishStatus(await readJson(read));
      }
      if (routePath === '/webhook/mvp-script-download-doc/v1') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || downloadDocument(await readJson(read));
      }
      if (routePath === '/webhook/video-projects/manual-create/v1') {
        const wrong = assertMethod(upperMethod, 'POST');
        return wrong || startManual(await readJson(read));
      }
      return json(404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (error instanceof SyntaxError) return json(400, { ok: false, error: 'invalid_json' });
      return errorResponse(error);
    }
  }

  return {
    mutationRoutes: LOCAL_MUTATION_ROUTES,
    matches,
    handle,
    isMutation(pathname = '') {
      return LOCAL_MUTATION_ROUTES.some((route) => route.path === pathname);
    },
  };
}

export { JSON_LIMIT as LOCAL_ROUTER_JSON_LIMIT };
