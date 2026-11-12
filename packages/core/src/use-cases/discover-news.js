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

function mergeClassification(rows, modelText) {
  const parsed = parseModelJson(modelText);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const footballIds = new Set(results
    .filter((row) => row && row.id_noticia && row.es_futbol === true)
    .map((row) => row.id_noticia));
  return rows
    .filter((row) => footballIds.has(row.id_noticia))
    .map((row) => ({ ...row, classification_source: 'ai' }));
}

/**
 * Port of "MVP - News Discovery v2 - Supabase": fetch the player feeds, keep
 * recent unique rows, classify football relevance with a heuristic first pass
 * and an LLM fallback, then persist the universe (live or staged by run id).
 */
export class DiscoverNews {
  constructor({ repository, newsSource, llm, players = DEFAULT_PLAYERS, now = () => new Date(), batchSize = 10 } = {}) {
    if (!repository) throw new Error('repository is required');
    if (!newsSource) throw new Error('newsSource is required');
    this.repository = repository;
    this.newsSource = newsSource;
    this.llm = llm || null;
    this.players = players || DEFAULT_PLAYERS;
    this.now = now;
    this.batchSize = Math.max(1, Number(batchSize) || 10);
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
    const fetched = [];
    for (const request of requests) {
      const rows = await this.newsSource.fetchFeed(request);
      for (const row of rows || []) fetched.push({ ...row, run_id: effectiveRunId || row.run_id || '' });
    }

    const recent = filterRecentUnique(fetched, { windowMs: normalized.window_ms, now: this.now() });
    const split = splitFootballNews(annotateGooglePositions(recent));
    const direct = split.direct;
    const ambiguous = split.ambiguous;
    const aiRows = [];
    if (ambiguous.length && this.llm) {
      for (let index = 0; index < ambiguous.length; index += this.batchSize) {
        const batch = ambiguous.slice(index, index + this.batchSize);
        try {
          const response = await this.llm.complete({
            prompt: buildBatchClassificationPrompt(batch),
            system: 'Clasifica noticias de futbol y responde solo con JSON valido.',
            temperature: 0,
          });
          aiRows.push(...mergeClassification(batch, extractModelText(response)));
        } catch {
          // The n8n workflow falls back to another model; locally a failed
          // classifier simply leaves those rows out of the universe.
        }
      }
    }

    const rows = [...direct, ...aiRows];
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
