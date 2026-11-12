import { renderToast } from '../core/ui/toast.js';
import { escapeHtmlCore } from '../core/ui/escape-html.js';
import { updateWordCounterCore } from '../core/ui/word-count.js';
import { defaultSettingsFactory } from '../core/state/app-store.js';
import { versionedModule } from '../core/versioning/asset-version.js';
import {
  clearSessionStatus,
  hydrateGatewaySession,
  loginGatewaySession,
  logoutGatewaySession,
  persistSessionStatus,
  readSessionStatus,
} from '../core/auth/session-gate.js';
import { bindCoreEvents } from '../core/bootstrap.js';
// Video Projects render (~60 modules) — loaded on first use, not at boot.
let _renderVideoProjectsListView = null;
let _renderSelectedVideoProjectView = null;
let _updateSelectedVideoProjectCompositionPreviewView = null;
async function _ensureVideoProjectsRender() {
  if (_renderVideoProjectsListView) return;
    const mod = await import(versionedModule('../features/video-projects/render.js', import.meta.url));
  _renderVideoProjectsListView = mod.renderVideoProjectsListView;
  _renderSelectedVideoProjectView = mod.renderSelectedVideoProjectView;
  _updateSelectedVideoProjectCompositionPreviewView = mod.updateSelectedVideoProjectCompositionPreview;
}
function renderVideoProjectsListView(...args) { return _renderVideoProjectsListView?.(...args); }
function renderSelectedVideoProjectView(...args) { return _renderSelectedVideoProjectView?.(...args); }
function updateSelectedVideoProjectCompositionPreviewView(...args) { return _updateSelectedVideoProjectCompositionPreviewView?.(...args); }
// Audio runtime helpers (~8 modules) — loaded on first use.
let _audioRuntime = null;
async function _ensureAudioRuntime() {
  if (_audioRuntime) return _audioRuntime;
  _audioRuntime = await import(versionedModule('../features/audio/runtime/index.js', import.meta.url));
  return _audioRuntime;
}
function getAudioStatusClassRuntime(...args) { return _audioRuntime?.getAudioStatusClassRuntime?.(...args); }
function getAudioStatusLabelRuntime(...args) { return _audioRuntime?.getAudioStatusLabelRuntime?.(...args); }
function isTerminalAudioStatus(...args) { return _audioRuntime?.isTerminalAudioStatus?.(...args); }
function normalizeAudioProgressPercent(...args) { return _audioRuntime?.normalizeAudioProgressPercent?.(...args); }
// Parity guard tokens: ./features/subtitles/runtime/index.js resolveSubtitleProgressPercentRuntime
import { createSettingsController } from './settings.js';
import { createAppShellComposition } from './composition.js';
import { createAppShellLifecycle } from './lifecycle.js';
import { bindShellEvents } from './events/index.js';
import { bindScriptEvents } from './events/scripts.js';
import { bindAudioEvents } from './events/audio.js';
import { bindSubtitlesEvents } from './events/subtitles.js';
import { bindApprovalDialogEvents } from './events/approval-dialog.js';
import { createShellNavigationController } from './views/navigation.js';
import { createApprovalSearchController } from './views/approval-search.js';
import { createShellRenderers } from './views/renderers.js';
import { createScriptToAudioVoiceController } from './voice/script-to-audio.js';
import { createI18n, setSharedI18n } from '../core/i18n/index.js';
import { createRuntimeRenderers } from './runtime-renderers.js';

const storageKey = 'approval-panel-settings-v1';
const sessionKey = 'approval-panel-session-v1';
const lastNewsSearchKey = 'approval-panel-last-news-search-at-v1';

const i18n = setSharedI18n(createI18n());

function waitForNextFrame() {
  return new Promise((resolve) => {
    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame === 'function') {
      requestFrame(resolve);
      return;
    }
    resolve();
  });
}

function defaultSettings() {
  return defaultSettingsFactory();
}

const __testOverrides = {
  ttsGet: null,
  toast: null,
};

let toastTimer = null;

let renderFns = null;

