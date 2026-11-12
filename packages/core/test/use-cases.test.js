import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  ClusterTopics,
  DecideApproval,
  DiscoverNews,
  DraftScript,
  ManualCreateVideoProject,
  PublishScript,
  SaveScriptDraft,
  CreateVideoProject,
  RefreshSearch,
  buildReadModels,
  createExportDocument,
} from '../src/index.js';
import {
  ARTICLE_FIXTURE,
  CLUSTER_FIXTURE,
  NEWS_FIXTURE,
  createHarness,
  createMockLLM,
  seedApprovalCluster,
  seedPublishableDraft,
} from './helpers.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');

function articleExtractor(result = ARTICLE_FIXTURE) {
  const calls = [];
  return {
    calls,
    async extract(input) {
      calls.push(input);
      return result;
    },
  };
}

function imageSearch(images = [{ imageUrl: 'https://img.example.local/1.jpg', title: 'Demo' }]) {
  return {
    async search(input) {
      return { ok: true, images, query: input.query };
    },
  };
}

function documentExport() {
  const documents = [];
  return {
    documents,
    async createDocument(input) {
      documents.push(input);
      return { doc_id: 'doc-1', doc_url: 'https://docs.example.local/doc-1' };
    },
    async exportDocument(input) {
      return {
        filename: `${input.title}.docx`,
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: Buffer.from('docx-bytes'),
      };
    },
  };
}

describe('DiscoverNews', () => {
  it('filters feeds, classifies ambiguous rows and persists a live universe', async () => {
    const { repository } = await createHarness();
    const direct = {
      ...NEWS_FIXTURE[0],
      fecha_publicacion: NOW.toISOString(),
    };
    const ambiguous = {
      ...NEWS_FIXTURE[1],
      id_noticia: 'news-3',
      titular: 'Andrade visitó una escuela de su ciudad',
      snippet: 'Actividad social fuera del deporte',
      link: 'https://news.example.local/andrade-3',
      fecha_publicacion: NOW.toISOString(),
      pass_direct: undefined,
      football_signals: undefined,
    };
    const useCase = new DiscoverNews({
      repository,
      now: () => NOW,
      newsSource: {
        async fetchFeed(request) {
          return request.jugador === 'Nicolás Andrade' ? [direct, ambiguous] : [];
        },
      },
      llm: createMockLLM('{"results":[{"id_noticia":"news-3","es_futbol":true,"razon":"futbol"}]}'),
      players: [{ seleccion: 'Aurenia', jugador: 'Nicolás Andrade' }],
    });

    const result = await useCase.execute({ window: '24h' });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'live');
    assert.equal(result.received, 2);
    assert.equal(result.persisted, 2);
    assert.equal(result.sample.length, 2);

    const listed = await repository.listNewsForClustering({});
    assert.equal(listed.count, 2);
    assert.deepEqual(listed.rows.map((row) => row.classification_source).sort(), ['ai', 'heuristic']);
  });

  it('points every per-player request at one configured local feed', async () => {
    const { repository } = await createHarness();
    const requested = [];
    const useCase = new DiscoverNews({
      repository,
      now: () => NOW,
      feedUrl: 'http://panel/assets/demo/discovery.xml',
      players: [
        { seleccion: 'Aurenia', jugador: 'Nicolás Andrade' },
        { seleccion: 'Montelia', jugador: 'Leonel Márquez' },
      ],
      newsSource: {
        async fetchFeed(request) {
          requested.push(request);
          return [];
        },
      },
      llm: createMockLLM('{"results":[]}'),
    });

    await useCase.execute({ window: '24h' });

    assert.equal(requested.length, 2);
    for (const request of requested) {
      assert.equal(request.feed_url, 'http://panel/assets/demo/discovery.xml');
      assert.equal(request.source_kind, 'local_rss');
    }
  });

  it('stages discovery under a run without touching the live approval universe', async () => {
    const { repository } = await createHarness();
    const run = await repository.createNewsSearchRun({ requestedWindow: '1h' });
    const useCase = new DiscoverNews({
      repository,
      now: () => NOW,
      newsSource: {
        async fetchFeed() {
          return [{ ...NEWS_FIXTURE[0], fecha_publicacion: NOW.toISOString() }];
        },
      },
      llm: createMockLLM('{"results":[]}'),
      players: [{ seleccion: 'Aurenia', jugador: 'Nicolás Andrade' }],
    });

    const result = await useCase.execute({ window: '1h', runId: run.run_id });
    assert.equal(result.mode, 'staging');
    assert.equal(result.run_id, run.run_id);
    assert.equal((await repository.listNewsForClustering({})).count, 0);
    assert.equal((await repository.listNewsForClustering({ runId: run.run_id })).count, 1);
    const updated = await repository.getNewsSearchRun(run.run_id);
    assert.equal(updated.status, 'discovery_succeeded');
  });
});

