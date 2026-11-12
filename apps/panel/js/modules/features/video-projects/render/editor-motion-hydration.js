import { findMotionPreset } from '../domain/motion-presets.js';
import { setActiveFramingKeyframe, syncFramingKeyframeActiveState } from './framing-keyframe-state.js';
import { hydrateMotionScrubberInput } from './motion-scrub.js';
import { getCompositionRendererForPreview } from './preview-lifecycle.js';

export function hydrateMotionControls({ root, project, updateRow, updatePreviewTimeline }) {
  root.querySelectorAll('[data-action="update-row-motion"]').forEach((control) => {
    const eventName = control.tagName === 'SELECT' ? 'change' : 'click';
    control.addEventListener(eventName, () => {
      const rowId = control.dataset.rowId;
      if (!rowId) return;
      const preset = findMotionPreset(control.value);
      root.querySelectorAll('[data-action="update-row-motion"]').forEach((button) => {
        if (button.dataset.rowId !== rowId) return;
        const isSelected = button.value === control.value;
        button.classList.toggle('is-selected', isSelected);
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
      updateManualMotionPanelValues(root, rowId, preset, preset?.name || control.value);
      updateRow?.(rowId, { motionPresetId: preset?.name || control.value, motion: preset ? { ...preset } : control.value });
    });
  });
  root.querySelectorAll('[data-action="seek-motion-keyframe"]').forEach((button) => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId;
      const seekTime = Number(button.dataset.seekTime || 0);
      if (rowId) project._selectedEditorRowId = rowId;
      if (!Number.isFinite(seekTime)) return;
      project._previewSeekTime = seekTime;
      if (button.closest('[data-framing-keyframe-controls]')) {
        setActiveFramingKeyframe(project, { rowId, keyframe: button.dataset.keyframe || '' });
      }
      const renderer = getCompositionRendererForPreview();
      if (renderer) { renderer.seek(seekTime); updatePreviewTimeline?.(seekTime, renderer.duration); }
      else {
        const previewVideo = root.querySelector('[data-preview-video]');
        if (previewVideo) { previewVideo.currentTime = seekTime; updatePreviewTimeline?.(seekTime, previewVideo.duration); }
      }
      syncFramingKeyframeActiveState(root, project, seekTime);
    });
  });
  syncFramingKeyframeActiveState(root, project, project?._previewSeekTime);
  root.querySelectorAll('[data-action="update-row-motion-keyframe"]').forEach((input) => {
    const updateManualMotionKeyframe = () => {
      const panel = input.closest('[data-motion-manual]');
      const rowId = panel?.dataset.rowId || '';
      if (!rowId) return;
      const readField = (field, fallback = 0) => {
        const value = Number(panel.querySelector(`[data-motion-field="${field}"]`)?.value);
        return Number.isFinite(value) ? value : fallback;
      };
      const motionPresetId = panel.dataset.motionPreset || 'custom';
      updateRow?.(rowId, {
        motionPresetId,
        motion: { name: motionPresetId, presetName: motionPresetId, fromX: readField('fromX'), fromY: readField('fromY'), toX: readField('toX'), toY: readField('toY'), fromScale: Math.max(0.1, readField('fromScalePercent', 100) / 100), toScale: Math.max(0.1, readField('toScalePercent', 100) / 100), easing: 'linear' },
        manualMotionDraft: true,
      });
    };
    input.addEventListener('input', updateManualMotionKeyframe);
    input.addEventListener('change', updateManualMotionKeyframe);
    hydrateMotionScrubberInput(input);
  });
}

function updateManualMotionPanelValues(root, rowId, preset, presetName = '') {
  if (!root || !rowId || !preset || typeof preset !== 'object') return;
  const panels = [...(root.querySelectorAll?.('[data-motion-manual]') || [])];
  const panel = panels.find((item) => item?.dataset?.rowId === rowId);
  if (!panel) return;
  panel.dataset.motionPreset = presetName || preset.name || 'custom';
  const setFieldValue = (field, value) => {
    const input = panel.querySelector?.(`[data-motion-field="${field}"]`);
    if (input) input.value = Number.isFinite(Number(value)) ? String(value) : '0';
  };
  setFieldValue('fromX', preset.fromX ?? 0);
  setFieldValue('fromY', preset.fromY ?? 0);
  setFieldValue('toX', preset.toX ?? 0);
  setFieldValue('toY', preset.toY ?? 0);
  setFieldValue('fromScalePercent', Math.round(Number(preset.fromScale ?? 1) * 100));
  setFieldValue('toScalePercent', Math.round(Number(preset.toScale ?? 1) * 100));
}
