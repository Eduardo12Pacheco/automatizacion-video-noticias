import { ADMIN_MUTATION_ROUTES } from './admin-router.js';
import { DATA_MUTATION_ROUTES } from './data-router.js';
import { LOCAL_MUTATION_ROUTES, normalizeLocalWorkflowPath } from './local-router.js';

/**
 * Single source of truth for every mutating panel route.
 *
 * The gateway uses this table to decide whether a request is a mutation and
 * which role it requires. The routers export their own route definitions and
 * the table is derived from them, so a new mutation cannot be added without
 * being covered here (and by the table-driven security test).
 */
function normalize(route, router, role) {
  return Object.freeze({
    id: route.id,
    router,
    role,
    methods: Object.freeze([...(route.methods || [route.method])]),
    pattern: route.pattern instanceof RegExp ? route.pattern : new RegExp(`^${escapePath(route.path)}$`),
    examplePath: route.examplePath || route.path,
  });
}

function escapePath(path) {
  return String(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const PANEL_MUTATION_ROUTES = Object.freeze([
  ...LOCAL_MUTATION_ROUTES.map((route) => normalize(route, 'local', 'editor')),
  ...ADMIN_MUTATION_ROUTES.map((route) => normalize(route, 'admin', 'admin')),
  ...DATA_MUTATION_ROUTES.map((route) => normalize(route, 'data', 'editor')),
]);

export function matchPanelMutation(method, pathname = '') {
  const upperMethod = String(method || '').toUpperCase();
  const canonicalPath = normalizeLocalWorkflowPath(pathname);
  return PANEL_MUTATION_ROUTES.find(
    (route) => route.methods.includes(upperMethod) && route.pattern.test(canonicalPath),
  ) || null;
}

export function isPanelMutation(method, pathname = '') {
  return Boolean(matchPanelMutation(method, pathname));
}