describe('ClusterTopics', () => {
  it('persists model clusters with joined source metadata and average position', async () => {
    const { repository } = await createHarness();
    await repository.upsertNews(structuredClone(NEWS_FIXTURE));
    const llm = createMockLLM(JSON.stringify({
      clusters: [
        {
          cluster_id: CLUSTER_FIXTURE.cluster_id,
          seleccion: 'Aurenia',
          jugador: 'Nicolás Andrade',
          tema_principal: CLUSTER_FIXTURE.tema_principal,
          resumen_cluster: CLUSTER_FIXTURE.resumen_cluster,
          tag_editorial: 'club',
          source_ids: ['news-1', 'news-2'],
        },
      ],
    }));
    const useCase = new ClusterTopics({ repository, llm });

    const result = await useCase.execute({});
    assert.equal(result.status, 'ok');
    assert.equal(result.clustered, 2);
    assert.equal(result.clusters.length, 1);
    const pending = await repository.listPendingApprovalClusters();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].cantidad_fuentes, 2);
    assert.equal(pending[0].avg_google_position, 1.5);
  });

  it('returns an empty result without calling the model when there is no news', async () => {
    const { repository } = await createHarness();
    const llm = createMockLLM('{"clusters":[]}');
    const useCase = new ClusterTopics({ repository, llm });
    const result = await useCase.execute({});
    assert.deepEqual(result, { status: 'ok', clustered: 0, clusters: [] });
    assert.equal(llm.calls.length, 0);
  });
});

describe('DecideApproval', () => {
  it('applies an approval and records one pending script job', async () => {
    const { repository } = await createHarness();
    await seedApprovalCluster(repository);
    const useCase = new DecideApproval({ repository });

    const result = await useCase.execute({
      id_noticia: 'news-1',
      cluster_id: CLUSTER_FIXTURE.cluster_id,
      action: 'approve',
    });
    assert.equal(result.ok, true);
    assert.equal(result.enqueued, true);
    assert.equal(result.job_id, 'news-1');
    assert.equal(result.status, 'pendiente');
    assert.equal((await repository.getScriptQueueMonitor()).length, 1);
  });

  it('rejects invalid actions and missing approve identities', async () => {
    const { repository } = await createHarness();
    const useCase = new DecideApproval({ repository });
    await assert.rejects(() => useCase.execute({ action: 'maybe' }), /action/i);
    await assert.rejects(() => useCase.execute({ action: 'approve' }), /id_noticia/i);
  });
});

