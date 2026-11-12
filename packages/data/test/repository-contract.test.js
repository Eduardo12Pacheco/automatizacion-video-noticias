import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

const NEWS_FIXTURE = [
  {
    id_noticia: 'news-1',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Andrade',
    titular: 'Andrade vuelve a entrenar con el Costa Azul FC',
    fuente: 'Example Sports',
    fecha_publicacion: '2026-11-10T10:00:00.000Z',
    link: 'https://news.example.local/andrade-1',
    snippet: 'El mediocampista trabajó con el grupo.',
    fuente_origen: 'google_news_rss',
    estado_revision: 'pendiente',
    tema_principal: 'Regreso de Andrade',
    google_position: 1,
    classification_source: 'heuristic',
    football_signals: 'entrenamiento || club',
    pass_direct: true,
  },
  {
    id_noticia: 'news-2',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Andrade',
    titular: 'Andrade, titular ante el Bahía Norte FC',
    fuente: 'Example Football',
    fecha_publicacion: '2026-11-10T09:00:00.000Z',
    link: 'https://news.example.local/andrade-2',
    snippet: 'El técnico confirmó la alineación.',
    fuente_origen: 'google_news_rss',
    estado_revision: 'pendiente',
    tema_principal: 'Regreso de Andrade',
    google_position: 2,
    classification_source: 'ai',
    football_signals: 'partido || titular',
    pass_direct: false,
  },
];

const CLUSTER_FIXTURE = {
  cluster_id: 'cluster-andrade-20261110',
  seleccion: 'Aurenia',
  jugador: 'Nicolás Andrade',
  tema_principal: 'Regreso de Andrade al Costa Azul FC',
  resumen_cluster: 'Andrade entrenó y fue titular.',
  tag_editorial: 'club',
  fecha_creacion_cluster: '2026-11-10T11:00:00.000Z',
  avg_google_position: 1.5,
  sources: [
    { id_noticia: 'news-1', source_order: 0, source_title_snapshot: NEWS_FIXTURE[0].titular },
    { id_noticia: 'news-2', source_order: 1, source_title_snapshot: NEWS_FIXTURE[1].titular },
  ],
};

async function seedApprovalUniverse(repo) {
  const upserted = await repo.upsertNews(NEWS_FIXTURE);
  assert.equal(upserted.upserted, 2);
  const persisted = await repo.persistClusters([CLUSTER_FIXTURE]);
  assert.equal(persisted.upserted, 1);
}

