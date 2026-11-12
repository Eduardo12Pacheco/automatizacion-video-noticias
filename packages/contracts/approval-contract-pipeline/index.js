const { computeApprovalSnapshotHash } = require("./hash");
const { parseGuionSegments } = require("./guion-parsing");
const { alignPhrasesToTranscript } = require("./phrase-alignment");

const DEFAULT_BRAND_CHANNEL = "demo-primary";
const ALIGNMENT_FALLBACK_WARNING = "timing_fallback_not_whisper_aligned";

const BRAND_CHANNEL_ASSETS = {
  "demo-primary": {
    channel: "demo-primary",
    label: "Demo Sports Uno",
    logo: { assetId: "brand-logo-primary", previewPath: "logo-primary.webm", renderPath: "overlays/logo-primary.webm", source: "logo-primary.webm" },
    outro: { assetId: "brand-outro-primary", previewPath: "outro-primary.webm", renderPath: "overlays/outro-primary.mp4", durationSeconds: 30.53, label: "Demo Sports Uno" },
  },
  "demo-secondary": {
    channel: "demo-secondary",
    label: "Demo Sports Dos",
    logo: { assetId: "brand-logo-secondary", previewPath: "logo-secondary.webm", renderPath: "overlays/logo-secondary.webm", source: "logo-secondary.webm" },
    outro: { assetId: "brand-outro-secondary", previewPath: "outro-secondary.webm", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 30.16, label: "Demo Sports Dos" },
  },
  "demo-final": {
    channel: "demo-final",
    label: "Final Liga Demo",
    logo: { assetId: "brand-logo-final", previewPath: "logo-final.png", renderPath: "overlays/logo-final.png", source: "logo-final.png" },
    outro: { assetId: "brand-outro-final", previewPath: "outro-final.webm", renderPath: "overlays/outro-final.mp4", durationSeconds: 30.12, label: "Final Liga Demo" },
  },
};

function stableId(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeBrandChannel(value = DEFAULT_BRAND_CHANNEL) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BRAND_CHANNEL_ASSETS, normalized) ? normalized : DEFAULT_BRAND_CHANNEL;
}

function resolveBrandChannelAssets(channel = DEFAULT_BRAND_CHANNEL) {
  return BRAND_CHANNEL_ASSETS[normalizeBrandChannel(channel)];
}

function buildBrandAssetRecords(channelAssets = resolveBrandChannelAssets()) {
  const logo = channelAssets.logo;
  const outro = channelAssets.outro;
  return {
    [logo.assetId]: {
      assetId: logo.assetId,
      id: logo.assetId,
      type: "logo",
      role: "logo",
      source: { kind: "local", bridge: "approval-panel", channel: channelAssets.channel },
      publicUrl: `./assets/${logo.previewPath}`,
      previewUrl: `./assets/${logo.previewPath}`,
      publicPath: `./assets/${logo.previewPath}`,
      renderPath: logo.renderPath,
      status: "ready",
    },
    [outro.assetId]: {
      assetId: outro.assetId,
      id: outro.assetId,
      type: "outro",
      role: "outro",
      source: { kind: "local", bridge: "approval-panel", channel: channelAssets.channel },
      publicUrl: `./assets/${outro.previewPath}`,
      previewUrl: `./assets/${outro.previewPath}`,
      publicPath: `./assets/${outro.previewPath}`,
      renderPath: outro.renderPath,
      durationSeconds: outro.durationSeconds,
      status: "ready",
    },
  };
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}

function timelineRowId(row = {}, index = 0) {
  return String(row?.rowId || row?.id || `row-${index + 1}`);
}

function timelineNumber(row = {}, field) {
  const value = Number(row?.[field]);
  return Number.isFinite(value) ? value : null;
}

function formatTimelineNumber(value) {
  return Number(value).toString();
}

function createInvalidTimelineError(violations, { label = "timeline" } = {}) {
  const error = new Error(`Invalid timeline: ${violations.join("; ")}`);
  error.code = "invalid_timeline";
  error.details = { label, violations };
  return error;
}