const composition = createAppShellComposition({
  documentRef: document,
  windowRef: window,
  storage: localStorage,
  storageKey,
  lastNewsSearchKey,
  fetchImpl: (...args) => globalThis.fetch(...args),
  btoaImpl: btoa,
  defaultsFactory: defaultSettings,
  ui: { toast },
  helpers: {
    escapeHtml,
    getErrorMessage,
    downloadBlob,
    resolveTtsGet: __resolveTtsGet,
    getBlob: ttsGetBlob,
  },
  callbacks: {
    renderStats: (...args) => renderFns?.renderStats(...args),
    renderCountryFilter: (...args) => renderFns?.renderCountryFilter(...args),
    renderCards: (...args) => renderFns?.renderCards(...args),
    renderQueue: (...args) => renderFns?.renderQueue(...args),
    renderTopicDetail: (...args) => renderFns?.renderTopicDetail(...args),
    refreshScriptDrafts: (...args) => renderFns?.refreshScriptDrafts(...args),
    renderScriptStats: (...args) => renderFns?.renderScriptStats(...args),
    renderScriptCards: (...args) => renderFns?.renderScriptCards(...args),
    renderSelectedScriptEditor: (...args) => renderFns?.renderSelectedScriptEditor(...args),
    renderVideoProjects: (...args) => renderFns?.renderVideoProjects(...args),
    renderSelectedVideoProject: (...args) => renderFns?.renderSelectedVideoProject(...args),
    updateSelectedVideoProjectCompositionPreview: (...args) => renderFns?.updateSelectedVideoProjectCompositionPreview(...args),
  },
  browser: { URL, AbortController, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, clipboard: globalThis.navigator?.clipboard },
});

const {
  state,
  el,
  customDropdowns,
  approvalApi,
  approvalFeature,
  scriptsFeature,
  videoProjectsFeature,
  radarController,
  errorsAuditController,
  activeUsersController,
  adminUsersController,
  subtitlesController,
  audioFeature,
  ttsApi,
  runQueueRefresh,
  runScriptDraftsRefresh,
  runVideoProjectsRefresh,
  _ensureApprovalFeature,
  _ensureScriptsFeature,
  _ensureVideoProjectsFeature,
  _ensureAudioFeature,
  _ensureSubtitlesFeature,
  _ensureRadarFeature,
  _ensureErrorsAuditFeature,
  _ensureActiveUsersFeature,
  _ensureAdminUsersFeature,
  _cssLoaded,
  _domInjected,
  _visited,
} = composition;

let approvalSearch = null;
const approvalSearchProxy = {
  runSearchRefresh: (...args) => approvalSearch?.runSearchRefresh(...args),
};

renderFns = createRuntimeRenderers({
  state,
  el,
  customDropdowns,
  approvalFeature,
  scriptsFeature,
  videoProjectsFeature,
  subtitlesController,
  radarController,
  audioFeature,
  approvalSearch: approvalSearchProxy,
  runQueueRefresh,
  runScriptDraftsRefresh,
  runVideoProjectsRefresh,
  _visited,
  _ensureVideoProjectsRender,
  renderVideoProjectsListView,
  renderSelectedVideoProjectView,
  updateSelectedVideoProjectCompositionPreviewView,
  waitForNextFrame,
  toast,
  updateWordCounter,
  escapeHtml,
});

const {
  hydrateSettingsForm,
  refreshAll,
  refreshPending,
  refreshQueue,
  refreshScriptDrafts,
  refreshVideoProjects,
  ensureApprovalAutoRefresh,
  refreshApprovalMonitorData,
  renderSearchRefreshState,
  runSearchRefresh,
  renderQueue,
  renderStats,
  renderCountryFilter,
  renderCards,
  renderScriptStats,
  renderScriptCards,
  renderSelectedScriptEditor,
  renderVideoProjects,
  renderSelectedVideoProject,
  updateSelectedVideoProjectCompositionPreview,
  openDetail,
  renderTopicDetail,
  openScriptEditor,
  openVideoProject,
  closeVideoProject,
  saveSelectedScript,
  publishSelectedScript,
  downloadSelectedScriptDocx,
  removeSourceFromTopic,
  approveSourceFromTopic,
  decision,
  runQueue,
} = renderFns;

const settingsController = createSettingsController({
  state,
  el,
  storage: localStorage,
  storageKey,
  lastNewsSearchKey,
  defaultsFactory: defaultSettings,
});

approvalSearch = createApprovalSearchController({
  state,
  el,
  customDropdowns,
  approvalApi,
  refreshAll,
  renderCards,
  toast,
  getErrorMessage,
});

