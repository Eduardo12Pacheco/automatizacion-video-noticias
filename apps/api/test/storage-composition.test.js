import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { S3BlobStorage } from '../../../packages/data/src/index.js';
import { createRuntimeDataRouter } from '../src/composition.js';

describe('blob storage composition', () => {
  it('defaults to the local filesystem adapter', async () => {
    const runtime = await createRuntimeDataRouter({ env: {} });
    assert.equal(runtime.blobStorage.constructor.name, 'FsBlobStorage');
    assert.equal(runtime.blobKind, 'fs');
  });

  it('selects the S3-compatible adapter without leaking credentials into the public url', async () => {
    const runtime = await createRuntimeDataRouter({
      env: {
        STORAGE: 's3',
        S3_ENDPOINT: 'http://minio.local:9000',
        S3_BUCKET: 'newsroom',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-secret',
        S3_REGION: 'us-east-1',
      },
    });
    assert.ok(runtime.blobStorage instanceof S3BlobStorage);
    assert.equal(runtime.blobKind, 's3');
    assert.equal(runtime.blobStorage.getPublicUrl('a/b.png'), '/panel/blobs/a/b.png');
  });
});