export function runRepositoryContract({ label, createHarness }) {
  describe(`repository contract: ${label}`, () => {
    let harness;
    let repo;

    beforeEach(async () => {
      harness = await createHarness();
      repo = harness.repo;
      await harness.reset();
    });

    after(async () => {
      await harness?.close?.();
    });

    it('exposes roles seeded by the migrations', async () => {
      const roles = await repo.listRoles();
      assert.deepEqual(roles.map((role) => role.role).sort(), ['admin', 'editor', 'viewer']);
    });

    it('upserts news rows and reports counts', async () => {
      const result = await repo.upsertNews(NEWS_FIXTURE);
      assert.deepEqual({ received: result.received, valid: result.valid, upserted: result.upserted }, {
        received: 2,
        valid: 2,
        upserted: 2,
      });

      const updated = await repo.upsertNews([{ ...NEWS_FIXTURE[0], titular: 'Titular actualizado' }]);
      assert.equal(updated.upserted, 1);

      const listed = await repo.listNewsForClustering({});
      assert.equal(listed.count, 2);
      const first = listed.rows.find((row) => row.id_noticia === 'news-1');
      assert.equal(first.titular, 'Titular actualizado');
      assert.equal(first.google_position, 1);
    });

    it('ignores invalid news rows and returns deterministic ordering', async () => {
      const result = await repo.upsertNews([
        { id_noticia: '', titular: 'sin id' },
        { id_noticia: 'news-x', titular: '' },
        NEWS_FIXTURE[0],
        NEWS_FIXTURE[1],
      ]);
      assert.equal(result.received, 4);
      assert.equal(result.valid, 2);
      const listed = await repo.listNewsForClustering({});
      assert.deepEqual(listed.rows.map((row) => row.id_noticia), ['news-1', 'news-2']);
    });

    it('persists clusters, links sources and builds the pending read model', async () => {
      await seedApprovalUniverse(repo);

      const pending = await repo.listPendingApprovalClusters();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].cluster_id, CLUSTER_FIXTURE.cluster_id);
      assert.equal(pending[0].cantidad_fuentes, 2);
      assert.equal(pending[0].tema_principal, CLUSTER_FIXTURE.tema_principal);
      assert.equal(Number(pending[0].avg_google_position), 1.5);

      const detail = await repo.getApprovalTopicDetail(CLUSTER_FIXTURE.cluster_id);
      assert.equal(detail.cluster_id, CLUSTER_FIXTURE.cluster_id);
      assert.equal(detail.sources.length, 2);
      assert.equal(detail.sources[0].id_noticia, 'news-1');
      assert.equal(detail.sources[0].index, 1);
      assert.equal(detail.cantidad_fuentes, 2);
    });

    it('applies approve/reject decisions and enqueues approved script jobs', async () => {
      await seedApprovalUniverse(repo);

      const approved = await repo.applyApprovalDecision({
        idNoticia: 'news-1',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        action: 'approve',
      });
      assert.equal(approved.estado_revision, 'aprobado');
      assert.equal(approved.approval_action, 'approve');

      const rejected = await repo.applyApprovalDecision({
        idNoticia: 'news-2',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        action: 'reject',
      });
      assert.equal(rejected.estado_revision, 'rechazado');
      assert.equal(rejected.approval_action, 'reject');

      const pending = await repo.listPendingApprovalClusters();
      assert.equal(pending.length, 0);

      const queue = await repo.getScriptQueueMonitor();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].id_noticia, 'news-1');
      assert.equal(queue[0].estado_queue, 'pendiente');
    });

    it('claims, progresses, completes and fails script jobs', async () => {
      await seedApprovalUniverse(repo);
      await repo.applyApprovalDecision({ idNoticia: 'news-1', clusterId: CLUSTER_FIXTURE.cluster_id, action: 'approve' });

      const claimed = await repo.claimScriptJob({ idNoticia: 'news-1' });
      assert.equal(claimed.id_noticia, 'news-1');
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.attempts, 1);
      assert.ok(claimed.started_at);

      const secondClaim = await repo.claimScriptJob({ idNoticia: 'news-1' });
      assert.equal(secondClaim, null);

      const progress = await repo.updateScriptJobProgress({
        idNoticia: 'news-1',
        status: 'running',
        stage: 'extracting',
        percent: 20,
      });
      assert.equal(progress.stage, 'extracting');
      assert.equal(progress.percent, 20);

      const completed = await repo.completeScriptJob({
        idNoticia: 'news-1',
        draftId: 'draft-news-1',
        guionDraft: 'Guion generado',
        guionEditado: 'Guion generado',
        wordCount: 2,
      });
      assert.equal(completed.job.status, 'completado');
      assert.equal(completed.job.percent, 100);
      assert.equal(completed.draft.draft_id, 'draft-news-1');
      assert.equal(completed.draft.estado_guion, 'borrador');
      assert.equal(completed.draft.guion_word_count, 2);

      const drafts = await repo.getPendingScriptDrafts();
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].draft_id, 'draft-news-1');

      const failed = await repo.failScriptJob({ idNoticia: 'news-1', error: 'boom' });
      assert.equal(failed.status, 'fallido');
      assert.equal(failed.last_error, 'boom');
    });

    it('saves, dismisses and publishes drafts', async () => {
      await seedApprovalUniverse(repo);
      await repo.applyApprovalDecision({ idNoticia: 'news-1', clusterId: CLUSTER_FIXTURE.cluster_id, action: 'approve' });
      await repo.claimScriptJob({ idNoticia: 'news-1' });
      await repo.completeScriptJob({
        idNoticia: 'news-1',
        draftId: 'draft-news-1',
        guionDraft: 'Borrador',
        guionEditado: 'Borrador',
        wordCount: 1,
      });

      const saved = await repo.saveScriptDraft({
        draftId: 'draft-news-1',
        idNoticia: 'news-1',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        guionEditado: 'Borrador editado por la redacción',
      });
      assert.equal(saved.guion_editado, 'Borrador editado por la redacción');
      assert.equal(saved.guion_word_count, 5);

      const publishable = await repo.getPublishableScriptDraft({ draftId: 'draft-news-1' });
      assert.equal(publishable.draft_id, 'draft-news-1');
      assert.equal(publishable.guion_editado, 'Borrador editado por la redacción');
      assert.equal(publishable.titular, NEWS_FIXTURE[0].titular);

      const finalized = await repo.finalizeScriptPublish({
        draftId: 'draft-news-1',
        idNoticia: 'news-1',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        docId: 'doc-123',
        docUrl: 'https://docs.example.local/document/d/doc-123',
        guionEditado: 'Borrador publicado',
      });
      assert.equal(finalized.estado_guion, 'publicado');
      assert.equal(finalized.doc_id, 'doc-123');
      assert.ok(finalized.fecha_publicacion);

      const pending = await repo.getPendingScriptDrafts();
      assert.equal(pending.length, 0);

      const dismissed = await repo.saveScriptDraft({
        draftId: 'draft-news-2',
        idNoticia: 'news-2',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        guionEditado: 'Otro borrador',
      });
      assert.equal(dismissed.estado_guion, 'borrador');
      const dismissResult = await repo.dismissScriptFromPanel({
        draftId: 'draft-news-2',
        idNoticia: 'news-2',
        clusterId: CLUSTER_FIXTURE.cluster_id,
      });
      assert.equal(dismissResult.ok, true);
      const pendingAfterDismiss = await repo.getPendingScriptDrafts();
      assert.equal(pendingAfterDismiss.length, 0);
    });

    it('tracks publish jobs and ignores updates after a terminal state', async () => {
      const created = await repo.createPublishJob({
        job_id: 'pub-1',
        draft_id: 'draft-news-1',
        id_noticia: 'news-1',
        cluster_id: CLUSTER_FIXTURE.cluster_id,
        status: 'queued',
        stage: 'queued',
        message: 'En cola',
        started_at: '2026-11-10T12:00:00.000Z',
      });
      assert.equal(created.status, 'queued');

      const running = await repo.updatePublishJob('pub-1', {
        status: 'running',
        stage: 'saving_script',
        message: 'Guardando',
      });
      assert.equal(running.stage, 'saving_script');
      assert.ok(running.updated_at);

      const completed = await repo.updatePublishJob('pub-1', {
        status: 'completed',
        stage: 'completed',
        finished_at: '2026-11-10T12:01:00.000Z',
      });
      assert.equal(completed.status, 'completed');

      const ignored = await repo.updatePublishJob(
        'pub-1',
        { status: 'running', stage: 'late_update' },
        { onlyActive: true },
      );
      assert.equal(ignored, null);

      const fetched = await repo.getPublishJob('pub-1');
      assert.equal(fetched.stage, 'completed');
      assert.equal(fetched.finished_at, '2026-11-10T12:01:00.000Z');
      assert.deepEqual(await repo.getPublishJob('missing'), null);
    });

    it('manages the video project lifecycle and hides disabled projects', async () => {
      await seedApprovalUniverse(repo);
      const project = await repo.upsertVideoProject({
        draft_id: 'draft-news-1',
        id_noticia: 'news-1',
        cluster_id: CLUSTER_FIXTURE.cluster_id,
        jugador: NEWS_FIXTURE[0].jugador,
        seleccion: NEWS_FIXTURE[0].seleccion,
        tema_principal: CLUSTER_FIXTURE.tema_principal,
        guion_editado: 'Guion',
        segments: [{ id: 'seg-001', order: 1, text: 'Guion' }],
        status: 'ready',
      });
      assert.equal(project.draft_id, 'draft-news-1');
      assert.equal(project.segments.length, 1);

      const listed = await repo.getVideoEditProjects({ limit: 50 });
      assert.equal(listed.ok, true);
      assert.equal(listed.projects.length, 1);

      const selections = await repo.saveVideoProjectSelections({
        draftId: 'draft-news-1',
        selectedImageIds: ['candidate-1', 'candidate-2'],
      });
      assert.deepEqual(selections.selected_images, ['candidate-1', 'candidate-2']);

      const editor = await repo.saveVideoProjectEditorState({
        draftId: 'draft-news-1',
        editorState: { phase: 'preview_ready', motion: { preset: 'clean' } },
      });
      assert.equal(editor.editor_state.phase, 'preview_ready');

      const audio = await repo.saveVideoProjectAudio({
        draftId: 'draft-news-1',
        voiceAudio: { public_url: '/panel/blobs/voice.m4a', kind: 'voice' },
        backgroundAudio: { public_url: '/panel/blobs/music.wav', kind: 'background' },
      });
      assert.equal(audio.voice_audio.kind, 'voice');
      assert.equal(audio.background_audio.kind, 'background');

      const added = await repo.addVideoProjectCustomImages({
        draftId: 'draft-news-1',
        customCandidates: [{ id: 'custom-1', storage_path: 'projects/x/custom/1.png' }],
      });
      assert.equal(added.added_count, 1);
      assert.equal(added.image_candidates.length, 1);

      const disabled = await repo.disableVideoEditProject({ draftId: 'draft-news-1' });
      assert.equal(disabled.ok, true);
      const afterDisable = await repo.getVideoEditProjects({ limit: 50 });
      assert.equal(afterDisable.projects.length, 0);
      assert.deepEqual(await repo.getVideoEditProjects({ draftId: 'draft-news-1' }), {
        ok: true,
        projects: [],
      });
    });

    it('stages discovery runs, lists staged news and promotes them atomically', async () => {
      const run = await repo.createNewsSearchRun({ requestedWindow: '1h' });
      assert.ok(run.run_id);
      assert.equal(run.requested_window, '1h');
      assert.equal(run.status, 'queued');

      await repo.upsertNews(NEWS_FIXTURE, { runId: run.run_id });
      const staged = await repo.listNewsForClustering({ runId: run.run_id });
      assert.equal(staged.count, 2);

      await repo.persistClusters([CLUSTER_FIXTURE], { runId: run.run_id });
      const stagedDetail = await repo.getApprovalTopicDetail(CLUSTER_FIXTURE.cluster_id);
      assert.equal(stagedDetail, null);

      const updated = await repo.updateNewsSearchRun(run.run_id, {
        status: 'cluster_succeeded',
        stats: { staged_news: 2, staged_clusters: 1 },
      });
      assert.equal(updated.status, 'cluster_succeeded');
      assert.deepEqual(updated.stats, { staged_news: 2, staged_clusters: 1 });

      const promoted = await repo.promoteNewsSearchRun(run.run_id);
      assert.equal(promoted.promoted_news, 2);
      assert.equal(promoted.promoted_clusters, 1);
      const live = await repo.listNewsForClustering({});
      assert.equal(live.count, 2);
      const pending = await repo.listPendingApprovalClusters();
      assert.equal(pending.length, 1);
      const fetchedRun = await repo.getNewsSearchRun(run.run_id);
      assert.equal(fetchedRun.status, 'promoted');
      assert.ok(fetchedRun.finished_at);
    });

    it('creates users with roles and verifies sessions', async () => {
      const user = await repo.createUser({
        email: 'Editor@Example.local',
        displayName: 'Demo Editor',
        passwordHash: 'scrypt:v1:salt:hash',
        roles: ['editor', 'viewer'],
      });
      assert.equal(user.email, 'editor@example.local');
      assert.deepEqual(user.roles.sort(), ['editor', 'viewer']);
      assert.equal(user.status, 'active');

      const byEmail = await repo.getUserByEmail('EDITOR@example.local');
      assert.equal(byEmail.user_id, user.user_id);
      assert.equal(byEmail.password_hash, 'scrypt:v1:salt:hash');
      assert.deepEqual(byEmail.roles.sort(), ['editor', 'viewer']);
      assert.equal(await repo.getUserByEmail('missing@example.local'), null);

      await assert.rejects(() => repo.createUser({
        email: 'editor@example.local',
        displayName: 'Duplicado',
        passwordHash: 'x',
      }));

      const admin = await repo.createUser({
        email: 'admin@example.local',
        displayName: 'Demo Admin',
        passwordHash: 'hash',
        roles: ['admin'],
      });
      assert.deepEqual((await repo.listUsers()).map((row) => row.email).sort(), [
        'admin@example.local',
        'editor@example.local',
      ]);

      const promoted = await repo.setUserRoles(admin.user_id, ['editor']);
      assert.deepEqual(promoted.roles, ['editor']);

      const disabled = await repo.updateUser(admin.user_id, { status: 'disabled' });
      assert.equal(disabled.status, 'disabled');
      await assert.rejects(() => repo.updateUser(admin.user_id, { status: 'nope' }));

      const session = await repo.createSession({
        userId: user.user_id,
        tokenHash: 'sha256-token-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        ipAddress: '127.0.0.1',
        userAgent: 'node-test',
      });
      assert.equal(session.session_id.length > 0, true);

      const verified = await repo.getSessionByTokenHash('sha256-token-1');
      assert.equal(verified.user.user_id, user.user_id);
      assert.deepEqual(verified.roles.sort(), ['editor', 'viewer']);
      assert.equal(verified.session_id, session.session_id);

      await repo.touchSession(session.session_id, { lastSeenAt: '2026-11-10T12:00:00.000Z' });
      const touched = await repo.getSessionByTokenHash('sha256-token-1');
      assert.equal(touched.last_seen_at, '2026-11-10T12:00:00.000Z');

      await repo.revokeSession(session.session_id);
      assert.equal(await repo.getSessionByTokenHash('sha256-token-1'), null);

      const expired = await repo.createSession({
        userId: user.user_id,
        tokenHash: 'sha256-token-2',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      assert.ok(expired.session_id);
      assert.equal(await repo.getSessionByTokenHash('sha256-token-2'), null);
      const deleted = await repo.deleteExpiredSessions({ now: '2026-11-10T12:00:00.000Z' });
      assert.ok(deleted >= 1);
    });

    it('resets the discovery universe without deleting drafts or projects', async () => {
      await seedApprovalUniverse(repo);
      const run = await repo.createNewsSearchRun({ requestedWindow: '24h' });
      await repo.upsertNews([NEWS_FIXTURE[0]], { runId: run.run_id });
      await repo.saveScriptDraft({
        draftId: 'draft-keep',
        idNoticia: 'news-1',
        clusterId: CLUSTER_FIXTURE.cluster_id,
        guionEditado: 'Mantener',
      });

      await repo.resetStaging(run.run_id);
      assert.equal((await repo.listNewsForClustering({ runId: run.run_id })).count, 0);

      await repo.resetDiscoveryState();
      assert.equal((await repo.listNewsForClustering({})).count, 0);
      assert.equal((await repo.listPendingApprovalClusters()).length, 0);
      const drafts = await repo.getPendingScriptDrafts();
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].draft_id, 'draft-keep');
    });
  });
}