function validateApprovalTimeline(rows = [], options = {}) {
  const label = options.label || "approval timeline";
  if (!Array.isArray(rows)) {
    throw createInvalidTimelineError([`${label} rows must be an array`], { label });
  }
  const violations = [];
  let previous = null;

  rows.forEach((row, index) => {
    const rowId = timelineRowId(row, index);
    const startTime = timelineNumber(row, "startTime");
    const endTime = timelineNumber(row, "endTime");
    const hasEffectiveEndTime = row && Object.prototype.hasOwnProperty.call(row, "effectiveEndTime");
    const effectiveEndTime = hasEffectiveEndTime ? timelineNumber(row, "effectiveEndTime") : null;

    if (startTime === null) violations.push(`row ${rowId} has invalid startTime ${row?.startTime}`);
    if (endTime === null) violations.push(`row ${rowId} has invalid endTime ${row?.endTime}`);
    if (hasEffectiveEndTime && effectiveEndTime === null) violations.push(`row ${rowId} has invalid effectiveEndTime ${row?.effectiveEndTime}`);

    if (startTime !== null && endTime !== null && endTime <= startTime) {
      violations.push(`row ${rowId} endTime ${formatTimelineNumber(endTime)} is not after startTime ${formatTimelineNumber(startTime)}`);
    }
    if (startTime !== null && effectiveEndTime !== null && effectiveEndTime < startTime) {
      violations.push(`row ${rowId} effectiveEndTime ${formatTimelineNumber(effectiveEndTime)} is before startTime ${formatTimelineNumber(startTime)}`);
    }
    if (endTime !== null && effectiveEndTime !== null && effectiveEndTime < endTime) {
      violations.push(`row ${rowId} effectiveEndTime ${formatTimelineNumber(effectiveEndTime)} is before endTime ${formatTimelineNumber(endTime)}`);
    }

    if (previous && startTime !== null) {
      if (previous.startTime !== null && startTime < previous.startTime) {
        violations.push(`row ${rowId} starts at ${formatTimelineNumber(startTime)} before previous row ${previous.rowId} startTime ${formatTimelineNumber(previous.startTime)}`);
      }
      if (previous.endTime !== null && startTime < previous.endTime) {
        violations.push(`row ${rowId} starts at ${formatTimelineNumber(startTime)} before previous row ${previous.rowId} endTime ${formatTimelineNumber(previous.endTime)}`);
      }
      if (previous.effectiveEndTime !== null && startTime < previous.effectiveEndTime) {
        violations.push(`row ${rowId} starts at ${formatTimelineNumber(startTime)} before previous row ${previous.rowId} effectiveEndTime ${formatTimelineNumber(previous.effectiveEndTime)}`);
      }
    }

    previous = { rowId, startTime, endTime, effectiveEndTime };
  });

  if (violations.length) throw createInvalidTimelineError(violations, { label });
  return rows;
}

function normalizeAsset(asset = {}, fallback = {}) {
  const assetId = String(asset.assetId || asset.id || fallback.assetId || fallback.id || "").trim();
  if (!assetId) return null;
  const publicPath = asset.publicPath || asset.publicUrl || asset.public_url || asset.previewUrl || asset.localPath || asset.url || "";
  return {
    ...asset,
    assetId,
    id: assetId,
    type: asset.type || fallback.type || "image",
    role: asset.role || fallback.role || fallback.type || "image",
    source: asset.source || fallback.source || { kind: "local", bridge: "approval-panel" },
    publicUrl: asset.publicUrl || asset.public_url || publicPath || null,
    previewUrl: asset.previewUrl || publicPath || null,
    publicPath: asset.publicPath || publicPath || null,
    renderPath: asset.renderPath || asset.localPath || publicPath || null,
    status: asset.status || "ready",
  };
}

function timedSegments({ segments = [], alignedTimings = null, totalDurationSeconds = 0 }) {
  const phrases = Array.isArray(alignedTimings?.phrases) ? alignedTimings.phrases : [];
  const timed = segments.map((segment, index) => {
    const timing = phrases[index] || segment;
    const startTime = round(timing?.startTime ?? timing?.start ?? segment?.startTime ?? index);
    const endTime = round(timing?.endTime ?? timing?.end ?? segment?.endTime ?? startTime + 1);
    return { ...segment, startTime, endTime, effectiveEndTime: endTime };
  }).map((segment, index, all) => {
    const next = all[index + 1];
    const finalEnd = index === all.length - 1 ? Math.max(segment.endTime, totalDurationSeconds || 0) : next.startTime;
    return { ...segment, effectiveEndTime: round(finalEnd) };
  });
  return validateApprovalTimeline(timed, { label: "approval contract timed segments" });
}

