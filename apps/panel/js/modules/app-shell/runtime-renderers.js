import {
  hydrateSettingsFormValues,
  resolveServiceConfig,
  shouldSkipApprovalBackgroundRefresh,
  shouldSkipApprovalInitialBootRefresh,
} from '../core/state/app-store.js';
import {
  buildApprovalNewsCardMarkup,
  orderApprovalItemsByLowestAvg,
  renderApprovalTopicDetail,
  renderQueueMonitor,
  resolveApprovalSourceLink,
} from '../features/approval/index.js';
import { isScriptProcessed } from '../features/scripts/index.js';
import { renderScriptCardsView, renderScriptStatsView, renderSelectedScriptEditorView } from '../features/scripts/render.js';
import { approvalItemMatchesSearch, tokenizeApprovalSearchQuery } from './search-filter.js';
import { formatNewsSearchTimestamp, resolveLatestSharedPanelTimestamp } from './views/approval-search.js';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../core/ui/screen-state.js';
import { t } from '../core/i18n/index.js';

const APPROVAL_AUTO_REFRESH_INTERVAL_MS = 30000;
const MIN_REFRESH_INTERVAL_MS = 5000;

export function createRuntimeRenderers({
  state,
  el,
  customDropdowns,
  approvalFeature,
  scriptsFeature,
  videoProjectsFeature,
  subtitlesController,
  radarController,
  audioFeature,
  approvalSearch,
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
}) {
  let lastRefreshAllTime = 0;
  let lastMonitorRefreshTime = 0;
function hydrateSettingsForm() {
  hydrateSettingsFormValues({ el, settings: state.settings });
}


async function refreshAll(options = {}) {
  const approvalBaseUrl = resolveServiceConfig(state.settings, 'n8n').baseUrl || state.settings?.baseUrl;
  if (options?.silent === true && shouldSkipApprovalBackgroundRefresh({ baseUrl: approvalBaseUrl, locationLike: globalThis.location })) {
    return;
  }

  if (shouldSkipApprovalInitialBootRefresh({
    baseUrl: approvalBaseUrl,
    locationLike: globalThis.location,
    refreshOptions: options,
  })) {
    // Defer video projects RPC until user visits the scripts view
    if (_visited.has('scripts')) {
      await refreshVideoProjects({ silent: true });
    }
    return;
  }

  const now = Date.now();
  if (now - lastRefreshAllTime < MIN_REFRESH_INTERVAL_MS) return;
  lastRefreshAllTime = now;

  const tasks = [refreshPending(), refreshQueue(), refreshScriptDrafts()];
  // Only refresh video projects if the user has already visited that view
  if (_visited.has('scripts')) {
    tasks.push(refreshVideoProjects({ silent: true }));
  }
  await Promise.all(tasks);
}

async function refreshPending() {
  await approvalFeature.refreshPending();
}

async function refreshQueue(options = {}) {
  await runQueueRefresh(options);
}

async function refreshScriptDrafts(options = {}) {
  await runScriptDraftsRefresh(options);
}

async function refreshVideoProjects(options = {}) {
  await runVideoProjectsRefresh(options);
}

function ensureApprovalAutoRefresh(start = true) {
  if (!start) {
    if (state.approvalAutoRefreshTimer) {
      clearInterval(state.approvalAutoRefreshTimer);
      state.approvalAutoRefreshTimer = null;
    }
    return;
  }
  if (state.approvalAutoRefreshTimer) return;

  const run = () => {
    void refreshApprovalMonitorData();
  };

  state.approvalAutoRefreshTimer = setInterval(run, APPROVAL_AUTO_REFRESH_INTERVAL_MS);
}

async function refreshApprovalMonitorData() {
  const approvalBaseUrl = resolveServiceConfig(state.settings, 'n8n').baseUrl || state.settings?.baseUrl;
  if (shouldSkipApprovalBackgroundRefresh({ baseUrl: approvalBaseUrl, locationLike: globalThis.location })) {
    return;
  }
  const now = Date.now();
  if (now - lastMonitorRefreshTime < MIN_REFRESH_INTERVAL_MS) return;
  lastMonitorRefreshTime = now;
  await Promise.allSettled([
    refreshQueue({ silent: true }),
    refreshScriptDrafts({ silent: true }),
  ]);
}

function getSearchRefreshWindowValue() {
  return el.searchRefreshWindow?.value === '1h' ? '1h' : '24h';
}

function getSearchRefreshWindowLabel(value) {
  return value === '1h' ? t('approval.range1h') : t('approval.range24h');
}

function assertSearchRefreshSucceeded(result) {
  const status = (result?.status || '').toString().trim().toLowerCase();
  const promoteStatus = (result?.promote?.status || '').toString().trim().toLowerCase();
  const errorMessage = (result?.error || result?.message || result?.promote?.error || '').toString().trim();

  if (status !== 'ok' || promoteStatus !== 'succeeded') {
    throw new Error(errorMessage || t('approval.searchFailed'));
  }
}

function resolveSearchRefreshCompletionMessage(result, windowLabel) {
  const promote = result?.promote || {};
  const promoted = promote.promoted ?? result?.promoted;
  const noPromoteReason = (promote.no_promote_reason || result?.no_promote_reason || '').toString().trim();

  if (promoted === false) {
    const reasonCopy = noPromoteReason === 'no_staged_clusters'
      ? t('approval.noNewClusters')
      : t('approval.noNewChanges');
    return t('approval.lastChoice', { window: windowLabel, reason: reasonCopy });
  }

  return t('approval.panelUpdated', { window: windowLabel });
}

function renderSearchRefreshState() {
  if (!el.searchRefreshBtn || !el.searchRefreshStatus) return;

  el.searchRefreshBtn.disabled = state.searchRefreshRunning;
  el.searchRefreshBtn.textContent = state.searchRefreshRunning ? t('approval.refreshing') : t('approval.refresh');
  if (el.searchRefreshWindow) {
    el.searchRefreshWindow.disabled = state.searchRefreshRunning;
    customDropdowns.refreshAll();
  }

  el.searchRefreshStatus.textContent = state.searchRefreshStatus || t('approval.refreshStatus');
  el.searchRefreshStatus.classList.toggle('is-running', state.searchRefreshStatusKind === 'running');
  el.searchRefreshStatus.classList.toggle('is-success', state.searchRefreshStatusKind === 'success');
  el.searchRefreshStatus.classList.toggle('is-error', state.searchRefreshStatusKind === 'error');
}

async function runSearchRefresh() {
  return approvalSearch.runSearchRefresh();
}

function renderQueue() {
  renderQueueMonitor({ queueItems: state.queue, el, escapeHtml, dismissedQueueIds: state.dismissedQueueJobs });
}

function renderStats() {
  const total = state.items.length;
  const countries = new Set(state.items.map((i) => i.seleccion).filter(Boolean)).size;
  const avgSources = total ? (state.items.reduce((a, b) => a + Number(b.cantidad_fuentes || 0), 0) / total).toFixed(1) : 0;

  el.stats.innerHTML = `
    <div class="stat"><small>${t('approval.pendingStat')}</small><strong>${total}</strong></div>
    <div class="stat"><small>${t('approval.countries')}</small><strong>${countries}</strong></div>
    <div class="stat"><small>${t('approval.avgSources')}</small><strong>${avgSources}</strong></div>
  `;
}

function renderCountryFilter() {
  const current = el.countryFilter.value;
  const countries = [...new Set(state.items.map((i) => i.seleccion).filter(Boolean))].sort();
  el.countryFilter.innerHTML = `<option value="">${t('approval.allCountries')}</option>`
    + countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join('');
  el.countryFilter.value = current;
  customDropdowns.refreshAll();
}

function filteredItems() {
  const queryTokens = tokenizeApprovalSearchQuery(el.searchInput.value);
  const country = el.countryFilter.value;
  const minSources = Number(el.sourcesFilter.value || 0);

  const filtered = state.items.filter((item) => {
    const searchMatch = approvalItemMatchesSearch(item, queryTokens);
    const countryMatch = !country || item.seleccion === country;
    const sourcesMatch = Number(item.cantidad_fuentes || 0) >= minSources;
    return searchMatch && countryMatch && sourcesMatch;
  });

  return orderApprovalItemsByLowestAvg(filtered);
}

function renderCards() {
  const list = filteredItems();
  el.cardsMeta.textContent = `${list.length} resultado${list.length === 1 ? '' : 's'}`;
  renderLastNewsSearchMeta();
  bindCardsInteractionEvents();

  if (state.approvalLoading && !list.length) {
    el.cards.innerHTML = renderLoadingState({ rows: 3, variant: 'cards' });
    return;
  }
  if (state.approvalError && !list.length) {
    el.cards.innerHTML = renderErrorState({
      error: state.approvalError,
      fallbackKey: 'errors.unavailable',
      retryAttribute: 'data-approval-action="refresh"',
    });
    return;
  }
  if (!list.length) {
    el.cards.innerHTML = renderEmptyState({
      icon: 'search',
      titleKey: 'approval.emptyTitle',
      messageKey: 'approval.emptyMessage',
    });
    return;
  }

  el.cards.innerHTML = list.map((item) => buildApprovalNewsCardMarkup(item)).join('');
}

function bindCardsInteractionEvents() {
  if (!el.cards || el.cards.dataset.delegatedCardEvents === 'true') return;
  el.cards.dataset.delegatedCardEvents = 'true';

  el.cards.addEventListener('click', async (ev) => {
    if (ev.target.closest?.('[data-approval-action="refresh"]')) {
      await refreshAll({ source: 'retry' });
      return;
    }
    const card = ev.target.closest?.('.card');
    if (!card || !el.cards.contains(card)) return;
    const interactive = ev.target.closest?.('button, a');
    if (interactive) return;
    const id = decodeURIComponent(card.dataset.cardId || '');
    if (id) await openDetail(id);
  });

  el.cards.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest?.('.card');
    if (!card || !el.cards.contains(card)) return;
    ev.preventDefault();
    const id = decodeURIComponent(card.dataset.cardId || '');
    if (id) await openDetail(id);
  });
}

