import { t } from '../../../core/i18n/index.js';
import { escapeHtmlCore } from '../../../core/ui/escape-html.js';
import { formatCount, formatDateLabel } from '../domain/formatters.js';
import {
  resolveCandidateImageUrl,
  resolveStoragePublicUrl,
} from '../domain/image-candidates.js';
import { resolveVideoProjectKey, resolveVideoProjectTitle } from '../domain/project-identity.js';

function getProjectCardPhaseLabel(project = {}) {
  const status = (project.status || '').toString().trim().toLowerCase();
  const editorPhase = (project.editor_state?.phase || '').toString().trim().toLowerCase();
  const exportStatus = (project.editor_state?.export_status || '').toString().trim().toLowerCase();
  const currentStep = (project._videoProjectStep || '').toString().trim().toLowerCase();

  if (editorPhase === 'final_rendering' || exportStatus === 'rendering') return t('scripts.phaseRendered');
  if (editorPhase === 'final_ready' || exportStatus === 'ready') return t('scripts.phaseRendered');
  if (['preparing', 'preview_rendering', 'preview_ready', 'editing_dirty', 'error'].includes(editorPhase)) return t('scripts.phaseEditing');
  if (currentStep === 'audio' || project.voice_audio?.public_url || project.background_audio?.public_url) return t('scripts.phaseAudio');
  if (status === 'image_search_error') return t('scripts.phaseImagesError');
  if (status === 'no_candidates') return t('scripts.phaseImagesEmpty');
  return t('scripts.phaseImages');
}

function resolveProjectThumbnailUrl(project = {}) {
  const firstImageUrl = (project.first_image_url || '').toString().trim();
  if (firstImageUrl) return firstImageUrl;

  const firstImage = project.first_image || project.first_image_candidate || project.firstImage || null;
  if (firstImage) return resolveCandidateImageUrl(firstImage);

  const candidates = Array.isArray(project.image_candidates) ? project.image_candidates : [];
  const cachedCandidate = candidates.find((candidate) => resolveStoragePublicUrl(candidate));
  return cachedCandidate ? resolveStoragePublicUrl(cachedCandidate) : resolveCandidateImageUrl(candidates[0] || {});
}

export function buildProjectCard(project = {}) {
  const id = resolveVideoProjectKey(project);
  const encodedId = encodeURIComponent(id);
  const title = escapeHtmlCore(resolveVideoProjectTitle(project));
  const player = escapeHtmlCore((project.jugador || t('scripts.noPlayer')).toString());
  const country = escapeHtmlCore((project.seleccion || t('scripts.noSelection')).toString());
  const imageUrl = resolveProjectThumbnailUrl(project);
  const phase = escapeHtmlCore(getProjectCardPhaseLabel(project));
  const statusName = escapeHtmlCore((project.status || 'unknown').toString());
  const createdAt = project.published_at || project.created_at || project.updated_at;

  return `
    <article class="video-project-card" data-project-id="${encodedId}">
      <header class="video-project-card__header">
        <div>
          <h3>${title}</h3>
        </div>
        <div class="video-project-card__actions">
          <button class="video-project-card__delete" type="button" data-action="delete-video-project" data-project-id="${encodedId}" aria-label="${t('scripts.deleteProjectAria', { title })}"><span aria-hidden="true">✕</span></button>
        </div>
      </header>

      <div class="video-project-card__body">
        <div class="video-project-card__thumb">
          ${imageUrl
            ? `<img src="${escapeHtmlCore(imageUrl)}" alt="" width="86" height="68" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
            : '<span aria-hidden="true">VP</span>'}
        </div>
        <div class="video-project-card__copy">
          <div class="video-project-card__meta">
            <span>${t('scripts.player')}: <strong>${player}</strong></span>
            <span>${t('scripts.country')}: <strong>${country}</strong></span>
            <span>${formatCount(project.image_count, t('scripts.imageUnitOne'), t('scripts.imageUnitMany'))}</span>
            <span>${formatDateLabel(createdAt)}</span>
            <span class="video-project-status video-project-card__phase" data-status="${statusName}">${phase}</span>
          </div>
        </div>
      </div>

      <button class="video-project-card__open" type="button" data-action="open-video-project" data-project-id="${encodedId}">
        ${t('scripts.openProject')}
      </button>
    </article>
  `;
}

export function buildFutureProjectCard() {
  return `
    <article class="video-project-card video-project-card--placeholder" aria-label="${t('scripts.futureProjectAria')}">
      <h3>${t('scripts.futureProjectTitle')}</h3>
      <p>${t('scripts.futureProjectBody')}</p>
      <span class="video-project-card__plus" aria-hidden="true">＋</span>
    </article>
  `;
}
