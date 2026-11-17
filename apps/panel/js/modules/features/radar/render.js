import { t } from '../../core/i18n/index.js';
import { RADAR_COUNTRIES, getVisibleMonitorCards, mapMonitorCard, normalizeMonitorCardStatus } from './state.js';
import { formatDemoDateTimeWithZone } from '../../shared/time/demo-time.js';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../../core/ui/screen-state.js';

const COUNTRY_LABELS = new Map([
  ...RADAR_COUNTRIES.map((country) => [country.value, country.label]),
  ['ar', 'Valdoria'],
  ['arg', 'Valdoria'],
  ['co', 'Montelia'],
  ['col', 'Montelia'],
  ['ec', 'Aurenia'],
  ['ecu', 'Aurenia'],
  ['py', 'Bosquemar'],
  ['pry', 'Bosquemar'],
  ['uy', 'Rivamar'],
  ['ury', 'Rivamar'],
  ['mx', 'Terramar'],
  ['mex', 'Terramar'],
  ['important', t('radar.importantPlural')],
]);

const LIFECYCLE_LABEL_KEYS = {
  aprobado: 'radar.status.approved',
  transcribiendo: 'radar.status.transcribing',
  transcrito: 'radar.status.transcribed',
  enqueue_pending: 'radar.status.waiting',
  enqueued: 'radar.status.queued',
  queued: 'radar.status.queued',
  processing: 'radar.status.analyzing',
  processed: 'radar.status.analysisReady',
  completed: 'radar.status.analysisReady',
  ignored_seen: 'radar.status.seenDiscarded',
  ignored: 'radar.status.discarded',
  skipped: 'radar.status.skipped',
  failed: 'radar.status.failed',
  monitor: 'radar.status.monitored',
};

const IMPORTANT_LIFECYCLE_LABEL_KEYS = {
  aprobado: 'radar.priorityApproved',
  transcribiendo: 'radar.priorityTranscribing',
  transcrito: 'radar.priorityTranscribed',
  enqueue_pending: 'radar.priorityWaitingQueue',
  enqueued: 'radar.priorityQueued',
  queued: 'radar.priorityQueued',
  processing: 'radar.priorityAnalyzing',
  processed: 'radar.priorityAnalysisReady',
  completed: 'radar.priorityAnalysisReady',
  ignored_seen: 'radar.status.seenDiscarded',
  ignored: 'radar.status.discarded',
  skipped: 'radar.prioritySkipped',
  failed: 'radar.priorityFailed',
  monitor: 'radar.status.importantMonitored',
};

