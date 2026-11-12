import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  ClusterTopics,
  CreateVideoProject,
  DecideApproval,
  DiscoverNews,
  DraftScript,
  JobQueue,
  ManualCreateVideoProject,
  PublishScript,
  RefreshSearch,
  createExportDocument,
} from '../../../packages/core/src/index.js';
import { InMemoryRepository } from '../../../packages/data/src/index.js';
import { createLocalRouter } from '../src/local-router.js';
import { DemoArticleExtractor, DemoLLMAdapter } from '../../../packages/adapters/src/demo.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');

const NEWS = [
  {
    id_noticia: 'news-1',
    seleccion: 'Ecuador',
    jugador: 'Moisés Caicedo',
    titular: 'Caicedo anotó en la victoria del Chelsea',
    fuente: 'Example Sports',
    fecha_publicacion: '2026-11-10T10:00:00.000Z',
    link: 'https://news.example.local/caicedo-1',
    snippet: 'El mediocampista marcó el primer gol.',
    estado_revision: 'pendiente',
    tema_principal: 'Gol de Caicedo',
    google_position: 1,
  },
  {
    id_noticia: 'news-2',
    seleccion: 'Ecuador',
    jugador: 'Moisés Caicedo',
    titular: 'Caicedo, titular ante el Arsenal',
    fuente: 'Example Football',
    fecha_publicacion: '2026-11-10T09:00:00.000Z',
    link: 'https://news.example.local/caicedo-2',
    snippet: 'El técnico confirmó la alineación.',
    estado_revision: 'pendiente',
    tema_principal: 'Alineación',
    google_position: 2,
  },
];

const CLUSTER = {
  cluster_id: 'cluster-caicedo',
  seleccion: 'Ecuador',
  jugador: 'Moisés Caicedo',
  tema_principal: 'Regreso de Caicedo',
  resumen_cluster: 'Caicedo entrenó y fue titular.',
  tag_editorial: 'club',
  fecha_creacion_cluster: '2026-11-10T11:00:00.000Z',
  sources: [
    { id_noticia: 'news-1', source_order: 0, source_title_snapshot: NEWS[0].titular },
    { id_noticia: 'news-2', source_order: 1, source_title_snapshot: NEWS[1].titular },
  ],
};

function bodyReader(bytes) {
  return async () => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)));
}

function jsonBody(body) {
  return bodyReader(Buffer.from(JSON.stringify(body)));
}

function mockLlm(...texts) {
  let index = 0;
  return {
    async complete() {
      const text = texts[Math.min(index, texts.length - 1)];
      index += 1;
      return { text, model: 'mock' };
    },
  };
}

async function seedDraft(repository) {
  await repository.upsertNews(structuredClone(NEWS));
  await repository.persistClusters([structuredClone(CLUSTER)]);
  await repository.applyApprovalDecision({ idNoticia: 'news-1', clusterId: CLUSTER.cluster_id, action: 'approve' });
  await repository.claimScriptJob({ idNoticia: 'news-1' });
  await repository.completeScriptJob({
    idNoticia: 'news-1',
    draftId: 'draft-news-1',
    guionDraft: 'Moisés Caicedo anotó y fue figura del partido.',
    guionEditado: 'Moisés Caicedo anotó y fue figura del partido.',
    wordCount: 9,
  });
}

function createDocumentAdapter() {
  return {
    async createDocument() {
      return { doc_id: 'doc-1', doc_url: 'https://docs.example.local/doc-1' };
    },
    async exportDocument() {
      return {
        filename: 'guion.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: Buffer.from('docx-bytes'),
      };
    },
  };
}

