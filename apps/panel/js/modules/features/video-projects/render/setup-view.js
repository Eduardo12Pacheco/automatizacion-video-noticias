import { t } from '../../../core/i18n/index.js';
import { escapeHtmlCore } from '../../../core/ui/escape-html.js';
import { DEFAULT_BACKGROUND_MUSIC_TRACKS } from '../audio/default-background-music.js';
import { formatCount } from '../domain/formatters.js';
import { getPhaseLabel } from '../domain/status-labels.js';
import {
  getCandidateQualityScore,
  getImageNaturalQualityScore,
  resolveCandidateDimensionInfo,
  resolveCandidateDimensions,
  resolveCandidateFallbackUrl,
  resolveCandidateImageUrl,
} from '../domain/image-candidates.js';
import { hydrateSetupEvents } from '../events/setup-events.js';

export function buildProjectPhaseText({ currentStep, inEditorPhase, editorPhase } = {}) {
  if (!inEditorPhase && currentStep === 'images') return t('projects.phaseImagesOne');
  if (!inEditorPhase && currentStep === 'audio') return t('projects.phaseAudioTitle');
  if (['preview_ready', 'editing_dirty'].includes(editorPhase)) return t('projects.phaseEditingTitle');
  if (['final_rendering', 'final_ready'].includes(editorPhase)) return t('projects.phaseExport');
  if (inEditorPhase) return t('projects.phaseEditor');
  return t('projects.phaseImagesOne');
}

export function buildPhaseBadge(phase, dirty) {
  const label = getPhaseLabel(phase);
  const dirtyBadge = dirty ? `<span class="video-project-dirty-badge" title="${t('projects.dirtyTitle')}">●</span>` : '';
  return `<span class="video-project-phase-badge" data-phase="${escapeHtmlCore(phase)}">${escapeHtmlCore(label)}${dirtyBadge}</span>`;
}

