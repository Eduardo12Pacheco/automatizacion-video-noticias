const { renderPropsV2Schema } = require("./schemas");

const FINAL_OUTRO_GAP_SECONDS = 2;
const WHIP_TRANSITION_DURATION_SECONDS = 0.5;
const WHIP_SFX_SRC = "sfx/whoosh-demo.wav";

function createAdapterError(message, details = {}) {
  const error = new Error(message);
  error.code = "invalid_composition_contract";
  error.details = details;
  return error;
}

function resolveAssetPath(manifestAsset, { allowFallback = true } = {}) {
  if (!manifestAsset || typeof manifestAsset !== "object") return null;
  if (typeof manifestAsset.renderPath === "string" && manifestAsset.renderPath.trim()) return manifestAsset.renderPath;
  if (!allowFallback) return null;
  const fallback = [manifestAsset.previewUrl, manifestAsset.localPath].find((entry) => typeof entry === "string" && entry.trim());
  return fallback || null;
}

function isSafeRenderAssetPath(value = "") {
  const path = String(value || "").trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return !path.split("/").some((part) => part === "..") && !path.includes("//");
}

function normalizeAssets(contract, manifest) {
  if (contract?.assets && typeof contract.assets === "object") return contract.assets;
  return manifest?.assets || {};
}

function assetIdFromAudio(audio = {}, kind) {
  return audio?.[`${kind}AssetId`] || audio?.[kind]?.assetId || audio?.[kind]?.id || null;
}

function resolveRequiredAsset(assets, assetId, role, options) {
  const normalizedId = String(assetId || "").trim();
  if (!normalizedId) {
    throw createAdapterError(`Missing required asset id for ${role}`, { role, assetId });
  }
  const manifestAsset = assets[normalizedId];
  if (!manifestAsset) {
    throw createAdapterError(`Missing manifest asset reference: ${normalizedId} (${role})`, { role, assetId: normalizedId });
  }
  const status = String(manifestAsset.status || "ready").toLowerCase();
  if (["missing", "stale", "invalid"].includes(status)) {
    throw createAdapterError(`Asset ${normalizedId} (${role}) is not ready for render (status=${status})`, { role, assetId: normalizedId, status });
  }
  const path = resolveAssetPath(manifestAsset, options);
  if (!path) {
    throw createAdapterError(`Asset ${normalizedId} (${role}) has no renderable path`, { role, assetId: normalizedId });
  }
  if (!isSafeRenderAssetPath(path)) {
    throw createAdapterError(`Unsafe render asset path for ${role}: ${path}`, { role, assetId: normalizedId, path });
  }
  return path;
}

function resolveOptionalImageDimensions(manifestAsset) {
  const width = Number(manifestAsset?.imageWidth ?? manifestAsset?.width ?? manifestAsset?.metadata?.imageWidth ?? manifestAsset?.metadata?.width);
  const height = Number(manifestAsset?.imageHeight ?? manifestAsset?.height ?? manifestAsset?.metadata?.imageHeight ?? manifestAsset?.metadata?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return {};
  return { imageWidth: width, imageHeight: height };
}

function extendFinalSegmentToDuration(segments, compositionDurationSeconds) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;
  const lastIndex = segments.length - 1;
  const lastSegment = segments[lastIndex];
  const targetEnd = Number(compositionDurationSeconds);
  if (!Number.isFinite(targetEnd) || targetEnd <= Number(lastSegment?.endTime || 0)) return segments;

  return segments.map((segment, index) => {
    if (index !== lastIndex) return segment;
    const startTime = Number(segment?.startTime || 0);
    const extendedSegment = {
      ...segment,
      endTime: targetEnd,
      effectiveEndTime: targetEnd,
    };
    if (extendedSegment.media?.kind !== "video-segment") return extendedSegment;
    const durationSeconds = Number((targetEnd - startTime).toFixed(6));
    return {
      ...extendedSegment,
      media: {
        ...extendedSegment.media,
        durationSeconds,
        sourceOutSeconds: Number((Number(extendedSegment.media.sourceInSeconds || 0) + durationSeconds).toFixed(6)),
      },
    };
  });
}

