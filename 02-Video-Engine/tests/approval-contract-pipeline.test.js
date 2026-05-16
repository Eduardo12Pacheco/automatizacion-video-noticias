const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildApprovalContractPipeline,
  buildCompositionContractFromPreparedInput,
  computeApprovalSnapshotHash,
} = require("../scripts/lib/approval-contract-pipeline");
const sharedApprovalPipeline = require("../../03-Contracts-Core/approval-contract-pipeline");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function importControlPanelCompositionModule(relativePath) {
  return import(pathToFileURL(path.join(__dirname, "../../01-Control-Panel/js/modules/features/video-projects/composition", relativePath)).href);
}

function makeRows() {
  return [
    { id: "row-1", index: 0, phrase: "Linea 1", caption: "", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true }, filter: { enabled: true, mode: "cover" }, transition: "none", sfx: null },
    { id: "row-2", index: 1, phrase: "Linea 2", caption: "", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true }, filter: { enabled: true, mode: "cover" }, transition: "none", sfx: null },
  ];
}

test("approval contract pipeline builds gapless effectiveEndTime segments", () => {
  const result = buildApprovalContractPipeline({
    projectId: "draft-42",
    title: "Approval Bridge",
    draftId: "Draft 42",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.1 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 2.2 },
    ],
    alignedTimings: {
      phrases: [
        { startTime: 0, endTime: 1.4 },
        { startTime: 1.4, endTime: 2.6 },
      ],
    },
    alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: "2026-05-07T00:00:00.000Z" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
  });

  assert.equal(result.contract.segments.length, 2);
  assert.equal(result.contract.segments[0].effectiveEndTime, 1.4);
  assert.equal(result.contract.segments[1].effectiveEndTime, 2.6);
  assert.equal(result.rows[0].endTime, 1.4);
  assert.equal(result.rows[1].startTime, 1.4);
});

test("approval contract pipeline extends final segment to official voice asset duration", () => {
  const result = buildApprovalContractPipeline({
    projectId: "draft-audio-duration",
    title: "Official Audio Duration",
    draftId: "Draft Audio Duration",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.4 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 3.1 },
    ],
    alignedTimings: {
      totalDurationSeconds: 8.75,
      phrases: [
        { startTime: 0, endTime: 1.4 },
        { startTime: 1.4, endTime: 3.1 },
      ],
    },
    alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: "2026-05-07T00:00:00.000Z" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/audio-48khz.wav", publicPath: "generated/audio-48khz.wav", durationSeconds: 9.5, source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
  });

  assert.equal(result.contract.audio.totalDurationSeconds, 9.5);
  assert.equal(result.contract.totalDurationSeconds, 9.5);
  assert.equal(result.contract.segments[1].effectiveEndTime, 9.5);
  assert.equal(result.contract.rows[1].effectiveEndTime, 9.5);
});

test("approval contract pipeline reports selected image mismatch diagnostics", () => {
  const result = buildApprovalContractPipeline({
    projectId: "draft-43",
    title: "Mismatch",
    draftId: "Draft 43",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1 },
      { phrase: "Linea 2", startTime: 1, endTime: 2 },
    ],
    alignedTimings: null,
    alignmentStatus: { status: "pending", source: "approval-bridge", warning: "timing_fallback_not_whisper_aligned" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
  });

  assert.equal(result.diagnostics.images.match, false);
  assert.equal(result.diagnostics.images.expected, 2);
  assert.equal(result.diagnostics.images.received, 1);
  assert.match(result.diagnostics.images.message, /selected image count/i);
});

test("approval contract pipeline manifest is stable and row-linked", () => {
  const input = {
    projectId: "draft-stable",
    title: "Stable",
    draftId: "Draft stable",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.2 },
      { phrase: "Linea 2", startTime: 1.2, endTime: 2.4 },
    ],
    alignedTimings: null,
    alignmentStatus: { status: "pending", source: "approval-bridge", warning: "timing_fallback_not_whisper_aligned" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
  };

  const first = buildApprovalContractPipeline(input);
  const second = buildApprovalContractPipeline(input);

  assert.equal(first.manifest.cacheKey, second.manifest.cacheKey);
  assert.deepEqual(first.manifest.assets, second.manifest.assets);
  assert.deepEqual(first.manifest.rowAssetMap, second.manifest.rowAssetMap);
  assert.equal(first.manifest.rowAssetMap["row-1"], "image-1");
  assert.equal(first.manifest.rowAssetMap["row-2"], "image-2");
  assert.equal(first.manifest.assets["voice-1"].role, "voice");
  assert.equal(first.manifest.assets["music-1"].role, "music");
});

