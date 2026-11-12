/**
 * Shared screen states (S10): designed empty, loading and error blocks.
 *
 * Every view uses the same vocabulary so a failed request never dumps a raw
 * HTTP body or stack trace into the DOM. Error details (status/code only) are
 * rendered behind a disclosure for administrators, never for other roles.
 */
import { escapeHtmlCore } from './escape-html.js';
import { t } from '../i18n/index.js';

const ICONS = Object.freeze({
  inbox: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M4.75 13.5 7 5.75h10l2.25 7.75v4.75a1 1 0 0 1-1 1h-12.5a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><path d="M4.75 13.5h4l1 1.75h4.5l1-1.75h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>',
  search: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>',
  alert: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 4.5 21 20H3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><path d="M12 9.5v4.75M12 17.25v.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>',
  script: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M7.25 4.75h6.5l4 4v10.5a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><path d="M13.75 4.75v4h4M8.75 12h6.5M8.75 15.25h6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>',
  video: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><rect x="3.75" y="6.5" width="12.5" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"></rect><path d="m16.25 10 4-2.25v8.5L16.25 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>',
  users: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="9" cy="9" r="3.25" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M3.75 19.25c0-2.6 2.35-4.5 5.25-4.5s5.25 1.9 5.25 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><path d="M15.5 6.25a3.25 3.25 0 0 1 0 6.5M17 14.9c2 .45 3.25 2.05 3.25 4.35" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>',
  connector: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M9 4.75v3.5M15 4.75v3.5M6.75 8.25h10.5v4a3.5 3.5 0 0 1-3.5 3.5h-3.5a3.5 3.5 0 0 1-3.5-3.5ZM12 15.75v3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  audio: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 4.5a3.5 3.5 0 0 0-3.5 3.5v4a3.5 3.5 0 1 0 7 0V8A3.5 3.5 0 0 0 12 4.5Z" fill="none" stroke="currentColor" stroke-width="1.6"></path><path d="M6.5 10.5a5.5 5.5 0 0 0 11 0M12 16v3.5M8.5 19.5h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>',
});

const STATUS_MESSAGE_KEYS = Object.freeze({
  401: 'errors.session',
  403: 'errors.forbidden',
  404: 'errors.notFound',
  409: 'errors.conflict',
  429: 'errors.throttled',
  503: 'errors.unavailable',
});

export function isAdminSession(session = globalThis.__CONTROL_PANEL_SESSION__) {
  return Array.isArray(session?.roles) && session.roles.includes('admin');
}

/** Reads the numeric status from an adapter error without touching its body. */
export function errorStatus(error) {
  const status = Number(error?.status || error?.http_status || 0);
  return Number.isFinite(status) && status > 0 ? status : 0;
}

/** Short, safe error code for the admin disclosure (never the response body). */
export function errorCode(error) {
  const raw = (error?.code || '').toString().trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_.:-]+/g, '').slice(0, 64);
}

/**
 * Maps an error to an i18n message key. HTTP status wins; otherwise the
 * caller's view-specific fallback is used. Response bodies are never read.
 */
export function describeError(error, fallbackKey = 'errors.generic') {
  const status = errorStatus(error);
  if (STATUS_MESSAGE_KEYS[status]) return STATUS_MESSAGE_KEYS[status];
  if (status >= 500) return 'errors.unavailable';
  return fallbackKey;
}

function stateContainer(className, body, { role = 'status', live = 'polite' } = {}) {
  return `<article class="${className}" role="${role}" aria-live="${live}">${body}</article>`;
}

export function renderLoadingState({ labelKey = 'state.loading', variant = 'cards', rows = 3 } = {}) {
  const items = Array.from({ length: Math.max(1, rows) }, () => (
    `<span class="skeleton-block skeleton-block--${variant}" aria-hidden="true"></span>`
  )).join('');
  return stateContainer(
    'screen-state screen-state--loading',
    `<div class="skeleton-stack" aria-hidden="true">${items}</div><p class="visually-hidden">${escapeHtmlCore(t(labelKey))}</p>`,
  );
}

export function renderEmptyState({
  icon = 'inbox',
  titleKey = 'state.emptyTitle',
  messageKey = 'state.emptyMessage',
  actionLabelKey = '',
  actionAttribute = '',
  actionValue = '',
} = {}) {
  const glyph = ICONS[icon] || ICONS.inbox;
  const action = actionLabelKey && actionAttribute
    ? `<button type="button" class="secondary" ${actionAttribute}="${escapeHtmlCore(actionValue)}">${escapeHtmlCore(t(actionLabelKey))}</button>`
    : '';
  return stateContainer(
    'screen-state screen-state--empty',
    `<span class="screen-state__icon" aria-hidden="true">${glyph}</span>
     <h3>${escapeHtmlCore(t(titleKey))}</h3>
     <p>${escapeHtmlCore(t(messageKey))}</p>
     ${action}`,
  );
}

export function renderErrorState({
  error,
  fallbackKey = 'errors.generic',
  titleKey = 'errors.title',
  retryLabelKey = 'errors.retry',
  retryAttribute = '',
  retryValue = '',
  admin = isAdminSession(),
} = {}) {
  const status = errorStatus(error);
  const code = errorCode(error);
  const messageKey = describeError(error, fallbackKey);
  const retry = retryAttribute
    ? `<button type="button" class="secondary" ${retryAttribute}="${escapeHtmlCore(retryValue)}">${escapeHtmlCore(t(retryLabelKey))}</button>`
    : '';
  const details = admin && (status || code)
    ? `<details class="screen-state__details">
         <summary>${escapeHtmlCore(t('errors.details'))}</summary>
         <dl>
           ${status ? `<div><dt>${escapeHtmlCore(t('errors.status'))}</dt><dd>${status}</dd></div>` : ''}
           ${code ? `<div><dt>${escapeHtmlCore(t('errors.code'))}</dt><dd>${escapeHtmlCore(code)}</dd></div>` : ''}
         </dl>
       </details>`
    : '';
  return stateContainer(
    'screen-state screen-state--error',
    `<span class="screen-state__icon" aria-hidden="true">${ICONS.alert}</span>
     <h3>${escapeHtmlCore(t(titleKey))}</h3>
     <p>${escapeHtmlCore(t(messageKey))}</p>
     ${retry}
     ${details}`,
    { role: 'alert', live: 'assertive' },
  );
}