function renderLastNewsSearchMeta() {
  if (!el.lastNewsSearchMeta) return;
  const formatted = formatNewsSearchTimestamp(resolveLatestSharedPanelTimestamp(state.items));
  el.lastNewsSearchMeta.hidden = false;
  el.lastNewsSearchMeta.textContent = formatted
    ? t('approval.lastUpdate', { value: formatted })
    : t('approval.lastUpdatePending');
}

function renderScriptStats() {
  renderScriptStatsView({ scriptDrafts: state.scriptDrafts, el });
}

function renderScriptCards() {
  renderScriptCardsView({
    state,
    el,
    openScriptEditor,
    dismissProcessedScript: scriptsFeature.dismissProcessedScript,
  });
}

function renderSelectedScriptEditor() {
  if (!state.selectedScript) {
    state.scriptEditorDirty = false;
  }
  renderSelectedScriptEditorView({
    selected: state.selectedScript,
    el,
    updateWordCounter,
    preserveCurrentValue: Boolean(state.selectedScript && state.scriptEditorDirty),
  });
}

async function renderVideoProjects() {
  if (!el.videoProjectsList && !state.selectedVideoProject) return;
  await _ensureVideoProjectsRender();
  renderVideoProjectsListView({
    state,
    el,
    openVideoProject,
    prefetchProjectDetail: videoProjectsFeature.prefetchProjectDetail,
    disableVideoProject: videoProjectsFeature.disableVideoProject,
    confirmDelete: (message) => window.confirm(message),
  });
}

