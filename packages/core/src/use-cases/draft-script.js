import { extractModelText } from '../domain/news.js';
import {
  buildScriptPrompt,
  validateDraft,
  validateSourceArticle,
  wordCount,
} from '../domain/script.js';
import { AdapterUnavailableError } from '../errors.js';

function isTemporaryModelError(errorOrText) {
  const text = typeof errorOrText === 'string'
    ? errorOrText
    : `${errorOrText?.message || ''} ${errorOrText?.code || ''} ${errorOrText?.statusCode || ''}`;
  return /\b(429|503|unavailable|resource_exhausted|high\s+demand|temporar|try\s+again\s+later|overloaded|rate\s*limit|too\s+many\s+requests|server\s+error|internal\s+error)\b/i.test(text);
}

/**
 * Port of "MVP - Approved Topic to Script Draft Job Worker v1 - Supabase":
 * claim the queued job, extract the source article, generate the script with
 * the editorial prompt, validate the length and complete or fail the job.
 */
export class DraftScript {
  constructor({ repository, articleExtractor, llm, now = () => new Date() } = {}) {
    if (!repository) throw new Error('repository is required');
    if (!articleExtractor) throw new Error('articleExtractor is required');
    this.repository = repository;
    this.articleExtractor = articleExtractor;
    this.llm = llm || null;
    this.now = now;
  }

  async execute({ id_noticia = '' } = {}) {
    const idNoticia = String(id_noticia || '').trim();
    if (!idNoticia) throw new Error('Missing required field: id_noticia');
    const job = await this.repository.claimScriptJob({ idNoticia });
    if (!job) return { status: 'skipped', reason: 'not_claimable', id_noticia: idNoticia };

    try {
      await this.repository.updateScriptJobProgress({
        idNoticia,
        status: 'running',
        stage: 'extracting',
        percent: 20,
      });
      const extracted = await this.articleExtractor.extract({ url: job.link, job });
      const article = extracted?.article || extracted?.data || extracted || {};
      const validation = validateSourceArticle(article, job);
      if (!validation.ok) {
        const failed = await this.repository.failScriptJob({ idNoticia, error: validation.error });
        return { status: 'failed', error: validation.error, job: failed };
      }

      if (!this.llm) throw new AdapterUnavailableError('llm adapter is not configured');
      await this.repository.updateScriptJobProgress({
        idNoticia,
        status: 'running',
        stage: 'drafting',
        percent: 50,
      });
      const response = await this.llm.complete({
        prompt: buildScriptPrompt({ ...job, combined_context: validation.combined_context }),
        system: 'Sos un editor deportivo senior para un canal digital. Devolvé solamente el guion final, en texto plano.',
        temperature: 0.35,
        maxTokens: 20_000,
      });
      const draft = validateDraft(extractModelText(response));
      if (!draft.ok) {
        if (draft.temporary) {
          const updated = await this.repository.updateScriptJobProgress({
            idNoticia,
            status: 'pendiente',
            stage: 'retry_later',
            percent: 35,
            error: draft.error,
          });
          return { status: 'retry_later', error: draft.error, job: updated };
        }
        const failed = await this.repository.failScriptJob({ idNoticia, error: draft.error });
        return { status: 'failed', error: draft.error, job: failed };
      }

      await this.repository.updateScriptJobProgress({
        idNoticia,
        status: 'running',
        stage: 'finalizing',
        percent: 90,
      });
      const completed = await this.repository.completeScriptJob({
        idNoticia,
        draftId: `draft-${idNoticia}`,
        guionDraft: draft.text,
        guionEditado: draft.text,
        wordCount: draft.word_count ?? wordCount(draft.text),
      });
      return {
        status: 'completed',
        id_noticia: idNoticia,
        job: completed.job,
        draft: completed.draft,
      };
    } catch (error) {
      const message = String(error?.message || 'Script job failed').slice(0, 1000);
      if (isTemporaryModelError(error)) {
        const updated = await this.repository.updateScriptJobProgress({
          idNoticia,
          status: 'pendiente',
          stage: 'retry_later',
          percent: 35,
          error: message,
        });
        return { status: 'retry_later', error: message, job: updated };
      }
      const failed = await this.repository.failScriptJob({ idNoticia, error: message });
      return { status: 'failed', error: message, job: failed };
    }
  }
}
