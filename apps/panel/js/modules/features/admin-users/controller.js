import { createAdminUsersState } from './state.js';
import { renderAdminUsersView } from './render.js';
import { t } from '../../core/i18n/index.js';

export function createAdminUsersController({ state = createAdminUsersState(), el, api, ui = {}, windowRef = globalThis.window } = {}) {
  const notify = (message) => ui.toast?.(message);

  function render() {
    renderAdminUsersView({ el, state });
  }

  async function refresh({ silent = false } = {}) {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    state.status = silent ? state.status : 'loading';
    state.error = '';
    render();
    try {
      const [users, roles] = await Promise.all([api.listUsers(), api.listRoles().catch(() => [])]);
      state.users = users;
      state.roles = roles;
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      state.error = error?.status === 403 ? t('users.forbidden') : (error?.message || t('users.forbidden'));
      if (!silent) notify(state.error);
    } finally {
      state.refreshInFlight = false;
      render();
    }
  }

  async function createUserFromForm(event) {
    event?.preventDefault?.();
    const displayName = el.adminUserName?.value?.trim() || '';
    const email = el.adminUserEmail?.value?.trim() || '';
    const password = el.adminUserPassword?.value || '';
    const role = el.adminUserRole?.value || 'editor';
    if (!email || password.length < 8) {
      state.error = t('users.password');
      render();
      return;
    }
    try {
      await api.createUser({ display_name: displayName, email, password, roles: [role] });
      if (el.adminUsersForm?.reset) el.adminUsersForm.reset();
      state.error = '';
      notify(t('users.created'));
      await refresh({ silent: true });
    } catch (error) {
      state.error = error?.message || t('users.forbidden');
      render();
      notify(state.error);
    }
  }

  async function toggleStatus(userId, nextStatus) {
    state.busyUserId = userId;
    render();
    try {
      await api.updateUser(userId, { status: nextStatus });
      notify(t('users.updated'));
      await refresh({ silent: true });
    } catch (error) {
      state.error = error?.message || t('users.forbidden');
      render();
      notify(state.error);
    } finally {
      state.busyUserId = '';
      render();
    }
  }

  async function resetPassword(userId) {
    const password = windowRef?.prompt?.(t('users.resetPassword'));
    if (!password) return;
    if (password.length < 8) {
      notify(t('users.password'));
      return;
    }
    state.busyUserId = userId;
    render();
    try {
      await api.updateUser(userId, { password });
      notify(t('users.passwordChanged'));
    } catch (error) {
      state.error = error?.message || t('users.forbidden');
      render();
      notify(state.error);
    } finally {
      state.busyUserId = '';
      render();
    }
  }

  function bindEvents() {
    el.adminUsersRefreshBtn?.addEventListener?.('click', () => { void refresh(); });
    el.adminUsersForm?.addEventListener?.('submit', createUserFromForm);
    el.adminUsersList?.addEventListener?.('click', (event) => {
      const button = event.target?.closest?.('[data-admin-user-action]');
      if (!button) return;
      const userId = button.dataset.userId || '';
      const action = button.dataset.adminUserAction;
      if (!userId) return;
      if (action === 'toggle-status') void toggleStatus(userId, button.dataset.nextStatus || 'active');
      if (action === 'reset-password') void resetPassword(userId);
    });
  }

  async function activate() { await refresh(); }
  function deactivate() {}

  return { activate, deactivate, bindEvents, refresh, render };
}