async function renderSelectedVideoProject() {
  if (!state.selectedVideoProject && !el.videoProjectDetail) return;
  await _ensureVideoProjectsRender();
  renderSelectedVideoProjectView({
    state,
    el,
    closeVideoProject,
    toggleImageSelection: videoProjectsFeature.toggleImageSelection,
    goToAudioStep: videoProjectsFeature.goToAudioStep,
    goToImagesStep: videoProjectsFeature.goToImagesStep,
    uploadProjectAudio: videoProjectsFeature.uploadProjectAudio,
    selectDefaultBackgroundMusic: videoProjectsFeature.selectDefaultBackgroundMusic,
    uploadCustomImages: videoProjectsFeature.uploadCustomImages,
    preparePreview: videoProjectsFeature.preparePreview,
    refreshPreview: videoProjectsFeature.refreshPreview,
    exportFinal: videoProjectsFeature.exportFinal,
    updateRow: videoProjectsFeature.updateRow,
    swapRowImages: videoProjectsFeature.swapRowImages,
    applyDustToAllImageRows: videoProjectsFeature.applyDustToAllImageRows,
    assignExistingImageToRow: videoProjectsFeature.assignExistingImageToRow,
    uploadAndAssignImage: videoProjectsFeature.uploadAndAssignImage,
    uploadVideoToLibrary: videoProjectsFeature.uploadVideoToLibrary,
    assignVideoSegmentToRow: videoProjectsFeature.assignVideoSegmentToRow,
    updateGlobalAudio: videoProjectsFeature.updateGlobalAudio,
    updateBrandChannel: videoProjectsFeature.updateBrandChannel,
    undoEditorChange: videoProjectsFeature.undoEditorChange,
    renderSelectedVideoProject,
    updateSelectedVideoProjectCompositionPreview,
    showToast: toast,
  });
}

async function updateSelectedVideoProjectCompositionPreview({ project } = {}) {
  await _ensureVideoProjectsRender();
  return updateSelectedVideoProjectCompositionPreviewView({ project: project || state.selectedVideoProject });
}

async function openDetail(clusterId) {
  await approvalFeature.openDetail(clusterId);
}

function renderTopicDetail() {
  renderApprovalTopicDetail({ item: state.selectedTopic, el, state, escapeHtml, resolveApprovalSourceLink });
}

async function openScriptEditor(clusterId) {
  await scriptsFeature.openScriptEditor(clusterId);
}

async function openVideoProject(projectId) {
  await videoProjectsFeature.openVideoProject(projectId);
  await waitForNextFrame();
  el.viewScripts?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

function closeVideoProject() {
  state.selectedVideoProject = null;
  state.videoProjectDetailLoading = false;
  state.videoProjectDetailImagesPreparing = false;
  renderVideoProjects();
  renderSelectedVideoProject();
}

async function saveSelectedScript() {
  await scriptsFeature.saveSelectedScript();
}

async function publishSelectedScript() {
  await scriptsFeature.publishSelectedScript();
  if (state.selectedScript && isScriptProcessed(state.selectedScript)) {
    await refreshVideoProjects({ silent: true });
  }
}

async function downloadSelectedScriptDocx() {
  await scriptsFeature.downloadSelectedScriptDocx();
}

async function removeSourceFromTopic(source) {
  await approvalFeature.removeSourceFromTopic(source);
}

async function approveSourceFromTopic(source) {
  await approvalFeature.approveSourceFromTopic(source);
}

async function decision(clusterId, action) {
  await approvalFeature.decision(clusterId, action, refreshAll);
}

async function runQueue() {
  await approvalFeature.runQueue(refreshAll);
}


  return {
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
  };
}
