import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createJobsRouter } from '../src/jobs-router.js';

function harness({ apiKey = 'jobs-secret', withRefresh = true } = {}) {
  const started = [];
  const enqueued = [];
  const router = createJobsRouter({
    apiKey,
    jobQueue: { enqueue: (name, payload) => enqueued.push({ name, payload }) },
    useCases: withRefresh
      ? {
        refreshSearch: {
          async start(input) {
            started.push(input);
            return { run_id: 'run-1', status: 'accepted' };
          },
          async processRun() {},
        },
      }
      : {},
  });
  return { router, started, enqueued };
}

describe('machine jobs router (n8n connector)', () => {
  it('starts a discovery run with the configured bearer token exactly once', async () => {
    const { router, started, enqueued } = harness();
    const response = await router.handle({
      method: 'POST',
      pathname: '/jobs/discover',
      headers: { authorization: 'Bearer jobs-secret' },
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.run_id, 'run-1');
    assert.equal(response.body.orchestrator, 'n8n');
    assert.deepEqual(started, [{ window: '24h' }]);
    assert.deepEqual(enqueued, [{ name: 'refresh-search', payload: { run_id: 'run-1', window: '24h' } }]);
  });

  it('accepts x-api-key as the machine credential', async () => {
    const { router } = harness();
    const response = await router.handle({
      method: 'POST',
      pathname: '/jobs/discover',
      headers: { 'x-api-key': 'jobs-secret' },
    });
    assert.equal(response.status, 202);
  });

  it('rejects missing and wrong tokens without starting a run', async () => {
    const { router, started } = harness();
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-api-key': 'wrong' }]) {
      const response = await router.handle({ method: 'POST', pathname: '/jobs/discover', headers });
      assert.equal(response.status, 401);
    }
    assert.deepEqual(started, []);
  });

  it('fails closed when no machine credential is configured', async () => {
    const { router } = harness({ apiKey: '' });
    const response = await router.handle({
      method: 'POST',
      pathname: '/jobs/discover',
      headers: { authorization: 'Bearer anything' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'jobs_connector_disabled');
  });

  it('ignores other methods and paths', async () => {
    const { router } = harness();
    assert.equal((await router.handle({ method: 'GET', pathname: '/jobs/discover', headers: { authorization: 'Bearer jobs-secret' } })).status, 405);
    assert.equal((await router.handle({ method: 'POST', pathname: '/jobs/other', headers: { authorization: 'Bearer jobs-secret' } })).status, 404);
  });
});
