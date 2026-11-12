import { escapeHtmlCore } from '../../core/ui/escape-html.js';
import { t } from '../../core/i18n/index.js';

function roleLabel(role) {
  return t(`users.role${role.charAt(0).toUpperCase()}${role.slice(1)}`);
}

function formatLastLogin(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(document.documentElement.lang || 'es', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function renderAdminUsersView({ el, state }) {
  if (el.adminUsersStatus) {
    if (state.status === 'loading') el.adminUsersStatus.textContent = t('common.loading');
    else if (state.error) el.adminUsersStatus.textContent = state.error;
    else el.adminUsersStatus.textContent = `${state.users.length} ${t('users.title').toLowerCase()}`;
  }
  if (!el.adminUsersList) return;
  if (state.status === 'loading' && !state.users.length) {
    el.adminUsersList.innerHTML = `<article class="admin-users-empty">${escapeHtmlCore(t('common.loading'))}</article>`;
    return;
  }
  if (!state.users.length) {
    el.adminUsersList.innerHTML = `<article class="admin-users-empty">${escapeHtmlCore(t('users.empty'))}</article>`;
    return;
  }
  el.adminUsersList.innerHTML = `
    <table class="admin-users-table">
      <thead>
        <tr>
          <th scope="col">${escapeHtmlCore(t('users.name'))}</th>
          <th scope="col">${escapeHtmlCore(t('users.email'))}</th>
          <th scope="col">${escapeHtmlCore(t('users.roles'))}</th>
          <th scope="col">${escapeHtmlCore(t('users.status'))}</th>
          <th scope="col"><span class="visually-hidden">${escapeHtmlCore(t('users.resetPassword'))}</span></th>
        </tr>
      </thead>
      <tbody>
        ${state.users.map((user) => renderUserRow(user, state)).join('')}
      </tbody>
    </table>`;
}

function renderUserRow(user, state) {
  const active = user.status === 'active';
  const userId = escapeHtmlCore(user.user_id || '');
  const busy = state.busyUserId === user.user_id ? 'disabled' : '';
  const roles = (user.roles || []).map((role) => `<span class="role-chip">${escapeHtmlCore(roleLabel(role))}</span>`).join(' ');
  return `
    <tr data-user-id="${userId}">
      <td>${escapeHtmlCore(user.display_name || user.email || '')}</td>
      <td>${escapeHtmlCore(user.email || '')}</td>
      <td>${roles}</td>
      <td><span class="status-chip ${active ? 'status-chip--active' : 'status-chip--disabled'}">${escapeHtmlCore(t(active ? 'users.statusActive' : 'users.statusDisabled'))}</span></td>
      <td class="admin-users-actions">
        <button class="secondary" type="button" data-admin-user-action="toggle-status" data-user-id="${userId}" data-next-status="${active ? 'disabled' : 'active'}" ${busy}>${escapeHtmlCore(t(active ? 'users.disable' : 'users.enable'))}</button>
        <button class="ghost" type="button" data-admin-user-action="reset-password" data-user-id="${userId}" ${busy}>${escapeHtmlCore(t('users.resetPassword'))}</button>
        <small>${escapeHtmlCore(formatLastLogin(user.last_login_at))}</small>
      </td>
    </tr>`;
}