test("pure prepared-input builder supports deterministic manifest timestamps", () => {
  const nowIso = "2026-05-07T12:34:56.000Z";
  const result = buildCompositionContractFromPreparedInput({
    projectId: "draft-pure-1",
    title: "Pure Builder",
    draftId: "Draft pure",
    rowsSeed: makeRows(),
    preparedSegments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.2 },
      { phrase: "Linea 2", startTime: 1.2, endTime: 2.8 },
    ],
    alignmentResult: {
      alignedTimings: {
        phrases: [
          { startTime: 0, endTime: 1.2 },
          { startTime: 1.2, endTime: 2.8 },
        ],
      },
      alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: nowIso },
    },
    preparedImageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    preparedAudioAssets: {
      voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
      musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
    },
    nowIso,
  });

  assert.equal(result.manifest.generatedAt, nowIso);
  assert.equal(result.contract.segments[0].startTime, 0);
  assert.equal(result.contract.segments[0].effectiveEndTime, 1.2);
  assert.equal(result.contract.segments[1].effectiveEndTime, 2.8);
});

test("shared module exports preserve approval contract parity", () => {
  const input = {
    projectId: "draft-shared-parity",
    title: "Shared Parity",
    draftId: "Draft shared",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.4 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 3.1 },
    ],
    alignedTimings: {
      phrases: [
        { startTime: 0, endTime: 1.4 },
        { startTime: 1.4, endTime: 3.1 },
      ],
    },
    alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: "2026-05-07T00:00:00.000Z" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
  };

  const legacy = buildApprovalContractPipeline(input);
  const shared = sharedApprovalPipeline.buildApprovalContractPipeline(input);

  assert.deepEqual(shared.contract, legacy.contract);
  assert.deepEqual(shared.rows, legacy.rows);
  assert.equal(shared.manifest.version, legacy.manifest.version);
  assert.equal(shared.manifest.cacheKey, legacy.manifest.cacheKey);
  assert.deepEqual(shared.manifest.assets, legacy.manifest.assets);
  assert.deepEqual(shared.diagnostics, legacy.diagnostics);
  assert.equal(shared.contract.segments[0].effectiveEndTime, 1.4);
});

test("legacy approval-contract-pipeline path re-exports shared module API", () => {
  assert.equal(buildApprovalContractPipeline, sharedApprovalPipeline.buildApprovalContractPipeline);
  assert.equal(buildCompositionContractFromPreparedInput, sharedApprovalPipeline.buildCompositionContractFromPreparedInput);
});

test("approval editor V1 snapshot hash ignores object key order and volatile render fields", () => {
  const left = {
    schemaVersion: 1,
    contractVersion: "approval-editor-service-v1",
    projectId: "draft-hash",
    snapshotId: "snapshot-a",
    render: { status: "idle", updatedAt: "2026-05-08T10:00:00.000Z" },
    rows: [{ rowId: "row-1", selectedAssetId: "asset-1", motion: { fromX: 0, toX: 10 } }],
  };
  const right = {
    rows: [{ motion: { toX: 10, fromX: 0 }, selectedAssetId: "asset-1", rowId: "row-1" }],
    render: { updatedAt: "2026-05-08T11:00:00.000Z", status: "rendering" },
    snapshotId: "snapshot-b",
    projectId: "draft-hash",
    contractVersion: "approval-editor-service-v1",
    schemaVersion: 1,
  };

  assert.equal(computeApprovalSnapshotHash(left), computeApprovalSnapshotHash(right));
});

test("approval editor V1 contract includes canonical rows, assets, overlays, audio and snapshot metadata", () => {
  const result = buildApprovalContractPipeline({
    projectId: "draft-v1",
    title: "V1",
    draftId: "Draft V1",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.4 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 3.1 },
    ],
    alignedTimings: null,
    alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: "2026-05-07T00:00:00.000Z" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
    nowIso: "2026-05-08T12:00:00.000Z",
  });

  assert.equal(result.contract.contractVersion, "approval-editor-service-v1");
  assert.equal(result.contract.rows.length, 2);
  assert.equal(result.contract.rows[0].rowId, "row-1");
  assert.equal(result.contract.rows[0].motionPresetId, "slow-zoom-in");
  assert.equal(result.contract.rows[0].dust.blendMode, "screen");
  assert.equal(result.contract.globalLayers.logo.preferredSource, "logo-demo-alpha.webm");
  assert.equal(result.contract.assets["image-1"].previewUrl, "generated/images/001.jpg");
  assert.equal(result.contract.audio.voice.assetId, "voice-1");
  assert.match(result.contract.snapshotId, /^draft-v1:/);
  assert.equal(result.contract.snapshotHash, computeApprovalSnapshotHash(result.contract));
});

