import {
  annotateGooglePositions,
  buildBatchClassificationPrompt,
  buildDiscoverySummary,
  buildFeedRequests,
  DEFAULT_PLAYERS,
  extractModelText,
  filterRecentUnique,
  normalizeWindow,
  parseModelJson,
  splitFootballNews,
} from '../domain/news.js';

function classifyBatch(rows, modelText) {
  const parsed = parseModelJson(modelText);
  const results = Array.isArray(parsed?.results) ? parsed.results : null;
  if (!results) return null;
  const decisions = new Map(results
    .filter((row) => row && row.id_noticia)
    .map((row) => [String(row.id_noticia), row.es_futbol]));
  const football = [];
  const needsReview = [];
  for (const row of rows) {
    const decision = decisions.get(String(row.id_noticia));
    if (decision === true) football.push({ ...row, classification_source: 'ai' });
    else if (decision === false) continue;
    else {
      needsReview.push({
        ...row,
        classification_source: 'needs_review',
        estado_revision: 'pendiente',
        needs_review_reason: 'classifier_missing_decision',
      });
    }
  }
  return { football, needsReview };
}

/**
 * Port of "MVP - News Discovery v2 - Supabase": fetch the player feeds, keep
 * recent unique rows, classify football relevance with a heuristic first pass
 * and an LLM fallback, then persist the universe (live or staged by run id).
 */
export class DiscoverNews {
  constructor({
    repository,
    newsSource,
    llm,
    fallbackLlms = [],
    players = DEFAULT_PLAYERS,
    feedUrl = '',
    now = () => new Date(),
    batchSize = 10,
  } = {}) {
    if (!repository) throw new Error('repository is required');
    if (!newsSource) throw new Error('newsSource is required');
    this.repository = repository;
    this.newsSource = newsSource;
    this.llm = llm || null;
    this.fallbackLlms = (Array.isArray(fallbackLlms) ? fallbackLlms : [fallbackLlms]).filter(Boolean);
    this.players = players || DEFAULT_PLAYERS;
    this.feedUrl = String(feedUrl || '').trim();
    this.now = now;
    this.batchSize = Math.max(1, Number(batchSize) || 10);
  }

  async #classifyBatch(batch) {
    const models = [this.llm, ...this.fallbackLlms].filter(Boolean);
    let lastResult = null;
    for (const model of models) {
      try {
        const response = await model.complete({
          prompt: buildBatchClassificationPrompt(batch),
          system: 'Clasifica noticias de futbol y responde solo con JSON valido.',
          temperature: 0,
        });
        const classified = classifyBatch(batch, extractModelText(response));
        if (classified) {
          lastResult = classified;
          if (!classified.needsReview.length) return classified;
        }
      } catch {
        // Try the next configured model; the last fallback marks the batch
        // for review instead of dropping it from the universe.
      }
    }
    if (lastResult) return lastResult;
    return {
      football: [],
      needsReview: batch.map((row) => ({
        ...row,
        classification_source: 'needs_review',
        estado_revision: 'pendiente',
        needs_review_reason: models.length ? 'classifier_failed' : 'classifier_not_configured',
      })),
    };
  }

  async execute({ window = '24h', runId = null, players = null } = {}) {
    const normalized = normalizeWindow(window);
    let effectiveRunId = runId ? String(runId) : null;
    if (effectiveRunId) {
      const run = await this.repository.getNewsSearchRun(effectiveRunId);
      if (!run) throw new Error(`search run not found: ${effectiveRunId}`);
      await this.repository.updateNewsSearchRun(effectiveRunId, {
        status: 'discovery_running',
        started_at: run.started_at || new Date(this.now()).toISOString(),
      });
    }

    const requests = buildFeedRequests(players || this.players, normalized.requested_window, { runId: effectiveRunId || '' });
    // A single local fixture feed is useful for air-gapped installs and the
    // local-mode E2E; the production default keeps the per-player Google News
    // RSS requests.
    const effectiveRequests = this.feedUrl
      ? requests.map((request) => ({
        ...request,
        feed_url: this.feedUrl,
        source_kind: 'local_rss',
        source_name: 'Local RSS fixture',
      }))
      : requests;
    const fetched = [];
    for (const request of effectiveRequests) {
      const rows = await this.newsSource.fetchFeed(request);
      for (const row of rows || []) fetched.push({ ...row, run_id: effectiveRunId || row.run_id || '' });
    }

    const recent = filterRecentUnique(fetched, { windowMs: normalized.window_ms, now: this.now() });
    const split = splitFootballNews(annotateGooglePositions(recent));
    const direct = split.direct;
    const ambiguous = split.ambiguous;
    const aiRows = [];
    const reviewRows = [];
    for (let index = 0; index < ambiguous.length; index += this.batchSize) {
      const batch = ambiguous.slice(index, index + this.batchSize);
      const classified = await this.#classifyBatch(batch);
      aiRows.push(...classified.football);
      reviewRows.push(...classified.needsReview);
    }

    const rows = [...direct, ...aiRows, ...reviewRows];
    const persisted = await this.repository.upsertNews(rows, effectiveRunId ? { runId: effectiveRunId } : {});
    const summary = buildDiscoverySummary({
      runId: effectiveRunId,
      upserted: rows,
      received: fetched.length,
      valid: persisted.valid,
    });

    if (effectiveRunId) {
      const previous = await this.repository.getNewsSearchRun(effectiveRunId);
      await this.repository.updateNewsSearchRun(effectiveRunId, {
        status: 'discovery_succeeded',
        stats: { ...(previous?.stats || {}), ...summary, received: fetched.length, valid: persisted.valid },
      });
    }
    return summary;
  }
}
