import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryRepository } from '../../../packages/data/src/index.js';
import { seedDemoData } from '../src/seed-demo.js';

 describe('demo seed', () => {
  let repository;

  beforeEach(async () => {
    repository = new InMemoryRepository();
    await repository.migrate();
  });

  it('seeds one complete story plus fictional users idempotently', async () => {
    const first = await seedDemoData({
      repository,
      password: 'e2e-demo-password',
      editorEmail: 'editor@example.local',
      viewerEmail: 'viewer@example.local',
    });

    assert.equal(first.users.editor.created, true);
    assert.equal(first.users.viewer.created, true);
    assert.equal(first.story.pending_cluster_id, 'demo-cluster-pending');
    assert.equal(first.story.draft_id, 'draft-demo-news-draft');
    assert.equal(first.story.video_project_id, 'demo-project-1');

    const pending = await repository.listPendingApprovalClusters();
    assert.equal(pending.some((item) => item.cluster_id === 'demo-cluster-pending'), true);

    const drafts = await repository.getPendingScriptDrafts();
    assert.equal(drafts.some((draft) => draft.draft_id === 'draft-demo-news-draft'), true);

    const projects = await repository.getVideoEditProjects({ draftId: 'demo-project-1' });
    assert.equal(projects.projects.length, 1);

    const users = await repository.listUsers();
    assert.deepEqual(users.map((user) => user.email).sort(), [
      'editor@example.local',
      'viewer@example.local',
    ]);
    // Passwords are stored as hashes, never as plain text.
    assert.equal(users.every((user) => user.password_hash && !user.password_hash.includes('e2e-demo-password')), true);

    const second = await seedDemoData({
      repository,
      password: 'e2e-demo-password',
      editorEmail: 'editor@example.local',
      viewerEmail: 'viewer@example.local',
    });
    assert.equal(second.users.editor.created, false);
    assert.equal(second.users.viewer.created, false);
    assert.equal((await repository.listUsers()).length, 2);
  });

  it('requires a password so the seed never ships a hardcoded credential', async () => {
    await assert.rejects(
      () => seedDemoData({ repository, editorEmail: 'editor@example.local', viewerEmail: 'viewer@example.local' }),
      /password/i,
    );
  });
});
