export const BOUNDARY_TRANSITION_CONFIGS = {
  'transition-1': { type: 'overlay-video', assetId: 'transition-1', src: './assets/boundary-transitions/TRANSITION 1 NUEVO.mp4', renderPath: 'overlays/TRANSITION 1 NUEVO.mp4', previewUrl: './assets/boundary-transitions/TRANSITION 1 NUEVO.mp4', blendMode: 'screen', durationSeconds: 0.833333, audio: true },
  'transition-2': { type: 'overlay-video', assetId: 'transition-2', src: './assets/boundary-transitions/TRANSITION 2 NUEVO.mp4', renderPath: 'overlays/TRANSITION 2 NUEVO.mp4', previewUrl: './assets/boundary-transitions/TRANSITION 2 NUEVO.mp4', blendMode: 'screen', durationSeconds: 1.4, audio: true },
};

export const WHIP_TRANSITION_CONFIG = { type: 'whip', durationSeconds: 0.5, direction: 'left-to-right' };
export const WHIP_SFX = { type: 'whip', assetId: 'whip', src: 'sfx/sound-demo.wav' };

const MANUAL_BOUNDARY_TRANSITIONS = new Set(['transition-1', 'transition-2', 'whip']);
const TRANSITION_SOURCES = new Set(['auto', 'manual']);

function normalizeTransitionName(value = '') {
  return (value || '').toString().trim().toLowerCase();
}

function isEligibleParagraphBoundary(row = {}) {
  return row?.paragraphBoundaryAfter === true && Boolean((row?.nextRowId || '').toString().trim());
}

function shouldApplyAutomaticBoundaryDefault(row = {}) {
  const transition = normalizeTransitionName(row.transition);
  const source = normalizeTransitionName(row.transitionSource);
  if (source === 'manual') return false;
  if (source === 'auto') return true;
  return !MANUAL_BOUNDARY_TRANSITIONS.has(transition);
}

function resolveTransitionSource(source) {
  const normalized = normalizeTransitionName(source);
  return TRANSITION_SOURCES.has(normalized) ? normalized : null;
}

export function resolveBoundaryTransitionPatch(value, options = {}) {
  const transition = normalizeTransitionName(value);
  const transitionSource = resolveTransitionSource(options.source || options.transitionSource);
  const sourcePatch = transitionSource ? { transitionSource } : {};
  if (!transition || transition === 'none') return { transition: 'none', transitionConfig: undefined, sfx: null, ...sourcePatch };
  if (BOUNDARY_TRANSITION_CONFIGS[transition]) return { transition, transitionConfig: { ...BOUNDARY_TRANSITION_CONFIGS[transition] }, sfx: null, ...sourcePatch };
  if (transition === 'whip') return { transition: 'whip', transitionConfig: { ...WHIP_TRANSITION_CONFIG }, sfx: { ...WHIP_SFX }, ...sourcePatch };
  return { transition: 'none', transitionConfig: undefined, sfx: null, ...sourcePatch };
}

export function applyAlternatingBoundaryTransitionDefaults(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  let boundaryIndex = 0;
  return rows.map((row) => {
    if (!isEligibleParagraphBoundary(row)) return row;
    const defaultTransition = boundaryIndex % 2 === 0 ? 'transition-1' : 'transition-2';
    boundaryIndex += 1;
    if (!shouldApplyAutomaticBoundaryDefault(row)) return row;
    return { ...row, ...resolveBoundaryTransitionPatch(defaultTransition, { source: 'auto' }) };
  });
}
