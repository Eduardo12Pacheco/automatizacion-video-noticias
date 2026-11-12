import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ROUTES, resolvePanelRequestOrigin, resolveRoutesFromEnv } from '../src/gateway.js';

describe('compose route configuration', () => {
  it('keeps default routes when no target env vars are present', () => {
    assert.deepEqual(resolveRoutesFromEnv({}), DEFAULT_ROUTES);
  });

  it('lets Compose point each local service at its container target', () => {
    const routes = resolveRoutesFromEnv({
      API_GATEWAY_TTS_TARGET: 'http://demo-worker:8088',
      API_GATEWAY_SUBTITLES_TARGET: 'http://demo-worker:8092',
      API_GATEWAY_REMOTION_TARGET: 'http://demo-worker:3037',
    });
    assert.equal(routes.tts.target, 'http://demo-worker:8088');
    assert.equal(routes.subtitles.target, 'http://demo-worker:8092');
    assert.equal(routes.remotion.target, 'http://demo-worker:3037');
    assert.equal(routes.n8n.target, DEFAULT_ROUTES.n8n.target);
    assert.equal(routes.tts.prefix, '/tts');
  });

  it('derives the public panel origin from the reverse proxy headers', () => {
    assert.equal(resolvePanelRequestOrigin({
      headers: { 'x-forwarded-host': 'newsroom.lan:8080', 'x-forwarded-proto': 'http' },
    }, 'http://fallback.local'), 'http://newsroom.lan:8080');
    assert.equal(resolvePanelRequestOrigin({ headers: {} }, 'http://fallback.local'), 'http://fallback.local');
    assert.equal(resolvePanelRequestOrigin({
      headers: { 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'javascript' },
    }, 'http://fallback.local'), 'http://fallback.local');
  });
});
