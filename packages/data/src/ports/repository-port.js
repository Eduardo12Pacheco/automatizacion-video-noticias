/**
 * The repository port is declared in `packages/core` so the core use cases own
 * their persistence boundary. This module keeps the historical import path
 * (`@newsroom/data/ports/repository-port`) working.
 */
export { RepositoryPort } from '@newsroom/core';
