import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdaptersFromEnv, createConnectorRegistry, resolveRunMode } from '@newsroom/adapters';
import { DEFAULT_EVENT_RETENTION, JsonlEventRecorder } from './gateway-events.js';
import { DEFAULT_HOST, DEFAULT_PANEL_BOOTSTRAP, DEFAULT_PORT, DEFAULT_TRUSTED_PROXY_CIDRS, resolveRoutesFromEnv } from './gateway-config.js';
import { readServiceCredentialsFromEnv } from './gateway-auth.js';
import { createGatewayServer } from './gateway-server.js';
import { createAdminRouter } from './admin-router.js';
import { createAuthService } from './auth.js';
import { createRuntimeDataRouter } from './composition.js';
import { createCoreRuntime } from './core-runtime.js';
import { createJobsRouter } from './jobs-router.js';
import { createLocalRouter } from './local-router.js';

export function readAllowedOrigins() {
  return (process.env.API_GATEWAY_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function readTrustedMutationOrigins() {
  return (process.env.API_GATEWAY_TRUSTED_MUTATION_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function readTrustedProxyCidrs() {
  const configured = (process.env.TRUSTED_PROXY_CIDRS || '')
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_TRUSTED_PROXY_CIDRS;
}

export function defaultGatewayEventsFilePath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime-logs', 'gateway-events.jsonl');
}

function parseDiscoveryPlayers(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item) => item && typeof item.jugador === 'string' && item.jugador.trim());
  } catch {
    return null;
  }
}

export function startGateway({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  dataRouter = null,
  repository = null,
  authService = null,
  localRouter = null,
  adminRouter = null,
  jobsRouter = null,
  blobStorage = null,
  adapters = null,
} = {}) {
  const allowedOrigins = readAllowedOrigins();
  const trustedMutationOrigins = readTrustedMutationOrigins();
  const trustedProxyCidrs = readTrustedProxyCidrs();
  const eventRecorder = new JsonlEventRecorder({
    filePath: process.env.API_GATEWAY_EVENTS_FILE || defaultGatewayEventsFilePath(),
    retention: {
      max_events: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_EVENTS || '', 10) || DEFAULT_EVENT_RETENTION.max_events,
      max_age_days: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_AGE_DAYS || '', 10) || DEFAULT_EVENT_RETENTION.max_age_days,
      max_bytes: Number.parseInt(process.env.API_GATEWAY_EVENTS_MAX_BYTES || '', 10) || DEFAULT_EVENT_RETENTION.max_bytes,
    },
    logger: console,
  });
  if (repository && !authService) {
    authService = createAuthService({ repository });
  }
  let runtimeScheduler = null;
  let runtimeAdapters = adapters;
  let runtime = null;
  if (repository && !localRouter) {
    runtimeAdapters = adapters || createAdaptersFromEnv({ logger: console, authService });
    runtime = createCoreRuntime({
      repository,
      adapters: runtimeAdapters,
      discovery: {
        feedUrl: String(process.env.NEWS_DISCOVERY_FEED_URL || '').trim(),
        players: parseDiscoveryPlayers(process.env.NEWS_DISCOVERY_PLAYERS),
      },
      logger: console,
    });
    runtimeScheduler = runtime.scheduler;
    localRouter = createLocalRouter({
      repository,
      readModels: runtime.readModels,
      useCases: runtime.useCases,
      jobQueue: runtime.jobQueue,
    });
    if (!adminRouter) {
      const connectors = createConnectorRegistry({
        env: process.env,
        adapters: runtimeAdapters || {},
        blobStorage,
        repository,
        logger: console,
      });
      adminRouter = createAdminRouter({ authService, connectors });
    }
  }
  if (!jobsRouter && runtime && (process.env.JOBS_API_KEY || process.env.API_GATEWAY_SHARED_API_KEY)) {
    jobsRouter = createJobsRouter({
      useCases: { refreshSearch: runtime.useCases.refreshSearch },
      jobQueue: runtime.jobQueue,
      apiKey: process.env.JOBS_API_KEY || process.env.API_GATEWAY_SHARED_API_KEY,
    });
  }
  if (runtimeScheduler && repository) {
    runtimeScheduler.register('expired-session-cleanup', {
      everyMs: 60 * 60 * 1000,
      runOnStart: false,
      handler: () => repository.deleteExpiredSessions(),
    });
    runtimeScheduler.start();
  }

  const routes = resolveRoutesFromEnv(process.env);
  const configuredPublicOrigin = String(process.env.PANEL_PUBLIC_ORIGIN || '').trim();
  const panelBootstrap = {
    ...DEFAULT_PANEL_BOOTSTRAP,
    ...(configuredPublicOrigin ? { apiOrigin: configuredPublicOrigin } : {}),
    runMode: resolveRunMode(process.env),
    featureFlags: { localWorkflows: true },
  };
  const server = createGatewayServer({
    routes,
    panelBootstrap,
    allowedOrigins: allowedOrigins.length ? allowedOrigins : undefined,
    trustedMutationOrigins: trustedMutationOrigins.length ? trustedMutationOrigins : undefined,
    trustedProxyCidrs,
    authService,
    localRouter,
    adminRouter,
    jobsRouter,
    serviceCredentials: readServiceCredentialsFromEnv(),
    dataRouter,
    eventRecorder,
  });
  if (runtimeScheduler) server.on('close', () => runtimeScheduler.stop());
  server.listen(port, host, () => {
    console.info(`Control Panel API Gateway listening on http://${host}:${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dataRouter, repository, blobStorage } = await createRuntimeDataRouter();
  startGateway({
    host: process.env.API_GATEWAY_HOST || DEFAULT_HOST,
    port: Number(process.env.API_GATEWAY_PORT || DEFAULT_PORT),
    dataRouter,
    repository,
    blobStorage,
  });
}
