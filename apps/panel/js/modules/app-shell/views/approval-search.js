import { t } from '../../core/i18n/index.js';
const SHARED_PANEL_TIMESTAMP_FIELDS = ['fecha_creacion_cluster'];

export function formatNewsSearchTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (input) => String(input).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function resolveLatestSharedPanelTimestamp(items = []) {
  if (!Array.isArray(items)) return null;

  let latest = null;
  for (const item of items) {
    for (const field of SHARED_PANEL_TIMESTAMP_FIELDS) {
      const value = item?.[field];
      if (!value) continue;
      const date = new Date(value);
      const time = date.getTime();
      if (Number.isNaN(time)) continue;
      if (!latest || time > latest.time) {
        latest = { time, value: date.toISOString() };
      }
    }
  }

  return latest?.value || null;
}

export function createApprovalSearchController({
  state,
  el,
  customDropdowns,
  approvalApi,
  refreshAll,
  renderCards,
  toast,
  getErrorMessage,
}) {
  const SEARCH_REFRESH_START_PATH = '/webhook/approval/search-refresh/v2';
  const SEARCH_REFRESH_STATUS_PATH = '/webhook/approval/search-refresh/status/v1';
  const SEARCH_REFRESH_POLL_INTERVAL_MS = 5000;
  const SEARCH_REFRESH_MAX_POLL_MS = 60 * 60 * 1000;
  const SEARCH_REFRESH_MAX_STATUS_ERRORS = 5;
  const SEARCH_REFRESH_SUCCESS_STATUSES = new Set(['succeeded']);
  const SEARCH_REFRESH_FAILURE_STATUSES = new Set(['failed', 'error']);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function renderLastNewsSearchMeta() {
    if (!el.lastNewsSearchMeta) return;
    const formatted = formatNewsSearchTimestamp(resolveLatestSharedPanelTimestamp(state.items));
    el.lastNewsSearchMeta.hidden = false;
    el.lastNewsSearchMeta.textContent = formatted
      ? t('approval.lastUpdate', { value: formatted })
      : t('approval.lastUpdatePending');
  }

  function getSearchRefreshRunId(result) {
    return String(result?.run_id || result?.created_run?.run_id || '').trim();
  }

  function getSearchRefreshErrorMessage(run) {
    return String(
      run?.error_message
      || run?.error
      || run?.message
      || run?.details?.error
      || run?.details?.message
      || '',
    ).trim();
  }

  function getSearchRefreshStatusCopy(run, windowLabel) {
    const status = String(run?.status || '').trim().toLowerCase();
    const stats = run?.stats && typeof run.stats === 'object' ? run.stats : {};
    const staged = Number(stats.staged_news || stats.valid || stats.received || 0);
    const clusters = Number(stats.staged_clusters || 0);

    if (status === 'queued') return t('approval.status.queued', { window: windowLabel });
    if (status === 'running' || status === 'discovery_running') return t('approval.status.searching', { window: windowLabel });
    if (status === 'discovery_succeeded') return staged > 0
      ? t('approval.status.found', { count: staged })
      : t('approval.status.noNews');
    if (status === 'cluster_running') return staged > 0
      ? t('approval.status.clustering', { count: staged })
      : t('approval.status.clusteringGeneric');
    if (status === 'cluster_succeeded') return clusters > 0
      ? t('approval.status.clustersReady', { count: clusters })
      : t('approval.status.clustersReadyGeneric');
    if (status === 'promoting') return t('approval.status.promoting');
    if (SEARCH_REFRESH_SUCCESS_STATUSES.has(status)) return t('approval.status.completed');
    if (SEARCH_REFRESH_FAILURE_STATUSES.has(status)) return t('approval.status.failed');
    return t('approval.status.inProgress', { window: windowLabel });
  }

  async function pollSearchRefreshRun({ runId, windowLabel, token }) {
    const startedAt = Date.now();
    let firstPoll = true;

    while (state.searchRefreshPollingToken === token) {
      if (!firstPoll) await wait(SEARCH_REFRESH_POLL_INTERVAL_MS);
      firstPoll = false;

      if (Date.now() - startedAt > SEARCH_REFRESH_MAX_POLL_MS) {
        throw new Error(t('approval.status.timeout'));
      }

      let run;
      try {
        run = await approvalApi.post(SEARCH_REFRESH_STATUS_PATH, { run_id: runId });
        state.searchRefreshPollingErrorStreak = 0;
      } catch (err) {
        state.searchRefreshPollingErrorStreak += 1;
        if (state.searchRefreshPollingErrorStreak >= SEARCH_REFRESH_MAX_STATUS_ERRORS) throw err;
        state.searchRefreshStatusKind = 'running';
        state.searchRefreshStatus = t('approval.status.pollingProblem', { streak: state.searchRefreshPollingErrorStreak, max: SEARCH_REFRESH_MAX_STATUS_ERRORS });
        renderSearchRefreshState();
        continue;
      }

      const status = String(run?.status || '').trim().toLowerCase();
      state.lastSearchRefresh = run;
      state.searchRefreshStatusKind = SEARCH_REFRESH_FAILURE_STATUSES.has(status) ? 'error' : 'running';
      state.searchRefreshStatus = getSearchRefreshStatusCopy(run, windowLabel);
      renderSearchRefreshState();

      if (SEARCH_REFRESH_FAILURE_STATUSES.has(status)) {
        throw new Error(getSearchRefreshErrorMessage(run) || t('approval.status.failedService'));
      }

      if (SEARCH_REFRESH_SUCCESS_STATUSES.has(status)) return run;
    }

    throw new Error(t('approval.status.replaced'));
  }

  async function runSearchRefresh() {
    if (state.searchRefreshRunning) return;

    const windowValue = getSearchRefreshWindowValue();
    const windowLabel = getSearchRefreshWindowLabel(windowValue);
    state.searchRefreshRunning = true;
    state.searchRefreshStatusKind = 'running';
    state.searchRefreshStatus = t('approval.status.running', { window: windowLabel });
    state.lastSearchRefresh = null;
    renderSearchRefreshState();

    try {
      const result = await approvalApi.post(SEARCH_REFRESH_START_PATH, { window: windowValue });
      const runId = getSearchRefreshRunId(result);
      const isAsyncRun = String(result?.status || '').toLowerCase() === 'accepted' && runId;

      let finalResult = result;
      if (isAsyncRun) {
        const token = Symbol(`search-refresh:${runId}`);
        state.searchRefreshRunId = runId;
        state.searchRefreshPollingToken = token;
        state.searchRefreshPollingErrorStreak = 0;
        state.searchRefreshStatus = t('approval.status.started', { id: runId });
        renderSearchRefreshState();
        finalResult = await pollSearchRefreshRun({ runId, windowLabel, token });
      } else {
        assertSearchRefreshSucceeded(result);
      }

      state.lastSearchRefresh = finalResult;
      state.searchRefreshStatusKind = 'success';
      state.searchRefreshStatus = t('approval.status.completed');
      renderSearchRefreshState();
      toast(t('approval.status.completedToast'));
      await refreshAll();
      renderLastNewsSearchMeta();
      renderCards();
      state.searchRefreshStatus = isAsyncRun
        ? `Última elección: ${windowLabel}. Panel actualizado.`
        : resolveSearchRefreshCompletionMessage(result, windowLabel);
    } catch (err) {
      console.error(err);
      const message = getErrorMessage(err, t('approval.status.refreshFailed'));
      state.searchRefreshStatusKind = 'error';
      state.searchRefreshStatus = t('approval.status.error', { message });
      toast(message);
    } finally {
      state.searchRefreshPollingToken = null;
      state.searchRefreshRunning = false;
      renderSearchRefreshState();
    }
  }

  return {
    getSearchRefreshWindowValue,
    getSearchRefreshWindowLabel,
    formatNewsSearchTimestamp,
    assertSearchRefreshSucceeded,
    resolveSearchRefreshCompletionMessage,
    renderSearchRefreshState,
    renderLastNewsSearchMeta,
    runSearchRefresh,
  };
}