function resolveVideoSegmentMedia(segment, assets, index, options) {
  const media = segment?.media;
  if (media?.kind !== "video-segment") return media?.kind === "image" ? { kind: "image" } : undefined;

  const startTime = Number(segment?.startTime || 0);
  const endTime = Number.isFinite(Number(segment?.effectiveEndTime)) ? Number(segment.effectiveEndTime) : Number(segment?.endTime);
  const phraseDuration = Number((endTime - startTime).toFixed(6));
  const durationSeconds = Number(media.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw createAdapterError(`Invalid video segment duration for segment[${index}]`, { index, durationSeconds: media.durationSeconds });
  }
  if (Number.isFinite(phraseDuration) && Math.abs(durationSeconds - phraseDuration) > 0.001) {
    throw createAdapterError(`Video segment duration must match phrase duration for segment[${index}]`, { index, durationSeconds, phraseDuration });
  }

  const sourceInSeconds = Number(media.sourceInSeconds || 0);
  const sourceVideoSrc = media.sourceVideoSrc || resolveRequiredAsset(assets, media.sourceVideoAssetId, `segment[${index}].video`, options);
  const effect1Src = media.effect1Src || resolveRequiredAsset(assets, media.effect1AssetId || "overlay-layer-01", `segment[${index}].effect1`, options);
  const effect2Src = media.effect2Src || resolveRequiredAsset(assets, media.effect2AssetId || "overlay-layer-02", `segment[${index}].effect2`, options);

  return {
    kind: "video-segment",
    sourceVideoSrc,
    sourceInSeconds,
    durationSeconds,
    sourceOutSeconds: Number((sourceInSeconds + durationSeconds).toFixed(6)),
    overlayColor: "#3835AF",
    overlayOpacity: 0.3,
    effect1Src,
    effect1BlendMode: "screen",
    effect2Src,
    effect2BlendMode: "multiply",
  };
}

function resolveMediaMode(value) {
  return String(value || "").trim().toLowerCase() === "newspaper" ? "newspaper" : "image";
}

function resolveImageMotionForMode(segment) {
  const mediaMode = resolveMediaMode(segment?.mediaMode);
  if (mediaMode === "newspaper" && !segment?.motion && !segment?.motionPresetId) {
    return { fromScale: 1, toScale: 1.1, fromX: 0, fromY: 0, toX: 0, toY: 0, easing: "linear" };
  }
  return segment?.motion || segment?.motionPresetId || "slow-zoom-in";
}

function resolveSegmentRowId(segment = {}, index = 0) {
  return String(segment?.rowId || segment?.id || `row-${index + 1}`);
}

function isActiveWhipBoundary(segment = {}, nextSegment = null) {
  if (!segment || !nextSegment) return false;
  if (segment.paragraphBoundaryAfter !== true) return false;
  if (String(segment.transition || "").trim().toLowerCase() !== "whip") return false;
  const expectedNextRowId = String(segment.nextRowId || "");
  if (expectedNextRowId && expectedNextRowId !== String(nextSegment.rowId || nextSegment.id || "")) return false;
  return true;
}

function resolveWhipDurationSeconds(segment = {}) {
  const duration = Number(segment?.transitionConfig?.durationSeconds);
  return Number.isFinite(duration) && duration > 0 ? duration : WHIP_TRANSITION_DURATION_SECONDS;
}

