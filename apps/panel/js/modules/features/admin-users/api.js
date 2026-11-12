import { resolveGatewayBaseUrl } from '../../core/http/shared-read-models.js';

async function requestJson({ fetchImpl, url, method = 'GET', body }) {
  const res = await fetchImpl(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  if (!res.ok) {
    const message = data?.message || data?.error || `${method} ${url} ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function createAdminUsersApiClient({ getSettings, fetchImpl = fetch }) {
  function baseUrl() {
    return resolveGatewayBaseUrl(getSettings());
  }

  return {
    async listUsers() {
      const data = await requestJson({ fetchImpl, url: `${baseUrl()}/panel/admin/users` });
      return Array.isArray(data.users) ? data.users : [];
    },
    async listRoles() {
      const data = await requestJson({ fetchImpl, url: `${baseUrl()}/panel/admin/roles` });
      return Array.isArray(data.roles) ? data.roles : [];
    },
    async createUser(payload) {
      const data = await requestJson({
        fetchImpl,
        url: `${baseUrl()}/panel/admin/users`,
        method: 'POST',
        body: payload,
      });
      return data.user;
    },
    async updateUser(userId, payload) {
      const data = await requestJson({
        fetchImpl,
        url: `${baseUrl()}/panel/admin/users/${encodeURIComponent(userId)}`,
        method: 'PATCH',
        body: payload,
      });
      return data.user;
    },
  };
}