const navigation = createShellNavigationController({
  documentRef: document,
  state,
  el,
  audioFeature,
  subtitlesController,
  radarController,
  errorsAuditController,
  activeUsersController,
  adminUsersController,
  approvalFeature,
  scriptsFeature,
  videoProjectsFeature,
  ensureApprovalAutoRefresh,
  refreshVideoProjects,
  renderSelectedVideoProject,
  _ensureApprovalFeature,
  _ensureScriptsFeature,
  _ensureVideoProjectsFeature,
  _ensureAudioFeature,
  _ensureSubtitlesFeature,
  _ensureRadarFeature,
  _ensureErrorsAuditFeature,
  _ensureActiveUsersFeature,
  _ensureAdminUsersFeature,
  _cssLoaded,
  _domInjected,
  _visited,
  bindViewEvents,
});
const { setView } = navigation;

const voiceController = createScriptToAudioVoiceController({
  state,
  el,
  customDropdowns,
  audioFeature,
  toast,
  updateWordCounter,
  setView,
});

const renderers = createShellRenderers({
  renderQueue,
  renderStats,
  renderCountryFilter,
  renderCards,
  renderScriptStats,
  renderScriptCards,
  renderSelectedScriptEditor,
  renderVideoProjects,
  renderSelectedVideoProject,
  updateSelectedVideoProjectCompositionPreview,
});

const lifecycle = createAppShellLifecycle({
  bindEvents,
  customDropdowns,
  hydrateSettingsForm: settingsController.hydrateSettingsForm,
  el,
  readSessionStatus,
  storage: localStorage,
  cookieJar: document,
  sessionKey,
  setView,
  refreshAll,
  renderSearchRefreshState: approvalSearch.renderSearchRefreshState,
  renderSelectedScriptEditor: renderers.renderSelectedScriptEditor,
  renderSelectedVideoProject: renderers.renderSelectedVideoProject,
  _visited,
});

function syncRunModeChrome() {
  const bootstrap = globalThis.__CONTROL_PANEL_BOOTSTRAP__ || {};
  const showcase = document.documentElement?.getAttribute?.('data-showcase') === 'true';
  const demo = bootstrap.run_mode === 'demo' || showcase;
  const badge = document.getElementById('runModeBadge');
  const banner = document.getElementById('runModeBanner');
  if (badge) badge.hidden = !demo;
  if (banner) banner.hidden = !demo;
}

export async function bootApp() {
  i18n.apply();
  await hydrateGatewaySession().catch(() => null);
  syncAdminNavigation();
  syncRunModeChrome();
  lifecycle.bootApp();
}

export async function bootCompatibilityShell() {
  i18n.apply();
  await hydrateGatewaySession().catch(() => null);
  syncAdminNavigation();
  syncRunModeChrome();
  lifecycle.bootCompatibilityShell();
}

function sessionIsAdmin() {
  const roles = globalThis.__CONTROL_PANEL_SESSION__?.roles;
  return Array.isArray(roles) && roles.includes('admin');
}

globalThis.__NEWSROOM_SYNC_ADMIN__ = () => syncAdminNavigation();

function syncAdminNavigation() {
  const adminGroup = document.querySelector('[data-admin-only]');
  if (!adminGroup) return;
  const visible = sessionIsAdmin();
  adminGroup.hidden = !visible;
  adminGroup.setAttribute('aria-hidden', String(!visible));
}

function bindLanguageEvents() {
  if (el.languageSelect) {
    el.languageSelect.value = i18n.getLanguage();
    el.languageSelect.addEventListener('change', () => {
      i18n.setLanguage(el.languageSelect.value);
      syncAdminNavigation();
      toast(i18n.t('settings.saved'));
    });
  }
  el.cancelSettingsBtn?.addEventListener('click', () => el.settingsDialog?.close?.());
  el.closePublishDialog?.addEventListener('click', () => el.publishConfirmDialog?.close?.());
  el.cancelOriginalDialog?.addEventListener('click', () => el.scriptOriginalDialog?.close?.());
  el.manualVideoProjectCancelFooterBtn?.addEventListener('click', () => el.manualVideoProjectDialog?.close?.());
  el.closeVoicePresetBtn?.addEventListener('click', () => el.voicePresetDialog?.close?.());
}

function renderSubtitle2PreviewPlaybackState() {
  subtitlesController.renderPreviewPlaybackState?.();
}

