import { DomainError } from '@newsroom/core';

const JSON_LIMIT = 1024 * 1024;

export const ADMIN_MUTATION_ROUTES = Object.freeze([
  {
    id: 'admin-create-user',
    methods: ['POST'],
    pattern: /^\/panel\/admin\/users$/,
    examplePath: '/panel/admin/users',
  },
  {
    id: 'admin-update-user',
    methods: ['PATCH', 'PUT'],
    pattern: /^\/panel\/admin\/users\/[^/]+$/,
    examplePath: '/panel/admin/users/user-1',
  },
  {
    id: 'admin-test-connector',
    methods: ['POST'],
    pattern: /^\/panel\/connectors\/[^/]+\/test$/,
    examplePath: '/panel/connectors/llm/test',
  },
]);

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

async function readJson(readBody) {
  const raw = await readBody({ maxBodyBytes: JSON_LIMIT });
  if (!raw || !raw.length) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed;
}

/**
 * Admin user management (S9). Mounted behind the gateway's admin-role check.
 */
export function createAdminRouter({ authService, connectors = null } = {}) {
  if (!authService) throw new Error('authService is required');

  function matches(pathname = '') {
    return pathname === '/panel/admin/users'
      || pathname.startsWith('/panel/admin/users/')
      || pathname === '/panel/admin/roles'
      || pathname === '/panel/connectors'
      || pathname.startsWith('/panel/connectors/');
  }

  async function handle({ method = 'GET', pathname, readBody } = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const read = readBody || (async () => Buffer.alloc(0));
    try {
      if (pathname === '/panel/connectors') {
        if (upperMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
        return json(200, { ok: true, connectors: connectors ? connectors.list() : [] });
      }
      const connectorMatch = pathname.match(/^\/panel\/connectors\/([^/]+)\/test$/);
      if (connectorMatch) {
        if (upperMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        if (!connectors) return json(404, { ok: false, error: 'connector_not_found' });
        const connectorId = decodeURIComponent(connectorMatch[1]);
        const result = await connectors.test(connectorId);
        if (!result) return json(404, { ok: false, error: 'connector_not_found' });
        return json(200, { ok: true, result });
      }
      if (pathname === '/panel/admin/roles') {
        if (upperMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
        return json(200, { ok: true, roles: await authService.listRoles() });
      }
      if (pathname === '/panel/admin/users') {
        if (upperMethod === 'GET') {
          return json(200, { ok: true, users: await authService.listUsers() });
        }
        if (upperMethod === 'POST') {
          const body = await readJson(read);
          const user = await authService.createUser({
            email: body.email,
            display_name: body.display_name ?? body.displayName,
            password: body.password,
            roles: body.roles,
          });
          return json(201, { ok: true, user });
        }
        return json(405, { ok: false, error: 'method_not_allowed' });
      }
      const match = pathname.match(/^\/panel\/admin\/users\/([^/]+)$/);
      if (match) {
        if (upperMethod !== 'PATCH' && upperMethod !== 'PUT') {
          return json(405, { ok: false, error: 'method_not_allowed' });
        }
        const userId = decodeURIComponent(match[1]);
        const body = await readJson(read);
        const user = await authService.updateUser(userId, {
          display_name: body.display_name ?? body.displayName,
          status: body.status,
          roles: body.roles,
          password: body.password,
        });
        return json(200, { ok: true, user });
      }
      return json(404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (error instanceof SyntaxError) return json(400, { ok: false, error: 'invalid_json' });
      const status = Number(error?.statusCode) || (error instanceof DomainError ? 400 : 500);
      return json(status, {
        ok: false,
        error: error?.code || 'admin_error',
        message: String(error?.message || 'Request failed'),
      });
    }
  }

  return { mutationRoutes: ADMIN_MUTATION_ROUTES, matches, handle };
}
