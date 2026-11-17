import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlobStoragePort, RepositoryPort, verifyPortContracts } from '@newsroom/core';

import { FsBlobStorage } from '../src/adapters/fs-blob-storage.js';
import { InMemoryRepository } from '../src/adapters/in-memory-repository.js';
import { PostgresRepository } from '../src/adapters/postgres-repository.js';
import { S3BlobStorage } from '../src/adapters/s3-blob-storage.js';

describe('repository and blob adapters satisfy the core port contracts', () => {
  it('covers the in-memory, Postgres, filesystem and S3 variants', () => {
    const pairs = [
      { portClass: RepositoryPort, label: 'in-memory', adapter: new InMemoryRepository() },
      { portClass: RepositoryPort, label: 'postgres', adapter: new PostgresRepository({ pool: { query() {}, connect() {} } }) },
      { portClass: BlobStoragePort, label: 'filesystem', adapter: new FsBlobStorage({ root: '/tmp/newsroom-port-contracts' }) },
      { portClass: BlobStoragePort, label: 's3', adapter: new S3BlobStorage({ accessKey: 'test', secretKey: 'test' }) },
    ];
    assert.deepEqual(verifyPortContracts(pairs), []);
  });
});
