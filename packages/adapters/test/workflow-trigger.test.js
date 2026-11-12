import assert from 'node:assert/strict';
import test from 'node:test';

import { N8nWorkflowTrigger } from '../src/workflow-trigger.js';

test('N8nWorkflowTrigger posts the payload to the aligned completion webhook', async () => {
  const calls = [];
  const adapter = new N8nWorkflowTrigger({
    baseUrl: 'http://n8n.local:5678/',
    headers: { authorization: 'Bearer test-token' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } };
    },
  });

  const result = await adapter.trigger('job-completed', { job_id: 'job-1' });

  assert.equal(result.status, 'triggered');
  assert.equal(result.workflow, 'job-completed');
  assert.equal(calls[0].url, 'http://n8n.local:5678/webhook/job-completed');
  assert.equal(JSON.parse(calls[0].options.body).job_id, 'job-1');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
});

test('N8nWorkflowTrigger accepts an explicit webhook path override', async () => {
  const calls = [];
  const adapter = new N8nWorkflowTrigger({
    baseUrl: 'http://n8n.local:5678',
    webhookPaths: { discover: 'custom/discover' },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, async text() { return '{}'; } };
    },
  });

  await adapter.trigger('discover', {});
  assert.equal(calls[0], 'http://n8n.local:5678/webhook/custom/discover');
});

test('N8nWorkflowTrigger requires a workflow name', async () => {
  const adapter = new N8nWorkflowTrigger({ fetchImpl: async () => ({}) });
  await assert.rejects(() => adapter.trigger('', {}), /Workflow name is required/);
});