function buildCandidateCard(candidate = {}, index = 0, selectedImageUrls = []) {
  const imageUrl = resolveCandidateImageUrl(candidate);
  const fallbackUrl = resolveCandidateFallbackUrl(candidate, imageUrl);
  const order = Number(candidate.order || candidate.position || 0);
  const title = escapeHtmlCore((candidate.title || t('projects.imageLabel', { order: order || '' })).toString());
  const sizeLabel = escapeHtmlCore(resolveCandidateDimensions(candidate) || t('projects.calculating'));
  const qualityScore = getCandidateQualityScore(candidate);
  const candidateId = escapeHtmlCore(imageUrl || '');
  const isSelected = candidateId && Array.isArray(selectedImageUrls) && selectedImageUrls.includes(imageUrl);
  const provider = escapeHtmlCore((candidate.provider || candidate.source || 'unknown').toString());
  const dimensions = resolveCandidateDimensionInfo(candidate);
  const imageSizeAttrs = dimensions ? ` width="${Math.round(dimensions.width)}" height="${Math.round(dimensions.height)}"` : '';
  return `
    <article class="video-image-card" data-quality-score="${qualityScore}" data-original-index="${index}" data-candidate-id="${candidateId}" data-candidate-provider="${provider}" data-selected="${isSelected}" role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="${isSelected ? t('projects.unselectImage', { order: order || '', title }) : t('projects.selectImage', { order: order || '', title })}">
      <span class="video-image-card__checkbox" aria-hidden="true"></span>
      <div class="video-image-card__media" aria-hidden="true">
        ${imageUrl ? `<img src="${escapeHtmlCore(imageUrl)}"${imageSizeAttrs} ${fallbackUrl ? `data-fallback-src="${escapeHtmlCore(fallbackUrl)}"` : ''} alt="${title}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : `<span>${t('projects.noPreview')}</span>`}
        <span class="video-image-card__size" data-image-size>${sizeLabel}</span>
      </div>
    </article>
  `;
}

function buildAudioAssetCard({ kind, label, help, audio = {}, uploading = false }) {
  const hasAudio = Boolean(audio?.public_url || audio?.path);
  const fileName = escapeHtmlCore((audio?.name || t('projects.noFile')).toString());
  const publicUrl = escapeHtmlCore((audio?.public_url || '').toString());
  const sizeMb = Number(audio?.size || 0) > 0 ? `${(Number(audio.size) / 1024 / 1024).toFixed(1)} MB` : '';
  const selectedDefaultTrackId = (audio?.default_track_id || '').toString();
  const uploadTitle = kind === 'background' ? t('projects.addMusic') : t('projects.addVoice');
  const uploadHelp = kind === 'background' ? t('projects.addMusicHelp') : t('projects.addVoiceHelp');
  const accept = kind === 'voice' ? 'audio/*,video/mp4,.mp4' : 'audio/*';
  const defaultMusicSelector = kind === 'background' ? `
    <label class="video-audio-card__default-select">
      <span>${t('projects.defaultMusic')}</span>
      <select data-action="select-default-background-music" ${uploading ? 'disabled' : ''}>
        <option value="">${t('projects.chooseSystemMusic')}</option>
        ${DEFAULT_BACKGROUND_MUSIC_TRACKS.map((track) => `<option value="${escapeHtmlCore(track.id)}" ${track.id === selectedDefaultTrackId ? 'selected' : ''}>${escapeHtmlCore(track.label)}</option>`).join('')}
      </select>
    </label>` : '';
  return `
    <article class="video-audio-card" data-audio-kind="${escapeHtmlCore(kind)}">
      <div class="video-audio-card__copy"><span class="video-projects-eyebrow">${escapeHtmlCore(label)}</span><strong>${fileName}</strong><p>${escapeHtmlCore(help)}</p>${hasAudio ? `<small>${t('projects.uploaded')}${sizeMb ? ` · ${escapeHtmlCore(sizeMb)}` : ''}</small>` : `<small>${t('projects.pending')}</small>`}</div>
      ${hasAudio && publicUrl ? `<audio controls src="${publicUrl}"></audio>` : ''}
      ${defaultMusicSelector}
      <label class="video-audio-card__upload"><input type="file" accept="${escapeHtmlCore(accept)}" data-action="upload-project-audio" data-audio-kind="${escapeHtmlCore(kind)}" ${uploading ? 'disabled' : ''} /><span class="video-audio-card__dropzone"><span class="video-audio-card__dropzone-plus">+</span><strong>${uploading ? t('projects.uploading') : hasAudio ? t('projects.replaceAudio', { label: escapeHtmlCore(label.toLowerCase()) }) : escapeHtmlCore(uploadTitle)}</strong><small>${escapeHtmlCore(uploadHelp)}</small></span></label>
    </article>`;
}

export function buildSetupPhaseContent({ project, viewModel }) {
  const { googleCandidates, customCandidates, googleCandidateCount, selectedImageCount, selectedImageUrls, segments, requiredImageCount, hasEnoughSelectedImages, detailPending, currentStep, voiceAudio, backgroundAudio, voiceUploading, backgroundUploading, canPreparePreview, editorState, editorPhase, timedRows } = viewModel;
  const mainContent = currentStep === 'images' ? `
    <div class="video-project-section-heading"><div><span class="video-projects-eyebrow">${t('projects.phase1')}</span><h3>${t('projects.googleImages')}</h3></div><p>${formatCount(googleCandidateCount, t('projects.candidateOne'), t('projects.candidateMany'))}</p></div>
    ${detailPending ? `<div class="video-image-grid video-image-grid--skeleton" aria-hidden="true">${new Array(12).fill(0).map(() => '<article class="video-image-card video-image-card--skeleton"><div class="video-image-card__media"></div></article>').join('')}</div>` : googleCandidates.length ? `<div class="video-image-grid">${googleCandidates.map((candidate, index) => buildCandidateCard(candidate, index, selectedImageUrls)).join('')}</div>` : `<p class="video-projects-empty">${t('projects.noCandidatesHelp')}</p>`}
    <section class="video-project-custom-images" aria-label="${t('projects.myImages')}"><div class="video-project-custom-images__separator" aria-hidden="true"></div><div class="video-project-section-heading video-project-section-heading--compact"><div><h3>${t('projects.myImages')}</h3></div><p class="video-project-custom-images__count">${formatCount(customCandidates.length, t('projects.imageOne'), t('projects.imageMany'))}</p></div><div class="video-project-custom-images__upload-row"><p class="video-project-custom-images__help">${t('projects.uploadHelp')}</p><label class="video-project-custom-images__upload"><input type="file" accept="image/jpeg,image/png,image/webp,.jfif" data-action="upload-custom-images" multiple ${project._customImagesUploading ? 'disabled' : ''} /><span>${project._customImagesUploading ? t('projects.uploadingImages') : t('projects.uploadImages')}</span></label></div>${project._customImageUploadError ? `<p class="video-projects-empty video-projects-empty--error">${escapeHtmlCore(project._customImageUploadError)}</p>` : ''}${customCandidates.length ? `<div class="video-image-grid video-image-grid--custom">${customCandidates.map((candidate, index) => buildCandidateCard(candidate, index, selectedImageUrls)).join('')}</div>` : `<p class="video-projects-empty">${t('projects.noCustomImages')}</p>`}</section>
    <div class="video-project-next-panel video-project-next-panel--image-selection"><div><span class="video-projects-eyebrow">${t('projects.selection')}</span><strong>${t(selectedImageCount === 1 ? 'projects.selectedImagesOne' : 'projects.selectedImagesMany', { count: selectedImageCount })} · ${t(requiredImageCount === 1 ? 'projects.requiredOne' : 'projects.requiredMany', { count: requiredImageCount })}</strong><p>${hasEnoughSelectedImages ? t('projects.enoughImages') : t('projects.missingImages', { count: Math.max(requiredImageCount - selectedImageCount, 0) })}</p></div><button class="video-project-primary-action" type="button" data-action="video-project-next-audio">${t('projects.nextAudio')}</button></div>` : `
    <div class="video-project-section-heading"><div><span class="video-projects-eyebrow">${t('projects.phase2')}</span><h3>${t('projects.voiceAudio')} · ${t('projects.backgroundMusic')}</h3></div><button class="video-project-secondary-action" type="button" data-action="video-project-back-images">${t('projects.backImages')}</button></div>
    <div class="video-audio-grid">${buildAudioAssetCard({ kind: 'voice', label: t('projects.voiceAudio'), help: t('projects.voiceAudioHelp'), audio: voiceAudio, uploading: voiceUploading })}${buildAudioAssetCard({ kind: 'background', label: t('projects.backgroundMusic'), help: t('projects.backgroundMusicHelp'), audio: backgroundAudio, uploading: backgroundUploading })}</div>
    ${project._audioUploadError ? `<p class="video-projects-empty video-projects-empty--error">${escapeHtmlCore(project._audioUploadError)}</p>` : ''}<div class="video-project-next-panel"><div><span class="video-projects-eyebrow">${t('projects.nextStep')}</span><strong>${canPreparePreview ? t('projects.readyEditor') : t('projects.missingFiles')}</strong><p>${t(requiredImageCount === 1 ? 'projects.needSegments' : 'projects.needSegmentsMany', { count: requiredImageCount })}</p></div><button class="video-project-primary-action" type="button" data-action="video-project-prepare-preview" ${canPreparePreview ? '' : 'disabled'}>${editorPhase === 'preparing' || editorPhase === 'preview_rendering' ? t('projects.preparingEditor') : t('projects.prepareEditor')}</button></div>${editorState.error ? `<p class="video-projects-empty video-projects-empty--error">${escapeHtmlCore(editorState.error)}</p>` : ''}${timedRows.length ? `<section class="video-project-custom-images" aria-label="${t('projects.timedRowsAria')}"><div class="video-project-section-heading video-project-section-heading--compact"><div><span class="video-projects-eyebrow">${t('projects.timedContract')}</span><h3>${t('projects.rowsCount', { count: timedRows.length })}</h3></div></div><ol class="video-segments-list">${timedRows.map((row) => `<li><span>${escapeHtmlCore(`${Number(row.startTime || 0).toFixed(2)}s - ${Number(row.endTime || 0).toFixed(2)}s`)}</span><p>${escapeHtmlCore((row.phrase || '').toString())}</p></li>`).join('')}</ol></section>` : ''}`;
  const sideContent = `<div class="video-project-section-heading video-project-section-heading--compact"><div><span class="video-projects-eyebrow">${t('projects.pipedScript')}</span><h3>${t('projects.segments')}${segments.length ? ` (${segments.length})` : ''}</h3></div></div><ol class="video-segments-list">${segments.map((segment) => `<li><span>${escapeHtmlCore((segment.order || '').toString().padStart(2, '0'))}</span><p>${escapeHtmlCore((segment.text || '').toString())}</p></li>`).join('') || `<li><p>${t('projects.noSegments')}</p></li>`}</ol>`;
  return { mainContent, sideContent };
}

export function hydrateImageSizeBadges(root, { onBrokenCandidate } = {}) {
  root?.querySelectorAll?.('.video-image-card__media img')?.forEach((img) => {
    const card = img.closest('.video-image-card');
    const badge = card?.querySelector('[data-image-size]');
    if (!badge) return;
    const removeBrokenCard = () => {
      const candidateId = card?.dataset.candidateId || '';
      const wasSelected = card?.dataset.selected === 'true';
      if (card) { card.dataset.qualityScore = '0'; card.dataset.broken = 'true'; card.remove(); }
      const provider = (card?.dataset?.candidateProvider || '').toLowerCase();
      if (provider !== 'user-upload' && wasSelected && candidateId && typeof onBrokenCandidate === 'function') setTimeout(() => onBrokenCandidate(candidateId), 0);
    };
    const setSize = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        badge.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
        const score = getImageNaturalQualityScore(img);
        if (score > 0 && card) card.dataset.qualityScore = score.toString();
        return;
      }
      badge.textContent = t('projects.noSize');
    };
    const handleImageError = () => {
      const fallback = img.dataset.fallbackSrc || '';
      if (fallback && img.dataset.fallbackUsed !== 'true') { img.dataset.fallbackUsed = 'true'; img.src = fallback; return; }
      removeBrokenCard();
    };
    img.addEventListener('load', setSize);
    img.addEventListener('error', handleImageError);
    if (img.complete) img.naturalWidth > 0 && img.naturalHeight > 0 ? setSize() : handleImageError();
  });
}

export function hydrateSetupPhaseInteractions({ root, toggleImageSelection, goToAudioStep, goToImagesStep, preparePreview, uploadProjectAudio, selectDefaultBackgroundMusic, uploadCustomImages }) {
  hydrateImageSizeBadges(root, { onBrokenCandidate: (candidateId) => toggleImageSelection?.(candidateId) });
  root.querySelector('[data-action="video-project-next-audio"]')?.addEventListener('click', () => goToAudioStep?.());
  root.querySelector('[data-action="video-project-back-images"]')?.addEventListener('click', () => goToImagesStep?.());
  root.querySelector('[data-action="video-project-prepare-preview"]')?.addEventListener('click', () => preparePreview?.());
  hydrateSetupEvents({ root, uploadProjectAudio, selectDefaultBackgroundMusic, uploadCustomImages, toggleImageSelection });
}
