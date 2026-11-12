import { normalizeWindow } from '../domain/news.js';

/**
 * Port of "Approval Search Refresh v2" + "Approval Search Refresh Worker v1":
 * create a staging run, discover and cluster into it, then promote atomically
 * so the live approval universe is swapped only after both stages succeed.
 */
export class RefreshSearch {
  constructor({ repository, discoverNews, clusterTopics, now = () => new Date() } = {}) {
    if (!repository) throw new Error('repository is required');
    if (!discoverNews) throw new Error('discoverNews is required');
    if (!clusterTopics) throw new Error('clusterTopics is required');
    this.repository = repository;
    this.discoverNews = discoverNews;
    this.clusterTopics = clusterTopics;
    this.now = now;
  }

  async start({ window = '24h' } = {}) {
    const normalized = normalizeWindow(window);
    const run = await this.repository.createNewsSearchRun({ requestedWindow: normalized.requested_window });
    return {
      status: 'accepted',
      run_id: run.run_id,
      requested_window: normalized.requested_window,
      message: 'Search refresh queued',
    };
  }

  async processRun(runId, { window = '24h', players = null } = {}) {
    const normalized = normalizeWindow(window);
    const existing = await this.repository.getNewsSearchRun(runId);
    if (!existing) throw new Error(`search run not found: ${runId}`);
    try {
      await this.repository.updateNewsSearchRun(runId, {
        status: 'discovery_running',
        started_at: existing.started_at || new Date(this.now()).toISOString(),
      });
      const discovery = await this.discoverNews.execute({
        window: normalized.requested_window,
        runId,
        ...(players ? { players } : {}),
      });
      const cluster = await this.clusterTopics.execute({ runId });
      const promoted = await this.repository.promoteNewsSearchRun(runId);
      if (!promoted) throw new Error('search run could not be promoted');
      return {
        status: 'ok',
        run_id: runId,
        window: normalized.requested_window,
        discovery,
        cluster,
        promote: { ...promoted, status: 'promoted' },
      };
    } catch (error) {
      await this.repository.updateNewsSearchRun(runId, {
        status: 'failed',
        error: String(error?.message || error).slice(0, 1000),
        finished_at: new Date(this.now()).toISOString(),
      });
      throw error;
    }
  }

  async execute({ window = '24h', players = null } = {}) {
    const started = await this.start({ window });
    return this.processRun(started.run_id, { window, players });
  }
}
