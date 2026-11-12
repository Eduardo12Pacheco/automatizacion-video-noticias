import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoProjectsApiClient } from '../data/api.js';

function withBootstrap(flags, run) {
  const previous = globalThis.__CONTROL_PANEL_BOOTSTRAP__;
  globalThis.__CONTROL_PANEL_BOOTSTRAP__ = { feature_flags: flags };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete globalThis.__CONTROL_PANEL_BOOTSTRAP__;
      else globalThis.__CONTROL_PANEL_BOOTSTRAP__ = previous;
    });
}

test('manual project creation posts to the local gateway when local workflows are enabled', async () => {
  await withBootstrap({ localWorkflows: true }, async () => {
    const calls = [];
    const client = createVideoProjectsApiClient({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ ok: true, project_id: 'project-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.createManualVideoProject({
      settings: { baseUrl: '/n8n' },
      payload: { title: 'Demo' },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/webhook/video-projects/manual-create/v1');
  });
});

test('manual project creation keeps the explicit n8n base URL outside local workflows', async () => {
  await withBootstrap({ localWorkflows: false }, async () => {
    const calls = [];
    const client = createVideoProjectsApiClient({
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true, project_id: 'project-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.createManualVideoProject({
      settings: { baseUrl: 'https://n8n.example.local' },
      payload: { title: 'Demo' },
    });
    assert.deepEqual(calls, ['https://n8n.example.local/webhook/video-projects/manual-create/v1']);
  });
});

test('manual project creation never shows the response body in its error message', async () => {
  await withBootstrap({ localWorkflows: true }, async () => {
    const client = createVideoProjectsApiClient({
      fetchImpl: async () => new Response('<html><body>proxy failure</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    });
    await assert.rejects(
      client.createManualVideoProject({ settings: {}, payload: { title: 'Demo' } }),
      (error) => {
        assert.equal(error.message, 'No se pudo crear el proyecto (502).');
        assert.doesNotMatch(error.message, /<html>|proxy failure/i);
        return true;
      },
    );
  });
});