function buildWhipRenderEvents(segments = [], { fps = 30, sfxSrc = WHIP_SFX_SRC } = {}) {
  const rows = Array.isArray(segments) ? segments : [];
  const frameRate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 30;
  const events = [];
  for (let index = 0; index < rows.length - 1; index += 1) {
    const segment = rows[index] || {};
    const nextSegment = rows[index + 1] || null;
    if (!isActiveWhipBoundary(segment, nextSegment)) continue;
    const previousImage = String(segment.image || "");
    const nextImage = String(nextSegment?.image || "");
    if (!previousImage || !nextImage) continue;
    const rowId = resolveSegmentRowId(segment, index);
    const nextRowId = resolveSegmentRowId(nextSegment, index + 1);
    const cutTime = Number(Number(nextSegment.startTime ?? segment.endTime ?? segment.effectiveEndTime ?? 0).toFixed(6));
    const durationSeconds = Number(resolveWhipDurationSeconds(segment).toFixed(6));
    const startTime = Number(Math.max(0, cutTime - durationSeconds / 2).toFixed(6));
    events.push({
      id: `${rowId}->${nextRowId}:whip:${cutTime}`,
      rowId,
      nextRowId,
      cutTime,
      startTime,
      durationSeconds,
      startFrame: Math.round(startTime * frameRate),
      cutFrame: Math.round(cutTime * frameRate),
      durationInFrames: Math.max(1, Math.round(durationSeconds * frameRate)),
      previousImage,
      nextImage,
      direction: "left-to-right",
      sfx: segment.sfx === "whip" || segment.sfx?.type === "whip" ? "whip" : null,
      sfxSrc: segment.sfx === "whip" || segment.sfx?.type === "whip" ? sfxSrc : null,
    });
  }
  return events;
}

