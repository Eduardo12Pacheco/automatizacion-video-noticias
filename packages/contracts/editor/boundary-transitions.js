const BOUNDARY_TRANSITION_CONFIGS = {
  "transition-1": { type: "overlay-video", assetId: "transition-1", src: "./assets/boundary-transitions/transition-1.mp4", renderPath: "overlays/transition-1.mp4", previewUrl: "./assets/boundary-transitions/transition-1.mp4", blendMode: "screen", durationSeconds: 0.833333, audio: true },
  "transition-2": { type: "overlay-video", assetId: "transition-2", src: "./assets/boundary-transitions/transition-2.mp4", renderPath: "overlays/transition-2.mp4", previewUrl: "./assets/boundary-transitions/transition-2.mp4", blendMode: "screen", durationSeconds: 1.4, audio: true },
  "transition-3": { type: "overlay-video", assetId: "transition-3", src: "./assets/boundary-transitions/transition-3.mp4", renderPath: "overlays/transition-3.mp4", previewUrl: "./assets/boundary-transitions/transition-3.mp4", blendMode: "screen", durationSeconds: 1, audio: true },
};

const WHIP_TRANSITION_CONFIG = { type: "whip", durationSeconds: 0.5, direction: "left-to-right" };
const WHIP_SFX = { type: "whip", assetId: "whip", src: "sfx/sound-demo.wav" };
const MANUAL_BOUNDARY_TRANSITIONS = new Set(["transition-1", "transition-2", "transition-3", "whip"]);
const TRANSITION_SOURCES = new Set(["auto", "manual"]);

function normalizeTransitionName(value = "") {
  return (value || "").toString().trim().toLowerCase();
}

function isEligibleParagraphBoundary(row = {}) {
  return row?.paragraphBoundaryAfter === true && Boolean((row?.nextRowId || "").toString().trim());
}

function shouldApplyAutomaticBoundaryDefault(row = {}) {
  const transition = normalizeTransitionName(row.transition);
  const source = normalizeTransitionName(row.transitionSource);
  if (source === "manual") return false;
  if (source === "auto") return true;
  return !MANUAL_BOUNDARY_TRANSITIONS.has(transition);
}

function resolveTransitionSource(source) {
  const normalized = normalizeTransitionName(source);
  return TRANSITION_SOURCES.has(normalized) ? normalized : null;
}

function resolveBoundaryTransitionPatch(value, options = {}) {
  const transition = normalizeTransitionName(value);
  const transitionSource = resolveTransitionSource(options.source || options.transitionSource);
  const sourcePatch = transitionSource ? { transitionSource } : {};
  if (!transition || transition === "none") return { transition: "none", transitionConfig: undefined, sfx: null, ...sourcePatch };
  if (BOUNDARY_TRANSITION_CONFIGS[transition]) return { transition, transitionConfig: { ...BOUNDARY_TRANSITION_CONFIGS[transition] }, sfx: null, ...sourcePatch };
  if (transition === "whip") return { transition: "whip", transitionConfig: { ...WHIP_TRANSITION_CONFIG }, sfx: { ...WHIP_SFX }, ...sourcePatch };
  return { transition: "none", transitionConfig: undefined, sfx: null, ...sourcePatch };
}

function applyAlternatingBoundaryTransitionDefaults(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map((row) => {
    if (!isEligibleParagraphBoundary(row)) return row;
    if (!shouldApplyAutomaticBoundaryDefault(row)) return row;
    return { ...row, ...resolveBoundaryTransitionPatch("transition-3", { source: "auto" }) };
  });
}

function buildBoundaryTransitionAssetRecord(transition) {
  const config = BOUNDARY_TRANSITION_CONFIGS[transition];
  if (!config) return null;
  return { assetId: transition, id: transition, type: "video", role: "boundary-transition", renderPath: config.renderPath, previewUrl: config.previewUrl, durationSeconds: config.durationSeconds, status: "ready" };
}

function addBoundaryTransitionAssets(snapshot = {}) {
  const next = { ...(snapshot || {}), assets: { ...(snapshot?.assets || {}) } };
  for (const row of Array.isArray(next.rows) ? next.rows : []) {
    const transition = normalizeTransitionName(row?.transition);
    const asset = buildBoundaryTransitionAssetRecord(transition);
    if (asset && !next.assets[transition]) next.assets[transition] = asset;
  }
  return next;
}

function normalizeBoundaryTransitionRows(rows = []) {
  return applyAlternatingBoundaryTransitionDefaults(rows);
}

module.exports = {
  BOUNDARY_TRANSITION_CONFIGS,
  WHIP_TRANSITION_CONFIG,
  WHIP_SFX,
  applyAlternatingBoundaryTransitionDefaults,
  addBoundaryTransitionAssets,
  buildBoundaryTransitionAssetRecord,
  normalizeBoundaryTransitionRows,
  resolveBoundaryTransitionPatch,
};
