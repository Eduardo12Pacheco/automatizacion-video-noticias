import {
  AdapterUnavailableError,
  ClusterTopics,
  CreateVideoProject,
  DecideApproval,
  DiscoverNews,
  DraftScript,
  JobQueue,
  SaveScriptDraft,
  ManualCreateVideoProject,
  PublishScript,
  RefreshSearch,
  Scheduler,
  buildReadModels,
  createExportDocument,
} from '@newsroom/core';

function unavailable(portName) {
  return async () => {
    throw new AdapterUnavailableError(`${portName} adapter is not configured`);
  };
}

function withDefaults(adapter, methods) {
  if (!adapter) {
    const missing = {};
    for (const method of methods) missing[method] = unavailable(method);
    return missing;
  }
  // Class adapters expose their methods on the prototype; spreading an
  // instance would silently drop them and turn a working adapter into the
  // "not configured" fallback.
  const output = Object.create(Object.getPrototypeOf(adapter));
  Object.assign(output, adapter);
  for (const method of methods) {
    if (typeof output[method] !== 'function') output[method] = unavailable(method);
  }
  return output;
}

/**
 * Composition root for the core use cases. It injects the local adapters
 * (Ollama, trafilatura, SearXNG, python-docx, …); without them the API still
 * serves read models and fails write endpoints with a clear 503.
 */
export function createCoreRuntime({ repository, adapters = {}, discovery = {}, now = () => new Date(), logger = console } = {}) {
  if (!repository) throw new Error('repository is required');
  const llm = adapters.llm || null;
  const newsSource = withDefaults(adapters.newsSource, ['fetchFeed']);
  const articleExtractor = withDefaults(adapters.articleExtractor, ['extract']);
  const imageSearch = adapters.imageSearch || null;
  const documentExport = adapters.documentExport
    ? withDefaults(adapters.documentExport, ['createDocument', 'exportDocument'])
    : null;
  const workflowTrigger = adapters.workflowTrigger || null;
  const notification = adapters.notification || null;
  const channelFeed = adapters.channelFeed || null;
  const mediaDownload = adapters.mediaDownload || null;
  const tts = adapters.tts || null;
  const asr = adapters.asr || null;
  const translation = adapters.translation || null;
  const videoRenderer = adapters.videoRenderer || null;
  const auth = adapters.auth || null;

  const createVideoProject = new CreateVideoProject({ repository, now });
  const discoverNews = new DiscoverNews({
    repository,
    newsSource,
    llm,
    ...(discovery.feedUrl ? { feedUrl: discovery.feedUrl } : {}),
    ...(Array.isArray(discovery.players) && discovery.players.length ? { players: discovery.players } : {}),
    now,
  });
  const clusterTopics = new ClusterTopics({ repository, llm, now });
  const decideApproval = new DecideApproval({ repository });
  const draftScript = new DraftScript({ repository, articleExtractor, llm, now });
  const publishScript = new PublishScript({
    repository,
    createVideoProject,
    llm,
    documentExport,
    imageSearch,
    now,
  });
  const manualCreateVideoProject = new ManualCreateVideoProject({ repository, imageSearch, now });
  const refreshSearch = new RefreshSearch({ repository, discoverNews, clusterTopics, now });
  const exportDocument = createExportDocument({ repository, documentExport: documentExport || withDefaults(null, ['exportDocument']) });
  const readModels = buildReadModels({ repository });

  const jobQueue = new JobQueue({
    logger,
    handlers: {
      'refresh-search': (payload) => refreshSearch.processRun(payload.run_id, { window: payload.window }),
      'publish-script': (payload) => publishScript.process(payload.job_id),
      'manual-video': (payload) => manualCreateVideoProject.process(payload.job_id),
      'draft-script': (payload) => draftScript.execute(payload),
    },
    // With the optional n8n trigger enabled, n8n owns the notification
    // workflow. Completion events stay small and contain no article or secret
    // content.
    onComplete: workflowTrigger
      ? (job) => workflowTrigger.trigger('job-completed', {
        job_id: job.id,
        job_name: job.name,
        status: job.status,
        finished_at: job.finished_at,
        subject_id: job.payload?.id_noticia || job.payload?.job_id || job.payload?.run_id || null,
      })
      : null,
  });
  const scheduler = new Scheduler({ logger });

  return {
    useCases: {
      decideApproval,
      draftScript,
      publishScript,
      manualCreateVideoProject,
      refreshSearch,
      exportDocument,
      saveScriptDraft: new SaveScriptDraft({ repository }),
    },
    readModels,
    jobQueue,
    scheduler,
    adapters: {
      llm,
      newsSource,
      articleExtractor,
      imageSearch,
      documentExport,
      workflowTrigger,
      notification,
      channelFeed,
      mediaDownload,
      tts,
      asr,
      translation,
      videoRenderer,
      auth,
    },
  };
}