describe('DraftScript', () => {
  async function setup() {
    const { repository } = await createHarness();
    await seedApprovalCluster(repository);
    await repository.applyApprovalDecision({
      idNoticia: 'news-1',
      clusterId: CLUSTER_FIXTURE.cluster_id,
      action: 'approve',
    });
    return { repository };
  }

  it('claims a job, extracts the source, generates a draft and completes the job', async () => {
    const { repository } = await setup();
    const draft = Array.from({ length: 240 }, (_, index) => (index === 0 ? 'Andrade' : 'palabra')).join(' ');
    const useCase = new DraftScript({
      repository,
      articleExtractor: articleExtractor(),
      llm: createMockLLM(draft),
    });

    const result = await useCase.execute({ id_noticia: 'news-1' });
    assert.equal(result.status, 'completed');
    assert.equal(result.draft.draft_id, 'draft-news-1');
    assert.equal(result.draft.estado_guion, 'borrador');
    assert.equal((await repository.getPendingScriptDrafts()).length, 1);
    const [job] = await repository.getScriptQueueMonitor();
    assert.equal(job.estado_queue, 'completado');
    assert.equal(job.progress_percent, 100);
  });

  it('fails the job when the article is rejected as betting content', async () => {
    const { repository } = await setup();
    const useCase = new DraftScript({
      repository,
      articleExtractor: articleExtractor({
        ...ARTICLE_FIXTURE,
        main_content: `${ARTICLE_FIXTURE.main_content} Las casas de apuestas publicaron sus cuotas.`,
      }),
      llm: createMockLLM('no deberia usarse'),
    });

    const result = await useCase.execute({ id_noticia: 'news-1' });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /betting/i);
    const [job] = await repository.getScriptQueueMonitor();
    assert.equal(job.estado_queue, 'fallido');
    assert.match(job.last_error, /betting/i);
    assert.equal((await repository.getPendingScriptDrafts()).length, 0);
  });

  it('returns a job to the queue when the model output is too short', async () => {
    const { repository } = await setup();
    const useCase = new DraftScript({
      repository,
      articleExtractor: articleExtractor(),
      llm: createMockLLM('texto demasiado corto'),
    });

    const result = await useCase.execute({ id_noticia: 'news-1' });
    assert.equal(result.status, 'retry_later');
    const [job] = await repository.getScriptQueueMonitor();
    assert.equal(job.estado_queue, 'pendiente');
    assert.equal(job.progress_stage, 'retry_later');
    assert.equal(job.attempts, 1);
  });

  it('is idempotent for jobs that are not claimable', async () => {
    const { repository } = await setup();
    const draft = Array.from({ length: 240 }, () => 'palabra').join(' ');
    const useCase = new DraftScript({
      repository,
      articleExtractor: articleExtractor(),
      llm: createMockLLM(draft),
    });
    await useCase.execute({ id_noticia: 'news-1' });
    const skipped = await useCase.execute({ id_noticia: 'news-1' });
    assert.equal(skipped.status, 'skipped');
  });
});

describe('PublishScript', () => {
  function createUseCase(repository, overrides = {}) {
    return new PublishScript({
      repository,
      createVideoProject: new CreateVideoProject({ repository, now: () => NOW }),
      llm: createMockLLM('Móises Andrade anotó y fue figura'),
      documentExport: documentExport(),
      imageSearch: imageSearch(),
      now: () => NOW,
      createJobId: () => 'pub-test-1',
      ...overrides,
    });
  }

  it('starts a publish job and completes the document, image and video-project flow', async () => {
    const { repository } = await createHarness();
    await seedPublishableDraft(repository);
    const useCase = createUseCase(repository);

    const started = await useCase.start({ draft_id: 'draft-news-1' });
    assert.equal(started.job_id, 'pub-test-1');
    assert.equal(started.status, 'queued');
    assert.ok(await repository.getPublishJob('pub-test-1'));

    const result = await useCase.process('pub-test-1');
    assert.equal(result.status, 'completed');
    const job = await repository.getPublishJob('pub-test-1');
    assert.equal(job.status, 'completed');
    const draft = await repository.getPublishableScriptDraft({ draftId: 'draft-news-1' });
    assert.equal(draft.estado_guion, 'publicado');
    assert.equal(draft.doc_id, 'doc-1');
    const projects = await repository.getVideoEditProjects({ draftId: 'draft-news-1' });
    assert.equal(projects.projects.length, 1);
    assert.ok(projects.projects[0].segments.length >= 1);
    assert.equal(projects.projects[0].image_candidates.length, 1);
  });

  it('marks the publish job failed when document export fails', async () => {
    const { repository } = await createHarness();
    await seedPublishableDraft(repository);
    const useCase = createUseCase(repository, {
      documentExport: {
        async createDocument() {
          throw new Error('export unavailable');
        },
        async exportDocument() {
          throw new Error('not used');
        },
      },
    });
    await useCase.start({ draft_id: 'draft-news-1' });
    const result = await useCase.process('pub-test-1');
    assert.equal(result.status, 'failed');
    const job = await repository.getPublishJob('pub-test-1');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /export unavailable/);
  });

  it('rejects publish requests without any draft identity', async () => {
    const { repository } = await createHarness();
    const useCase = createUseCase(repository);
    await assert.rejects(() => useCase.start({}), /draft_id|id_noticia|cluster_id/i);
  });
});

