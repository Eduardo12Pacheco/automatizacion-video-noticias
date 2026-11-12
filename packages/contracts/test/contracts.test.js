const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildApprovalContractPipeline,
  buildBrandAssetRecords,
  computeApprovalSnapshotHash,
  normalizeBrandChannel,
  parseGuionSegments,
  validateApprovalTimeline,
} = require('@newsroom/contracts/approval-contract-pipeline');
const { applyContractOperations } = require('@newsroom/contracts/editor/contract-updates');

function demoPipeline() {
  return buildApprovalContractPipeline({
    projectId: 'demo-project',
    title: 'Demo project',
    draftId: 'draft-1',
    segments: [
      { phrase: 'Aurenia prepara el partido.', startTime: 0, endTime: 1.2 },
      { phrase: 'El equipo entrenó con normalidad.', startTime: 1.2, endTime: 2.8 },
    ],
    alignedTimings: {
      phrases: [
        { startTime: 0, endTime: 1.2 },
        { startTime: 1.2, endTime: 2.8 },
      ],
    },
    imageAssets: [
      { assetId: 'image-1', publicUrl: 'https://example.local/1.jpg', status: 'ready' },
      { assetId: 'image-2', publicUrl: 'https://example.local/2.jpg', status: 'ready' },
    ],
    voiceAsset: { assetId: 'voice-1', publicUrl: 'https://example.local/voice.wav', status: 'ready' },
    musicAsset: { assetId: 'music-1', publicUrl: 'https://example.local/music.wav', status: 'ready' },
    nowIso: '2026-11-10T12:00:00.000Z',
  });
}

describe('contract schemas', () => {
  it('builds a canonical approval snapshot with stable identifiers and assets', () => {
    const { contract, manifest } = demoPipeline();
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.contractVersion, 'approval-editor-service-v1');
    assert.equal(contract.projectId, 'demo-project');
    assert.equal(contract.canvas.width, 1280);
    assert.equal(contract.canvas.height, 720);
    assert.equal(contract.rows.length, 2);
    assert.equal(contract.rows[0].phrase, 'Aurenia prepara el partido.');
    assert.equal(contract.rows[1].startTime, 1.2);
    assert.equal(contract.totalDurationSeconds, 2.8);
    assert.equal(typeof contract.snapshotHash, 'string');
    assert.equal(contract.snapshotHash.length, 64);
    assert.equal(contract.audio.voiceAssetId, 'voice-1');
    assert.equal(contract.audio.musicAssetId, 'music-1');
    assert.equal(contract.outro.assetId, 'brand-outro-primary');
    assert.equal(manifest.assets['image-1'].assetId, 'image-1');
    assert.equal(manifest.rowAssetMap['row-1'], 'image-1');
  });

  it('rejects an invalid timeline before it can be persisted', () => {
    assert.throws(
      () => validateApprovalTimeline([
        { rowId: 'row-1', startTime: 2, endTime: 1 },
      ]),
      (error) => error.code === 'invalid_timeline' && /not after startTime/.test(error.message),
    );
    assert.throws(
      () => validateApprovalTimeline([
        { rowId: 'row-1', startTime: 0, endTime: 1 },
        { rowId: 'row-2', startTime: 0.5, endTime: 2 },
      ]),
      (error) => error.code === 'invalid_timeline' && /before previous row/.test(error.message),
    );
  });

  it('resolves only the known demo brand channels and falls back safely', () => {
    assert.equal(normalizeBrandChannel('demo-secondary'), 'demo-secondary');
    assert.equal(normalizeBrandChannel('unknown-channel'), 'demo-primary');
    assert.equal(buildBrandAssetRecords().length, undefined);
    assert.equal(buildBrandAssetRecords()['brand-logo-primary'].type, 'logo');
  });
});

describe('guion parsing', () => {
  it('splits piped blocks, trims whitespace and keeps block indexes', () => {
    assert.deepEqual(parseGuionSegments(' Uno | Dos |  Tres  '), [
      { blockIndex: 1, phrase: 'Uno' },
      { blockIndex: 2, phrase: 'Dos' },
      { blockIndex: 3, phrase: 'Tres' },
    ]);
  });

  it('marks paragraph boundaries after blank lines', () => {
    const segments = parseGuionSegments('Primer bloque\n\n|Segundo bloque|\nTercer bloque');
    assert.equal(segments.length, 3);
    assert.equal(segments[0].paragraphBoundaryAfter, true);
    assert.equal(segments[1].phrase, 'Segundo bloque');
    assert.equal(segments[1].paragraphBoundaryAfter, undefined);
    assert.equal(segments[2].paragraphBoundaryAfter, undefined);
  });

  it('rejects empty blocks with the failing block number', () => {
    assert.throws(() => parseGuionSegments('Uno||Tres'), /bloque 2 vacio/);
  });
});

describe('snapshot hashing', () => {
  it('is order-independent and ignores volatile render fields', () => {
    const base = { projectId: 'demo', rows: [{ id: 'row-1', startTime: 0 }], assets: { a: { publicUrl: 'x' } } };
    const reordered = { assets: { a: { publicUrl: 'x' } }, rows: [{ startTime: 0, id: 'row-1' }], projectId: 'demo' };
    const withVolatile = { ...base, snapshotHash: 'old', render: { status: 'rendering' }, snapshotId: 'old' };
    assert.equal(computeApprovalSnapshotHash(base), computeApprovalSnapshotHash(reordered));
    assert.equal(computeApprovalSnapshotHash(base), computeApprovalSnapshotHash(withVolatile));
    assert.notEqual(computeApprovalSnapshotHash(base), computeApprovalSnapshotHash({ ...base, projectId: 'other' }));
  });

  it('changes when the editor contract changes', () => {
    const { contract } = demoPipeline();
    const edited = applyContractOperations(contract, [
      { type: 'setRowMotion', rowId: 'row-1', motionPresetId: 'Zoom 200' },
    ]);
    assert.notEqual(edited.snapshotHash, contract.snapshotHash);
    assert.equal(edited.rows[0].motionPresetId, 'Zoom 200');
  });
});