function escapeHtml(value) {
  return (value ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTranscriptCopy(transcript = {}) {
  if (transcript.text) return transcript.text.toString().trim();
  return (transcript.segments || [])
    .map((segment) => `(${formatTimestamp(segment.start_ms)}) ${(segment.text || '').toString().trim()}`.trim())
    .filter(Boolean)
    .join('\n');
}

export function formatMentionsCopy(mentions = {}) {
  return (mentions.matches || [])
    .map((match) => {
      const canonical = match.canonical || match.canonical_target || match.target || '';
      const keyword = match.keyword || match.matched_variant || match.variant || '';
      const context = match.context || match.text || [match.context_before, match.context_after].filter(Boolean).join(' ');
      return `(${formatTimestamp(match.start_ms)}) ${canonical} [${keyword}] ${context}`.trim();
    })
    .join('\n');
}

export function renderRadarStatus({ el, state }) {
  if (el.radarHealthStatus) {
    const status = state.health?.status || 'unknown';
    const isReachable = status === 'ok' || status === 'degraded';
    el.radarHealthStatus.textContent = isReachable ? t('radar.serviceActive') : t('radar.serviceInactive');
    el.radarHealthStatus.title = status === 'degraded'
      ? t('radar.serviceDegradedTitle')
      : (state.health?.message || '');
    el.radarHealthStatus.classList?.toggle?.('is-online', isReachable);
    el.radarHealthStatus.classList?.toggle?.('is-offline', !isReachable);
  }
  if (el.radarProgressStatus) {
    const percent = state.currentJob?.progress?.percent;
    const suffix = Number.isFinite(Number(percent)) ? ` · ${percent}%` : '';
    const errorMessage = state.currentJob?.error?.message;
    el.radarProgressStatus.textContent = state.currentJob
      ? `${humanJobStatus(state.currentJob.status)}${suffix}${errorMessage ? ` · ${errorMessage}` : ''}`
      : state.health?.status === 'error' && state.health?.message
        ? state.health.message
      : t('radar.readyToResearch');
  }
  if (el.radarSubmitBtn) el.radarSubmitBtn.disabled = ['queued', 'running'].includes(state.currentJob?.status);
}

export function renderRadarResults({ el, state }) {
  if (!el.radarQueueList) return;
  const job = state.currentJob;
  if (!job || job.status === 'succeeded' || job.status === 'cancelled') {
    el.radarQueueList.classList?.add?.('is-empty');
    el.radarQueueList.innerHTML = t('radar.noQueuedJobs');
    return;
  }
  const countries = (job.selected_countries || job.countries || []).join(', ');
  const title = job.title || job.url || job.job_id;
  const isFailed = job.status === 'failed';
  const error = job.error?.message || job.error?.code || '';
  el.radarQueueList.classList?.remove?.('is-empty');
  el.radarQueueList.innerHTML = `
    <article class="audio-queue-item radar-job-card ${isFailed ? 'is-failed' : 'is-active'}" data-radar-job-id="${escapeHtml(job.job_id)}">
      <div class="radar-job-card__main">
        <span class="radar-kicker">${isFailed ? t('radar.jobFailed') : t('radar.processingJob')}</span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(countries || t('radar.noCountry'))}</small>
        ${error ? `<p class="radar-error-text">${escapeHtml(error)}</p>` : ''}
      </div>
      <span class="radar-status-chip ${isFailed ? 'is-failed' : 'is-processing'}">${escapeHtml(humanJobStatus(job.status || 'queued'))}</span>
      <button type="button" data-radar-action="${isFailed ? 'delete' : 'cancel'}" data-radar-job-id="${escapeHtml(job.job_id)}">${isFailed ? t('common.delete') : t('common.cancel')}</button>
    </article>
  `;
}

export function renderRadarHistory({ el, history = [] }) {
  if (!el.radarHistoryList) return;
  const completed = history.filter((job) => job.status === 'succeeded');
  if (!completed.length) {
    el.radarHistoryList.classList?.add?.('is-empty');
    el.radarHistoryList.innerHTML = t('radar.noTranscriptsYet');
    return;
  }
  el.radarHistoryList.classList?.remove?.('is-empty');
  el.radarHistoryList.innerHTML = completed.map((job) => {
    const target = job.title || job.target?.name || (job.selected_countries || []).join(', ') || t('radar.untitled');
    const count = Number(job.mention_count || job.matches_count || 0);
    const language = job.detected_language || t('radar.pendingLanguage');
    const canDownload = job.artifacts?.export_txt;
    return `
      <article class="audio-queue-item radar-transcript-card" data-radar-job-id="${escapeHtml(job.job_id)}">
        <div class="radar-job-card__main">
          <span class="radar-kicker">${t('radar.transcriptReady')}</span>
          <strong>${escapeHtml(target)}</strong>
          <small>${escapeHtml(language)} · ${count === 1 ? t('radar.mentionOne', { count }) : t('radar.mentionMany', { count })}</small>
        </div>
        <div class="radar-card-actions">
          <button type="button" data-radar-action="summary" data-radar-job-id="${escapeHtml(job.job_id)}">${t('radar.summary')}</button>
          <button type="button" data-radar-action="download" data-radar-job-id="${escapeHtml(job.job_id)}" ${canDownload ? '' : 'disabled'}>${t('radar.downloadTxt')}</button>
          <button type="button" data-radar-action="delete" data-radar-job-id="${escapeHtml(job.job_id)}">${t('common.delete')}</button>
        </div>
      </article>
    `;
  }).join('');
}

export function renderRadarMonitor({ el, state }) {
  if (!el.radarMonitorList) return;
  const status = state.monitorStatus || 'idle';
  const visibleCards = getVisibleMonitorCards(state.monitorCards || [], {
    country: state.selectedCountry || '',
    query: state.monitorSearchQuery || '',
    sortMode: state.monitorSortMode || 'relevance',
  });
  if (el.radarMonitorStatus) {
    el.radarMonitorStatus.textContent = monitorStatusText({ status, total: state.monitorCards?.length || 0, visible: visibleCards.length, error: state.monitorError });
  }
  if (el.radarBasuraCount) el.radarBasuraCount.textContent = String(Number(state.basuraCount || 0));
  renderBasuraList({ el, state });
  updateCountryBar(el.radarCountryBar, state.selectedCountry || '');
  if (status === 'loading') {
    el.radarMonitorList.classList?.add?.('is-empty');
    el.radarMonitorList.innerHTML = renderLoadingState({ rows: 2, variant: 'cards' });
    return;
  }
  if (status === 'error') {
    el.radarMonitorList.classList?.add?.('is-empty');
    el.radarMonitorList.innerHTML = renderErrorState({
      error: state.monitorCause,
      fallbackKey: 'radar.monitorError',
      retryAttribute: 'data-radar-action="refresh-monitor"',
    });
    return;
  }
  if (!visibleCards.length) {
    el.radarMonitorList.classList?.add?.('is-empty');
    el.radarMonitorList.innerHTML = renderEmptyState({
      icon: 'search',
      titleKey: 'radar.emptyTitle',
      messageKey: 'radar.emptyMessage',
    });
    return;
  }
  el.radarMonitorList.classList?.remove?.('is-empty');
  el.radarMonitorList.innerHTML = visibleCards.map(renderMonitorCard).join('');
}

function monitorStatusText({ status, total, visible, error }) {
  if (status === 'loading') return t('radar.loadingVideos');
  if (status === 'error') return error || t('radar.monitorUnavailable');
  if (status === 'degraded') return t('radar.monitorDegraded', { visible, total });
  return t('radar.monitorCount', { visible, total });
}

function updateCountryBar(countryBar, selectedCountry = '') {
  countryBar?.querySelectorAll?.('[data-radar-country-option]')?.forEach?.((button) => {
    const isActive = button.dataset?.radarCountryOption === selectedCountry;
    button.classList?.toggle?.('is-active', isActive);
    button.setAttribute?.('aria-pressed', isActive ? 'true' : 'false');
  });
}

function renderMonitorCard(card = {}) {
  const dashboardCard = mapMonitorCard(card, Array.isArray(card.mentionCounts) ? card.mentionCounts : []);
  const title = card.title || card.video_id || t('radar.videoUntitled');
  const meta = formatMonitorMetadata(card);
  const importantAudit = formatImportantAudit(card);
  const status = normalizeMonitorCardStatus(card);
  const statusLabel = formatMonitorDisplayStatus(card, status);
  const url = resolveMonitorVideoUrl(card);
  const canDownloadTranscript = status === 'transcrito' && Boolean(card.radar_job_id);
  const linkDisabled = url ? '' : `disabled aria-disabled="true" title="${t('radar.linkUnavailable')}"`;
  const transcriptDisabled = canDownloadTranscript ? '' : `disabled aria-disabled="true" title="${t('radar.transcriptUnavailable')}"`;
  const mentions = Array.isArray(dashboardCard.mentionCounts) ? dashboardCard.mentionCounts : [];
  const dismissContext = resolveDismissContext(card);
  const dismissLabel = formatCountryLabel(dismissContext) || t('radar.noCountry');
  const emptyMentions = status === 'transcrito'
    ? `<span class="radar-mention-row is-ready"><small>${t('radar.noMentionsLabel')}</small><strong>0</strong></span>`
    : `<span class="radar-mention-row is-pending"><small>${t('radar.pendingLabel')}</small><strong>—</strong></span>`;
  return `
    <article class="radar-monitor-card" data-video-id="${escapeHtml(card.video_id || '')}" data-radar-job-id="${escapeHtml(card.radar_job_id || '')}">
      <div class="radar-monitor-card__main">
        <span class="radar-status-chip ${escapeHtml(monitorStatusChipClass(status))}">${escapeHtml(statusLabel)}</span>
        <strong>${escapeHtml(title)}</strong>
        <small class="radar-monitor-card__meta">${escapeHtml(meta || t('radar.metadataPending'))}</small>
        ${importantAudit ? `<small class="radar-monitor-card__meta">${escapeHtml(importantAudit)}</small>` : ''}
      </div>
      <div class="radar-monitor-card__actions" aria-label="${t('radar.actionsAria')}">
        <button type="button" data-radar-action="open-link" data-radar-url="${escapeHtml(url)}" aria-label="${t('radar.openVideoAria')}" ${linkDisabled}>${t('radar.openVideo')}</button>
        <button type="button" data-radar-action="download-monitor-transcript" data-radar-job-id="${escapeHtml(card.radar_job_id || '')}" aria-label="${t('radar.downloadTranscriptAria')}" ${transcriptDisabled}>${t('radar.transcript')}</button>
        <button class="danger radar-monitor-card__dismiss" type="button" data-radar-action="dismiss-monitor-card" data-radar-dismiss-surface="monitor-card" data-radar-dismiss-target-context="${escapeHtml(dismissContext)}" data-radar-dismiss-target-label="${escapeHtml(dismissLabel)}" data-radar-dismiss-video-id="${escapeHtml(card.video_id || '')}" aria-label="${t('radar.dismissAria', { context: escapeHtml(dismissLabel) })}">${t('common.delete')}</button>
      </div>
      <div class="radar-monitor-card__mentions" aria-label="${t('radar.mentionsDetectedAria')}">
        <span class="radar-monitor-card__mentions-title" data-i18n="radar.mentions">${t('radar.mentions')}</span>
        <div class="radar-monitor-card__mentions-grid">
          ${mentions.length ? mentions.map(renderMentionColumn).join('') : emptyMentions}
        </div>
      </div>
    </article>
  `;
}

function resolveDismissContext(card = {}) {
  const rawContext = card.target_country || card.country || '';
  const normalized = normalizeKey(rawContext);
  if (normalized === 'importantes') return 'important';
  return normalized || 'monitor';
}

function resolveMonitorVideoUrl(card = {}) {
  const rawUrl = (card.url || '').toString().trim();
  if (isSafeYouTubeUrl(rawUrl)) return rawUrl;
  const videoId = (card.video_id || '').toString().trim();
  if (/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return '';
}

function isSafeYouTubeUrl(rawUrl = '') {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname);
  } catch {
    return false;
  }
}

function monitorStatusChipClass(status = '') {
  const normalized = normalizeKey(status).replace(/-/g, '_');
  if (normalized === 'aprobado') return 'is-info';
  if (normalized === 'transcribiendo') return 'is-warning';
  if (normalized === 'transcrito') return 'is-success';
  if (normalized === 'geo_blocked' || normalized === 'yt_dlp_geo_blocked') return 'is-failed';
  if (normalized === 'error' || normalized === 'failed') return 'is-failed';
  return 'is-processing';
}

function formatMonitorMetadata(card = {}) {
  const target = card.target_country_label || card.country_label || formatCountryLabel(card.target_country || card.country);
  const source = card.source_country_label || formatCountryLabel(card.source_country);
  const channel = card.channel_label || card.channel_name || card.channel;
  const uploaded = formatUploadedAt(card.published_at || card.uploaded_at || card.created_at);
  return [target ? t('radar.destination', { value: target }) : '', source ? t('radar.sourceLabel', { value: source }) : '', channel ? t('radar.channelLabel', { value: channel }) : '', uploaded].filter(Boolean).join(' · ');
}

function formatImportantAudit(card = {}) {
  if (!card.important && normalizeKey(card.target_country || card.country) !== 'important') return '';
  const reason = formatImportantReason(card.important_reason || card.importantReason || card.classification_reason || card.classificationReason || '');
  const rule = formatImportantRule(card.important_rule || card.importantRule);
  return [reason ? t('radar.importantReason', { value: reason }) : t('radar.important'), rule].filter(Boolean).join(' · ');
}

function formatImportantReason(value = '') {
  const normalized = normalizeKey(value).replace(/-/g, '_');
  const labelKeys = {
    important_program_match: 'radar.reason.programMatch',
    important_full_channel: 'radar.reason.fullChannel',
    full_channel: 'radar.reason.fullChannel',
    program_rules: 'radar.reason.programMatch',
    important_channel: 'radar.reason.importantChannel',
  };
  return labelKeys[normalized] ? t(labelKeys[normalized]) : humanizeToken(value);
}

function formatImportantRule(rule = null) {
  if (!rule || typeof rule !== 'object') return '';
  const op = (rule.op || rule.type || '').toString().trim();
  const value = (rule.value || rule.label || '').toString().trim();
  if (op && value) return `${op}: ${value}`;
  return value || op;
}

function formatCountryLabel(value = '') {
  const normalized = normalizeKey(value);
  if (!normalized) return '';
  return COUNTRY_LABELS.get(normalized) || value.toString().trim();
}

function formatLifecycleLabel(value = '') {
  const normalized = normalizeKey(value).replace(/-/g, '_');
  if (!normalized) return t('radar.status.monitored');
  return LIFECYCLE_LABEL_KEYS[normalized] ? t(LIFECYCLE_LABEL_KEYS[normalized]) : humanizeToken(value);
}

function formatMonitorDisplayStatus(card = {}, normalizedStatus = '') {
  const displayStatus = (card.display_status || card.displayStatus || '').toString().trim();
  if (displayStatus) return displayStatus;
  if (isGeoBlockedStatus(normalizedStatus) || isGeoBlockedStatus(card.last_error || card.lastError)) return t('radar.status.geoBlocked');
  if (isImportantMonitorCard(card)) {
    return formatImportantLifecycleLabel(normalizedStatus);
  }
  return formatLifecycleLabel(normalizedStatus);
}

function formatImportantLifecycleLabel(value = '') {
  const normalized = normalizeKey(value).replace(/-/g, '_');
  if (!normalized) return t('radar.status.importantMonitored');
  return IMPORTANT_LIFECYCLE_LABEL_KEYS[normalized] ? t(IMPORTANT_LIFECYCLE_LABEL_KEYS[normalized]) : humanizeToken(value);
}

function isImportantMonitorCard(card = {}) {
  return Boolean(card.important)
    || normalizeKey(card.target_country || card.country) === 'important'
    || normalizeKey(card.target_country_label || card.country_label) === 'importantes';
}

function isGeoBlockedStatus(value = '') {
  const normalized = normalizeKey(value).replace(/-/g, '_');
  return normalized === 'geo_blocked' || normalized === 'yt_dlp_geo_blocked';
}

function formatUploadedAt(value = '') {
  const formatted = formatDemoDateTimeWithZone(value);
  return formatted ? t('radar.uploaded', { value: formatted }) : '';
}

function normalizeKey(value = '') {
  return (value || '').toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function humanizeToken(value = '') {
  const text = (value || '').toString().trim().replace(/[_-]+/g, ' ').toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : t('radar.status.monitored');
}

function renderMentionColumn(item = {}) {
  const isPending = item.status && item.status !== 'ready';
  return `
    <span class="radar-mention-row ${isPending ? 'is-pending' : ''}">
      <small>${escapeHtml(item.label || t('radar.pendingLabel'))}:</small>
      <strong>${escapeHtml(item.count ?? '—')}</strong>
    </span>
  `;
}

function humanJobStatus(status = '') {
  const keyMap = {
    aprobado: 'radar.status.approved',
    transcribiendo: 'radar.status.transcribing',
    transcrito: 'radar.status.transcribed',
    geo_blocked: 'radar.status.geoBlocked',
    yt_dlp_geo_blocked: 'radar.status.geoBlocked',
    error: 'radar.status.error',
    queued: 'radar.status.enqueued',
    running: 'radar.status.running',
    succeeded: 'radar.status.completed',
    failed: 'radar.status.failed',
    cancelled: 'radar.status.cancelled',
    cancel_requested: 'radar.status.cancelling',
    delete_requested: 'radar.status.deleting',
  };
  return keyMap[status] ? t(keyMap[status]) : (status || t('radar.status.noStatus'));
}

function renderBasuraList({ el, state }) {
  if (!el.radarBasuraList) return;
  const items = Array.isArray(state.basuraItems) ? state.basuraItems : [];
  el.radarBasuraList.innerHTML = items.length
    ? items.map((item) => `
      <article class="radar-basura-item" data-video-id="${escapeHtml(item.video_id || '')}">
        <strong>${escapeHtml(item.title || item.video_id || t('radar.videoUntitled'))}</strong>
        <small>${escapeHtml([item.source_country_label || formatCountryLabel(item.source_country), item.channel_label, item.reason].filter(Boolean).join(' · '))}</small>
      </article>
    `).join('')
    : `<article class="radar-monitor-empty">${t('radar.noDiscardedVideos')}</article>`;
}

export function renderRadarSummary({ el, summary }) {
  if (!el.radarSummaryBody) return;
  const items = summary?.items || [];
  el.radarSummaryBody.innerHTML = items.length
    ? items.map((item) => `<p><strong>${escapeHtml(item.label)}</strong>: ${t('radar.mentionMany', { count: escapeHtml(item.count) })} · ${escapeHtml((item.timestamps || []).join(', '))}</p>`).join('')
    : `<p>${t('radar.noMentionsDetected')}</p>`;
}
