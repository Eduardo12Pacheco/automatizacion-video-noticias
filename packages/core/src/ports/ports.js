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

/**
 * Worker-backed media ports. Each adapter is an HTTP client for one local
 * worker or a deterministic demo implementation; core code never spawns a
 * worker process or hard-codes a worker URL.
 */
export class TTSPort {
  /** @returns {Promise<{job_id: string, status: string}>} */
  async createJob() { throw new Error('not_implemented: createJob'); }
  /** @returns {Promise<{job_id: string, status: string, download_url?: string}>} */
  async getJob() { throw new Error('not_implemented: getJob'); }
  /** @returns {Promise<{bytes: Uint8Array, content_type: string}>} */
  async download() { throw new Error('not_implemented: download'); }
}

export class ASRPort {
  /** @returns {Promise<{segments: Array<object>, language?: string, device?: string, fallback_used?: boolean}>} */
  async transcribe() { throw new Error('not_implemented: transcribe'); }
}

export class TranslationPort {
  /** @returns {Promise<{segments: Array<object>, target_language: string}>} */
  async translate() { throw new Error('not_implemented: translate'); }
}

export class VideoRendererPort {
  /** @returns {Promise<{project_id: string, status: string}>} */
  async createProject() { throw new Error('not_implemented: createProject'); }
  /** @returns {Promise<{project_id: string, status: string}>} */
  async renderProject() { throw new Error('not_implemented: renderProject'); }
  /** @returns {Promise<{project_id: string, status: string, output?: string}>} */
  async getRenderStatus() { throw new Error('not_implemented: getRenderStatus'); }
  /** @returns {Promise<{bytes: Uint8Array, content_type: string}>} */
  async downloadRender() { throw new Error('not_implemented: downloadRender'); }
}

/**
 * Session/identity port. The bundled API is the auth authority, so the real
 * adapter wraps the local auth service; the HTTP adapter exists for a future
 * split deployment and the demo adapter keeps showcase mode keyless.
 */
export class AuthPort {
  /** @returns {Promise<{user: object, roles: string[], source: string}>} */
  async authenticate() { throw new Error('not_implemented: authenticate'); }
  /** @returns {Promise<object>} */
  async createSession() { throw new Error('not_implemented: createSession'); }
  /** @returns {Promise<object|null>} */
  async getSession() { throw new Error('not_implemented: getSession'); }
  /** @returns {Promise<void>} */
  async revokeSession() { throw new Error('not_implemented: revokeSession'); }
}
