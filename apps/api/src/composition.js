import { createDataRouter } from './data-router.js';

/**
 * Composition root for the local data layer.
 *
 * Postgres is used when DATABASE_URL is configured (the installer/compose
 * applies migrations at boot). Without it the gateway falls back to the
 * in-memory adapter so the showcase/demo mode still works with no services.
 */
export async function createRuntimeDataRouter({ env = process.env } = {}) {
  const { InMemoryRepository, PostgresRepository, FsBlobStorage, S3BlobStorage } = await import('@newsroom/data');
  const connectionString = String(env.DATABASE_URL || '').trim();
  const repository = connectionString
    ? new PostgresRepository({ connectionString })
    : new InMemoryRepository();
  const blobKind = String(env.STORAGE || 'fs').trim().toLowerCase();
  if (blobKind !== 'fs' && blobKind !== 's3') {
    throw new Error(`Unsupported STORAGE adapter: ${blobKind}`);
  }
  const blobStorage = blobKind === 's3'
    ? new S3BlobStorage({
      endpoint: env.S3_ENDPOINT || 'http://127.0.0.1:9000',
      bucket: env.S3_BUCKET || 'newsroom',
      region: env.S3_REGION || 'us-east-1',
      accessKey: env.S3_ACCESS_KEY || '',
      secretKey: env.S3_SECRET_KEY || '', // gitleaks:allow — read from env; empty default
      publicPath: '/panel/blobs',
    })
    : new FsBlobStorage({
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
    blobKind,
  };
}
