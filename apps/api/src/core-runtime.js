import {
  AdapterUnavailableError,
  ClusterTopics,
  CreateVideoProject,
  DecideApproval,
  DiscoverNews,
  DraftScript,
  JobQueue,
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
  const output = { ...(adapter || {}) };
  for (const method of methods) {
    if (typeof output[method] !== 'function') output[method] = unavailable(method);
  }
  return output;
}

/**
 * Composition root for the core use cases. T5 injects the local adapters
 * (Ollama, trafilatura, SearXNG, python-docx, …); without them the API still
 * serves read models and fails write endpoints with a clear 503.
 */
export function createCoreRuntime({ repository, adapters = {}, now = () => new Date(), logger = console } = {}) {
  if (!repository) throw new Error('repository is required');
  const llm = adapters.llm || null;
  const newsSource = withDefaults(adapters.newsSource, ['fetchFeed']);
  const articleExtractor = withDefaults(adapters.articleExtractor, ['extract']);
  const imageSearch = adapters.imageSearch || null;
  const documentExport = adapters.documentExport
    ? withDefaults(adapters.documentExport, ['createDocument', 'exportDocument'])
    : null;
  const workflowTrigger = adapters.workflowTrigger || null;

  const createVideoProject = new CreateVideoProject({ repository, now });
  const discoverNews = new DiscoverNews({ repository, newsSource, llm, now });
  const clusterTopics = new ClusterTopics({ repository, llm, now });
  const decideApproval = new DecideApproval({ repository, workflowTrigger });
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
    },
    readModels,
    jobQueue,
    scheduler,
  };
}