function adaptCompositionContractToRenderProps({ contract, manifest, options = {} }) {
  const safeContract = contract || {};
  const assets = normalizeAssets(safeContract, manifest);
  const fps = Number(safeContract?.renderProfile?.fps || safeContract?.fps || 30);

  const voiceAssetId = assetIdFromAudio(safeContract?.audio, "voice");
  const musicAssetId = assetIdFromAudio(safeContract?.audio, "music");
  const voiceSrc = resolveRequiredAsset(assets, voiceAssetId, "audio.voice", options);
  const musicSrc = resolveRequiredAsset(assets, musicAssetId, "audio.music", options);

  const contractRows = Array.isArray(safeContract?.rows) ? safeContract.rows : safeContract?.segments;
  const segments = (Array.isArray(contractRows) ? contractRows : []).map((segment, index) => {
    const image = resolveRequiredAsset(assets, segment?.selectedAssetId, `segment[${index}].image`, options);
    const imageDimensions = resolveOptionalImageDimensions(assets[String(segment?.selectedAssetId || "")] || {});
    const endTime = Number.isFinite(Number(segment?.effectiveEndTime)) ? Number(segment.effectiveEndTime) : Number(segment?.endTime);
    const media = resolveVideoSegmentMedia(segment, assets, index, options);
    return {
      rowId: resolveSegmentRowId(segment, index),
      id: index + 1,
      phrase: String(segment?.phrase || segment?.text || "").trim() || `Segmento ${index + 1}`,
      image,
      ...imageDimensions,
      ...(media ? { media } : {}),
      mediaMode: resolveMediaMode(segment?.mediaMode),
      startTime: Number(segment?.startTime || 0),
      endTime,
      effectiveEndTime: Number.isFinite(Number(segment?.effectiveEndTime)) ? Number(segment.effectiveEndTime) : undefined,
      ...(segment?.paragraphBoundaryAfter === true ? { paragraphBoundaryAfter: true } : {}),
      ...(segment?.nextRowId ? { nextRowId: String(segment.nextRowId) } : {}),
      motion: resolveImageMotionForMode(segment),
      dust: segment?.dust || { enabled: true },
      logo: segment?.logo || { enabled: true },
      filter: segment?.filter || { enabled: true, mode: "cover" },
      transition: segment?.transition || "none",
      ...(segment?.transitionConfig ? { transitionConfig: segment.transitionConfig } : {}),
      sfx: segment?.sfx || null,
      caption: segment?.caption || "",
    };
  });

  const latestSegmentEnd = segments.reduce((max, segment) => Math.max(max, Number(segment.endTime || 0)), 0);
  const explicitDuration = Number(
    safeContract?.totalDurationSeconds
      ?? safeContract?.audio?.totalDurationSeconds
      ?? safeContract?.audio?.durationSeconds
      ?? latestSegmentEnd,
  );
  const baseCompositionDurationSeconds = Math.max(latestSegmentEnd, Number.isFinite(explicitDuration) ? explicitDuration : 0);
  const compositionDurationSeconds = Number((baseCompositionDurationSeconds + FINAL_OUTRO_GAP_SECONDS).toFixed(6));
  const renderSegments = extendFinalSegmentToDuration(segments, compositionDurationSeconds);
  const whipTransitions = buildWhipRenderEvents(segments, { fps });

  const logoAssetId = safeContract?.globalLayers?.logoAssetId;
  const globalLogo = safeContract?.globalLayers?.logo || {};
  const resolvedLogoAssetId = logoAssetId || globalLogo.assetId || null;
  const logoSrc = resolvedLogoAssetId
    ? resolveRequiredAsset(assets, resolvedLogoAssetId, "global.logo", options)
    : (globalLogo.source || null);

  const globalOutro = safeContract?.globalLayers?.outro || {};
  const outroAssetId = safeContract?.globalLayers?.outroAssetId || globalOutro.assetId || safeContract?.outro?.assetId || null;
  const outroAsset = outroAssetId ? (assets[String(outroAssetId)] || null) : null;
  const outroSrc = outroAssetId ? resolveRequiredAsset(assets, outroAssetId, "global.outro", options) : safeContract?.outro?.src;
  const outroDurationSeconds = Number(
    outroAsset?.durationSeconds
      ?? safeContract?.outro?.durationSeconds
      ?? 2,
  );

  const activeDust = segments.find((segment) => segment.dust?.enabled && (segment.dust?.assetId || segment.dust?.type));
  const dustAssetId = activeDust?.dust?.assetId || activeDust?.dust?.type || null;
  const dustSrc = dustAssetId && assets[dustAssetId] ? resolveRequiredAsset(assets, dustAssetId, "overlay.dust", options) : null;

  return renderPropsV2Schema.parse({
    schemaVersion: 2,
    lastRenderedSnapshotHash: safeContract?.snapshotHash,
    fps,
    compositionDurationSeconds,
    audio: {
      voiceSrc,
      musicSrc,
      voice: {
        volume: safeContract?.audio?.voice?.muted ? 0 : Number(safeContract?.audio?.voice?.volume ?? 1),
      },
      music: {
        volume: safeContract?.audio?.music?.muted ? 0 : Number(safeContract?.audio?.music?.volume ?? 0.15),
        loop: safeContract?.audio?.music?.loop !== false,
        fadeInSeconds: Number(safeContract?.audio?.music?.fadeInSeconds ?? 0.5),
        fadeOutSeconds: Number(safeContract?.audio?.music?.fadeOutSeconds ?? 1),
      },
    },
    segments: renderSegments,
    whipTransitions,
    globalLayers: safeContract?.globalLayers || {},
    logo: {
      src: logoSrc,
      enabled: segments.some((segment) => segment.logo?.enabled !== false),
      placeholder: false,
      label: "LOGO",
    },
    overlays: {
      dust: {
        src: dustSrc,
        opacity: Number(activeDust?.dust?.opacity ?? 0.36),
        blendMode: activeDust?.dust?.blendMode || "screen",
      },
    },
    outro: {
      ...(safeContract?.outro || {}),
      enabled: safeContract?.outro?.enabled ?? globalOutro?.enabled ?? true,
      ...(outroSrc ? { src: outroSrc } : {}),
      durationSeconds: Number.isFinite(outroDurationSeconds) ? outroDurationSeconds : 2,
      label: safeContract?.outro?.label || outroAsset?.label || "Gracias por mirar",
    },
  });
}

module.exports = {
  adaptCompositionContractToRenderProps,
  buildWhipRenderEvents,
  resolveAssetPath,
  isSafeRenderAssetPath,
};
