import { after, before, describe } from 'node:test';

import { runRepositoryContract } from './repository-contract.test.js';
import { PostgresRepository } from '../src/adapters/postgres-repository.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  describe('repository contract: postgres', () => {
    // Skipped unless a disposable database is provided.
  });
} else {
  describe('repository contract: postgres harness', () => {
    let repo;

    before(async () => {
      repo = new PostgresRepository({ connectionString });
      await repo.migrate();
    });

    after(async () => {
      await repo.close();
    });

    runRepositoryContract({
      label: 'postgres',
      createHarness: async () => ({
        repo,
        async reset() {
          const client = await repo._poolForTests().connect();
          try {
            await client.query(`truncate table
              sessions, user_roles, users, roles,
              noticias_staging, clusters_staging, news_search_runs,
              script_publish_jobs, video_edit_projects, guiones_noticia, script_jobs,
              noticias_raw, clusters
              restart identity cascade`);
            await client.query(`insert into roles (role, description) values
              ('admin', 'Full access'), ('editor', 'Can edit'), ('viewer', 'Read-only')`);
          } finally {
            client.release();
          }
        },
        async close() {},
      }),
    });
  });
}
