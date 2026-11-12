#!/usr/bin/env node
import { PostgresRepository } from '../src/adapters/postgres-repository.js';

const repository = new PostgresRepository();
try {
  const result = await repository.migrate();
  console.log(`applied ${result.applied} migration(s) (${result.adapter})`);
} finally {
  await repository.close();
}
