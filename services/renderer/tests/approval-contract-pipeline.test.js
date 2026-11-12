const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildApprovalContractPipeline,
  buildCompositionContractFromPreparedInput,
  computeApprovalSnapshotHash,
} = require("../scripts/lib/contracts/approval-contract-pipeline");
const sharedApprovalPipeline = require("../../../packages/contracts/approval-contract-pipeline");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function importControlPanelCompositionModule(relativePath) {
  return import(pathToFileURL(path.join(__dirname, "../../../apps/panel/js/modules/features/video-projects/composition", relativePath)).href);
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

test("approval contract pipeline defaults prepared music volume to eighty percent", () => {
  const result = buildApprovalContractPipeline({
    projectId: "draft-music-default",
    title: "Music Default",
    draftId: "Draft Music Default",
    rowsSeed: makeRows(),
    segments: [
      { phrase: "Linea 1", startTime: 0, endTime: 1.4 },
      { phrase: "Linea 2", startTime: 1.4, endTime: 3.1 },
    ],
    alignedTimings: {
      totalDurationSeconds: 3.1,
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
  });

  assert.equal(result.contract.audio.music.volume, 0.8);
});

test("approval contract pipeline rejects the seg-017 through seg-020 timing regression", () => {
  assert.throws(
    () => buildApprovalContractPipeline({
      projectId: "draft-corrupt-timeline",
      title: "Corrupt Timeline",
      draftId: "Draft Corrupt Timeline",
      rowsSeed: [
        { id: "seg-017", phrase: "Segmento 17" },
        { id: "seg-018", phrase: "Segmento 18" },
        { id: "seg-019", phrase: "Segmento 19" },
        { id: "seg-020", phrase: "Segmento 20" },
      ],
      segments: [
        { id: "seg-017", phrase: "Segmento 17", startTime: 92.28, endTime: 97.7 },
        { id: "seg-018", phrase: "Segmento 18", startTime: 97.7, endTime: 98.7 },
        { id: "seg-019", phrase: "Segmento 19", startTime: 88.74, endTime: 93.64 },
        { id: "seg-020", phrase: "Segmento 20", startTime: 93.84, endTime: 97.7 },
      ],
      alignedTimings: {
        phrases: [
          { startTime: 92.28, endTime: 97.7 },
          { startTime: 97.7, endTime: 98.7 },
          { startTime: 88.74, endTime: 93.64 },
          { startTime: 93.84, endTime: 97.7 },
        ],
      },
      alignmentStatus: { status: "ready", source: "whisper-alignment" },
      imageAssets: [
        { id: "image-17", publicPath: "generated/images/017.jpg" },
        { id: "image-18", publicPath: "generated/images/018.jpg" },
        { id: "image-19", publicPath: "generated/images/019.jpg" },
        { id: "image-20", publicPath: "generated/images/020.jpg" },
      ],
      voiceAsset: { id: "voice-1", publicPath: "generated/voice.wav", durationSeconds: 99 },
      musicAsset: { id: "music-1", publicPath: "generated/music.wav" },
    }),
    /Invalid timeline:.*seg-018 effectiveEndTime 88\.74 is before endTime 98\.7.*seg-019 starts at 88\.74 before previous row seg-018 endTime 98\.7/is,
  );
});

test("approval contract pipeline rejects effectiveEndTime before a row endTime", () => {
  const rows = [
    { rowId: "seg-014", startTime: 63.37, endTime: 87.04, effectiveEndTime: 80.56 },
    { rowId: "seg-015", startTime: 87.04, endTime: 92.28, effectiveEndTime: 92.28 },
  ];

  assert.throws(
    () => sharedApprovalPipeline.validateApprovalTimeline(rows, { label: "deployed snapshot" }),
    /Invalid timeline: row seg-014 effectiveEndTime 80\.56 is before endTime 87\.04/i,
  );
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
    nowIso: "2026-05-08T12:00:00.000Z",
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
    nowIso: "2026-05-08T12:00:00.000Z",
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
  assert.equal(result.contract.globalLayers.logo.preferredSource, "logo-primary.webm");
  assert.equal(result.contract.assets["image-1"].previewUrl, "generated/images/001.jpg");
  assert.equal(result.contract.audio.voice.assetId, "voice-1");
  assert.match(result.contract.snapshotId, /^draft-v1:/);
  assert.equal(result.contract.snapshotHash, computeApprovalSnapshotHash(result.contract));
});

test("brand channel registry resolves preview and render assets with legacy Aurenia fallback", async () => {
  const {
    normalizeBrandChannel,
    resolveBrandChannelAssets,
    resolveBrandChannelPreviewAssetUrl,
  } = await importControlPanelCompositionModule("overlay-assets.js");

  assert.equal(normalizeBrandChannel("demo-secondary"), "demo-secondary");
  assert.equal(normalizeBrandChannel(undefined), "demo-primary");
  assert.equal(normalizeBrandChannel("unknown"), "demo-primary");

  const montelia = resolveBrandChannelAssets("demo-secondary");
  assert.equal(montelia.logo.assetId, "brand-logo-secondary");
  assert.equal(montelia.logo.previewPath, "logo-secondary.webm");
  assert.equal(montelia.logo.renderPath, "overlays/logo-secondary.mp4");
  assert.equal(montelia.outro.assetId, "brand-outro-secondary");
  assert.equal(montelia.outro.previewPath, "outro-secondary.webm");
  assert.equal(montelia.outro.renderPath, "overlays/outro-secondary.mp4");
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: "demo-secondary", kind: "logo" }), "./assets/logo-secondary.webm");

  assert.equal(normalizeBrandChannel("demo-final"), "demo-final");
  const finalBrand = resolveBrandChannelAssets("demo-final");
  assert.equal(finalBrand.logo.assetId, "brand-logo-final");
  assert.equal(finalBrand.logo.previewPath, "logo-final.png");
  assert.equal(finalBrand.logo.renderPath, "overlays/logo-final.png");
  assert.equal(finalBrand.outro.assetId, "brand-outro-final");
  assert.equal(finalBrand.outro.previewPath, "outro-final.webm");
  assert.equal(finalBrand.outro.renderPath, "overlays/outro-final.mp4");
  assert.equal(finalBrand.outro.durationSeconds, 30.12);
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: "demo-final", kind: "logo" }), "./assets/logo-final.png");
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: "demo-final", kind: "outro" }), "./assets/outro-final.webm");

  const fallback = resolveBrandChannelAssets(null);
  assert.equal(fallback.channel, "demo-primary");
  assert.equal(fallback.logo.previewPath, "logo-primary.webm");
  assert.equal(fallback.logo.renderPath, "overlays/logo-primary.webm");
  assert.equal(resolveBrandChannelPreviewAssetUrl({ channel: null, kind: "logo" }), "./assets/logo-primary.webm");
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

  const aurenia = buildApprovalContractPipeline(baseInput).contract;
  const montelia = buildApprovalContractPipeline({ ...baseInput, brandChannel: "demo-secondary" }).contract;
  const finalBrand = buildApprovalContractPipeline({ ...baseInput, brandChannel: "demo-final" }).contract;

  assert.equal(aurenia.brandChannel, "demo-primary");
  assert.equal(aurenia.globalLayers.logo.assetId, "brand-logo-primary");
  assert.equal(aurenia.globalLayers.logo.source, "logo-primary.webm");
  assert.equal(aurenia.assets["brand-logo-primary"].previewUrl, "./assets/logo-primary.webm");
  assert.equal(aurenia.assets["brand-logo-primary"].renderPath, "overlays/logo-primary-alpha-frames");
  assert.equal(aurenia.globalLayers.outro.assetId, "brand-outro-primary");
  assert.equal(aurenia.assets["brand-outro-primary"].previewUrl, "./assets/outro-primary.webm");
  assert.equal(aurenia.assets["brand-outro-primary"].renderPath, "overlays/outro-primary.mp4");

  assert.equal(montelia.brandChannel, "demo-secondary");
  assert.equal(montelia.globalLayers.logo.assetId, "brand-logo-secondary");
  assert.equal(montelia.globalLayers.outro.assetId, "brand-outro-secondary");
  assert.equal(montelia.assets["brand-logo-secondary"].previewUrl, "./assets/logo-secondary.webm");
  assert.equal(montelia.assets["brand-logo-secondary"].renderPath, "overlays/logo-secondary-alpha-frames");
  assert.equal(montelia.assets["brand-outro-secondary"].renderPath, "overlays/outro-secondary.mp4");
  assert.notEqual(computeApprovalSnapshotHash(aurenia), computeApprovalSnapshotHash(montelia));

  assert.equal(finalBrand.brandChannel, "demo-final");
  assert.equal(finalBrand.globalLayers.logo.assetId, "brand-logo-final");
  assert.equal(finalBrand.globalLayers.logo.source, "logo-final.png");
  assert.equal(finalBrand.globalLayers.outro.assetId, "brand-outro-final");
  assert.equal(finalBrand.assets["brand-logo-final"].previewUrl, "./assets/logo-final.png");
  assert.equal(finalBrand.assets["brand-logo-final"].renderPath, "overlays/logo-final.png");
  assert.equal(finalBrand.assets["brand-outro-final"].previewUrl, "./assets/outro-final.webm");
  assert.equal(finalBrand.assets["brand-outro-final"].renderPath, "overlays/outro-final.mp4");
  assert.equal(finalBrand.assets["brand-outro-final"].durationSeconds, 30.12);
  assert.notEqual(computeApprovalSnapshotHash(aurenia), computeApprovalSnapshotHash(finalBrand));
});
