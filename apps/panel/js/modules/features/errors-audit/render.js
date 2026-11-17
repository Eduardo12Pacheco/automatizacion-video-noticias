import { t } from '../../core/i18n/index.js';
import { normalizeGatewayEvent } from './state.js';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../../core/ui/screen-state.js';

function escapeHtml(value) {
  return (value ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.toString();
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date).replace(/\./g, '') + ' UTC';
}

export function renderErrorsAuditEvents({ el, state }) {
  if (el.errorsAuditStatus) {
    el.errorsAuditStatus.textContent = state.status === 'loading'
      ? t('errors.loading')
      : state.status === 'error'
        ? t('errors.loadFailed')
        : t('errors.count', { count: state.events?.length || 0 });
  }
  if (!el.errorsAuditList) return;
  if (state.status === 'loading') {
    el.errorsAuditList.innerHTML = renderLoadingState({ rows: 4, variant: 'rows' });
    return;
  }
  if (state.status === 'error') {
    el.errorsAuditList.innerHTML = renderErrorState({
      error: state.cause,
      fallbackKey: 'errors.unavailable',
      retryAttribute: 'data-errors-audit-action="refresh"',
    });
    return;
  }
  const events = Array.isArray(state.events) ? state.events.map(normalizeGatewayEvent) : [];
  el.errorsAuditList.innerHTML = events.length
    ? events.map(renderEventCard).join('')
    : renderEmptyState({
        icon: 'alert',
        titleKey: 'errors.emptyTitle',
        messageKey: 'errors.emptyMessage',
      });
}

export function renderErrorsAuditDetail({ el, event }) {
  if (!el.errorsAuditDetail) return;
  if (!event) {
    el.errorsAuditDetail.innerHTML = `<p class="meta">${t('errors.select')}</p>`;
    return;
  }
  const item = normalizeGatewayEvent(event);
  el.errorsAuditDetail.innerHTML = `
    <section class="errors-audit-detail" aria-live="polite">
      <header>
        <span class="errors-audit-chip">${escapeHtml(item.kind)}</span>
        <div><h3>${escapeHtml(item.safeMessage || item.reasonCode || t('errors.systemEvent'))}</h3><p class="meta">${escapeHtml(formatDate(item.timestamp))}</p></div>
      </header>
      ${detailRow(t('errors.correlation'), item.correlationId)}
      ${detailRow(t('errors.status'), item.status)}
      ${detailRow(t('errors.routeService'), [item.method, item.path, item.routeService].filter(Boolean).join(' · '))}
      ${detailRow(t('errors.actorSession'), [item.actorLabel, item.sessionId].filter(Boolean).join(' · '))}
      ${detailRow(t('errors.actionReason'), [item.action, item.reasonCode].filter(Boolean).join(' · '))}
      <pre class="errors-audit-context">${escapeHtml(JSON.stringify(item.context || {}, null, 2))}</pre>
    </section>`;
}

function renderEventCard(rawEvent) {
  const item = normalizeGatewayEvent(rawEvent);
  const meta = [item.kind, item.status, item.routeService, item.actorLabel].filter(Boolean).join(' · ');
  return `
    <article class="errors-audit-card" data-errors-audit-event-id="${escapeHtml(item.id)}">
      <button type="button" data-errors-audit-action="detail" data-errors-audit-event-id="${escapeHtml(item.id)}">
        <span class="errors-audit-card__status">${escapeHtml(item.kind)}</span>
        <strong>${escapeHtml(item.safeMessage || item.reasonCode || item.action || t('errors.systemEvent'))}</strong>
        <small>${escapeHtml(meta)}</small>
        <code>${escapeHtml(item.correlationId || t('errors.noCorrelation'))}</code>
      </button>
    </article>`;
}

function detailRow(label, value) {
  return `<p><strong>${escapeHtml(label)}</strong>: ${escapeHtml(value || '—')}</p>`;
}
