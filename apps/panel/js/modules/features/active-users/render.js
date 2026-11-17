import { emptyPresenceSnapshot, normalizePresenceSnapshot } from './state.js';
import { t } from '../../core/i18n/index.js';
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
  if (!value) return t('activeUsers.noRecentActivity');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.toString();
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date).replace(/\./g, '') + ' UTC';
}

export function renderActiveUsersView({ el, state }) {
  const snapshot = state.status === 'error'
    ? emptyPresenceSnapshot()
    : normalizePresenceSnapshot(state.snapshot);

  if (el.activeUsersStatus) {
    el.activeUsersStatus.textContent = state.status === 'loading'
      ? t('activeUsers.loading')
      : state.status === 'error'
        ? t('activeUsers.loadFailed')
        : t(snapshot.sessions.length === 1 ? 'activeUsers.sessionCountOne' : 'activeUsers.sessionCount', { count: snapshot.sessions.length });
  }
  if (!el.activeUsersList) return;
  if (state.status === 'loading') {
    el.activeUsersList.innerHTML = renderLoadingState({ rows: 3, variant: 'cards' });
    return;
  }
  if (state.status === 'error') {
    el.activeUsersList.innerHTML = renderErrorState({
      error: state.cause,
      fallbackKey: 'activeUsers.empty',
      retryAttribute: 'data-active-users-action="refresh"',
    });
    return;
  }
  el.activeUsersList.innerHTML = snapshot.sessions.length
    ? snapshot.sessions.map(renderPresenceCard).join('')
    : renderEmptyState({
        icon: 'users',
        titleKey: 'activeUsers.emptyTitle',
        messageKey: 'activeUsers.emptyMessage',
      });
}

function renderPresenceCard(session) {
  return `
    <article class="active-users-card">
      <header>
        <strong>${escapeHtml(session.actorLabel)}</strong>
        <span>${escapeHtml(session.mode)}</span>
      </header>
      <p>${escapeHtml(session.area)} · ${escapeHtml(session.resourceLabel)}</p>
      <small>${t('activeUsers.lastActivity', { value: escapeHtml(formatDate(session.lastActivityAt)) })}</small>
    </article>`;
}
