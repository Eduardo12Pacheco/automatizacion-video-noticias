import { fileURLToPath } from 'node:url';

import { createRuntimeDataRouter } from './composition.js';
import { startGateway } from './gateway-start.js';

export * from './gateway-config.js';
export * from './gateway-http.js';
export * from './gateway-auth.js';
export * from './gateway-policy.js';
export * from './gateway-proxy.js';
export * from './gateway-read-models.js';
export * from './gateway-server.js';
export * from './gateway-start.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dataRouter, repository } = await createRuntimeDataRouter();
  startGateway({
    host: process.env.API_GATEWAY_HOST || '127.0.0.1',
    port: Number(process.env.API_GATEWAY_PORT || 8099),
    dataRouter,
    repository,
  });
}
