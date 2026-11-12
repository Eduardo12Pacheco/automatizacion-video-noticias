import { runRepositoryContract } from './repository-contract.test.js';
import { InMemoryRepository } from '../src/adapters/in-memory-repository.js';

runRepositoryContract({
  label: 'in-memory',
  createHarness: async () => {
    const repo = new InMemoryRepository();
    return {
      repo,
      async reset() {},
      async close() {},
    };
  },
});
