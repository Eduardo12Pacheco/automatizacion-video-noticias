import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresRepository } from '../src/adapters/postgres-repository.js';

class FakePool {
  constructor(rows = []) {
    this.rows = rows;
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql: String(sql), params });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

test('PostgresRepository composes the concern classes on one public surface', () => {
  for (const method of [
    'upsertNews',
    'claimScriptJob',
    'createPublishJob',
    'upsertVideoProject',
    'createUser',
    'createSession',
    'deleteExpiredSessions',
  ]) {
    assert.equal(typeof PostgresRepository.prototype[method], 'function', `${method} missing from PostgresRepository`);
  }
});

test('publish job writes JSONB result through the shared json helper', async () => {
  const pool = new FakePool([{ job_id: 'job-1', status: 'queued', result: { ok: true } }]);
  const repository = new PostgresRepository({ pool });

  const job = await repository.createPublishJob({
    job_id: 'job-1',
    draft_id: 'draft-1',
    result: { ok: true },
  });

  assert.equal(job.job_id, 'job-1');
  assert.equal(pool.calls[0].params[8], JSON.stringify({ ok: true }));
  assert.match(pool.calls[0].sql, /insert into script_publish_jobs/);
});

test('video project updates serialise JSON columns instead of failing on a missing helper', async () => {
  const pool = new FakePool([{ draft_id: 'draft-1', selected_images: ['image-1'] }]);
  const repository = new PostgresRepository({ pool });

  const project = await repository.saveVideoProjectSelections({
    draftId: 'draft-1',
    selectedImageIds: ['image-1'],
  });

  assert.deepEqual(project.selected_images, ['image-1']);
  const update = pool.calls.find((call) => call.sql.includes('set selected_images'));
  assert.equal(update.params[1], JSON.stringify(['image-1']));
});
