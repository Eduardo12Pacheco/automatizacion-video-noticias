import { t } from '../../../core/i18n/index.js';

export function getStatusLabel(status = '') {
  const normalized = status.toString().trim().toLowerCase();
  if (normalized === 'ready') return t('projects.status.ready');
  if (normalized === 'image_search_error') return t('projects.status.imageSearchError');
  if (normalized === 'no_candidates') return t('projects.status.noCandidates');
  if (normalized === 'pending') return t('projects.status.searching');
  return status || t('projects.status.noStatus');
}

export function getProjectPhaseLabel(project = {}) {
  const status = (project.status || '').toString().trim().toLowerCase();
  const editorPhase = (project.editor_state?.phase || '').toString().trim().toLowerCase();
  const exportStatus = (project.editor_state?.export_status || '').toString().trim().toLowerCase();
  const currentStep = (project._videoProjectStep || '').toString().trim().toLowerCase();

  if (editorPhase === 'final_rendering' || exportStatus === 'rendering') return t('projects.phase.rendered');
  if (editorPhase === 'final_ready' || exportStatus === 'ready') return t('projects.phase.rendered');
  if (['preparing', 'preview_rendering', 'preview_ready', 'editing_dirty', 'error'].includes(editorPhase)) return t('projects.phase.editing');
  if (currentStep === 'audio' || project.voice_audio?.public_url || project.background_audio?.public_url) return t('projects.phase.audio');
  if (status === 'image_search_error') return t('projects.phase.imagesError');
  if (status === 'no_candidates') return t('projects.phase.imagesEmpty');
  return t('projects.phase.images');
}

export function getPhaseLabel(phase = '') {
  const map = {
    idle: 'projects.phase.idle',
    preparing: 'projects.phase.preparing',
    preview_rendering: 'projects.phase.previewRendering',
    preview_ready: 'projects.phase.previewReady',
    editing_dirty: 'projects.phase.editingDirty',
    final_rendering: 'projects.phase.finalRendering',
    final_ready: 'projects.phase.finalReady',
    error: 'projects.phase.error',
  };
  return map[phase] ? t(map[phase]) : phase;
}