async function createHarness() {
  const repository = new InMemoryRepository();
  await repository.migrate();
  const createVideoProject = new CreateVideoProject({ repository, now: () => NOW });
  const discoverNews = new DiscoverNews({
    repository,
    now: () => NOW,
    newsSource: { async fetchFeed() { return [{ ...NEWS[0], fecha_publicacion: NOW.toISOString() }]; } },
    llm: mockLlm('{"results":[]}'),
    players: [{ seleccion: 'Ecuador', jugador: 'Moisés Caicedo' }],
  });
  const clusterTopics = new ClusterTopics({
    repository,
    llm: mockLlm(JSON.stringify({ clusters: [{ ...CLUSTER, source_ids: ['news-1'] }] })),
  });
  const refreshSearch = new RefreshSearch({ repository, discoverNews, clusterTopics, now: () => NOW });
  const publishScript = new PublishScript({
    repository,
    createVideoProject,
    llm: mockLlm('Moisés Caicedo'),
    documentExport: createDocumentAdapter(),
    imageSearch: {
      async search() {
        return { images: [{ imageUrl: 'https://img.example.local/1.jpg', title: 'Demo' }] };
      },
    },
    now: () => NOW,
    createJobId: () => 'pub-router-1',
  });
  const manualCreateVideoProject = new ManualCreateVideoProject({
    repository,
    imageSearch: {
      async search() {
        return { images: [{ imageUrl: 'https://img.example.local/2.jpg', title: 'Manual' }] };
      },
    },
    now: () => NOW,
    createJobId: () => 'manual-router-1',
  });
  const exportDocument = createExportDocument({ repository, documentExport: createDocumentAdapter() });
  const draftScript = new DraftScript({
    repository,
    articleExtractor: new DemoArticleExtractor(),
    llm: new DemoLLMAdapter(),
  });
  const jobQueue = new JobQueue({
    handlers: {
      'refresh-search': (payload) => refreshSearch.processRun(payload.run_id, { window: payload.window }),
      'publish-script': (payload) => publishScript.process(payload.job_id),
      'manual-video': (payload) => manualCreateVideoProject.process(payload.job_id),
      'draft-script': (payload) => draftScript.execute(payload),
    },
  });
  const router = createLocalRouter({
    repository,
    jobQueue,
    useCases: {
      decideApproval: new DecideApproval({ repository }),
      draftScript,
      publishScript,
      manualCreateVideoProject,
      exportDocument,
      refreshSearch,
    },
  });
  return { repository, router, jobQueue };
}

