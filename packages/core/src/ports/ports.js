/**
 * Port contracts consumed by the core use cases.
 *
 * A port is a declaration, not a runtime placeholder: adapters implement the
 * methods and the shared harness in `contracts.js` verifies every adapter
 * (demo, local, HTTP and Postgres/FS/S3 variants) exposes the whole contract.
 * These declarations carry no throwing placeholder bodies on purpose; an
 * adapter that misses a method fails the contract suite before it can reach
 * runtime.
 */

/** @returns {Promise<{text: string, model?: string}>} */
export class LLMPort {
  static methods = Object.freeze(['complete']);
}

/** @returns {Promise<Array<object>>} raw news rows */
export class NewsSourcePort {
  static methods = Object.freeze(['fetchFeed']);
}

/** @returns {Promise<{title?: string, main_content: string}>} */
export class ArticleExtractorPort {
  static methods = Object.freeze(['extract']);
}

/** @returns {Promise<{images: Array<object>, meta?: object}>} */
export class ImageSearchPort {
  static methods = Object.freeze(['search']);
}

/** @returns {Promise<{channelId: string, title: string, videos: Array<object>}>} */
export class ChannelFeedPort {
  static methods = Object.freeze(['fetchChannel']);
}

/** @returns {Promise<{path: string, title?: string}>} */
export class MediaDownloadPort {
  static methods = Object.freeze(['download']);
}

/** @returns {Promise<{status: string, adapter?: string}>} */
export class NotificationPort {
  static methods = Object.freeze(['send']);
}

export class DocumentExportPort {
  static methods = Object.freeze(['createDocument', 'exportDocument']);
}

export class WorkflowTriggerPort {
  static methods = Object.freeze(['trigger']);
}

/**
 * Worker-backed media ports. Each adapter is an HTTP client for one local
 * worker or a deterministic demo implementation; core code never spawns a
 * worker process or hard-codes a worker URL.
 */
export class TTSPort {
  static methods = Object.freeze(['createJob', 'getJob', 'download']);
}

export class ASRPort {
  static methods = Object.freeze(['transcribe']);
}

export class TranslationPort {
  static methods = Object.freeze(['translate']);
}

export class VideoRendererPort {
  static methods = Object.freeze(['createProject', 'renderProject', 'getRenderStatus', 'downloadRender']);
}

/**
 * Session/identity port. The bundled API is the auth authority, so the real
 * adapter wraps the local auth service; the HTTP adapter exists for a future
 * split deployment and the demo adapter keeps showcase mode keyless.
 */
export class AuthPort {
  static methods = Object.freeze(['authenticate', 'createSession', 'getSession', 'revokeSession']);
}

/**
 * Persistence boundary for the newsroom domain. Records are snake_case (the
 * wire shape used by the ported workflows and the panel); arguments are
 * camelCase because they are called from JavaScript use cases.
 */
export class RepositoryPort {
  static methods = Object.freeze([
    'migrate',
    'healthCheck',
    'close',
    'upsertNews',
    'listNewsForClustering',
    'resetDiscoveryState',
    'resetStaging',
    'resetDemoStory',
    'persistClusters',
    'createNewsSearchRun',
    'getNewsSearchRun',
    'updateNewsSearchRun',
    'promoteNewsSearchRun',
    'listPendingApprovalClusters',
    'getApprovalTopicDetail',
    'applyApprovalDecision',
    'claimScriptJob',
    'updateScriptJobProgress',
    'completeScriptJob',
    'failScriptJob',
    'getScriptQueueMonitor',
    'getPendingScriptDrafts',
    'saveScriptDraft',
    'dismissScriptFromPanel',
    'getPublishableScriptDraft',
    'finalizeScriptPublish',
    'createPublishJob',
    'updatePublishJob',
    'getPublishJob',
    'upsertVideoProject',
    'getVideoEditProjects',
    'saveVideoProjectSelections',
    'saveVideoProjectEditorState',
    'saveVideoProjectAudio',
    'addVideoProjectCustomImages',
    'disableVideoEditProject',
    'listRoles',
    'createUser',
    'getUserById',
    'getUserByEmail',
    'listUsers',
    'updateUser',
    'setUserRoles',
    'createSession',
    'getSessionByTokenHash',
    'touchSession',
    'revokeSession',
    'revokeSessionsForUser',
    'deleteExpiredSessions',
  ]);
}

/**
 * Blob storage for uploads, rendered media and cached images. Keys are opaque
 * slash-separated paths; implementations reject traversal and absolute paths.
 * The default adapter is the local filesystem; S3 is an optional adapter.
 */
export class BlobStoragePort {
  static methods = Object.freeze(['put', 'get', 'head', 'delete', 'list', 'getPublicUrl']);
}

export const PORT_CLASSES = Object.freeze({
  LLMPort,
  NewsSourcePort,
  ArticleExtractorPort,
  ImageSearchPort,
  ChannelFeedPort,
  MediaDownloadPort,
  NotificationPort,
  DocumentExportPort,
  WorkflowTriggerPort,
  TTSPort,
  ASRPort,
  TranslationPort,
  VideoRendererPort,
  AuthPort,
  RepositoryPort,
  BlobStoragePort,
});
