/**
 * Ports consumed by the core use cases. Adapters live outside this package
 * (T5 provides the local-first implementations); tests use in-file mocks.
 */

export class LLMPort {
  /** @returns {Promise<{text: string, model?: string}>} */
  async complete() { throw new Error('not_implemented: complete'); }
}

export class NewsSourcePort {
  /** @returns {Promise<Array<object>>} raw news rows */
  async fetchFeed() { throw new Error('not_implemented: fetchFeed'); }
}

export class ArticleExtractorPort {
  /** @returns {Promise<{title?: string, main_content: string}>} */
  async extract() { throw new Error('not_implemented: extract'); }
}

export class ImageSearchPort {
  /** @returns {Promise<{images: Array<object>, meta?: object}>} */
  async search() { throw new Error('not_implemented: search'); }
}

export class ChannelFeedPort {
  /** @returns {Promise<{channelId: string, title: string, videos: Array<object>}>} */
  async fetchChannel() { throw new Error('not_implemented: fetchChannel'); }
}

export class MediaDownloadPort {
  /** @returns {Promise<{path: string, title?: string}>} */
  async download() { throw new Error('not_implemented: download'); }
}

export class NotificationPort {
  /** @returns {Promise<{status: string, adapter?: string}>} */
  async send() { throw new Error('not_implemented: send'); }
}

export class DocumentExportPort {
  async createDocument() { throw new Error('not_implemented: createDocument'); }
  async exportDocument() { throw new Error('not_implemented: exportDocument'); }
}

export class WorkflowTriggerPort {
  async trigger() { throw new Error('not_implemented: trigger'); }
}
