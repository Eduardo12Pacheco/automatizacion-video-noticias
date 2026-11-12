import { resolveGatewayBaseUrl } from '../../core/http/shared-read-models.js';

async function requestJson({ fetchImpl, url, method = 'GET' }) {
  const res = await fetchImpl(url, { method, credentials: 'include' });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const message = data?.message || data?.error || `${method} ${url} ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function createConnectorsApiClient({ getSettings, fetchImpl = fetch }) {
  function baseUrl() {
    return resolveGatewayBaseUrl(getSettings());
  }

  return {
    async listConnectors() {
      const data = await requestJson({ fetchImpl, url: `${baseUrl()}/panel/connectors` });
      return Array.isArray(data.connectors) ? data.connectors : [];
    },
    async testConnector(id) {
      const data = await requestJson({
        fetchImpl,
        url: `${baseUrl()}/panel/connectors/${encodeURIComponent(id)}/test`,
        method: 'POST',
      });
      return data.result || null;
    },
  };
}