function bindEvents() {
  bindLanguageEvents();
  bindShellEvents({
    bindCore: () => bindCoreEvents({
      el,
          loginGatewaySession,
      persistSessionStatus: () => persistSessionStatus({ storage: localStorage, cookieJar: document, sessionKey }),
      logoutGatewaySession,
      clearSessionStatus: () => clearSessionStatus({ storage: localStorage, cookieJar: document, sessionKey }),
      setView,
      refreshAll,
      refreshQueue,
      runQueue,
      saveSettings: settingsController.saveSettings,
      defaultSettings,
      toast,
      renderCards,
      reloadPage: () => location.reload(),
    }),
    bindRadar: () => radarController.bindEvents(),
    bindErrorsAudit: () => errorsAuditController.bindEvents?.(),
    bindActiveUsers: () => activeUsersController.bindEvents?.(),
    bindAdminUsers: () => adminUsersController.bindEvents?.(),
    bindScripts: () => bindScriptEvents({
      state,
      el,
      updateWordCounter,
      renderScriptCards,
      renderSelectedScriptEditor,
      publishSelectedScript,
      openVoiceAiPresetDialog: voiceController.openVoiceAiPresetDialog,
      confirmVoiceAiPresetSelection: voiceController.confirmVoiceAiPresetSelection,
      downloadSelectedScriptDocx,
      refreshVideoProjects,
      createManualVideoProject: (...args) => videoProjectsFeature.createManualVideoProject(...args),
    }),
    bindAudio: () => bindAudioEvents({ el, audioFeature, updateWordCounter }),
    bindSubtitles: () => bindSubtitlesEvents({ state, el, subtitlesController, renderSubtitle2PreviewPlaybackState }),
    bindApprovalDialog: () => bindApprovalDialogEvents({
      state,
      el,
      renderQueue,
      removeSourceFromTopic,
      approveSourceFromTopic,
      runSearchRefresh: approvalSearch.runSearchRefresh,
      toast,
      windowRef: window,
    }),
  });
}

function bindViewEvents(viewName) {
  if (viewName === 'scripts') {
    bindScriptEvents({
      state,
      el,
      updateWordCounter,
      renderScriptCards,
      renderSelectedScriptEditor,
      publishSelectedScript,
      openVoiceAiPresetDialog: voiceController.openVoiceAiPresetDialog,
      confirmVoiceAiPresetSelection: voiceController.confirmVoiceAiPresetSelection,
      downloadSelectedScriptDocx,
      refreshVideoProjects,
      createManualVideoProject: (...args) => videoProjectsFeature.createManualVideoProject(...args),
    });
    return;
  }
  if (viewName === 'audio') {
    bindAudioEvents({ el, audioFeature, updateWordCounter });
    return;
  }
  if (viewName === 'radar') {
    radarController.bindEvents();
    return;
  }
  if (viewName === 'errors-audit') {
    errorsAuditController.bindEvents?.();
    return;
  }
  if (viewName === 'active-users') {
    activeUsersController.bindEvents?.();
    return;
  }
  if (viewName === 'admin-users') {
    adminUsersController.bindEvents?.();
    return;
  }
  if (viewName === 'subtitulos2') {
    bindSubtitlesEvents({ state, el, subtitlesController, renderSubtitle2PreviewPlaybackState });
  }
}

async function ttsGet(path) {
  return ttsApi.get(path);
}

function __resolveTtsGet() {
  return __testOverrides.ttsGet || ttsGet;
}

function __emitToast(message) {
  const mock = __testOverrides.toast;
  if (typeof mock === 'function') {
    mock(message);
    return;
  }
  toast(message);
}

function setTtsGetMock(mock) {
  __testOverrides.ttsGet = typeof mock === 'function' ? mock : null;
}

function setToastMock(mock) {
  __testOverrides.toast = typeof mock === 'function' ? mock : null;
}

function clearMocksForTesting() {
  __testOverrides.ttsGet = null;
  __testOverrides.toast = null;
}

export const __testHooks = {
  setTtsGetMock,
  setToastMock,
  clearMocksForTesting,
};

async function ttsPost(path, payload) {
  return ttsApi.post(path, payload);
}

async function ttsPostForm(path, formData) {
  return ttsApi.postForm(path, formData);
}

async function ttsGetBlob(path) {
  return ttsApi.getBlob(path);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function getErrorMessage(err, fallback) {
  const msg = (err?.message || '').toString().trim();
  return msg || fallback;
}

function toast(message) {
  if (!el.toast) return;

  toastTimer = renderToast({
    toastEl: el.toast,
    message,
    existingTimer: toastTimer,
    durationMs: 3000,
  });
}

function updateWordCounter(text, targetEl) {
  updateWordCounterCore(text, targetEl);
}

function escapeHtml(str) {
  return escapeHtmlCore(str);
}
