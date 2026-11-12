import { escapeHtmlCore } from '../../core/ui/escape-html.js';
import { t } from '../../core/i18n/index.js';

const STATUS_CLASS = Object.freeze({
  local: 'status-chip--local',
  configured: 'status-chip--configured',
  disabled: 'status-chip--disabled',
  error: 'status-chip--error',
});

function connectorName(id) {
  const key = `connectors.name.${id}`;
  const translated = t(key);
  return translated === key ? id : translated;
}

function formatCheckedAt(value) {
  if (!value) return t('connectors.never');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('connectors.never');
  return new Intl.DateTimeFormat(document.documentElement.lang || 'es', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function renderCard(connector, state) {
  const id = escapeHtmlCore(connector.id || '');
  const status = STATUS_CLASS[connector.status] || STATUS_CLASS.disabled;
  const busy = state.busyId === connector.id;
  const result = state.results[connector.id];
  const message = result
    ? (result.ok ? t('connectors.testOk') : result.message || t('connectors.testFailed'))
    : (connector.status === 'error' ? connector.last_message || '' : '');
  const checkedAt = result?.checked_at || connector.last_checked_at;
  return `
    <article class="connector-card" data-connector-id="${id}">
      <header class="connector-card__head">
        <div>
          <h3>${escapeHtmlCore(connectorName(connector.id))}</h3>
          <p class="connector-card__port">${escapeHtmlCore(connector.port || '')}</p>
        </div>
        <span class="status-chip ${status}">${escapeHtmlCore(t(`connectors.status.${connector.status || 'disabled'}`))}</span>
      </header>
      <dl class="connector-card__meta">
        <div><dt>${escapeHtmlCore(t('connectors.adapter'))}</dt><dd>${escapeHtmlCore(connector.adapter || 'none')}</dd></div>
        ${connector.detail ? `<div><dt>${escapeHtmlCore(t('connectors.detail'))}</dt><dd>${escapeHtmlCore(connector.detail)}</dd></div>` : ''}
        ${Array.isArray(connector.env) && connector.env.length ? `<div><dt>${escapeHtmlCore(t('connectors.env'))}</dt><dd>${escapeHtmlCore(connector.env.join(', '))}</dd></div>` : ''}
        <div><dt>${escapeHtmlCore(t('connectors.lastChecked'))}</dt><dd>${escapeHtmlCore(formatCheckedAt(checkedAt))}</dd></div>
      </dl>
      ${message ? `<p class="connector-card__message">${escapeHtmlCore(message)}</p>` : ''}
      <footer class="connector-card__foot">
        <button class="secondary" type="button" data-connector-test="${id}" ${busy || !connector.testable ? 'disabled' : ''}>
          ${escapeHtmlCore(busy ? t('connectors.testing') : t('connectors.test'))}
        </button>
      </footer>
    </article>`;
}

export function renderConnectorsView({ el, state }) {
  if (el.connectorsStatus) {
    if (state.status === 'loading') el.connectorsStatus.textContent = t('common.loading');
    else if (state.error) el.connectorsStatus.textContent = state.error;
    else el.connectorsStatus.textContent = `${state.connectors.length} ${t('connectors.title').toLowerCase()}`;
  }
  if (!el.connectorsList) return;
  if (state.status === 'loading' && !state.connectors.length) {
    el.connectorsList.innerHTML = `<article class="connector-empty">${escapeHtmlCore(t('common.loading'))}</article>`;
    return;
  }
  if (!state.connectors.length) {
    el.connectorsList.innerHTML = `<article class="connector-empty">${escapeHtmlCore(t('connectors.empty'))}</article>`;
    return;
  }
  el.connectorsList.innerHTML = state.connectors
    .map((connector) => renderCard(connector, state))
    .join('');
}