describe('ManualCreateVideoProject', () => {
  it('creates the manual records and finalizes image candidates asynchronously', async () => {
    const { repository } = await createHarness();
    const useCase = new ManualCreateVideoProject({
      repository,
      imageSearch: imageSearch(),
      now: () => NOW,
      createJobId: () => 'manual-job-1',
    });

    const started = await useCase.start({
      titular: 'Manual: Andrade en el Costa Azul FC',
      guion: 'Nicolás Andrade anotó y fue figura del partido.',
      jugador: 'Nicolás Andrade',
      seleccion: 'Aurenia',
      tema_principal: 'Manual Andrade',
    });
    assert.equal(started.job_id, 'manual-job-1');
    assert.equal(started.status, 'queued');
    assert.equal((await repository.getVideoEditProjects({ limit: 10 })).projects.length, 1);

    const result = await useCase.process('manual-job-1');
    assert.equal(result.status, 'completed');
    const projects = await repository.getVideoEditProjects({ draftId: started.draft_id });
    assert.equal(projects.projects[0].image_candidates.length, 1);
    const job = await repository.getPublishJob('manual-job-1');
    assert.equal(job.status, 'completed');
  });
});

describe('RefreshSearch', () => {
  it('runs discovery and clustering in staging then promotes the run atomically', async () => {
    const { repository } = await createHarness();
    const discover = new DiscoverNews({
      repository,
      now: () => NOW,
      newsSource: {
        async fetchFeed() {
          return [{ ...NEWS_FIXTURE[0], fecha_publicacion: NOW.toISOString() }];
        },
      },
      llm: createMockLLM('{"results":[]}'),
      players: [{ seleccion: 'Aurenia', jugador: 'Nicolás Andrade' }],
    });
    const cluster = new ClusterTopics({
      repository,
      llm: createMockLLM(JSON.stringify({
        clusters: [{
          cluster_id: CLUSTER_FIXTURE.cluster_id,
          seleccion: 'Aurenia',
          jugador: 'Nicolás Andrade',
          tema_principal: CLUSTER_FIXTURE.tema_principal,
          source_ids: ['news-1'],
        }],
      })),
    });
    const useCase = new RefreshSearch({ repository, discoverNews: discover, clusterTopics: cluster });

    const result = await useCase.execute({ window: '1h' });
    assert.equal(result.status, 'ok');
    assert.equal(result.promote.status, 'promoted');
    assert.equal(result.promote.promoted_news, 1);
    assert.equal(result.promote.promoted_clusters, 1);
    assert.equal((await repository.listPendingApprovalClusters()).length, 1);
    assert.equal((await repository.getNewsSearchRun(result.run_id)).status, 'promoted');
  });
});