test("brand channel registry resolves preview and render assets with legacy Ecuador fallback", async () => {
  const {
    normalizeBrandChannel,
    resolveBrandChannelAssets,
    resolveBrandChannelPreviewAssetUrl,
  } = await importControlPanelCompositionModule("overlay-assets.js");

  assert.equal(normalizeBrandChannel("golazo-colombia"), "golazo-colombia");
  assert.equal(normalizeBrandChannel(undefined), "golazo-ecuador");
  assert.equal(normalizeBrandChannel("unknown"), "golazo-ecuador");

  const colombia = resolveBrandChannelAssets("golazo-colombia");
  assert.equal(colombia.logo.assetId, "brand-logo-demo-co");
  assert.equal(colombia.logo.previewPath, "logo-demo-co.webm");
  assert.equal(colombia.logo.renderPath, "overlays/logo-demo-co.mp4");
  assert.equal(colombia.outro.assetId, "brand-outro-colombia");
  assert.equal(colombia.outro.previewPath, "final-demo-co.webm");
  assert.equal(colombia.outro.renderPath, "overlays/final-demo-co.mp4");
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: "golazo-colombia", kind: "logo" }), "./assets/logo-demo-co.webm");

  const fallback = resolveBrandChannelAssets(null);
  assert.equal(fallback.channel, "golazo-ecuador");
  assert.equal(fallback.logo.previewPath, "logo-demo-alpha.webm");
  assert.equal(fallback.logo.renderPath, "overlays/logo-demo-alpha.webm");
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: null, kind: "logo" }), "./assets/logo-demo-alpha.webm");
});

test("approval editor V1 contract seeds brand channel assets and changes hash by channel", () => {
  const baseInput = {
    projectId: "draft-brand",
    title: "Brand Channel",
    draftId: "Draft Brand",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.4 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 3.1 },
    ],
    alignedTimings: null,
    alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: "2026-05-07T00:00:00.000Z" },
    imageAssets: [
      { id: "image-1", localPath: "imagenes/001.jpg", publicPath: "generated/images/001.jpg", source: { kind: "local", bridge: "approval-panel" } },
      { id: "image-2", localPath: "imagenes/002.jpg", publicPath: "generated/images/002.jpg", source: { kind: "local", bridge: "approval-panel" } },
    ],
    voiceAsset: { id: "voice-1", localPath: "audio/voice-original.wav", publicPath: "generated/voice-original.wav", source: { kind: "local", bridge: "approval-panel" } },
    musicAsset: { id: "music-1", localPath: "audio/background-music.wav", publicPath: "generated/background-music.wav", source: { kind: "local", bridge: "approval-panel" } },
    nowIso: "2026-05-08T12:00:00.000Z",
  };

  const ecuador = buildApprovalContractPipeline(baseInput).contract;
  const colombia = buildApprovalContractPipeline({ ...baseInput, brandChannel: "golazo-colombia" }).contract;

  assert.equal(ecuador.brandChannel, "golazo-ecuador");
  assert.equal(ecuador.globalLayers.logo.assetId, "brand-logo-ecuador");
  assert.equal(ecuador.globalLayers.logo.source, "logo-demo-alpha.webm");
  assert.equal(ecuador.assets["brand-logo-ecuador"].previewUrl, "./assets/logo-demo-alpha.webm");
  assert.equal(ecuador.assets["brand-logo-ecuador"].renderPath, "overlays/logo-ecuador-alpha-frames");
  assert.equal(ecuador.globalLayers.outro.assetId, "brand-outro-ecuador");
  assert.equal(ecuador.assets["brand-outro-ecuador"].previewUrl, "./assets/final-demo-ec.webm");
  assert.equal(ecuador.assets["brand-outro-ecuador"].renderPath, "overlays/final-demo-ec.mp4");

  assert.equal(colombia.brandChannel, "golazo-colombia");
  assert.equal(colombia.globalLayers.logo.assetId, "brand-logo-demo-co");
  assert.equal(colombia.globalLayers.outro.assetId, "brand-outro-colombia");
  assert.equal(colombia.assets["brand-logo-demo-co"].previewUrl, "./assets/logo-demo-co.webm");
  assert.equal(colombia.assets["brand-logo-demo-co"].renderPath, "overlays/logo-demo-co-alpha-frames");
  assert.equal(colombia.assets["brand-outro-colombia"].renderPath, "overlays/final-demo-co.mp4");
  assert.notEqual(computeApprovalSnapshotHash(ecuador), computeApprovalSnapshotHash(colombia));
});
