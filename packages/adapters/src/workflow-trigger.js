import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

/**
 * Optional WorkflowTriggerPort for an n8n instance the user may run alongside
 * the local API (`--profile n8n`). It is off by default: the in-process job
 * queue is the local orchestration path.
 */
export class N8nWorkflowTrigger {
  constructor({
    baseUrl = 'http://127.0.0.1:5678',
    timeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
    headers = {},
  } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 15_000);
    this.fetchImpl = fetchImpl;
    this.headers = headers;
  }

  async trigger(name, payload = {}) {
    const workflow = String(name || '').trim();
    if (!workflow) throw new AdapterError('workflow_name_missing', 'Workflow name is required', { statusCode: 400 });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/webhook/${encodeURIComponent(workflow)}`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await readJsonResponse(response, { adapter: 'n8n' });
    return { status: 'triggered', workflow, response: data };
  }
}