describe('ReadModels and ExportDocument', () => {
  it('shapes approval, script and search read models without transport details', async () => {
    const { repository } = await createHarness();
    await seedPublishableDraft(repository);
    const readModels = buildReadModels({ repository });

    const pending = await readModels.pendingApproval();
    assert.equal(pending.ok, true);
    assert.equal(pending.total, 1);
    const scripts = await readModels.scriptDrafts();
    assert.equal(scripts.status, 'ok');
    assert.equal(scripts.total, 1);
    const queue = await readModels.approvalQueue();
    assert.equal(queue.total, 1);
    const detail = await readModels.approvalTopic('missing-cluster');
    assert.equal(detail.item, null);
  });

  it('exports a published script through the document port and rejects missing docs', async () => {
    const { repository } = await createHarness();
    await seedPublishableDraft(repository);
    await repository.finalizeScriptPublish({
      draftId: 'draft-news-1',
      idNoticia: 'news-1',
      clusterId: CLUSTER_FIXTURE.cluster_id,
      docId: 'doc-9',
      docUrl: 'https://docs.example.local/doc-9',
      guionEditado: 'Guion publicado',
    });
    const exportDocument = createExportDocument({
      repository,
      documentExport: documentExport(),
    });
    const result = await exportDocument.execute({ draft_id: 'draft-news-1' });
    assert.equal(result.filename.includes('docx'), true);
    assert.equal(result.bytes.toString(), 'docx-bytes');

    await repository.saveScriptDraft({
      draftId: 'draft-no-doc',
      idNoticia: 'news-2',
      clusterId: CLUSTER_FIXTURE.cluster_id,
      guionEditado: 'Sin doc',
    });
    await assert.rejects(
      () => exportDocument.execute({ draft_id: 'draft-no-doc' }),
      /Google Doc|documento/i,
    );
  });
});

describe('DiscoverNews classifier fallback', () => {
  function ambiguousRow(overrides = {}) {
    return {
      ...NEWS_FIXTURE[1],
      id_noticia: 'news-ambiguous',
      titular: 'Andrade visitó una escuela de su ciudad',
      snippet: 'Actividad social fuera del deporte',
      link: 'https://news.example.local/andrade-ambiguous',
      fecha_publicacion: NOW.toISOString(),
      pass_direct: undefined,
      football_signals: undefined,
      ...overrides,
    };
  }

  async function runWith(llms, row = ambiguousRow()) {
    const { repository } = await createHarness();
    const useCase = new DiscoverNews({
      repository,
      now: () => NOW,
      newsSource: { async fetchFeed() { return [row]; } },
      players: [{ seleccion: 'Aurenia', jugador: 'Nicolás Andrade' }],
      batchSize: 10,
      ...llms,
    });
    const summary = await useCase.execute({ window: '24h' });
    const listed = await repository.listNewsForClustering({});
    return { summary, rows: listed.rows };
  }

  it('falls back to the next configured model before marking a batch for review', async () => {
    const failing = { async complete() { throw new Error('primary model unavailable'); } };
    const fallback = createMockLLM('{"results":[{"id_noticia":"news-ambiguous","es_futbol":true,"razon":"futbol"}]}');
    const { rows } = await runWith({ llm: failing, fallbackLlms: [fallback] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classification_source, 'ai');
    assert.equal(fallback.calls.length, 1);
  });

  it('keeps unclassified rows as needs_review instead of silently dropping them', async () => {
    const failing = { async complete() { throw new Error('classifier offline'); } };
    const { summary, rows } = await runWith({ llm: failing });
    assert.equal(summary.persisted, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classification_source, 'needs_review');
    assert.equal(rows[0].estado_revision, 'pendiente');
  });

  it('marks ambiguous rows for review when no classifier is configured', async () => {
    const { rows } = await runWith({ llm: null });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classification_source, 'needs_review');
  });
});

describe('SaveScriptDraft', () => {
  it('persists an edited script and dismisses it from the pending panel', async () => {
    const { repository } = await createHarness();
    const useCase = new SaveScriptDraft({ repository });

    const saved = await useCase.execute({
      draftId: 'draft-news-1',
      guionEditado: 'Nicolás Andrade anotó y fue figura.',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.draft.guion_editado, 'Nicolás Andrade anotó y fue figura.');
    assert.equal((await repository.getPendingScriptDrafts()).length, 1);

    const dismissed = await useCase.execute({ draftId: 'draft-news-1', action: 'dismiss_processed' });
    assert.equal(dismissed.dismissed, true);
    assert.equal((await repository.getPendingScriptDrafts()).length, 0);
  });

  it('rejects unknown actions and requests without a draft identity', async () => {
    const { repository } = await createHarness();
    const useCase = new SaveScriptDraft({ repository });
    await assert.rejects(() => useCase.execute({ action: 'maybe' }), /draft_id/i);
    await assert.rejects(() => useCase.execute({ draftId: 'draft-1', action: 'maybe' }), /unknown action/i);
  });
});
