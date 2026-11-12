import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePanelBootstrap, resolveRoutesFromEnv } from '../src/gateway-config.js';

test('demo mode routes the media prefixes to the deterministic worker', () => {
  const routes = resolveRoutesFromEnv({ NEWSROOM_MODE: 'demo' });

  assert.equal(routes.tts.target, 'http://demo-worker:8088');
  assert.equal(routes.subtitles.target, 'http://demo-worker:8088');
  assert.equal(routes.remotion.target, 'http://demo-worker:8088');
  assert.equal(routes.approval.target, 'http://approval-editor:3042');
  assert.equal(routes.radar.target, 'http://demo-worker:8088');
  assert.equal(routes.monitor.target, 'http://demo-worker:8088');
});

test('local mode routes the media prefixes to the real CPU workers', () => {
  const routes = resolveRoutesFromEnv({ NEWSROOM_MODE: 'local' });

  assert.equal(routes.tts.target, 'http://tts-worker:8766');
  assert.equal(routes.subtitles.target, 'http://subtitles:8092');
  assert.equal(routes.remotion.target, 'http://renderer:3042');
  assert.equal(routes.approval.target, 'http://approval-editor:3042');
  assert.equal(routes.radar.target, 'http://asr-worker:8765');
  assert.equal(routes.monitor.target, 'http://channel-monitor:8790');
});

test('an explicit API_GATEWAY_*_TARGET overrides the mode default', () => {
  const routes = resolveRoutesFromEnv({
    NEWSROOM_MODE: 'demo',
    API_GATEWAY_TTS_TARGET: 'http://custom-tts:9000',
  });

  assert.equal(routes.tts.target, 'http://custom-tts:9000');
  assert.equal(routes.remotion.target, 'http://demo-worker:8088');
});

test('the panel bootstrap exposes the run mode so the UI can label demo runs', () => {
  assert.equal(normalizePanelBootstrap({ runMode: 'demo' }).run_mode, 'demo');
  assert.equal(normalizePanelBootstrap({ runMode: 'local' }).run_mode, 'local');
  assert.equal(normalizePanelBootstrap({}).run_mode, 'local');
});

test('the bootstrap exposes a server-derived overlay asset base and no placeholder host', () => {
  const bootstrap = normalizePanelBootstrap({ apiOrigin: 'http://127.0.0.1:8099' });
  assert.equal(bootstrap.asset_base_url, 'http://127.0.0.1:8099/approval/api/overlays');
  assert.equal(bootstrap.api_origin, 'http://127.0.0.1:8099');
  assert.equal(JSON.stringify(bootstrap).includes('example.local'), false);
});