describe('local API router', () => {
  let repository;
  let router;
  let jobQueue;

  beforeEach(async () => {
    ({ repository, router, jobQueue } = await createHarness());
  });

  it('serves pending, queue and topic read models on both legacy and panel paths', async () => {
    await repository.upsertNews(structuredClone(NEWS));
    await repository.persistClusters([structuredClone(CLUSTER)]);

    const pending = await router.handle({ method: 'GET', pathname: '/webhook/approval/pending/supabase/v2' });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.ok, true);
    assert.equal(pending.body.total, 1);

    const panelPending = await router.handle({ method: 'GET', pathname: '/panel/read-models/approval/pending' });
    assert.deepEqual(panelPending.body, pending.body);

    const topic = await router.handle({
      method: 'GET',
      pathname: '/webhook/approval/topic/supabase/v2',
      searchParams: new URLSearchParams('cluster_id=cluster-caicedo'),
    });
    assert.equal(topic.body.item.cluster_id, 'cluster-caicedo');

    const missing = await router.handle({
      method: 'GET',
      pathname: '/webhook/approval/topic/supabase/v2',
    });
    assert.equal(missing.status, 400);
  });

  it('enqueues the script draft job after an approval', async () => {
    await repository.upsertNews(structuredClone(NEWS));
    await repository.persistClusters(structuredClone(CLUSTER));
    const response = await router.handle({
      method: 'POST',
      pathname: '/webhook/approval/decision/supabase/v2',
      readBody: jsonBody({ id_noticia: 'news-1', cluster_id: CLUSTER.cluster_id, action: 'approve' }),
    });
    assert.equal(response.status, 200);
    assert.equal(jobQueue.list().some((job) => job.name === 'draft-script'), true);
    await jobQueue.drain();
    const drafts = await repository.getPendingScriptDrafts();
    assert.equal(drafts.some((draft) => draft.id_noticia === 'news-1'), true);
  });

  it('applies approval decisions through the local use case', async () => {
    await repository.upsertNews(structuredClone(NEWS));
    await repository.persistClusters([structuredClone(CLUSTER)]);
    const response = await router.handle({
      method: 'POST',
      pathname: '/webhook/approval/decision/supabase/v2',
      readBody: jsonBody({ id_noticia: 'news-1', cluster_id: CLUSTER.cluster_id, action: 'approve' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.enqueued, true);
    assert.equal((await repository.getScriptQueueMonitor()).length, 1);

    const invalid = await router.handle({
      method: 'POST',
      pathname: '/webhook/approval/decision/supabase/v2',
      readBody: jsonBody({ action: 'maybe' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'validation_error');
  });

  it('saves and dismisses drafts and serves the script read model', async () => {
    await seedDraft(repository);
    const drafts = await router.handle({ method: 'GET', pathname: '/webhook/mvp-script-drafts-pending/supabase/v2' });
    assert.equal(drafts.body.total, 1);
    assert.equal(drafts.body.drafts[0].draft_id, 'draft-news-1');

    const saved = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-draft-save/supabase/v2',
      readBody: jsonBody({ draft_id: 'draft-news-1', guion_editado: 'Guion editado por la redacción' }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.draft.guion_editado, 'Guion editado por la redacción');

    const dismissed = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-draft-save/supabase/v2',
      readBody: jsonBody({ draft_id: 'draft-news-1', action: 'dismiss_processed' }),
    });
    assert.equal(dismissed.body.ok, true);
    assert.equal((await repository.getPendingScriptDrafts()).length, 0);
  });

  it('publishes asynchronously, reports status and downloads the document', async () => {
    await seedDraft(repository);
    const started = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-publish/supabase/v2',
      readBody: jsonBody({ draft_id: 'draft-news-1' }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.job_id, 'pub-router-1');
    assert.equal(started.body.status, 'queued');

    await jobQueue.drain();
    const status = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-publish-status/supabase/v1',
      readBody: jsonBody({ job_id: 'pub-router-1' }),
    });
    assert.equal(status.body.status, 'completed');
    assert.equal(status.body.stage, 'completed');

    const download = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-download-doc/supabase/v1',
      readBody: jsonBody({ draft_id: 'draft-news-1' }),
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers['content-type'].includes('wordprocessingml'), true);
    assert.match(download.headers['content-disposition'], /guion\.docx/);
    assert.equal(download.body.toString(), 'docx-bytes');
  });

  it('starts a search refresh asynchronously and exposes status polling', async () => {
    const response = await router.handle({
      method: 'POST',
      pathname: '/webhook/approval/search-refresh/supabase/v2',
      readBody: jsonBody({ window: '1h' }),
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.status, 'accepted');
    assert.ok(response.body.run_id);

    await jobQueue.drain();
    const status = await router.handle({
      method: 'POST',
      pathname: '/webhook/approval/search-refresh/status/supabase/v1',
      readBody: jsonBody({ run_id: response.body.run_id }),
    });
    assert.equal(status.body.status, 'succeeded');
    assert.equal(status.body.stats.staged_clusters, 1);
  });

  it('creates a manual video project asynchronously', async () => {
    const response = await router.handle({
      method: 'POST',
      pathname: '/webhook/video-projects/manual-create/v1',
      readBody: jsonBody({
        titulo: 'Manual Caicedo',
        jugador: 'Moisés Caicedo',
        seleccion: 'Ecuador',
        guion: 'Moisés Caicedo anotó y fue figura del partido.',
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.job_id, 'manual-router-1');
    assert.equal((await repository.getVideoEditProjects({ limit: 10 })).projects.length, 1);

    await jobQueue.drain();
    const projects = await repository.getVideoEditProjects({ draftId: response.body.draft_id });
    assert.equal(projects.projects[0].image_candidates.length, 1);
  });

  it('returns method and payload errors without leaking stack traces', async () => {
    const wrongMethod = await router.handle({ method: 'POST', pathname: '/webhook/approval/pending/supabase/v2' });
    assert.equal(wrongMethod.status, 405);

    const invalidJson = await router.handle({
      method: 'POST',
      pathname: '/webhook/mvp-script-draft-save/supabase/v2',
      readBody: bodyReader(Buffer.from('{not json')),
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error, 'invalid_json');

    const missing = await router.handle({ method: 'GET', pathname: '/webhook/unknown' });
    assert.equal(missing.status, 404);
  });
});
