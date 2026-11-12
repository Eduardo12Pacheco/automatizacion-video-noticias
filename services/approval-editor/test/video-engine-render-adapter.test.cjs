const test = require('node:test');
const assert = require('node:assert/strict');

const { AUTHORITATIVE_DUST_ASSETS } = require('../lib/video-engine-render-adapter');

test('AUTHORITATIVE_DUST_ASSETS exports a non-empty object', () => {
  assert.ok(AUTHORITATIVE_DUST_ASSETS, 'Expected AUTHORITATIVE_DUST_ASSETS to be exported');
  assert.equal(typeof AUTHORITATIVE_DUST_ASSETS, 'object');
  assert.notEqual(AUTHORITATIVE_DUST_ASSETS, null);
});

test('AUTHORITATIVE_DUST_ASSETS still has particle-1 and particle-2 records (backward compatibility)', () => {
  assert.ok(AUTHORITATIVE_DUST_ASSETS['particle-1'], 'Expected particle-1 to remain');
  assert.ok(AUTHORITATIVE_DUST_ASSETS['particle-2'], 'Expected particle-2 to remain');
  assert.equal(AUTHORITATIVE_DUST_ASSETS['particle-1'].previewUrl, './assets/particle-1.webm');
  assert.equal(AUTHORITATIVE_DUST_ASSETS['particle-1'].renderPath, 'overlays/particle-1.mp4');
  assert.equal(AUTHORITATIVE_DUST_ASSETS['particle-2'].previewUrl, './assets/particle-2.webm');
  assert.equal(AUTHORITATIVE_DUST_ASSETS['particle-2'].renderPath, 'overlays/particle-2.mp4');
});

test('AUTHORITATIVE_DUST_ASSETS includes particle-3 record mirroring particle-1/particle-2 shape', () => {
  const record = AUTHORITATIVE_DUST_ASSETS['particle-3'];
  assert.ok(record, 'Expected particle-3 record to exist in AUTHORITATIVE_DUST_ASSETS');
  assert.equal(record.assetId, 'particle-3');
  assert.equal(record.id, 'particle-3');
  assert.equal(record.type, 'dust');
  assert.equal(record.role, 'dust');
  assert.deepEqual(record.source, { kind: 'local', bridge: 'approval-panel' });
  assert.equal(record.previewUrl, './assets/particle-3.webm');
  assert.equal(record.renderPath, 'overlays/particle-3.mp4');
  assert.equal(record.status, 'ready');
});

test('AUTHORITATIVE_DUST_ASSETS includes particle-4 record mirroring particle-1/particle-2 shape', () => {
  const record = AUTHORITATIVE_DUST_ASSETS['particle-4'];
  assert.ok(record, 'Expected particle-4 record to exist in AUTHORITATIVE_DUST_ASSETS');
  assert.equal(record.assetId, 'particle-4');
  assert.equal(record.id, 'particle-4');
  assert.equal(record.type, 'dust');
  assert.equal(record.role, 'dust');
  assert.deepEqual(record.source, { kind: 'local', bridge: 'approval-panel' });
  assert.equal(record.previewUrl, './assets/particle-4.webm');
  assert.equal(record.renderPath, 'overlays/particle-4.mp4');
  assert.equal(record.status, 'ready');
});
