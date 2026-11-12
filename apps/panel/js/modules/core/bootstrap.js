import { getI18n } from './i18n/index.js';

export function bindCoreEvents({
  el,
  persistSessionStatus,
  clearSessionStatus,
  loginGatewaySession,
  logoutGatewaySession,
  setView,
  refreshAll,
  refreshQueue,
  runQueue,
  saveSettings,
  defaultSettings,
  toast,
  renderCards,
  reloadPage,
}) {
  function openAuthenticatedShell() {
    persistSessionStatus();
    globalThis.__NEWSROOM_SYNC_ADMIN__?.();
    el.authGate.classList.add('hidden');
    el.appShell.classList.remove('hidden');
    el.authPass.value = '';
    setView('approval');
    toast('Sesión iniciada');
    refreshAll({ silent: true, source: 'login' });
  }

  function showAuthError(message = '') {
    if (!el.authError) return;
    if (message) el.authError.dataset.authErrorKey = 'auth.invalid';
    else delete el.authError.dataset.authErrorKey;
    el.authError.textContent = message;
    el.authError.hidden = !message;
  }

  el.authForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
      const user = el.authUser.value.trim();
      const pass = el.authPass.value;
      showAuthError('');

      if (typeof loginGatewaySession === 'function') {
        try {
          await loginGatewaySession({ user, pass });
          openAuthenticatedShell();
          return;
        } catch {
          // S9: local users live in the API/database; the panel never ships a
          // hardcoded fallback password.
        }
      }

      const i18n = getI18n();
      showAuthError(i18n.t('auth.invalid'));
      toast(i18n.t('auth.invalid'));
    })();
  });

  el.authForm.addEventListener('input', () => showAuthError(''));

  function syncAuthLanguageButtons(language) {
    el.authLanguageSwitch?.querySelectorAll?.('[data-auth-language]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.authLanguage === language ? 'true' : 'false');
    });
  }

  el.authLanguageSwitch?.addEventListener?.('click', (event) => {
    const button = event.target?.closest?.('[data-auth-language]');
    if (!button) return;
    const i18n = getI18n();
    const language = i18n.setLanguage(button.dataset.authLanguage || 'es');
    i18n.apply(document);
    syncAuthLanguageButtons(language);
    const errorKey = el.authError?.dataset?.authErrorKey;
    if (errorKey) el.authError.textContent = i18n.t(errorKey);
  });
  syncAuthLanguageButtons(getI18n().getLanguage());

  const mobileNavToggle = el.mobileNavToggle;
  const mobileNav = el.sidebarNav.closest?.('.sidebar');
  function closeMobileNav() {
    if (!mobileNav?.classList?.contains('is-nav-open')) return;
    mobileNav.classList.remove('is-nav-open');
    mobileNavToggle?.setAttribute('aria-expanded', 'false');
  }
  mobileNavToggle?.addEventListener('click', () => {
    const open = !mobileNav?.classList?.contains('is-nav-open');
    mobileNav?.classList?.toggle('is-nav-open', open);
    mobileNavToggle.setAttribute('aria-expanded', String(open));
  });
  globalThis.document?.addEventListener?.('keydown', (ev) => {
    if (ev.key === 'Escape') closeMobileNav();
  });

  el.sidebarNav.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.nav-item[data-view]');
    if (!btn) return;
    setView(btn.dataset.view);
    closeMobileNav();
  });

  el.refreshQueueBtn?.addEventListener('click', refreshQueue);
  el.runQueueBtn?.addEventListener('click', runQueue);
  el.settingsBtn.addEventListener('click', () => el.settingsDialog.showModal());
  el.logoutBtn.addEventListener('click', () => {
    if (typeof logoutGatewaySession === 'function') {
      void logoutGatewaySession().catch(() => {});
    }
    clearSessionStatus();
    reloadPage();
  });
  el.closeSettings.addEventListener('click', () => el.settingsDialog.close());
  el.openConnectorsBtn?.addEventListener('click', () => {
    el.settingsDialog.close();
    setView('connectors');
  });
  el.closeDialog.addEventListener('click', () => el.topicDialog.close());

  el.saveSettingsBtn.addEventListener('click', () => {
    saveSettings({
      brandChannel: el.brandChannelSelect?.value || 'demo-primary',
    });
    el.settingsDialog.close();
    toast('Configuración guardada');
    refreshAll({ silent: true, source: 'settings' });
  });

  let searchDebounceTimer = 0;
  [el.searchInput, el.countryFilter, el.sourcesFilter].forEach((inputEl) => {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      window.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = window.setTimeout(renderCards, 300);
    });
  });
}
