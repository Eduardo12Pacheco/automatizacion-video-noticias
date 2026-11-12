import { createConnectorsState } from './state.js';
import { renderConnectorsView } from './render.js';
import { t } from '../../core/i18n/index.js';

export function createConnectorsController({ state = createConnectorsState(), el, api, ui = {} } = {}) {
  const notify = (message) => ui.toast?.(message);

  function render() {
    renderConnectorsView({ el, state });
  }

  async function refresh({ silent = false } = {}) {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    state.status = silent ? state.status : 'loading';
    state.error = '';
    render();
    try {
      state.connectors = await api.listConnectors();
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      state.cause = error;
      state.error = error?.status === 403 ? t('connectors.forbidden') : t('connectors.error');
      if (!silent) notify(state.error);
    } finally {
      state.refreshInFlight = false;
      render();
    }
  }

  async function testConnector(id) {
    if (!id || state.busyId) return;
    state.busyId = id;
    render();
    try {
      const result = await api.testConnector(id);
      state.results[id] = result;
      if (result?.ok) notify(t('connectors.testOk'));
      else notify(t('connectors.testFailed'));
      await refresh({ silent: true });
    } catch (error) {
      state.cause = error;
      state.error = error?.status === 403 ? t('connectors.forbidden') : t('connectors.testFailed');
      notify(state.error);
    } finally {
      state.busyId = '';
      render();
    }
  }

  function bindEvents() {
    el.connectorsRefreshBtn?.addEventListener?.('click', () => { void refresh(); });
    el.connectorsList?.addEventListener?.('click', (event) => {
      if (event.target?.closest?.('[data-connectors-action="refresh"]')) {
        void refresh();
        return;
      }
      const button = event.target?.closest?.('[data-connector-test]');
      if (!button) return;
      void testConnector(button.dataset.connectorTest || '');
    });
  }

  async function activate() { await refresh(); }
  function deactivate() {}

  return { activate, deactivate, bindEvents, refresh, render, testConnector };
}