function normalizeRow(seed = {}, segment = {}, index, imageAsset, channelAssets) {
  const rowId = String(seed.id || segment.id || `row-${index + 1}`);
  const motionPresetId = seed.motionPresetId || (typeof seed.motion === "string" ? seed.motion : "slow-zoom-in");
  const dust = { enabled: false, type: "particle-1", assetId: "particle-1", opacity: 0.36, blendMode: "screen", ...(seed.dust || {}) };
  if (dust.enabled === false && seed.dust?.assetId === undefined) dust.assetId = null;
  return {
    rowId,
    id: rowId,
    index,
    phrase: String(seed.phrase || segment.phrase || segment.text || "").trim(),
    caption: String(seed.caption || seed.phrase || segment.phrase || segment.text || "").trim(),
    startTime: segment.startTime,
    endTime: segment.endTime,
    effectiveEndTime: segment.effectiveEndTime,
    selectedAssetId: imageAsset?.assetId || imageAsset?.id || null,
    candidates: imageAsset ? [{ id: `candidate-${rowId}-${imageAsset.assetId || imageAsset.id}`, assetId: imageAsset.assetId || imageAsset.id, source: imageAsset.source, publicPath: imageAsset.publicPath || imageAsset.publicUrl, reason: "approval selected image" }] : [],
    motionPresetId,
    motion: seed.motion || motionPresetId,
    motionTransform: typeof seed.motion === "object" && seed.motion ? { ...seed.motion } : null,
    dust,
    logo: { ...(seed.logo || { enabled: true }), source: channelAssets.logo.source, assetId: channelAssets.logo.assetId },
    filter: seed.filter || { enabled: true, mode: "cover" },
    transition: seed.transition || "none",
    ...(seed.transitionSource ? { transitionSource: seed.transitionSource } : {}),
    ...(seed.transitionConfig ? { transitionConfig: seed.transitionConfig } : {}),
    ...(seed.paragraphBoundaryAfter === true || segment.paragraphBoundaryAfter === true ? { paragraphBoundaryAfter: true } : {}),
    ...(seed.nextRowId ? { nextRowId: seed.nextRowId } : {}),
    sfx: seed.sfx || null,
    media: { kind: "image" },
    mediaMode: seed.mediaMode === "newspaper" ? "newspaper" : "image",
    newspaper: seed.newspaper && typeof seed.newspaper === "object" ? { ...seed.newspaper } : { labelEnabled: true },
    status: "ready",
  };
}

