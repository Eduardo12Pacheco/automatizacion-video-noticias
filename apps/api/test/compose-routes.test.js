import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolvePanelRequestOrigin, resolveRoutesFromEnv } from '../src/gateway.js';

describe('compose route configuration', () => {
  it('uses the local-mode worker targets when no target env vars are present', () => {
    const routes = resolveRoutesFromEnv({});
    assert.equal(routes.tts.target, 'http://tts-worker:8766');
    assert.equal(routes.subtitles.target, 'http://subtitles:8092');
    assert.equal(routes.remotion.target, 'http://renderer:3042');
    assert.equal(routes.n8n, undefined, 'the gateway must not proxy panel paths to n8n');
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
    assert.equal(routes.n8n, undefined, 'the gateway must not proxy panel paths to n8n');
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
