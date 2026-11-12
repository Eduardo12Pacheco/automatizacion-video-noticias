import { createDataRouter } from './data-router.js';

/**
 * Composition root for the local data layer.
 *
 * Postgres is used when DATABASE_URL is configured (the installer/compose
 * applies migrations at boot). Without it the gateway falls back to the
 * in-memory adapter so the showcase/demo mode still works with no services.
 */
export async function createRuntimeDataRouter({ env = process.env } = {}) {
  const { InMemoryRepository, PostgresRepository, FsBlobStorage } = await import('@newsroom/data');
  const connectionString = String(env.DATABASE_URL || '').trim();
  const repository = connectionString
    ? new PostgresRepository({ connectionString })
    : new InMemoryRepository();
  const blobStorage = new FsBlobStorage({
    root: env.BLOB_ROOT || './data/blobs',
    publicPath: '/panel/blobs',
  });
  const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES || '') || undefined;
  return {
    dataRouter: createDataRouter({
      repository,
      blobStorage,
      ...(maxUploadBytes ? { maxUploadBytes } : {}),
    }),
    repository,
    blobStorage,
  };
}