function buildApprovalContractPipeline({
  projectId = "approval-project",
  title = projectId,
  draftId = null,
  rowsSeed = [],
  segments = [],
  alignedTimings = null,
  alignmentStatus = { status: "pending_alignment" },
  imageAssets = [],
  voiceAsset = null,
  musicAsset = null,
  nowIso = new Date().toISOString(),
  brandChannel = DEFAULT_BRAND_CHANNEL,
} = {}) {
  const channelAssets = resolveBrandChannelAssets(brandChannel);
  const normalizedImages = imageAssets.map((asset, index) => normalizeAsset(asset, { id: `image-${index + 1}`, type: "image", role: "image" })).filter(Boolean);
  const normalizedVoice = normalizeAsset(voiceAsset, { id: "voice-1", type: "audio", role: "voice" });
  const normalizedMusic = normalizeAsset(musicAsset, { id: "music-1", type: "music", role: "music" });
  const audioDuration = Math.max(numberOr(normalizedVoice?.durationSeconds), numberOr(alignedTimings?.totalDurationSeconds));
  const preparedSegments = timedSegments({ segments, alignedTimings, totalDurationSeconds: audioDuration });
  const rows = preparedSegments.map((segment, index) => normalizeRow(rowsSeed[index] || {}, segment, index, normalizedImages[index], channelAssets));
  validateApprovalTimeline(rows, { label: "approval contract rows" });
  const brandAssets = buildBrandAssetRecords(channelAssets);
  const assets = {};
  for (const asset of [...normalizedImages, normalizedVoice, normalizedMusic].filter(Boolean)) assets[asset.assetId] = asset;
  Object.assign(assets, brandAssets);
  const manifestAssets = {};
  for (const asset of [...normalizedImages, normalizedVoice, normalizedMusic].filter(Boolean)) manifestAssets[asset.assetId] = asset;
  const totalDurationSeconds = round(Math.max(...rows.map((row) => row.effectiveEndTime), audioDuration, 0));
  const contract = {
    schemaVersion: 1,
    contractVersion: "approval-editor-service-v1",
    projectId,
    title,
    draftId,
    snapshotId: `${projectId}:${Date.parse(nowIso) || Date.now()}`,
    createdAt: nowIso,
    updatedAt: nowIso,
    brandChannel: channelAssets.channel,
    fps: 30,
    canvas: { width: 1280, height: 720 },
    totalDurationSeconds,
    rows,
    segments: rows.map((row) => ({ ...row })),
    assets,
    globalLayers: {
      logoAssetId: channelAssets.logo.assetId,
      outroAssetId: channelAssets.outro.assetId,
      logo: { enabled: true, source: channelAssets.logo.source, preferredSource: channelAssets.logo.source, assetId: channelAssets.logo.assetId, position: "top-left" },
      outro: { enabled: true, assetId: channelAssets.outro.assetId },
      dustDefault: true,
      filterDefault: true,
    },
    audio: {
      totalDurationSeconds,
      voiceAssetId: normalizedVoice?.assetId || null,
      musicAssetId: normalizedMusic?.assetId || null,
      voice: { assetId: normalizedVoice?.assetId || null, volume: 1, muted: false, previewUrl: normalizedVoice?.previewUrl || null, renderPath: normalizedVoice?.renderPath || null },
      music: { assetId: normalizedMusic?.assetId || null, volume: 0.8, muted: false, loop: true, fadeInSeconds: 0.5, fadeOutSeconds: 1, previewUrl: normalizedMusic?.previewUrl || null, renderPath: normalizedMusic?.renderPath || null },
    },
    outro: { enabled: true, assetId: channelAssets.outro.assetId, durationSeconds: channelAssets.outro.durationSeconds, label: channelAssets.outro.label },
    render: { status: "idle", updatedAt: nowIso },
  };
  contract.snapshotHash = computeApprovalSnapshotHash(contract);
  const manifest = {
    version: 1,
    generatedAt: nowIso,
    cacheKey: computeApprovalSnapshotHash({ assets: manifestAssets, rows: rows.map((row) => ({ rowId: row.rowId, selectedAssetId: row.selectedAssetId })) }),
    assets: manifestAssets,
    rowAssetMap: Object.fromEntries(rows.map((row) => [row.rowId, row.selectedAssetId]).filter(([, assetId]) => assetId)),
  };
  return {
    contract,
    rows,
    manifest,
    alignmentStatus,
    diagnostics: { images: { expected: rows.length, received: normalizedImages.length, match: rows.length === normalizedImages.length, message: rows.length === normalizedImages.length ? "selected image count matches rows" : `selected image count mismatch: expected ${rows.length}, received ${normalizedImages.length}` } },
  };
}

function buildCompositionContractFromPreparedInput({ preparedSegments = [], alignmentResult = {}, preparedImageAssets = [], preparedAudioAssets = {}, ...rest } = {}) {
  return buildApprovalContractPipeline({
    ...rest,
    segments: preparedSegments,
    alignedTimings: alignmentResult.alignedTimings,
    alignmentStatus: alignmentResult.alignmentStatus,
    imageAssets: preparedImageAssets,
    voiceAsset: preparedAudioAssets.voiceAsset,
    musicAsset: preparedAudioAssets.musicAsset,
  });
}

module.exports = {
  ALIGNMENT_FALLBACK_WARNING,
  DEFAULT_BRAND_CHANNEL,
  BRAND_CHANNEL_ASSETS,
  stableId,
  normalizeBrandChannel,
  resolveBrandChannelAssets,
  buildBrandAssetRecords,
  buildApprovalContractPipeline,
  buildCompositionContractFromPreparedInput,
  validateApprovalTimeline,
  computeApprovalSnapshotHash,
  parseGuionSegments,
  alignPhrasesToTranscript,
  prepareApprovalInputs: (...args) => require("./approval-input-preparation").prepareApprovalInputs(...args),
};
