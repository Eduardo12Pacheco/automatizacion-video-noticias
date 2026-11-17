import { assertPublicUrl, BlockedUrlError } from '@newsroom/contracts/security/url-guard';
import { AdapterError } from './http.js';
import { DEFAULT_ADAPTER_SCRIPT, runJsonCommand } from './spawn.js';

/**
 * ArticleExtractorPort backed by trafilatura (local Python). The CLI fetches
 * the URL and returns main text plus metadata, which the core validates
 * before drafting.
 */
export class TrafilaturaArticleExtractor {
  constructor({
    pythonBin = 'python3',
    scriptPath = DEFAULT_ADAPTER_SCRIPT,
    timeoutMs = 60_000,
    runCommand = runJsonCommand,
    resolver = null,
  } = {}) {
    this.pythonBin = pythonBin;
    this.scriptPath = scriptPath;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 60_000);
    this.runCommand = runCommand;
    this.resolver = resolver;
  }

  async extract({ url = '' } = {}) {
    const target = String(url || '').trim();
    if (!target) throw new AdapterError('extract_url_missing', 'Article URL is required', { statusCode: 400 });
    try {
      await assertPublicUrl(target, this.resolver ? { resolver: this.resolver } : undefined);
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        throw new AdapterError('extract_url_blocked', 'Article URL is not a public http(s) destination', { statusCode: 400 });
      }
      throw error;
    }
    const article = await this.runCommand({
      pythonBin: this.pythonBin,
      scriptPath: this.scriptPath,
      args: ['extract', target],
      timeoutMs: this.timeoutMs,
    });
    if (!article || !article.main_content) {
      throw new AdapterError('trafilatura_empty_content', 'trafilatura returned no article body');
    }
    return { article, data: article, url: target, extractor: 'trafilatura' };
  }
}
