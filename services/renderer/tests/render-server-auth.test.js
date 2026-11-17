import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createRenderServer } from '../scripts/render/render-server.js';

const TOKEN = 'renderer-test-token';
let server;
let baseUrl;

before(async () => {
  server = createRenderServer({
    projectsRoot: '/tmp/newsroom-render-auth-test',
    apiToken: TOKEN,
    renderAdapter: async ({ projectId }) => ({ finalPath: `/tmp/${projectId}.mp4`, projectRoot: '/tmp' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function renderRequest(headers = {}) {
  return fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ project_id: 'p1', snapshot: { rows: [] } }),
  });
}

describe('renderer internal auth', () => {
  it('keeps health public', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
  });

  it('rejects a render without the internal token', async () => {
    const response = await renderRequest();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  });

  it('rejects a wrong internal token', async () => {
    const response = await renderRequest({ 'x-api-key': 'wrong' });
    assert.equal(response.status, 401);
  });

  it('accepts the configured token', async () => {
    const response = await renderRequest({ 'x-api-key': TOKEN });
    assert.equal(response.status, 200);
  });
});
